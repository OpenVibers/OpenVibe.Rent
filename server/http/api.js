'use strict';

/**
 * /api/v1 — OpenVibe.Rent's API.
 *
 *   GET    /listings               public   search active listings: q, kind, city, country, min, max, period
 *   GET    /listings/:id           public   one listing (contact_url only for a signed-in person)
 *   POST   /listings               person   post a listing (never an app or a service)
 *   PATCH  /listings/:id           owner    edit it, or hide and show it again
 *   DELETE /listings/:id           owner    delete it
 *   POST   /listings/:id/renew     owner    30 more days
 *   POST   /listings/:id/reports   person   report it (3 distinct reports hide it until staff look)
 *   GET    /saved-searches         person   your saved searches, each with its count of new listings
 *   POST   /saved-searches         person   save the current filters
 *   DELETE /saved-searches/:id     person   forget one
 *   GET    /board                  person   your board: listings you keep from any site, with how far you got
 *   POST   /board                  person   keep one (its link, title, price, place, notes); the same link again updates it
 *   PATCH  /board/:id              person   change one (status: interested, contacted, viewing, applied, declined, rented)
 *   DELETE /board/:id              person   forget one
 *   GET    /staff/reports          staff    the report queue
 *   POST   /listings/:id/state     staff    restore (active), hide or remove
 *
 * A listing belongs to the person who posted it: only they may edit, renew, hide or delete it. Everyone may read
 * an active one, and its contact_url is included only for a signed-in person — that is the whole point of the
 * field. A hidden, expired or removed listing is 404 for everyone but its owner and staff. An app, agent or
 * service token cannot post, edit, report or save anything here: a listing is somebody's own, and no route names
 * a capability (see CAPABILITIES in ./principal.js). Writes made with the session cookie must come from
 * openvibe.rent itself (same-origin), so another site cannot make a signed-in person act.
 *
 * Nothing is fetched: a contact URL is stored as text and shown, never opened.
 *
 * Posting over a cap answers 429 with `listing.limit_active` or `listing.limit_daily` — a quota refusal, told apart
 * from the rate limiter's `rate_limited` by its code, and answered before the row is written.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const listings = require('../listings/listings');
const store = require('../listings/store');
const service = require('../listings/service');
const { isStaff } = require('../listings/staff');
const board = require('../board/board');
const housingPlaces = require('../housing/places');
const housingHpi = require('../housing/hpi');
const everywhere = require('../aggregate/everywhere');

/** The listing columns a caller may set, as the validate() input names. */
const INPUT_KEYS = ['kind', 'title', 'description', 'price', 'currency', 'period', 'city', 'region', 'country', 'neighbourhood', 'bedrooms'];

function createApi(ctx) {
    const { config, s, principal, limits } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    const personOf = (req) => (req.principal.kind === 'user' ? req.principal.requester : null);

    // Liveness: public, and counted per caller with the default read numbers.
    r.get('/ping', limits.reads('rent.api.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    // ── Affordable housing near you (public) ─────────────────
    // Search everywhere (server/aggregate/everywhere.js): one place and filters → every rental site's own search for it.
    // No token; it geocodes, so it takes the same per-address budget as /housing.
    r.get('/everywhere', limits.budget('rent.housing.search'), async (req, res) => {
        const one = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
        const kind = one(req.query.kind) || 'apartment';
        if (!everywhere.KINDS.includes(kind)) return problem(req, res, 422, 'rent.everywhere.invalid', `kind: one of ${everywhere.KINDS.join(', ')}`);
        if (!one(req.query.q)) return problem(req, res, 422, 'rent.everywhere.invalid', 'q: a place to search, such as a city and state or a ZIP code');
        const place = await housingPlaces.geocodePlace(ctx.upstream, one(req.query.q)).catch((err) => {
            if (err && err.code) { problem(req, res, err.status || 502, err.code, err.message); return null; }
            throw err;
        });
        if (!place) return undefined;
        const sites = everywhere.linksFor({ city: place.city, state: place.state, country: place.country_code, postcode: place.postcode, lat: place.lat, lon: place.lon, countryName: place.country_name },
            { kind, maxPrice: one(req.query.max_price), minBeds: one(req.query.min_beds) });
        res.set('Cache-Control', 'public, max-age=300');
        return res.json({
            place: { name: place.name, city: place.city, state: place.state, country: place.country_code, lat: place.lat, lon: place.lon },
            kind, sites,
        });
    });

    // No token: HUD's open data is the same for everyone. It spends Nominatim's shared one-request-a-second budget, so
    // it takes the per-address budget in ./caller-limits.js rather than the default read numbers.
    r.get('/housing', limits.budget('rent.housing.search'), async (req, res) => {
        const one = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const out = await housingPlaces.searchPlaces(ctx.upstream, {
            q: one(req.query.q),
            kinds: one(req.query.kind),
        }, config).catch((err) => {
            if (err && err.code) { problem(req, res, err.status || 502, err.code, err.message); return null; }
            throw err;
        });
        if (!out) return undefined;
        let areaPrices = null;
        if (out.in_us && config.hpi && config.hpi.enabled) {
            areaPrices = await housingHpi.areaPricesFor(s, out.location).catch((err) => {
                ctx.log.warn('[OpenVibe.Rent] FHFA HPI lookup failed:', err && err.message ? err.message : err);
                return null;
            });
        }
        // HUD answers are public and change slowly; a short shared cache keeps repeat searches off the upstream.
        res.set('Cache-Control', 'public, max-age=300');
        return res.json({ ...out, area_prices: areaPrices });
    });

    // ── Who may act ─────────────────────────────────────────
    /**
     * A person, signed in. An app, agent or service token is refused: a listing is posted and answered by a person,
     * and no app acts for one here. A session write must come from this site.
     */
    function requirePerson(req, res) {
        const p = req.principal;
        if (p.kind === 'anonymous') {
            problem(req, res, 401, 'token.required', 'Sign in at openvibe.rent, or send a person\'s Network token as a Bearer.');
            return false;
        }
        if (p.kind !== 'user') {
            problem(req, res, 403, 'rent.person_required', 'A listing is posted, edited and reported by a person; an app, agent or service token cannot do it.');
            return false;
        }
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) {
            problem(req, res, 403, 'request.cross_site', 'A signed-in request that changes something must come from openvibe.rent itself.');
            return false;
        }
        return true;
    }
    function requireStaff(req, res) {
        if (!requirePerson(req, res)) return false;
        if (!isStaff(req.principal)) {
            problem(req, res, 403, 'staff.forbidden', 'The report queue is for OpenVibe staff (a Network role of admin or global_mod).');
            return false;
        }
        return true;
    }
    const person = (req, res, next) => (requirePerson(req, res) ? next() : undefined);
    const staff = (req, res, next) => (requireStaff(req, res) ? next() : undefined);

    // ── Reading listings ────────────────────────────────────
    const mine = (req, row) => Boolean(row) && row.owner === personOf(req);
    /** Active, or the caller's own, or staff: what a hidden, expired or removed listing answers to. */
    const visible = (req, row) => Boolean(row) && (row.state === 'active' || mine(req, row) || isStaff(req.principal));

    /** Load one listing for a route. Answers the row, or writes the problem and answers null. */
    async function load(req, res, { needVisible = true } = {}) {
        const id = String(req.params.id || '');
        const row = listings.isListingId(id) ? await store.get(s, id) : null;
        if (!row || (needVisible && !visible(req, row))) {
            problem(req, res, 404, 'listing.not_found', 'No such listing.');
            return null;
        }
        return row;
    }

    /** Load one listing the person must own — otherwise 403, because a listing is not private, it is somebody's. */
    async function loadOwn(req, res) {
        const row = await load(req, res);
        if (!row) return null;
        if (!mine(req, row)) {
            problem(req, res, 403, 'listing.forbidden', 'Only the person who posted this listing can change it.');
            return null;
        }
        return row;
    }

    const rowToInput = (row) => ({
        kind: row.kind, title: row.title, description: row.description, price: Number(row.price),
        currency: row.currency, period: row.period, city: row.city, region: row.region || '',
        country: row.country, neighbourhood: row.neighbourhood || '', bedrooms: row.bedrooms == null ? '' : String(row.bedrooms),
        availableFrom: row.available_from || '', contactUrl: row.contact_url || '',
    });

    /** PATCH: the listing as it stands, with whatever the caller sent laid over it. */
    function overlay(base, body) {
        const out = { ...base };
        for (const k of INPUT_KEYS) if (body[k] !== undefined) out[k] = body[k];
        for (const [from, to] of [['available_from', 'availableFrom'], ['availableFrom', 'availableFrom'], ['contact_url', 'contactUrl'], ['contactUrl', 'contactUrl']]) {
            if (body[from] !== undefined) out[to] = body[from];
        }
        return out;
    }

    const pageOpts = (query) => ({
        limit: Math.min(60, Math.max(1, Number.parseInt(query.limit, 10) || listings.PAGE_SIZE)),
        before: listings.isListingId(query.before) ? String(query.before) : null,
    });

    r.get('/listings', limits.reads('rent.listing.read'), async (req, res) => {
        const filters = listings.normalizeFilters(req.query);
        const opts = pageOpts(req.query);
        const out = await store.search(s, filters, opts);
        const contact = Boolean(personOf(req));
        return res.json({
            filters,
            count: out.rows.length,
            listings: out.rows.map((row) => listings.toWire(row, { contact })),
            next: out.next,
            facets: await store.facets(s, filters),
            note: 'Active listings only, newest first. Facets count the same filters, each without its own dimension.',
        });
    });

    r.get('/listings/:id', limits.reads('rent.listing.read'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        return res.json(listings.toWire(row, { contact: Boolean(personOf(req)) }));
    });

    // ── Posting and owning ──────────────────────────────────
    r.post('/listings', person, limits.budget('rent.listing.create'), async (req, res) => {
        const check = listings.validate(req.body || {});
        if (!check.ok) return problem(req, res, 422, check.code, check.detail);
        const made = await service.create(s, req.principal.requester, check.fields);
        if (!made.ok) return problem(req, res, 429, made.code, made.detail);
        res.set('Location', `/api/v1/listings/${made.row.id}`);
        return res.status(201).json(listings.toWire(made.row, { contact: true }));
    });

    r.patch('/listings/:id', person, async (req, res) => {
        const row = await loadOwn(req, res);
        if (!row) return undefined;
        const body = req.body || {};
        if (row.state === 'removed') return problem(req, res, 409, 'listing.removed', 'Staff removed this listing; it can no longer be edited.');
        const check = listings.validate(overlay(rowToInput(row), body));
        if (!check.ok) return problem(req, res, 422, check.code, check.detail);
        // An owner may hide the listing or show it again, but never set it expired or removed.
        let state = null;
        if (body.state !== undefined) {
            if (!['active', 'hidden'].includes(String(body.state))) return problem(req, res, 422, 'listing.invalid', 'state: active or hidden (only staff remove a listing)');
            state = String(body.state);
        }
        const f = check.fields;
        // Editing an expired listing does not renew it: that is what POST /listings/:id/renew is for.
        const nextState = row.state === 'expired' ? 'expired' : (state || row.state);
        const after = await store.update(s, row.id, {
            kind: f.kind, title: f.title, description: f.description, price: f.price, currency: f.currency,
            period: f.period, city: f.city, region: f.region, country: f.country, neighbourhood: f.neighbourhood,
            bedrooms: f.bedrooms, available_from: f.availableFrom, contact_url: f.contactUrl, state: nextState,
        });
        return res.json(listings.toWire(after, { contact: true }));
    });

    r.delete('/listings/:id', person, async (req, res) => {
        const row = await loadOwn(req, res);
        if (!row) return undefined;
        await store.remove(s, row.id);
        return res.status(204).end();
    });

    r.post('/listings/:id/renew', person, limits.budget('rent.listing.renew'), async (req, res) => {
        const row = await loadOwn(req, res);
        if (!row) return undefined;
        if (row.state === 'removed') return problem(req, res, 409, 'listing.removed', 'Staff removed this listing; it cannot be renewed.');
        const after = await store.renew(s, row.id);
        return res.json(listings.toWire(after, { contact: true }));
    });

    // ── Reports ─────────────────────────────────────────────
    r.post('/listings/:id/reports', person, limits.budget('rent.listing.report'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        if (row.state !== 'active') return problem(req, res, 404, 'listing.not_found', 'No such listing.');
        if (mine(req, row)) return problem(req, res, 403, 'listing.own', 'You cannot report your own listing.');
        const check = listings.validateReport(req.body || {});
        if (!check.ok) return problem(req, res, 422, check.code, check.detail);
        const out = await store.addReport(s, row.id, {
            id: s.newId('rpt'), reporter: req.principal.requester,
            reason: check.fields.reason, note: check.fields.note, createdAt: s.iso(),
        });
        if (out.error === 'report.duplicate') return problem(req, res, 409, 'report.duplicate', 'You have already reported this listing.');
        if (out.error) return problem(req, res, 404, 'listing.not_found', 'No such listing.');
        res.set('Location', `/api/v1/listings/${row.id}`);
        return res.status(201).json({
            report: listings.toWireReport(out.report),
            listing: listings.toWire(out.row),
            hidden: out.hidden,
            note: out.hidden ? `This listing now has ${listings.HIDE_AT_REPORTS} distinct reports and is hidden until staff look at it.` : undefined,
        });
    });

    // ── Saved searches ──────────────────────────────────────
    r.get('/saved-searches', person, limits.reads('rent.saved.read'), async (req, res) => {
        const rows = await store.listSaved(s, req.principal.requester);
        const out = [];
        for (const row of rows) {
            const filters = typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters;
            out.push(listings.toWireSaved(row, { newCount: await store.countMatching(s, listings.normalizeFilters(filters), { sinceISO: row.last_seen_at }) }));
        }
        return res.json({
            saved_searches: out,
            note: 'new_count is the active listings that appeared since last_seen_at. Alerts by notification come later through OpenVibe.Watch.',
        });
    });

    r.post('/saved-searches', person, limits.budget('rent.saved.create'), async (req, res) => {
        const filters = listings.normalizeFilters(req.body || {});
        const row = await store.saveSearch(s, {
            id: s.newId('ssv'), subject: req.principal.requester, filters,
            key: listings.filtersKey(filters), createdAt: s.iso(),
        });
        res.set('Location', `/api/v1/saved-searches/${row.id}`);
        return res.status(201).json(listings.toWireSaved(row));
    });

    r.delete('/saved-searches/:id', person, async (req, res) => {
        const id = String(req.params.id || '');
        const row = listings.isSavedId(id) ? await store.getSaved(s, id) : null;
        if (!row || row.subject !== req.principal.requester) return problem(req, res, 404, 'saved.not_found', 'No such saved search.');
        await store.deleteSaved(s, id, req.principal.requester);
        return res.status(204).end();
    });

    // ── The board ───────────────────────────────────────────
    // Listings a person keeps from any site (server/board/board.js). Rent stores what the person sends and never
    // fetches the link.
    r.get('/board', person, limits.reads('rent.board.read'), async (req, res) => {
        const rows = await board.list(s, req.principal.requester);
        return res.json({ items: rows.map(board.toWire), statuses: board.STATUSES, max_items: board.MAX_ITEMS });
    });

    r.post('/board', person, limits.budget('rent.board.write'), async (req, res) => {
        const v = board.validate(req.body || {});
        if (!v.ok) return problem(req, res, 422, v.code, v.detail);
        const out = await board.save(s, req.principal.requester, v.item);
        if (!out.ok) return problem(req, res, 409, out.code, out.detail);
        if (out.created) res.set('Location', `/api/v1/board/${out.row.id}`);
        return res.status(out.created ? 201 : 200).json(board.toWire(out.row));
    });

    async function loadItem(req, res) {
        const id = String(req.params.id || '');
        const row = board.isItemId(id) ? await board.get(s, id) : null;
        if (!row || row.subject !== req.principal.requester) {
            problem(req, res, 404, 'board.not_found', 'No such listing on your board.');
            return null;
        }
        return row;
    }

    r.patch('/board/:id', person, limits.budget('rent.board.write'), async (req, res) => {
        const row = await loadItem(req, res);
        if (!row) return undefined;
        const v = board.validate(req.body || {}, { partial: true });
        if (!v.ok) return problem(req, res, 422, v.code, v.detail);
        if (v.item.url && v.item.url !== row.url) {
            const clash = await s.db.maybe('SELECT id FROM rent_board_items WHERE subject = $1 AND url = $2', [row.subject, v.item.url]);
            if (clash) return problem(req, res, 409, 'board.duplicate', 'That link is already on your board.');
        }
        return res.json(board.toWire(await board.update(s, row.id, v.item)));
    });

    r.delete('/board/:id', person, limits.budget('rent.board.write'), async (req, res) => {
        const row = await loadItem(req, res);
        if (!row) return undefined;
        await board.remove(s, row.id, req.principal.requester);
        return res.status(204).end();
    });

    // ── Staff ───────────────────────────────────────────────
    r.get('/staff/reports', staff, limits.reads('rent.report.staff'), async (req, res) => {
        const state = ['hidden', 'active', 'removed', 'all'].includes(String(req.query.state)) ? String(req.query.state) : 'hidden';
        const out = await store.staffQueue(s, { state, ...pageOpts(req.query) });
        const queue = [];
        for (const row of out.rows) {
            queue.push({ listing: listings.toWire(row), reports: (await store.reportsFor(s, row.id)).map(listings.toWireReport) });
        }
        return res.json({ filter: { state }, counts: await store.staffCounts(s), queue, next: out.next });
    });

    r.post('/listings/:id/state', staff, async (req, res) => {
        const row = await load(req, res, { needVisible: false });
        if (!row) return undefined;
        const state = String((req.body || {}).state || '');
        if (!['active', 'hidden', 'removed'].includes(state)) return problem(req, res, 422, 'listing.invalid', 'state: active, hidden or removed');
        return res.json(listings.toWire(await store.setState(s, row.id, state)));
    });

    return r;
}

module.exports = { createApi };
