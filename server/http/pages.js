'use strict';

/**
 * Public pages: home, search (/listings), one listing, /post, /mine, /saved, /safety, the staff report queue and
 * the update log. Crawl artifacts (robots.txt, sitemap.xml, llms.txt, llms-full.txt, JSON-LD) are http/discovery.js.
 *
 * Every page works without JavaScript and is server-rendered through openvibe-shared/shell (render/layout.js):
 * search is a GET form, posting and reporting are plain POSTs. Nothing here is hand-written copy about a listing —
 * a listing is what its owner typed, escaped by the `html` template and nothing else.
 *
 * A signed-in write must come from openvibe.rent itself (same-origin), exactly as in the API, and the form and the
 * API take the same per-caller budget, so the form is not a way round a limit.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time, badge } = require('../render/html');
const { send } = require('../render/layout');
const listings = require('../listings/listings');
const store = require('../listings/store');
const service = require('../listings/service');
const { isStaff } = require('../listings/staff');

const SITE_NAME = 'OpenVibe.Rent';
const TAGLINE = 'Find a place, or rent yours out.';
const HOME_LATEST = 6;

const STATE_KIND = { active: 'ok', hidden: 'warn', expired: '', removed: 'bad' };
const STATE_TEXT = { active: 'active', hidden: 'hidden — waiting for staff', expired: 'expired', removed: 'removed' };
// Only from a clear schema.org type do we publish JSON-LD for a listing; "other" is left without one on purpose.
const SCHEMA_TYPE = { apartment: 'Apartment', room: 'Room', house: 'House', commercial: 'Place', parking: 'ParkingFacility', equipment: 'Product' };

/** Plain text exactly as it was typed: escaped by the template, line breaks kept by the stylesheet. */
const textBlock = (t) => html`<p class="txt">${t}</p>`;
const truncate = (s, n) => (String(s == null ? '' : s).length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s == null ? '' : s));

function createPageRoutes(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    // The pages' forms are plain POSTs (no JavaScript): urlencoded only, and small — a listing is text.
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 120 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => Boolean(req.viewer && req.viewer.kind === 'user' && req.viewer.subject);
    const staffViewer = (req) => isStaff(req.viewer);
    const requesterOf = (req) => `user:${req.viewer.subject}`;
    const base = () => String(config.baseUrl).replace(/\/+$/, '');

    // ── Small pieces ─────────────────────────────────────────
    const stateBadge = (st) => badge(STATE_TEXT[st] || st, STATE_KIND[st] || '');
    const priceOf = (row) => html`<b class="price">${listings.priceText(row)}</b>`;
    const whereOf = (row) => [row.neighbourhood, row.city, row.country].filter(Boolean).join(', ');
    const signInPrompt = (what, next) => html`<div class="notice">${what} <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a>.</div>`;

    /** One listing in a list: the title, the price, where it is and how old it is. */
    const listingItem = (row) => html`<li class="listing">
<a class="listing-title" href="/listings/${row.id}">${row.title}</a>
<span class="listing-meta small muted">${listings.KIND_TEXT[row.kind] || row.kind} · ${whereOf(row)}${row.bedrooms == null ? '' : ` · ${row.bedrooms} bedroom${Number(row.bedrooms) === 1 ? '' : 's'}`} · posted ${time(row.created_at)}</span>
<span class="listing-price">${priceOf(row)}</span>
</li>`;

    /** `empty` may be a plain string (escaped) or an `html` value (a link, say). */
    const listingList = (rows, { empty = 'Nothing here yet.' } = {}) => (rows.length
        ? html`<ul class="listing-list">${rows.map(listingItem)}</ul>`
        : html`<p class="muted">${empty}</p>`);

    /** The search box: one GET form, the same fields /listings and a saved search use. */
    function searchForm(f = {}, { big = false } = {}) {
        const opt = (value, text, selected) => html`<option value="${value}"${value === (selected || '') ? raw(' selected') : ''}>${text}</option>`;
        return html`<form class="search-form${big ? ' search-big' : ''}" method="get" action="/listings" role="search">
<div class="field"><label for="q">What are you looking for?</label>
<input id="q" name="q" type="search" value="${f.q || ''}" maxlength="${listings.LIMITS.q}" placeholder="apartment in Lisbon, parking near the centre, a camera for a week"></div>
<div class="field-row">
<div class="field"><label for="kind">Kind</label><select id="kind" name="kind">${opt('', 'any kind', f.kind)}${listings.KINDS.map((k) => opt(k, listings.KIND_TEXT[k], f.kind))}</select></div>
<div class="field"><label for="city">City</label><input id="city" name="city" type="text" value="${f.city || ''}" maxlength="${listings.LIMITS.city}"></div>
<div class="field"><label for="country">Country</label><select id="country" name="country">${opt('', 'any country', f.country)}${listings.COUNTRIES.map((c) => opt(c, c, f.country))}</select></div>
</div>
<div class="field-row">
<div class="field"><label for="min">Price from</label><input id="min" name="min" type="number" min="0" step="any" value="${f.min == null ? '' : f.min}"></div>
<div class="field"><label for="max">Price up to</label><input id="max" name="max" type="number" min="0" step="any" value="${f.max == null ? '' : f.max}"></div>
<div class="field"><label for="period">Per</label><select id="period" name="period">${opt('', 'any period', f.period)}${listings.PERIODS.map((p) => opt(p, listings.PERIOD_TEXT[p], f.period))}</select></div>
</div>
<p><button class="sc-btn sc-primary" type="submit">Search</button> <a class="sc-btn" href="/listings">Clear</a></p>
</form>`;
    }

    /** A page write must come from this site, exactly as in the API: a cross-site form must not act as the person. */
    function sameSite(req, res, back) {
        if (sameOrigin(req, config.baseUrl)) return true;
        page(req, res, {
            title: 'Not from this site',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Not from this site' }],
            body: html`<h1>That came from somewhere else</h1><p class="muted">A signed-in page that changes something has to come from openvibe.rent itself. <a href="${back}">Go back</a> and try again.</p>`,
        }, 403);
        return false;
    }

    /** The signed-in gate, with a page of its own rather than a bare 401. */
    const mustSignIn = (back) => (req, res, next) => (signedIn(req) ? next()
        : page(req, res, { title: 'Sign in', crumbs: [{ label: 'Home', href: '/' }, { label: 'Sign in' }], body: html`<h1>Sign in first</h1>${signInPrompt('A listing belongs to your OpenVibe account, so you can edit, renew or delete it later.', back)}` }, 401));

    /**
     * The same per-caller budget the API applies, given an HTML face: the limiter writes its refusal to a shim and
     * the page renders its own 429 — a person using the form should not be handed problem+json. The counters, the
     * windows and the metric are the API's.
     */
    const budgeted = (name) => {
        const limit = ctx.limits.budget(name);
        return (req, res, next) => {
            let settled = false;
            const refusal = (body) => {
                let p = null;
                try { p = JSON.parse(String(body)); } catch { p = null; }
                if (p && p.retry_after_seconds) res.set('Retry-After', String(p.retry_after_seconds));
                return page(req, res, {
                    title: 'Too many requests',
                    crumbs: [{ label: 'Home', href: '/' }, { label: 'Too many requests' }],
                    body: html`<h1>Too many requests just now</h1>
${notice(p && p.detail ? p.detail : 'You are over the limit for this.', 'warn')}
<p class="muted">Wait a moment and send it again — nothing was lost. <a href="/mine">Your listings</a> are still there.</p>`,
                }, 429);
            };
            limit(req, {
                statusCode: 0,
                setHeader: () => {}, getHeader: () => undefined, removeHeader: () => {},
                end: (body) => { if (!settled) { settled = true; refusal(body); } },
            }, (err) => {
                if (settled) return undefined;
                settled = true;
                return err ? next(err) : next();
            });
            return undefined;
        };
    };

    const canSee = (req, row) => Boolean(row)
        && (row.state === 'active' || (signedIn(req) && row.owner === requesterOf(req)) || staffViewer(req));

    // ── Home ─────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const latest = await store.search(s, listings.normalizeFilters({}), { limit: HOME_LATEST });
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · ${TAGLINE}`,
            title: 'Somewhere to live, work or park',
            accent: 'Every listing here was posted by a person.',
            lede: `${SITE_NAME} is one place to find and offer things to rent: apartments, rooms, houses, commercial space, parking and storage, and equipment. In this first version people post the listings here themselves — nothing is scraped from another site, and nothing is paid for here.`,
            actions: signedIn(req)
                ? [{ label: 'Post a listing', href: '/post', primary: true }, { label: 'Your listings', href: '/mine' }]
                : [{ label: 'Browse listings', href: '/listings', primary: true }, { label: 'Sign in to post', href: '/auth/login?next=%2Fpost' }],
            note: 'No payments, no deposits, no messaging: a listing carries a way to make contact and nothing more.',
        });
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
<section class="sc-sec" aria-labelledby="h-search"><h2 id="h-search">Search the listings</h2>
<p class="sc-lede">Straight to it, or <a href="/listings">browse everything</a>.</p>
${searchForm({}, { big: true })}</section>

<section class="sc-sec" aria-labelledby="h-latest"><h2 id="h-latest">Latest listings</h2>
<p class="sc-lede">The newest active listings, posted by people on ${SITE_NAME}.</p>
${listingList(latest.rows, { empty: 'No listings yet — yours could be the first.' })}
<p><a class="sc-btn" href="/listings">Every listing</a> <a class="sc-btn" href="/post">Post a listing</a></p></section>

${raw(showcase.features({
                title: 'How it works',
                lede: 'A listing here is somebody offering something, and the rules are the same for everyone.',
                items: [
                    { icon: 'ov:account', title: 'Posted by people', text: 'Every listing is posted by a signed-in person, who can edit, renew, hide or delete it. Nothing here is scraped from another site.' },
                    { icon: 'ov:gauge', title: 'Safety first', text: 'Never pay or send a deposit before you have seen the place and signed an agreement. OpenVibe does not handle payments for listings.' },
                    { icon: 'ov:page', title: 'Reported listings are checked', text: 'Three distinct reports hide a listing until OpenVibe staff look at it and restore or remove it.' },
                    { icon: 'ov:db', title: 'Searches you can keep', text: 'Save your filters and see how many listings are new since you last looked. Alerts come later through OpenVibe.Watch.' },
                    { icon: 'ov:deploy', title: 'No addresses', text: 'A listing names a city and a neighbourhood, never a street address: a house number with a street is refused.' },
                ],
            }))}

<section class="sc-sec" aria-labelledby="h-sources"><h2 id="h-sources">Where the listings come from</h2>
<p class="sc-prose">Today: people, posting here themselves. There are no scraped listings and no partner feeds — other sources arrive only when their terms are verified, and each listing will then say where it came from and link back to it. <a href="/safety">The safety rules</a> are on every listing page.</p></section>

${raw(showcase.cta({ title: 'Have something to rent out?', text: 'Post it in a minute: a description, a price, a period and where it is. You can edit, renew or hide it at any time.', actions: [{ label: 'Post a listing', href: '/post', primary: true }, { label: 'Safety rules', href: '/safety' }] }))}`,
        });
    });

    // ── Search ───────────────────────────────────────────────
    r.get('/listings', async (req, res) => {
        const filters = listings.normalizeFilters(req.query);
        const before = listings.isListingId(req.query.before) ? String(req.query.before) : null;
        const out = await store.search(s, filters, { before });
        const facets = await store.facets(s, filters);
        const qs = listings.filtersToQuery(filters);
        const more = (extra) => `/listings?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qs)), ...extra }).toString()}`;
        const facetLink = (dim, value) => `/listings?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qs)), [dim]: value }).toString()}`;
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: 'Listings',
            description: 'Search apartments, rooms, houses, commercial space, parking and storage, and equipment for rent — posted by people on OpenVibe.Rent.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Listings' }],
            body: html`<h1>Listings</h1>
<p class="sc-lede">Active listings, newest first. ${out.rows.length} on this page.</p>
${searchForm(filters)}

<section class="sc-sec" aria-labelledby="h-results"><h2 id="h-results">Results</h2>
${facetList('Kind', 'kind', facets.kind, filters.kind, facetLink)}
${facetList('Country', 'country', facets.country, filters.country, facetLink)}
${qs ? html`<div class="small"><a href="/listings">Clear all filters</a>${signedIn(req) ? html` · <form class="inline" method="post" action="/saved">
<input type="hidden" name="q" value="${filters.q || ''}"><input type="hidden" name="kind" value="${filters.kind || ''}"><input type="hidden" name="city" value="${filters.city || ''}"><input type="hidden" name="country" value="${filters.country || ''}"><input type="hidden" name="period" value="${filters.period || ''}"><input type="hidden" name="min" value="${filters.min == null ? '' : filters.min}"><input type="hidden" name="max" value="${filters.max == null ? '' : filters.max}">
<button class="sc-btn" type="submit">Save this search</button></form>` : ''}</div>` : ''}
${listingList(out.rows, { empty: html`No listing matches those filters. <a href="/listings">Clear them</a> and try again.` })}
${out.next ? html`<p><a href="${more({ before: out.next })}">Older listings</a>${before ? html` · <a href="/listings${qs ? `?${qs}` : ''}">Newest first</a>` : ''}</p>` : ''}
</section>`,
        });
    });

    function facetList(title, dim, values, selected, link) {
        if (!values.length) return '';
        return html`<p class="facets small"><span class="muted">${title}:</span>
${selected ? html`<a href="${link(dim, '')}" class="badge info">any ${title.toLowerCase()}</a> ` : ''}
${values.slice(0, 24).map((v) => html`<a href="${link(dim, v.value)}" class="badge${v.value === selected ? ' info' : ''}">${dim === 'kind' ? (listings.KIND_TEXT[v.value] || v.value) : v.value} (${v.count})</a> `)}</p>`;
    }

    // ── One listing ──────────────────────────────────────────
    /** The schema.org Offer we publish, and only when the kind has a clear type: "other" gets no JSON-LD. */
    function listingJsonLd(row) {
        const type = SCHEMA_TYPE[row.kind];
        if (!type || row.state !== 'active') return null;
        return {
            '@context': 'https://schema.org', '@type': 'Offer',
            url: `${base()}/listings/${row.id}`,
            name: row.title,
            description: truncate(row.description, 300),
            price: Number(row.price),
            priceCurrency: row.currency,
            priceValidUntil: String(row.expires_at).slice(0, 10),
            availability: 'https://schema.org/InStock',
            businessFunction: row.period === 'once' ? 'https://schema.org/Sell' : 'https://schema.org/LeaseOut',
            areaServed: `${row.city}, ${row.country}`,
            itemOffered: { '@type': type, name: row.title },
        };
    }

    const reportForm = (row) => html`<form class="card report-form" method="post" action="/listings/${row.id}/reports">
<fieldset><legend>Report this listing</legend>
<div class="field"><label for="reason">Why?</label><select id="reason" name="reason">
${listings.REASONS.map((x) => html`<option value="${x}">${x === 'scam' ? 'It looks like a scam' : x === 'wrong' ? 'The details are wrong' : x === 'offensive' ? 'The content is offensive' : 'Something else'}</option>`)}
</select></div>
<div class="field"><label for="note">Anything else? (optional)</label><textarea id="note" name="note" rows="3" maxlength="${listings.LIMITS.note}"></textarea></div>
<button class="sc-btn" type="submit">Report it</button></fieldset>
<p class="small muted">Three different people reporting a listing hide it from search until OpenVibe staff look at it.</p>
</form>`;

    r.get('/listings/:id', async (req, res) => {
        const row = listings.isListingId(req.params.id) ? await store.get(s, req.params.id) : null;
        if (!canSee(req, row)) {
            return page(req, res, {
                title: 'No such listing',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Listings', href: '/listings' }, { label: 'Not found' }],
                body: html`<h1>No such listing</h1><p class="muted">There is no listing here. It may have expired or been removed. <a href="/listings">See what is available</a>.</p>`,
            }, 404);
        }
        const isMine = row.owner === requesterOf(req);
        const contact = row.contact_url || null;
        return page(req, res, {
            index: row.state === 'active', cache: (row.state === 'active' && !signedIn(req)) ? PUBLIC_CACHE : null,
            title: truncate(row.title, 70),
            description: truncate(`${listings.KIND_TEXT[row.kind] || row.kind} in ${whereOf(row)} — ${row.description}`, 160),
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Listings', href: '/listings' }, { label: truncate(row.title, 60) }],
            jsonLd: [listingJsonLd(row), seo.jsonLd.breadcrumbs([{ name: SITE_NAME, url: `${base()}/` }, { name: 'Listings', url: `${base()}/listings` }, { name: row.title, url: `${base()}/listings/${row.id}` }])],
            body: html`<article class="listing-page">
<h1>${row.title}</h1>
<p class="listing-facts">${stateBadge(row.state)} <span class="badge">${listings.KIND_TEXT[row.kind] || row.kind}</span> ${priceOf(row)}</p>
<p class="where"><b>${whereOf(row)}</b>${row.region ? html` <span class="muted small">(${row.region})</span>` : ''}${row.neighbourhood ? '' : html` <span class="muted small">— the neighbourhood is not given</span>`}</p>
<p class="facts small muted">${row.bedrooms == null ? '' : html`${row.bedrooms} bedroom${Number(row.bedrooms) === 1 ? '' : 's'} · `}${row.available_from ? html`available from ${row.available_from} · ` : ''}posted ${time(row.created_at)} · ${row.state === 'expired' ? 'expired' : 'expires'} ${time(row.expires_at)}</p>

${notice(listings.SAFETY, 'warn')}

<section aria-labelledby="h-about"><h2 id="h-about">About this listing</h2>${textBlock(row.description)}</section>

<section class="sc-sec" aria-labelledby="h-contact"><h2 id="h-contact">How to make contact</h2>
${contact
                ? (signedIn(req) ? html`<p><a class="sc-btn sc-primary" href="${contact}" rel="nofollow noopener">${contact}</a></p>
<p class="small muted">This link was given by the person who posted the listing. OpenVibe has not checked it and does not take part in the arrangement.</p>`
                    : html`<p>${signInPrompt('Sign in to see how to contact the person who posted this listing.', `/listings/${row.id}`)}</p>`)
                : html`<p class="muted">The person who posted this listing did not leave a way to make contact.</p>`}
${!signedIn(req) && contact ? html`<p class="small muted">Contact details are shown to signed-in people only, so they cannot be harvested from a public page.</p>` : ''}
</section>

${isMine ? html`<section class="sc-sec" aria-labelledby="h-own"><h2 id="h-own">Your listing</h2>
<p><a class="sc-btn" href="/listings/${row.id}/edit">Edit it</a></p>
<form class="inline" method="post" action="/listings/${row.id}/renew"><button class="sc-btn" type="submit">Renew for ${listings.EXPIRY_DAYS} more days</button></form>
<form class="inline" method="post" action="/listings/${row.id}/visibility"><input type="hidden" name="state" value="${row.state === 'hidden' ? 'active' : 'hidden'}"><button class="sc-btn" type="submit">${row.state === 'hidden' ? 'Show it again' : 'Hide it'}</button></form>
<form class="inline" method="post" action="/listings/${row.id}/delete"><button class="sc-btn" type="submit">Delete it</button></form>
<p class="small muted">Deleting removes the listing and its reports for good. Hiding leaves it in <a href="/mine">your listings</a> but takes it out of search.</p>
</section>` : ''}

${staffViewer(req) ? html`<section class="sc-sec" aria-labelledby="h-staff"><h2 id="h-staff">Staff</h2>
<p class="small muted">${row.report_count} report${Number(row.report_count) === 1 ? '' : 's'}. <a href="/staff">The report queue</a>.</p></section>` : ''}

${signedIn(req) && !isMine && row.state === 'active' ? reportForm(row) : ''}
${!signedIn(req) ? html`<div class="notice">Anyone signed in can <a href="/auth/login?next=${encodeURIComponent(`/listings/${row.id}`)}">report this listing</a>. Three different reports hide it until OpenVibe staff look at it.</div>` : ''}
</article>`,
        });
    });

    // ── Posting ──────────────────────────────────────────────
    /** The listing form. Every dynamic value is escaped; the field rules are the ones the API enforces. */
    function listingForm({ values = {}, problem = null, action, submit = 'Post the listing' }) {
        const v = values;
        const opt = (value, text, selected) => html`<option value="${value}"${String(value) === String(selected == null ? '' : selected) ? raw(' selected') : ''}>${text}</option>`;
        return html`<form class="card listing-form" method="post" action="${action}">
${problem ? notice(problem, 'warn') : ''}
<div class="field"><label for="kind">What is it?</label><select id="kind" name="kind" required>
${listings.KINDS.map((k) => opt(k, listings.KIND_TEXT[k], v.kind))}
</select></div>
<div class="field"><label for="title">Title</label><input id="title" name="title" type="text" maxlength="${listings.LIMITS.title}" required value="${v.title || ''}" placeholder="Sunny two-bedroom flat near the park">
<p class="small muted">Up to ${listings.LIMITS.title} characters. No street address, please — the area only.</p></div>
<div class="field"><label for="description">Description</label><textarea id="description" name="description" rows="8" maxlength="${listings.LIMITS.description}" required placeholder="What it is like, what is included, who it suits.">${v.description || ''}</textarea>
<p class="small muted">Plain text, up to ${listings.LIMITS.description} characters. Never a street address.</p></div>
<div class="field-row">
<div class="field"><label for="price">Price</label><input id="price" name="price" type="number" min="0" step="any" required value="${v.price == null ? '' : v.price}"></div>
<div class="field"><label for="currency">Currency</label><select id="currency" name="currency" required>${listings.CURRENCIES.map((c) => opt(c, c, v.currency || 'USD'))}</select></div>
<div class="field"><label for="period">Per</label><select id="period" name="period" required>${listings.PERIODS.map((p) => opt(p, listings.PERIOD_TEXT[p], v.period))}</select></div>
</div>
<div class="field-row">
<div class="field"><label for="city">City or town</label><input id="city" name="city" type="text" maxlength="${listings.LIMITS.city}" required value="${v.city || ''}"></div>
<div class="field"><label for="country">Country</label><select id="country" name="country" required>${listings.COUNTRIES.map((c) => opt(c, c, v.country))}</select></div>
</div>
<div class="field-row">
<div class="field"><label for="region">Region or state (optional)</label><input id="region" name="region" type="text" maxlength="${listings.LIMITS.region}" value="${v.region || ''}"></div>
<div class="field"><label for="neighbourhood">Neighbourhood (optional)</label><input id="neighbourhood" name="neighbourhood" type="text" maxlength="${listings.LIMITS.neighbourhood}" value="${v.neighbourhood || ''}">
<p class="small muted">The area, never a street address.</p></div>
</div>
<div class="field-row">
<div class="field"><label for="bedrooms">Bedrooms (optional)</label><input id="bedrooms" name="bedrooms" type="number" min="0" max="50" step="1" value="${v.bedrooms == null ? '' : v.bedrooms}"></div>
<div class="field"><label for="available_from">Available from (optional)</label><input id="available_from" name="available_from" type="date" value="${v.availableFrom || ''}"></div>
</div>
<div class="field"><label for="contact_url">How to make contact (optional)</label><input id="contact_url" name="contact_url" type="text" maxlength="${listings.LIMITS.contactUrl}" value="${v.contactUrl || ''}" placeholder="https://example.com/your-listing or mailto:you@example.com">
<p class="small muted">An https:// link or a mailto: address, shown only to signed-in people — never on a public page.</p></div>
<p><button class="sc-btn sc-primary" type="submit">${submit}</button> <a class="sc-btn" href="/mine">Your listings</a></p>
</form>`;
    }

    /** The form values, from the body as typed (so a refusal gives the text back). */
    const formValues = (b) => ({
        kind: b.kind, title: b.title, description: b.description, price: b.price, currency: b.currency, period: b.period,
        city: b.city, region: b.region, country: b.country, neighbourhood: b.neighbourhood, bedrooms: b.bedrooms,
        availableFrom: b.available_from, contactUrl: b.contact_url,
    });

    r.get('/post', (req, res) => {
        if (!signedIn(req)) return page(req, res, {
            title: 'Post a listing',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Post a listing' }],
            body: html`<h1>Post a listing</h1>${signInPrompt('A listing belongs to your OpenVibe account, so you can edit, renew or delete it later.', '/post')}
<p class="muted">Posting is for people: an app or a service cannot post here.</p>`,
        }, 401);
        return page(req, res, {
            title: 'Post a listing',
            description: 'Post a place, a space or a piece of equipment for rent on OpenVibe.Rent. No payments are handled here.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Post a listing' }],
            body: html`<h1>Post a listing</h1>
<p class="sc-lede">A description, a price and where it is. You can have ${listings.MAX_ACTIVE} active listings at a time and post ${listings.MAX_PER_DAY} a day; each one lasts ${listings.EXPIRY_DAYS} days and you can renew it.</p>
${notice(listings.SAFETY, 'warn')}
${listingForm({ action: '/post' })}`,
        });
    });

    r.post('/post', mustSignIn('/post'), budgeted('rent.listing.create'), async (req, res) => {
        if (!sameSite(req, res, '/post')) return;
        const b = req.body || {};
        const check = listings.validate(formValues(b));
        if (!check.ok) return page(req, res, {
            title: 'Post a listing',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Post a listing' }],
            body: html`<h1>Post a listing</h1>${listingForm({ values: formValues(b), problem: check.detail, action: '/post' })}`,
        }, 422);
        const made = await service.create(s, requesterOf(req), check.fields);
        if (!made.ok) return page(req, res, {
            title: 'Post a listing',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Post a listing' }],
            body: html`<h1>Post a listing</h1>${listingForm({ values: formValues(b), problem: made.detail, action: '/post' })}`,
        }, 429);
        return res.redirect(303, `/listings/${made.row.id}`);
    });

    // ── Editing your own ────────────────────────────────────
    async function ownListing(req, res) {
        const row = listings.isListingId(req.params.id) ? await store.get(s, req.params.id) : null;
        if (!signedIn(req) || !row || row.owner !== requesterOf(req)) {
            page(req, res, {
                title: 'Not yours to change',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Your listings', href: '/mine' }, { label: 'Not yours' }],
                body: html`<h1>Not yours to change</h1><p class="muted">Only the person who posted a listing can change it. <a href="/mine">Your listings</a>.</p>`,
            }, signedIn(req) ? 403 : 401);
            return null;
        }
        return row;
    }

    const rowValues = (row) => ({
        kind: row.kind, title: row.title, description: row.description, price: Number(row.price), currency: row.currency,
        period: row.period, city: row.city, region: row.region || '', country: row.country, neighbourhood: row.neighbourhood || '',
        bedrooms: row.bedrooms == null ? '' : String(row.bedrooms), availableFrom: row.available_from || '', contactUrl: row.contact_url || '',
    });

    r.get('/listings/:id/edit', mustSignIn('/mine'), async (req, res) => {
        const row = await ownListing(req, res);
        if (!row) return undefined;
        if (row.state === 'removed') return page(req, res, {
            title: 'Removed by staff',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your listings', href: '/mine' }, { label: 'Removed' }],
            body: html`<h1>Removed by staff</h1><p class="muted">OpenVibe staff removed this listing, so it cannot be edited. <a href="/mine">Your listings</a>.</p>`,
        }, 409);
        return page(req, res, {
            title: `Edit: ${truncate(row.title, 50)}`,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your listings', href: '/mine' }, { label: truncate(row.title, 40) }],
            body: html`<h1>Edit your listing</h1>
<p class="small muted">${stateBadge(row.state)} · expires ${time(row.expires_at)}</p>
${notice(listings.SAFETY, 'warn')}
${listingForm({ values: rowValues(row), action: `/listings/${row.id}/edit`, submit: 'Save the changes' })}`,
        });
    });

    r.post('/listings/:id/edit', mustSignIn('/mine'), async (req, res) => {
        if (!sameSite(req, res, '/mine')) return;
        const row = await ownListing(req, res);
        if (!row) return undefined;
        const b = req.body || {};
        const check = listings.validate(formValues(b));
        if (!check.ok) return page(req, res, {
            title: 'Edit your listing',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your listings', href: '/mine' }, { label: 'Edit' }],
            body: html`<h1>Edit your listing</h1>${listingForm({ values: formValues(b), problem: check.detail, action: `/listings/${row.id}/edit`, submit: 'Save the changes' })}`,
        }, 422);
        const f = check.fields;
        await store.update(s, row.id, {
            kind: f.kind, title: f.title, description: f.description, price: f.price, currency: f.currency,
            period: f.period, city: f.city, region: f.region, country: f.country, neighbourhood: f.neighbourhood,
            bedrooms: f.bedrooms, available_from: f.availableFrom, contact_url: f.contactUrl,
            state: row.state === 'expired' ? 'expired' : row.state,
        });
        return res.redirect(303, `/listings/${row.id}`);
    });

    r.post('/listings/:id/renew', mustSignIn('/mine'), budgeted('rent.listing.renew'), async (req, res) => {
        if (!sameSite(req, res, '/mine')) return;
        const row = await ownListing(req, res);
        if (!row) return undefined;
        if (row.state !== 'removed') await store.renew(s, row.id);
        return res.redirect(303, `/listings/${row.id}`);
    });

    r.post('/listings/:id/visibility', mustSignIn('/mine'), async (req, res) => {
        if (!sameSite(req, res, '/mine')) return;
        const row = await ownListing(req, res);
        if (!row) return undefined;
        const state = String((req.body || {}).state || '');
        if (['active', 'hidden'].includes(state) && row.state !== 'removed' && row.state !== 'expired') await store.setState(s, row.id, state);
        return res.redirect(303, '/mine');
    });

    r.post('/listings/:id/delete', mustSignIn('/mine'), async (req, res) => {
        if (!sameSite(req, res, '/mine')) return;
        const row = await ownListing(req, res);
        if (!row) return undefined;
        await store.remove(s, row.id);
        return res.redirect(303, '/mine');
    });

    // ── Your listings ────────────────────────────────────────
    r.get('/mine', async (req, res) => {
        if (!signedIn(req)) return page(req, res, {
            title: 'Your listings',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your listings' }],
            body: html`<h1>Your listings</h1>${signInPrompt('Your listings belong to your OpenVibe account.', '/mine')}`,
        }, 401);
        const rows = await store.listByOwner(s, requesterOf(req));
        return page(req, res, {
            title: 'Your listings',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your listings' }],
            body: html`<h1>Your listings</h1>
<p class="sc-lede">Everything you posted, newest first. ${rows.filter((x) => x.state === 'active').length} of your ${listings.MAX_ACTIVE} allowed active listings.</p>
<p><a class="sc-btn sc-primary" href="/post">Post a listing</a> <a class="sc-btn" href="/listings">Browse listings</a></p>
${table(['Listing', 'State', 'Price', 'Reports', 'Expires', ''], rows.map((row) => [
            html`<a href="/listings/${row.id}">${truncate(row.title, 60)}</a>`,
            stateBadge(row.state),
            priceOf(row),
            String(row.report_count),
            time(row.expires_at),
            html`<a href="/listings/${row.id}/edit">Edit</a>
<form class="inline" method="post" action="/listings/${row.id}/renew"><button class="sc-btn" type="submit">Renew</button></form>
${row.state === 'removed' ? '' : html`<form class="inline" method="post" action="/listings/${row.id}/visibility"><input type="hidden" name="state" value="${row.state === 'hidden' ? 'active' : 'hidden'}"><button class="sc-btn" type="submit">${row.state === 'hidden' ? 'Show' : 'Hide'}</button></form>`}
<form class="inline" method="post" action="/listings/${row.id}/delete"><button class="sc-btn" type="submit">Delete</button></form>`,
        ]), { empty: 'You have not posted anything yet.' })}`,
        });
    });

    // ── Saved searches ───────────────────────────────────────
    r.get('/saved', async (req, res) => {
        if (!signedIn(req)) return page(req, res, {
            title: 'Saved searches',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Saved searches' }],
            body: html`<h1>Saved searches</h1>${signInPrompt('Saved searches belong to your OpenVibe account.', '/saved')}`,
        }, 401);
        const rows = await store.listSaved(s, requesterOf(req));
        const items = [];
        for (const row of rows) {
            const filters = typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters;
            items.push({
                row, filters,
                newCount: await store.countMatching(s, listings.normalizeFilters(filters), { sinceISO: row.last_seen_at }),
            });
        }
        // Looking at the page is looking at the searches: what we counted is new since this moment next time.
        const now = s.iso();
        for (const it of items) await store.markSavedSeen(s, it.row.id, now);
        return page(req, res, {
            title: 'Saved searches',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Saved searches' }],
            body: html`<h1>Saved searches</h1>
<p class="sc-lede">Each one is a set of filters with the count of listings that have appeared since you last looked. Save one from <a href="/listings">the listings page</a>.</p>
${items.length
                ? html`<ul class="saved-list">${items.map((it) => html`<li>
<a href="/listings?${listings.filtersToQuery(it.filters)}"><b>${savedTitle(it.filters)}</b></a>
${it.newCount ? html` <span class="badge info">${it.newCount} new</span>` : html` <span class="badge">nothing new</span>`}
<span class="small muted"> · saved ${time(it.row.created_at)} · last looked ${time(it.row.last_seen_at)}</span>
<form class="inline" method="post" action="/saved/${it.row.id}/delete"><button class="sc-btn" type="submit">Forget it</button></form>
</li>`)}</ul>`
                : html`<p class="muted">No saved searches yet. Search the listings, then save the filters to see what is new each time you come back.</p>`}
<div class="notice">Alerts that come to you — a notification, an email — arrive later through OpenVibe.Watch. For now a saved search is a page you open.</div>`,
        });
    });

    /** A saved search as a sentence: the filters, not a JSON blob. */
    function savedTitle(f) {
        const bits = [];
        if (f.q) bits.push(`“${truncate(f.q, 40)}”`);
        if (f.kind) bits.push(listings.KIND_TEXT[f.kind] || f.kind);
        if (f.city) bits.push(`in ${f.city}`);
        if (f.country) bits.push(`in ${f.country}`);
        if (f.min != null || f.max != null) bits.push(`price ${f.min == null ? 'up to' : f.max == null ? 'from' : ''} ${f.min != null ? f.min : f.max}`);
        if (f.period) bits.push(`per ${f.period}`);
        return bits.length ? bits.join(' ') : 'Everything for rent';
    }

    r.post('/saved', mustSignIn('/listings'), budgeted('rent.saved.create'), async (req, res) => {
        if (!sameSite(req, res, '/listings')) return;
        const filters = listings.normalizeFilters(req.body || {});
        await store.saveSearch(s, { id: s.newId('ssv'), subject: requesterOf(req), filters, key: listings.filtersKey(filters), createdAt: s.iso() });
        return res.redirect(303, '/saved');
    });

    r.post('/saved/:id/delete', mustSignIn('/saved'), async (req, res) => {
        if (!sameSite(req, res, '/saved')) return;
        const id = String(req.params.id || '');
        if (listings.isSavedId(id)) await store.deleteSaved(s, id, requesterOf(req));
        return res.redirect(303, '/saved');
    });

    // ── Reporting ────────────────────────────────────────────
    r.post('/listings/:id/reports', mustSignIn('/listings'), budgeted('rent.listing.report'), async (req, res) => {
        if (!sameSite(req, res, '/listings')) return;
        const row = listings.isListingId(req.params.id) ? await store.get(s, req.params.id) : null;
        if (!canSee(req, row) || row.state !== 'active') return page(req, res, {
            title: 'No such listing',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Listings', href: '/listings' }, { label: 'Not found' }],
            body: html`<h1>No such listing</h1><p class="muted"><a href="/listings">See what is available</a>.</p>`,
        }, 404);
        if (row.owner === requesterOf(req)) return page(req, res, {
            title: 'That is your listing',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your listings', href: '/mine' }],
            body: html`<h1>That is your own listing</h1><p class="muted">You cannot report your own listing. <a href="/listings/${row.id}">Back to it</a>.</p>`,
        }, 403);
        const check = listings.validateReport(req.body || {});
        if (!check.ok) return res.redirect(303, `/listings/${row.id}`);
        const out = await store.addReport(s, row.id, { id: s.newId('rpt'), reporter: requesterOf(req), reason: check.fields.reason, note: check.fields.note, createdAt: s.iso() });
        return res.redirect(303, `/listings/${row.id}${out.hidden ? '?reported=hidden' : '?reported=1'}`);
    });

    // ── The report queue (staff) ─────────────────────────────
    r.get('/staff', async (req, res) => {
        if (!signedIn(req)) return page(req, res, {
            title: 'Report queue',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>The report queue</h1>${signInPrompt('The queue is for OpenVibe staff.', '/staff')}`,
        }, 401);
        if (!staffViewer(req)) return page(req, res, {
            title: 'Staff only',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>Staff only</h1><p class="muted">The report queue is for OpenVibe staff — a Network role of <code>admin</code> or <code>global_mod</code>. Yours is <code>${truncate(req.viewer.role || 'user', 32)}</code>. <a href="/mine">Your listings</a>.</p>`,
        }, 403);
        const state = ['hidden', 'active', 'removed', 'all'].includes(String(req.query.state)) ? String(req.query.state) : 'hidden';
        const out = await store.staffQueue(s, { state, limit: 50 });
        const counts = await store.staffCounts(s);
        const items = [];
        for (const row of out.rows) items.push({ row, reports: await store.reportsFor(s, row.id) });
        return page(req, res, {
            title: 'Report queue',
            description: 'Listings people reported, for OpenVibe staff to restore or remove.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>The report queue</h1>
<p class="sc-lede">${counts.hidden} hidden by reports, ${counts.active} reported but still active, ${counts.removed} removed. A listing is hidden automatically at ${listings.HIDE_AT_REPORTS} distinct reports.</p>
<form class="card filters" method="get" action="/staff">
<div class="field"><label for="state">Show</label><select id="state" name="state">
${['hidden', 'active', 'removed', 'all'].map((x) => html`<option value="${x}"${x === state ? raw(' selected') : ''}>${x === 'hidden' ? 'hidden (needs a look)' : x}</option>`)}
</select></div>
<p><button class="sc-btn sc-primary" type="submit">Filter</button> <a class="sc-btn" href="/staff">Clear</a></p>
</form>
${items.length ? items.map((it) => html`<section class="card staff-item">
<h2><a href="/listings/${it.row.id}">${truncate(it.row.title, 80)}</a> ${stateBadge(it.row.state)}</h2>
<p class="small muted">Posted by <code>${it.row.owner}</code> · ${whereOf(it.row)} · ${priceOf(it.row)} · ${it.row.report_count} report${Number(it.row.report_count) === 1 ? '' : 's'}</p>
${textBlock(truncate(it.row.description, 400))}
<ul class="report-list small">${it.reports.map((rp) => html`<li><b>${rp.reason}</b> · <code>${rp.reporter}</code> · ${time(rp.created_at)}${rp.note ? html` — ${rp.note}` : ''}</li>`)}</ul>
<form class="inline" method="post" action="/listings/${it.row.id}/state"><input type="hidden" name="state" value="active"><button class="sc-btn" type="submit">Restore it</button></form>
<form class="inline" method="post" action="/listings/${it.row.id}/state"><input type="hidden" name="state" value="hidden"><button class="sc-btn" type="submit">Hide it</button></form>
<form class="inline" method="post" action="/listings/${it.row.id}/state"><input type="hidden" name="state" value="removed"><button class="sc-btn" type="submit">Remove it</button></form>
</section>`) : html`<p class="muted">Nothing in the queue with that filter.</p>`}`,
        });
    });

    r.post('/listings/:id/state', async (req, res) => {
        if (!signedIn(req) || !staffViewer(req)) return page(req, res, {
            title: 'Staff only',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>Staff only</h1><p class="muted">Restoring or removing a listing is for OpenVibe staff.</p>`,
        }, signedIn(req) ? 403 : 401);
        if (!sameSite(req, res, '/staff')) return;
        const row = listings.isListingId(req.params.id) ? await store.get(s, req.params.id) : null;
        if (!row) return page(req, res, {
            title: 'No such listing',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue', href: '/staff' }],
            body: html`<h1>No such listing</h1><p class="muted"><a href="/staff">The report queue</a>.</p>`,
        }, 404);
        const state = String((req.body || {}).state || '');
        if (['active', 'hidden', 'removed'].includes(state)) await store.setState(s, row.id, state);
        return res.redirect(303, '/staff');
    });

    // ── Safety ───────────────────────────────────────────────
    r.get('/safety', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: 'Safety rules',
        description: 'How to rent safely: never pay or send a deposit before you have seen the place and signed an agreement. OpenVibe does not handle payments for listings.',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Safety' }],
        styles: [showcase.STYLESHEET],
        body: html`<h1>Renting safely</h1>
${notice(listings.SAFETY, 'warn')}
<section class="sc-sec" aria-labelledby="h-rules"><h2 id="h-rules">The rules</h2>
<ul class="prose">
<li><b>See it first.</b> Never pay, and never send a deposit, before you have seen the place and signed an agreement.</li>
<li><b>OpenVibe does not handle payments for listings.</b> There is no way to pay through this site and no deposit to leave here. Anyone who asks you to pay through OpenVibe.Rent is not telling the truth.</li>
<li><b>There is no messaging here.</b> Contact happens where the listing says it does — usually an https link or an email address. Keep a copy of everything you agree.</li>
<li><b>Meet in person, and take someone with you</b> for a first viewing, in daylight if you can.</li>
<li><b>Treat a price that is far below the area as a warning</b>, and never send money to hold a place you have not seen.</li>
<li><b>Report anything that looks wrong.</b> Anyone signed in can report a listing; ${listings.HIDE_AT_REPORTS} different reports hide it from search until OpenVibe staff look at it.</li>
</ul></section>
<section class="sc-sec" aria-labelledby="h-addresses"><h2 id="h-addresses">No street addresses</h2>
<p class="sc-prose">A listing here names a city, and a neighbourhood if the poster gave one — never a street address. A house number together with a street is refused when the listing is posted or edited, in the form and in the API alike. Ask for the exact address once you have made contact with the person, and see the place before you commit to anything.</p></section>
<section class="sc-sec" aria-labelledby="h-sources"><h2 id="h-sources">Where listings come from</h2>
<p class="sc-prose">Every listing in this version was posted by a person on this site. There are no scraped listings and no partner feeds: other sources arrive only when their terms are verified, and each listing will then say where it came from and link back to it. OpenVibe has not visited or checked any listing, and takes no part in the arrangement between the person renting and the person offering.</p></section>`,
    }));

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'rent', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes };
