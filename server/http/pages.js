'use strict';

/**
 * Public pages: home, search (/listings), one listing, /post, /mine, /saved, /board (http/board-pages.js), /safety, the staff report queue and
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
const kit = require('openvibe-shared/kit');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, render, table, notice, time, badge } = require('../render/html');
const S = require('../render/short');
const { send } = require('../render/layout');
const listings = require('../listings/listings');
const store = require('../listings/store');
const service = require('../listings/service');
const { isStaff } = require('../listings/staff');
const housingPlaces = require('../housing/places');
const housingHpi = require('../housing/hpi');
const everywhere = require('../aggregate/everywhere');
const { mountBoardPages } = require('./board-pages');
const { mountCityPages, listingRentCheck, listingCity } = require('./city-pages');
const cityList = require('../aggregate/cities');
const home = require('../render/home-blocks');
const { products } = require('openvibe-contracts');

const SITE_NAME = 'OpenVibe.Rent';
const TAGLINE = 'Every rental site, one search.';
const HOME_LATEST = 12;

const STATE_KIND = { active: 'ok', hidden: 'warn', expired: '', removed: 'bad' };
const STATE_TEXT = { active: 'active', hidden: 'hidden — waiting for staff', expired: 'expired', removed: 'removed' };
// The AI screen's signs, in words a reader knows (server/listings/screen.js names them; never a raw `full_time`-style value).
const SIGN_TEXT = {
    payment_before_viewing: 'payment before a viewing',
    unusual_payment: 'wire, gift card, crypto or a payment app',
    owner_unavailable: 'an owner who cannot show the place',
    pressure: 'pressure to decide or pay',
    personal_data_request: 'identity or bank details up front',
    off_platform_only: 'only a private channel, no calls or visits',
};
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** An ISO timestamp as "29 Oct 2026" (UTC), or null when it is not a real date (1970 is "not given"). */
function dayText(iso) {
    const t = Date.parse(String(iso == null ? '' : iso));
    if (!Number.isFinite(t) || t <= 0 || String(iso).startsWith('1970-01-01')) return null;
    const d = new Date(t);
    return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
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

    /** HUD's Fair Market Rent for a listing's city and size (the card's short line), or null. */
    const fmrForRow = (row) => {
        if (!ctx.fmr) return null;
        const found = listingCity(row);
        if (!found || found.size.beds > 4) return null;
        const area = ctx.fmr.forCity(found.city);
        const amount = area && area.rents[found.size.key];
        if (amount == null) return null;
        return { amount, area, size: found.size, read: dayText(area.retrieved_at) };
    };

    /** The date of a listing's latest check, and whether it found signs (only what the check really says). */
    const checkOf = (check) => (check ? { flagged: check.action === 'review', date: dayText(check.checked_at) } : null);

    /** One listing in a list, as a card: what kind it is at a glance, the title, where, the price on the right. */
    const KIND_MARK = { apartment: 'Apt', room: 'Room', house: 'House', commercial: 'Work', parking: 'Park', equipment: 'Gear', other: 'More' };
    const listingItem = (row, check = null, canReport = false) => {
        const f = fmrForRow(row);
        const c = checkOf(check);
        return html`<li class="listing kind-${listings.KINDS.includes(row.kind) ? row.kind : 'other'}">
<span class="listing-mark" aria-hidden="true">${KIND_MARK[row.kind] || 'More'}</span>
<span class="listing-main">
<a class="listing-title" href="/listings/${row.id}">${row.title}</a>
<span class="listing-where">${whereOf(row)}</span>
<span class="listing-chips"><span class="chip">${listings.KIND_TEXT[row.kind] || row.kind}</span>${row.bedrooms == null ? '' : html`<span class="chip">${row.bedrooms} bedroom${Number(row.bedrooms) === 1 ? '' : 's'}</span>`}${row.available_from ? html`<span class="chip">from ${row.available_from}</span>` : ''}${f ? html`<span class="chip">HUD FMR ${money(f.amount)}</span>` : ''}${c && c.date ? html`<span class="chip">${c.flagged ? 'Flagged' : 'Checked'} ${c.date}</span>` : ''}<span class="listing-age">posted ${time(row.created_at)}</span></span>
</span>
<div class="listing-price">${priceOf(row)}${canReport ? html`<form class="listing-report-mini" method="post" action="/listings/${row.id}/reports"><input type="hidden" name="reason" value="scam"><button class="chip" type="submit" aria-label="Report this listing" title="Report this listing to OpenVibe staff">Report</button></form>` : ''}</div>
</li>`;
    };

    /** `empty` may be a plain string (escaped) or an `html` value (a link, say). */
    const listingList = (rows, { empty = 'Nothing here yet.', checks = new Map(), canReport = null } = {}) => (rows.length
        ? html`<ul class="listing-list">${rows.map((row) => listingItem(row, checks.get(row.id), Boolean(canReport && canReport(row))))}</ul>`
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
    // What the home shows is real and current: every rental site this search opens, the Census rents of 885 cities,
    // the FHFA index's metro count, listings posted here. A block with nothing to show is left out.
    // A taste and a door, not the index (the owner, 2026-10-28): the search first, the numbers as one strip, the
    // newest listings and the largest cities as rails with See all, the site's places as a launcher, and the parts read
    // once (the cheapest and dearest cities, every state, every site searched, the questions) folded.
    const FAQ = ((products.get('openvibe.rent') || {}).faq || []);
    const PERIOD_SHORT = { month: '/mo', week: '/wk', day: '/day', hour: '/hr', once: '' };
    const priceShort = (row) => {
        const n = Number(row.price);
        const amount = Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }) : String(row.price);
        return `${amount} ${row.currency}${PERIOD_SHORT[row.period] == null ? '' : PERIOD_SHORT[row.period]}`;
    };
    /** One listing in a rail: the price in its corner, HUD's benchmark as the badge above it, the city and kind under
     *  the title, the full place on hover. */
    const listingCard = (row) => {
        const f = fmrForRow(row);
        return kit.card({
            href: `/listings/${row.id}`, title: row.title, type: 'listing', ratio: '4/3', share: false,
            sub: [row.city, listings.KIND_TEXT[row.kind] || row.kind].filter(Boolean).join(' · '),
            badge: f ? `HUD FMR ${money(f.amount)}` : '', corner: priceShort(row), peek: whereOf(row), when: row.created_at,
        });
    };
    /**
     * The home on a phone (the owner's short-pages rule, 2026-10-30): the parts a reader rarely needs — the questions
     * and the other OpenVibe places — are folds, closed on a phone and open where there is room. Both stay in the page.
     */
    function foldedHome(body) {
        let out = String(body);
        out = S.foldSection(out, 'id="h-faq"', 'faq-fold');
        out = S.foldSection(out, 'class="sc-sec sc-network"', 'network-fold');
        return out;
    }

    r.get('/', async (req, res) => {
        const all = listings.normalizeFilters({});
        const latest = await store.search(s, all, { limit: HOME_LATEST });
        const kinds = latest.rows.length ? (await store.facets(s, all)).kind : [];
        const posted = kinds.reduce((n, k) => n + k.count, 0);
        let moves = null;
        try { moves = await housingHpi.areaMoves(s); } catch { moves = null; }
        const homesBase = String(config.homes.url).replace(/\/+$/, '');
        const largest = home.bigCities(0).slice(0, 12);
        const big = home.bigCities(250000).filter((c) => c.rent.b2 != null && c.rent.b2 < 3501);
        const byTwo = [...big].sort((a, b) => a.rent.b2 - b.rent.b2);
        const rentRow = (c) => ({ name: `${c.name}, ${c.state}`, href: c.path, value: cityList.rentText(c.rent.b2) });
        const sizes = (c) => [c.rent.studio != null ? `Studio ${cityList.rentText(c.rent.studio)}` : null, c.rent.b1 != null ? `1 bed ${cityList.rentText(c.rent.b1)}` : null, c.rent.b3 != null ? `3 beds ${cityList.rentText(c.rent.b3)}` : null].filter(Boolean).join(' · ');
        const states = cityList.states().length;
        // The search comes first on a phone: the hero is a line of what it is, then the search, then two doors.
        const hero = showcase.hero({
            title: 'Every rental site.',
            accent: 'One search.',
            lede: `Type a place once and ${SITE_NAME} opens Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper and ${everywhere.SITES.length - 5} more at it.`,
            aside: { html: render(html`${home.search({ action: '/everywhere', placeholder: 'City or ZIP', kinds: everywhere.KINDS, kindText: everywhere.KIND_TEXT, kind: 'apartment', go: 'Search every site' })}
${home.doors([{ href: '/fair', label: 'Is this rent fair?' }, { href: '/housing', label: 'Affordable housing' }])}
<p class="home-note">Listings, messages and payments stay on each site. Never pay or send a deposit before you have seen the place.</p>`) },
        });
        const jsonLd = [
            ...homeJsonLd(config),
            seo.jsonLd.itemList('Typical 2-bedroom rent in the largest US cities', largest.filter((c) => c.rent.b2 != null).map((c) => ({ name: c.name, url: `${base()}${c.path}` })), { url: `${base()}/in` }),
            FAQ.length ? seo.jsonLd.faq(FAQ.map((f) => ({ q: f.question, a: f.answer }))) : null,
        ];
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: 'Every rental site in one search',
            description: 'Search Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper and more at once, check any rent against Census data for 885 US cities, and find HUD housing.',
            jsonLd,
            styles: [showcase.STYLESHEET, ...home.STYLES], localStyles: ['css/home.css'],
            body: raw(foldedHome(html`${raw(hero)}
${home.stats([
        { value: everywhere.SITES.length, label: 'rental sites in one search', href: '/everywhere' },
        { value: cityList.cities.length, label: 'US cities with typical rents', href: '/in' },
        { value: states, label: 'states and territories', href: '/in' },
        { value: moves ? moves.metros.length : null, label: 'metro areas with home-price trends', href: `${homesBase}/` },
        { value: posted || null, label: posted === 1 ? 'listing posted here' : 'listings posted here', href: '/listings' },
    ], { label: `${SITE_NAME} in numbers` })}

${latest.rows.length ? html`<section class="sc-sec home-sec home-latest">${raw(kit.rail({ id: 'latest', wrap: true, title: `Posted on ${SITE_NAME}`, more: { href: '/listings', label: `See all ${posted}` }, size: 's', items: latest.rows.map(listingCard) }))}
<p class="home-kinds" aria-label="Listings by kind">${raw(kinds.map((k) => kit.button({ href: `/listings?${listings.filtersToQuery({ kind: k.value })}`, label: `${listings.KIND_TEXT[k.value] || k.value} ${k.count}`, kind: 'quiet', small: true })).join(' '))}</p></section>` : ''}

<section class="sc-sec home-sec home-cities">${home.cityRail({ id: 'cities', title: 'What rent costs in the largest cities', more: { href: '/in', label: `All ${cityList.cities.length} cities` }, list: largest, pick: (c) => ({ corner: c.rent.b2 != null ? cityList.rentText(c.rent.b2) : null, peek: sizes(c) }) })}
<p class="small muted home-under">The middle rent for a 2-bedroom (Census Bureau, ${cityList.SOURCE.years}); studios, 1- and 3-bedrooms on hover and on each city's page, with every rental site there. <a href="/fair">Check a rent</a></p>
${big.length >= 10 ? home.fold('range', 'Where renting costs least and most', '', html`<p class="small muted">Big cities (250,000 people or more) by the middle 2-bedroom rent. A price far below a city's middle rent is a common sign of a scam.</p><div class="home-ranks">${home.ranked('Lowest 2-bedroom rent', byTwo.slice(0, 6).map(rentRow))}${home.ranked('Highest 2-bedroom rent', byTwo.slice(-6).reverse().map(rentRow))}</div>`) : ''}
${home.fold('states', 'Rent by state', `${states} states and territories`, html`<p class="small muted">Typical rents for every city of 50,000 people or more, and each state's largest, with every rental site's search for each.</p>${home.stateChips('/in')}`)}
</section>

${raw(showcase.apps({
                id: 'places', title: `Everything on ${SITE_NAME}`,
                items: [
                    { icon: 'ov:search', name: 'Search', text: 'Every rental site at once', href: '/everywhere' },
                    { icon: 'ov:gauge', name: 'Fair rent', text: 'Is the rent you were quoted fair?', href: '/fair' },
                    { icon: 'ov:map', name: 'Cities', text: `Typical rents in ${cityList.cities.length} US cities`, href: '/in' },
                    { icon: 'ov:homes', name: 'Affordable', text: 'Public and HUD-assisted housing', href: '/housing' },
                    { icon: 'ov:check', name: 'Your board', text: 'The places you like, from any site', href: '/board' },
                    { icon: 'ov:bell', name: 'Alerts', text: 'Save a search, hear what is new', href: '/listings' },
                    { icon: 'ov:docs', name: 'Listings', text: 'Posted here by people', href: '/listings' },
                    { icon: 'ov:rent', name: 'Post', text: 'Rent yours out', href: '/post' },
                    { icon: 'ov:shield', name: 'Safety', text: 'No deposit before you see it', href: '/safety' },
                    { icon: 'ov:homes', name: 'Buying', text: 'Homes for sale on OpenVibe.Homes', href: `${homesBase}/` },
                ],
            }))}

${home.section('faq', 'Questions people ask', '', html`${home.fold('sites', 'Which sites does it search?', `${everywhere.SITES.length} sites`, html`<p class="small muted">Each one opens its own search at your place, so you see its newest listings without typing the search again.</p>${home.siteList(everywhere.SITES.map((x) => ({ name: x.name, host: `${x.host}${x.us ? '' : ' · worldwide'}`, best: x.best })), 'The United States first; more countries next. Listings, the landlord and the payment stay on each site.')}`)}${home.faq(FAQ)}`)}

${raw(showcase.network({ service: 'rent' }))}
${raw(showcase.cta({ title: 'Have something to rent out?', text: 'Post it in a minute: a description, a price, a period and where it is. You can edit, renew or hide it at any time.', actions: [{ label: 'Post a listing', href: '/post', primary: true }, { label: 'Search every site', href: '/everywhere' }] }))}`)),
        });
    });

    // ── Search everywhere: every rental site's own search for one place ──
    // What each search-everywhere kind is called on this site's own listings (null: no listing kind matches).
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    const OWN_KIND = { apartment: 'apartment', house: 'house', room: 'room', stay: null, commercial: 'commercial', parking: 'parking', storage: 'parking', vehicle: 'equipment' };
    const HUD_KINDS = new Set(['apartment', 'house', 'room']);
    const everywhereForm = (v = {}) => html`<form class="search-form everywhere-form" method="get" action="/everywhere" role="search">
<div class="field"><label for="ew-q">Where</label><input id="ew-q" name="q" type="search" required maxlength="200" placeholder="A city and state, or a ZIP code" value="${v.q || ''}" autocomplete="address-level2"></div>
<div class="field-row">
<div class="field"><label for="ew-kind">Looking for</label><select id="ew-kind" name="kind">${everywhere.KINDS.map((k) => html`<option value="${k}"${k === (v.kind || 'apartment') ? raw(' selected') : ''}>${everywhere.KIND_TEXT[k]}</option>`)}</select></div>
<div class="field"><label for="ew-max">Up to, a month</label><input id="ew-max" name="max" type="number" min="1" max="100000" step="1" inputmode="numeric" placeholder="Any price" value="${v.max || ''}"></div>
<div class="field"><label for="ew-beds">Bedrooms</label><select id="ew-beds" name="beds"><option value="">Any</option>${[1, 2, 3, 4].map((n) => html`<option value="${n}"${String(n) === String(v.beds || '') ? raw(' selected') : ''}>${n}+</option>`)}</select></div>
</div>
<p><button class="sc-btn sc-primary" type="submit">Search every site</button></p>
</form>`;

    async function everywherePage(req, res, { limited = false } = {}) {
        const v = { q: str(req.query.q), kind: everywhere.KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : 'apartment', max: str(req.query.max), beds: str(req.query.beds) };
        let place = null;
        let problem = null;
        if (limited) problem = 'Too many searches from you just now. Try again in a minute.';
        else if (v.q) {
            try { place = await housingPlaces.geocodePlace(ctx.upstream, v.q); } catch (err) {
                problem = err && err.code === 'housing.place.not_found' ? err.message : 'The place search is unavailable right now. Try again in a few minutes.';
            }
        }
        const label = place ? [place.city, place.state || (place.country_name || '')].filter(Boolean).join(', ') : null;
        const links = place ? everywhere.linksFor({ city: place.city, state: place.state, country: place.country_code, postcode: place.postcode, lat: place.lat, lon: place.lon, countryName: place.country_name }, { kind: v.kind, maxPrice: v.max, minBeds: v.beds }) : [];
        const own = place && OWN_KIND[v.kind] ? `/listings?${listings.filtersToQuery({ kind: OWN_KIND[v.kind], city: place.city, max: v.max ? Number(v.max) || null : null })}` : null;
        const tab = (k) => `/everywhere?${new URLSearchParams({ q: v.q || '', kind: k, ...(v.max ? { max: v.max } : {}), ...(v.beds ? { beds: v.beds } : {}) })}`;
        const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
        page(req, res, {
            title: label ? `${everywhere.KIND_TEXT[v.kind]} near ${label}` : 'Search every rental site',
            description: 'One search across Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper, Rent.com and more: apartments, houses, rooms, furnished stays, commercial space, parking, storage and cars.',
            index: !v.q, cache: v.q ? null : PUBLIC_CACHE,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Search everywhere' }],
            styles: [showcase.STYLESHEET], localStyles: ['css/everywhere.css'],
            body: html`<h1>${label ? html`${everywhere.KIND_TEXT[v.kind]} near ${label}` : 'Search every rental site'}</h1>
<p class="sc-lede">One search, every site: ${SITE_NAME} opens Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper and more at the place and filters you choose, next to the listings people post here and affordable housing from HUD.</p>
${everywhereForm(v)}
${problem ? notice(problem, 'warn') : ''}
${place ? html`<nav class="everywhere-kinds" aria-label="What to look for">${everywhere.KINDS.map((k) => (k === v.kind ? html`<span class="ew-kind on" aria-current="page">${everywhere.KIND_TEXT[k]}</span>` : html`<a class="ew-kind" href="${tab(k)}">${everywhere.KIND_TEXT[k]}</a>`))}</nav>
<section class="sc-sec" aria-labelledby="h-sites"><h2 id="h-sites">On every site</h2>
${links.length ? html`<ul class="everywhere-sites">${links.map((l) => html`<li class="ew-site"><a class="ew-open" href="${l.url}" target="_blank" rel="noopener nofollow"><span class="ew-name">${l.name}</span><span class="ew-host">${hostOf(l.url)} ↗</span></a><p class="ew-best">${l.best}</p></li>`)}</ul>
<p class="small muted">Each link opens that site's own search for this place in a new tab, with your filters where the site takes them. Listings, messages and payments stay on that site: never pay a deposit before you have seen a place (<a href="/safety">the safety rules</a>).</p>
<p class="ew-board">Found one you like? <a href="/board">Keep it on your board</a>: every listing from every site in one list, with your notes and how far you got.</p>`
        : html`<p class="muted">No site in the list covers this place and kind yet. The list starts with the United States; more countries come next.</p>`}
</section>
<section class="sc-sec" aria-labelledby="h-here"><h2 id="h-here">On ${SITE_NAME}</h2><ul class="everywhere-here">
${own ? html`<li><a href="${own}">Listings people posted here near ${place.city}</a></li>` : ''}
${HUD_KINDS.has(v.kind) && (place.country_code || 'us') === 'us' ? html`<li><a href="/housing?${new URLSearchParams({ q: v.q })}">Affordable housing near ${place.city}</a>: public housing, tax-credit and HUD-assisted homes</li>` : ''}
<li><a href="/post">Post a listing</a> of your own</li></ul></section>` : ''}`,
        }, limited ? 429 : 200);
    }

    // The geocode spends the same per-caller budget as /housing and the API; over it, the page says so (429).
    const everywhereSearch = ctx.limits.budget('rent.housing.search');
    r.get('/everywhere', (req, res) => {
        if (!str(req.query.q)) return everywherePage(req, res);
        let settled = false;
        let retryAfter = '60';
        const allowed = () => { if (!settled) { settled = true; everywherePage(req, res); } };
        const refused = () => {
            if (settled) return;
            settled = true;
            res.set('Retry-After', retryAfter);
            everywherePage(req, res, { limited: true });
        };
        everywhereSearch(req, { statusCode: 200, setHeader: (k, val) => { if (String(k).toLowerCase() === 'retry-after') retryAfter = String(val); }, end: refused }, allowed);
    });

    // ── Affordable housing near you ──────────────────────────
    // HUD's data is public domain, but the licence still asks for credit; every /housing page carries it, linked back.
    const hudNote = (fetchedAt) => html`<p class="attribution small muted"><a href="${housingPlaces.ATTRIBUTION.url}" rel="noopener">${housingPlaces.ATTRIBUTION.text}</a> · <a href="${housingHpi.ATTRIBUTION.url}" rel="noopener">${housingHpi.ATTRIBUTION.text}</a>. The housing data covers the United States, and availability must be confirmed with the property or authority.${fetchedAt ? html` Fetched ${time(fetchedAt)}.` : ''}</p>`;
    // FHFA's index is a repeat-sales index, not a price: the card says so and links the source back.
    const hpiPct = (n) => { const r = Math.round(n * 10) / 10; return `${r > 0 ? '+' : ''}${r.toFixed(1)} %`; };
    const hpiCard = (p) => {
        const stat = (n, label) => html`<div class="hpi-stat"><span class="hpi-num${n < 0 ? ' hpi-down' : ''}">${hpiPct(n)}</span><span class="hpi-label">${label}</span></div>`;
        const stats = [p.year_change_pct != null ? stat(p.year_change_pct, 'over the past year') : '', p.five_year_change_pct != null ? stat(p.five_year_change_pct, 'over five years') : ''];
        return html`<aside class="hpi-card" aria-labelledby="hpi-title">
<h3 class="hpi-title" id="hpi-title">Home prices around ${p.place}</h3>
<div class="hpi-stats">${stats}</div>
<p class="hpi-note">FHFA all-transactions index, ${p.latest}. This is an index of repeat sales, not a price. <a href="${p.source.url}" rel="noopener">Source: ${p.source.name}</a></p>
</aside>`;
    };
    // HUD's data covers the United States, so distances read in miles (the API keeps distance_km).
    const housingMi = (km) => { const mi = Number(km) * 0.621371; return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`; };
    const housingQuery = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    const SHOWN_PER_KIND = 24;
    const phoneText = (p) => { const d = String(p).replace(/\D/g, ''); const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(p); };
    const titleCase = (v) => (v && v === v.toUpperCase() ? v.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : v);

    function housingForm({ q = '', selected = new Set() } = {}) {
        return html`<form class="search-form housing-form" method="get" action="/housing" role="search">
<div class="field"><label for="q">Where are you?</label>
<input id="q" name="q" type="search" value="${q}" maxlength="200" placeholder="A city, ZIP code or address in the US" autocomplete="address-level2"></div>
<fieldset class="housing-kinds"><legend>Show</legend>
${housingPlaces.KINDS.map((k) => html`<label class="housing-kind"><input type="checkbox" name="kind" value="${k}"${selected.has(k) ? raw(' checked') : ''}><span>${housingPlaces.KIND_TEXT[k]}</span></label>`)}
<p class="muted small">Leave them all unticked to see everything.</p></fieldset>
<p><button class="sc-btn sc-primary" type="submit">Find housing</button>${q || selected.size ? html` <a class="sc-btn" href="/housing">Clear</a>` : ''}</p>
</form>`;
    }

    const housingUnits = (r) => {
        const bits = [];
        if (r.units && r.units.total) bits.push(`${Number(r.units.total).toLocaleString('en-US')} home${Number(r.units.total) === 1 ? '' : 's'}`);
        if (r.units && r.units.low_income != null && r.kind !== 'housing_authority') bits.push(`${Number(r.units.low_income).toLocaleString('en-US')} ${r.kind === 'multifamily' ? 'assisted' : 'low-income'}`);
        if (r.extra && r.extra.section8_units) bits.push(`${Number(r.extra.section8_units).toLocaleString('en-US')} Section 8 vouchers`);
        return bits.join(' · ') || null;
    };
    const housingDetails = (r) => {
        const x = r.extra || {};
        const out = [];
        if (x.authority) out.push(html`Run by ${x.authority}`);
        if (x.rent_per_month) out.push(html`Average tenant rent $${Number(x.rent_per_month).toLocaleString('en-US')} a month`);
        if (x.year_placed) out.push(html`In service since ${x.year_placed}`);
        if (x.property_category) out.push(html`${x.property_category}`);
        if (x.expiration_date) out.push(html`Assistance contract runs to ${x.expiration_date}`);
        if (x.services) out.push(html`${x.services}`);
        if (x.languages) out.push(html`Languages: ${x.languages}`);
        if (x.case_number) out.push(html`HUD case ${x.case_number}`);
        if (x.acquired) out.push(html`Taken back by HUD in ${new Date(x.acquired).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`);
        return out;
    };

    function housingRow(r) {
        // A HUD home is named by its street, so its address line starts at the city.
        const where = [r.kind === 'hud_home' ? null : titleCase(r.address), titleCase(r.city), r.state, r.zip].filter(Boolean).join(', ');
        const tel = r.phone ? String(r.phone).replace(/[^\d+]/g, '') : null;
        const details = housingDetails(r);
        const units = housingUnits(r);
        const map = r.lat != null && r.lon != null ? `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}#map=17/${r.lat}/${r.lon}` : null;
        // HUD's Small Area Fair Market Rent for this ZIP, as a dated reference beside the place: never a listing.
        const safmr = ctx.safmr && r.zip ? ctx.safmr.reference(r.zip, 2) : null;
        return html`<li class="housing-card" id="${r.id}">
<div class="housing-card-head"><h4>${titleCase(r.name) || '—'}</h4><span class="housing-dist">${housingMi(r.distance_km)}</span></div>
${where ? html`<p class="housing-addr">${where}</p>` : ''}
${units ? html`<p class="housing-units">${units}</p>` : ''}
${safmr ? html`<p class="housing-fmr muted small">${safmr.text}</p>` : ''}
${details.length ? html`<ul class="housing-facts">${details.map((d) => html`<li>${d}</li>`)}</ul>` : ''}
<p class="housing-actions">${r.phone ? html`<a href="tel:${tel}">${phoneText(r.phone)}</a>` : ''}${r.extra && r.extra.email ? html`<a href="mailto:${r.extra.email}">Email</a>` : ''}${r.extra && r.extra.website ? html`<a href="${r.extra.website}" rel="nofollow noopener external">Website</a>` : ''}${r.extra && r.extra.homestore_url ? html`<a href="${r.extra.homestore_url}" rel="noopener external">Check it on HUD Homestore</a>` : ''}${map ? html`<a href="${map}" rel="noopener">Map</a>` : ''}</p>
</li>`;
    }

    function housingResults(out) {
        if (!out.results.length) return html`<p class="muted">Nothing was found in this area. Try a nearby town, or a wider place like a city.</p>`;
        const present = out.kinds.filter((k) => (out.per_kind[k] || []).length);
        return html`<ul class="housing-jump" aria-label="Found by kind">${present.map((k) => html`<li><a href="#h-${k}">${housingPlaces.KIND_TEXT[k]} <strong>${out.per_kind[k].length}</strong></a></li>`)}</ul>
${present.map((k) => {
        const rows = out.per_kind[k];
        const first = rows.slice(0, SHOWN_PER_KIND);
        const rest = rows.slice(SHOWN_PER_KIND);
        return html`<section class="housing-group" aria-labelledby="h-${k}">
<h3 id="h-${k}">${housingPlaces.KIND_TEXT[k]} <span class="muted">${rows.length}</span></h3>
<p class="housing-explain">${housingPlaces.KIND_DESCRIPTIONS[k]}</p>
<ul class="housing-list">${first.map(housingRow)}</ul>
${rest.length ? html`<details class="housing-more"><summary>Show ${rest.length} more, further away</summary><ul class="housing-list">${rest.map(housingRow)}</ul></details>` : ''}
</section>`;
    })}`;
    }

    async function housingPage(req, res, { limited = false } = {}) {
        const q = housingQuery(req.query.q) || '';
        const rawKinds = [].concat(req.query.kind || []).flatMap((v) => String(v).split(','));
        const selected = new Set(housingPlaces.KINDS.filter((k) => rawKinds.includes(k)));
        const kindParam = [...selected].join(',');
        let out = null;
        let problem = null;
        if (limited) {
            problem = 'Too many searches from you just now. Try again in a minute.';
        } else if (q) {
            try {
                out = await housingPlaces.searchPlaces(ctx.upstream, { q, kinds: kindParam || null }, config);
            } catch (err) {
                problem = err && err.code ? err.message : 'The housing search is unavailable right now. Try again in a few minutes.';
            }
        }
        let areaPrices = null;
        if (out && out.in_us && config.hpi && config.hpi.enabled) {
            try {
                areaPrices = await housingHpi.areaPricesFor(s, out.location);
            } catch (err) {
                // Home prices are context, never a reason for the page itself to fail.
                ctx.log.warn('[OpenVibe.Rent] FHFA HPI lookup failed:', err && err.message ? err.message : err);
            }
        }
        const title = out && out.location.name ? `Affordable housing near ${out.location.name.split(',').slice(0, 2).join(',')}` : 'Affordable housing near you';
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title,
            description: 'Public housing, tax-credit and HUD-assisted properties, and the authorities and counselling agencies to apply through, near a place you choose — from HUD open data.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Affordable housing' }],
            styles: [showcase.STYLESHEET], localStyles: ['css/housing.css'],
            body: html`<h1>Affordable housing near you</h1>
<p class="housing-lede">Public housing, tax-credit (LIHTC) and HUD-assisted homes near you, and the housing authorities and counselling agencies to apply through. From the U.S. Department of Housing and Urban Development's open data.</p>
${housingForm({ q, selected })}
${problem ? notice(problem, 'warn') : ''}
${out ? html`<section class="housing-results">
<h2 class="housing-where">${out.location.name || 'Around those coordinates'}</h2>
${areaPrices ? hpiCard(areaPrices) : ''}
${out.in_us
        ? html`<p class="muted small">${out.counts.total} found in and around this area, nearest first. Call before you visit: waiting lists and availability change.</p>${housingResults(out)}`
        : html`<p class="notice warn">HUD data covers the United States only.</p>`}
</section>` : html`<p class="muted">Type a city, a ZIP code or an address above.</p>`}
${hudNote(out ? out.fetched_at : null)}`,
        }, limited ? 429 : 200);
    }

    const housingSearch = ctx.limits.budget('rent.housing.search');
    r.get('/housing', (req, res) => {
        // A page load only spends the shared Nominatim budget when it will actually search.
        if (!housingQuery(req.query.q)) return housingPage(req, res);
        let settled = false;
        let retryAfter = '60';
        const allowed = () => { if (!settled) { settled = true; housingPage(req, res); } };
        const refused = () => {
            if (settled) return;
            settled = true;
            res.set('Retry-After', retryAfter);
            housingPage(req, res, { limited: true });
        };
        housingSearch(req, { statusCode: 200, setHeader: (k, v) => { if (String(k).toLowerCase() === 'retry-after') retryAfter = String(v); }, end: refused }, allowed);
    });

    // ── Alerts: a search as an Atom feed, followed by OpenVibe.Watch ──
    const WATCH_NEW = 'https://openvibe.watch/watches/new';
    const feedPath = (filters) => { const qs = listings.filtersToQuery(filters); return `/listings.atom${qs ? `?${qs}` : ''}`; };
    /** Watch's new-watch form, filled in to follow one search's feed; the person reviews and creates it on Watch. */
    const alertHref = (filters) => `${WATCH_NEW}?${new URLSearchParams({ template: 'feed', url: `${base()}${feedPath(filters)}`, name: `Rent: ${savedTitle(filters)}`.slice(0, 80) })}`;
    const xml = (v) => String(v == null ? '' : v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    const isoOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(); };

    r.get('/listings.atom', async (req, res) => {
        const filters = listings.normalizeFilters(req.query);
        const out = await store.search(s, filters, {});
        const rows = out.rows.slice(0, 25);
        const self = `${base()}${feedPath(filters)}`;
        const entries = rows.map((row) => `<entry><id>${xml(`${base()}/listings/${row.id}`)}</id><title>${xml(`${row.title} · ${listings.priceText(row)}`)}</title>`
            + `<link rel="alternate" type="text/html" href="${xml(`${base()}/listings/${row.id}`)}"/><updated>${isoOf(row.created_at)}</updated>`
            + `<summary>${xml([listings.KIND_TEXT[row.kind] || row.kind, whereOf(row), truncate(row.description || '', 300)].filter(Boolean).join(' — '))}</summary></entry>`);
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/atom+xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${xml(self)}</id><title>${xml(`OpenVibe.Rent: ${savedTitle(filters)}`)}</title>`
            + `<link rel="self" href="${xml(self)}"/><link rel="alternate" type="text/html" href="${xml(`${base()}${feedPath(filters).replace('/listings.atom', '/listings')}`)}"/>`
            + `<updated>${rows.length ? isoOf(rows[0].created_at) : new Date().toISOString()}</updated><generator>OpenVibe.Rent</generator>
${entries.join('\n')}
</feed>
`);
    });

    // ── Search ───────────────────────────────────────────────
    r.get('/listings', async (req, res) => {
        const filters = listings.normalizeFilters(req.query);
        const before = listings.isListingId(req.query.before) ? String(req.query.before) : null;
        const out = await store.search(s, filters, { before });
        const facets = await store.facets(s, filters);
        const checks = await store.checksFor(s, out.rows.map((row) => row.id));
        const qs = listings.filtersToQuery(filters);
        const more = (extra) => `/listings?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qs)), ...extra }).toString()}`;
        const facetLink = (dim, value) => `/listings?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qs)), [dim]: value }).toString()}`;
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            feed: { title: savedTitle(filters), href: feedPath(filters) },
            title: 'Listings',
            description: 'Search apartments, rooms, houses, commercial space, parking and storage, and equipment for rent — posted by people on OpenVibe.Rent.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Listings' }],
            styles: [showcase.STYLESHEET],
            body: html`<h1>Listings</h1>
<p class="sc-lede">Active listings, newest first. ${out.rows.length} on this page.</p>
${searchForm(filters)}

<section class="sc-sec" aria-labelledby="h-results"><h2 id="h-results">Results</h2>
${facetList('Kind', 'kind', facets.kind, filters.kind, facetLink)}
${facetList('Country', 'country', facets.country, filters.country, facetLink)}
${qs ? html`<div class="small"><a href="/listings">Clear all filters</a>${signedIn(req) ? html` · <form class="inline" method="post" action="/saved">
<input type="hidden" name="q" value="${filters.q || ''}"><input type="hidden" name="kind" value="${filters.kind || ''}"><input type="hidden" name="city" value="${filters.city || ''}"><input type="hidden" name="country" value="${filters.country || ''}"><input type="hidden" name="period" value="${filters.period || ''}"><input type="hidden" name="min" value="${filters.min == null ? '' : filters.min}"><input type="hidden" name="max" value="${filters.max == null ? '' : filters.max}">
<button class="sc-btn" type="submit">Save this search</button></form>` : ''}</div>` : ''}
<p class="listing-alert"><a class="sc-btn" href="${alertHref(filters)}">Get alerts for this search</a> <span class="small muted">OpenVibe.Watch follows <a href="${feedPath(filters)}">its feed</a> and tells you when a new listing appears.</span></p>
${listingList(out.rows, { empty: html`No listing matches those filters. <a href="/listings">Clear them</a> and try again.`, checks, canReport: (row) => signedIn(req) && row.owner !== requesterOf(req) && row.state === 'active' })}
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

    /** The detailed report form, folded under the one-tap button: a reason and a note for anything the button misses. */
    const reportForm = (row) => html`<form class="card report-form" method="post" action="/listings/${row.id}/reports">
<fieldset><legend>Tell us what is wrong</legend>
<div class="field"><label for="reason">Why?</label><select id="reason" name="reason">
${listings.REASONS.map((x) => html`<option value="${x}">${x === 'scam' ? 'It looks like a scam' : x === 'wrong' ? 'The details are wrong' : x === 'offensive' ? 'The content is offensive' : 'Something else'}</option>`)}
</select></div>
<div class="field"><label for="note">Anything else? (optional)</label><textarea id="note" name="note" rows="3" maxlength="${listings.LIMITS.note}"></textarea></div>
<button class="sc-btn" type="submit">Send the report</button></fieldset>
</form>`;

    /** The latest AI screen of a listing, in the words a renter knows, with the date and the quoted words behind a flag. */
    const checkLine = (check) => {
        if (!check) return html`<p class="listing-check"><b>Our listing check</b> has not read this listing yet.</p>`;
        const when = dayText(check.checked_at);
        const date = when || 'an unrecorded date';
        if (check.action !== 'review') {
            return html`<p class="listing-check check-ok"><b>Our listing check</b> read this on ${date}: no scam signs found.</p>`;
        }
        const spans = listOf(check.spans).filter((x) => x && x.quote).slice(0, 4);
        const signals = [...new Set(listOf(check.signals).map((x) => SIGN_TEXT[x]).filter(Boolean))];
        const reviewed = dayText(check.reviewed_at);
        const found = signals.length ? `${signals.length === 1 ? 'this sign' : 'these signs'} of a scam: ${signals.join('; ')}` : 'signs of a scam';
        return html`<div class="listing-check check-warn"><p><b>Our listing check</b> read this on ${date} and found ${found}.</p>
${spans.length ? html`<ul class="check-quotes">${spans.map((x) => html`<li>“${truncate(x.quote, 200)}”${x.signal && SIGN_TEXT[x.signal] ? html` <span class="muted">— ${SIGN_TEXT[x.signal]}</span>` : ''}</li>`)}</ul>` : ''}
<p class="small muted">A flag asks <a href="/staff">OpenVibe staff</a> to look; it is not a verdict, and the listing stays up until they decide.${reviewed ? html` Staff looked at it on ${reviewed} and left it up.` : ''}</p></div>`;
    };

    /** Outcome 5: one tap to the staff report queue, the named path, and the plain line about money. */
    const oneTapReport = (row) => html`<section class="listing-report" aria-labelledby="h-report"><h2 id="h-report">Something wrong?</h2>
<form method="post" action="/listings/${row.id}/reports"><input type="hidden" name="reason" value="scam"><button class="sc-btn sc-primary" type="submit">Report this listing</button></form>
<p class="small muted">One tap sends it to <a href="/staff">OpenVibe staff's report queue</a>: ${listings.HIDE_AT_REPORTS} different reports hide the listing until they look.</p>
<details class="listing-report-more"><summary>Something else is wrong</summary>${reportForm(row)}</details></section>`;

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
        const check = await store.getCheck(s, row.id);
        return page(req, res, {
            index: row.state === 'active', cache: (row.state === 'active' && !signedIn(req)) ? PUBLIC_CACHE : null,
            title: truncate(row.title, 70),
            description: truncate(`${listings.KIND_TEXT[row.kind] || row.kind} in ${whereOf(row)} — ${row.description}`, 160),
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Listings', href: '/listings' }, { label: truncate(row.title, 60) }],
            jsonLd: [listingJsonLd(row), seo.jsonLd.breadcrumbs([{ name: SITE_NAME, url: `${base()}/` }, { name: 'Listings', url: `${base()}/listings` }, { name: row.title, url: `${base()}/listings/${row.id}` }])],
            styles: [showcase.STYLESHEET], localStyles: ['css/cities.css'],
            body: html`<article class="listing-page">
<h1>${row.title}</h1>
<p class="listing-facts">${stateBadge(row.state)} <span class="badge">${listings.KIND_TEXT[row.kind] || row.kind}</span></p>
<p class="listing-asking"><span class="listing-asking-label">Asking rent</span> ${priceOf(row)}</p>
<p class="where"><b>${whereOf(row)}</b>${row.region ? html` <span class="muted small">(${row.region})</span>` : ''}${row.neighbourhood ? '' : html` <span class="muted small">— the neighbourhood is not given</span>`}</p>
<p class="facts small muted">${row.bedrooms == null ? '' : html`${row.bedrooms} bedroom${Number(row.bedrooms) === 1 ? '' : 's'} · `}${row.available_from ? html`available from ${row.available_from} · ` : ''}posted ${time(row.created_at)} · ${row.state === 'expired' ? 'expired' : 'expires'} ${time(row.expires_at)}</p>
${listingRentCheck(row, { fmr: ctx.fmr })}
${checkLine(check)}

${notice(listings.SAFETY, 'warn')}
<p class="small muted listing-nopay">We take no payment from renter or landlord: posting and searching are free, and rent and deposits stay between you two.</p>

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

${signedIn(req) && !isMine && row.state === 'active' ? oneTapReport(row) : ''}
${!signedIn(req) ? html`<div class="notice">Anyone signed in can <a href="/auth/login?next=${encodeURIComponent(`/listings/${row.id}`)}">report this listing</a>. ${listings.HIDE_AT_REPORTS} different reports hide it until OpenVibe staff look at it.</div>` : ''}
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
<section class="post-preview" aria-labelledby="need">
<h2 id="need">What you will need</h2>
<ul class="need-list">
<li><b>What it is</b><span>An apartment, a room, a house, commercial space, parking or storage, equipment — and a short title.</span></li>
<li><b>The price</b><span>An amount, its currency and the period: a month, a week, a day, an hour or once.</span></li>
<li><b>Where</b><span>The city and country, and a neighbourhood if you like. Never a street address: one is refused.</span></li>
<li><b>How to reach you</b><span>A link or an email address. Only signed-in people see it.</span></li>
</ul>
<p class="muted small">A listing stays up for 30 days and you can renew it. Posting is for people: an app or a service cannot post here. <a href="/safety">The safety rules</a>.</p>
</section>`,
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
<a class="sc-btn" href="${alertHref(it.filters)}">Get alerts</a>
<form class="inline" method="post" action="/saved/${it.row.id}/delete"><button class="sc-btn" type="submit">Forget it</button></form>
</li>`)}</ul>`
                : html`<p class="muted">No saved searches yet. Search the listings, then save the filters to see what is new each time you come back.</p>`}
<div class="notice">Get alerts opens OpenVibe.Watch with the search's feed filled in: Watch checks it and tells you (or runs your agent) when a listing that fits appears. Every search has its feed at <code>/listings.atom</code> with the same filters.</div>`,
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

    // ── The board: listings kept from any site (http/board-pages.js) ──
    mountBoardPages(r, { config, s, page, signedIn, requesterOf, mustSignIn, budgeted, sameSite, signInPrompt });
    mountCityPages(r, { config, page, fmr: ctx.fmr, rentCpi: ctx.rentCpi });

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
    const listOf = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());

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
        const state = ['flagged', 'hidden', 'active', 'removed', 'all'].includes(String(req.query.state)) ? String(req.query.state) : 'hidden';
        const out = state === 'flagged' ? { rows: await store.flaggedQueue(s, { limit: 50 }) } : await store.staffQueue(s, { state, limit: 50 });
        const counts = await store.staffCounts(s);
        const flagged = await store.countFlagged(s);
        const items = [];
        for (const row of out.rows) items.push({ row, reports: await store.reportsFor(s, row.id) });
        return page(req, res, {
            title: 'Report queue',
            description: 'Listings people reported, for OpenVibe staff to restore or remove.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>The report queue</h1>
<p class="sc-lede">${counts.hidden} hidden by reports, ${counts.active} reported but still active, ${counts.removed} removed. A listing is hidden automatically at ${listings.HIDE_AT_REPORTS} distinct reports.</p>
<p class="small">${flagged ? html`<a href="/staff?state=flagged">${flagged} flagged by the AI screen</a>` : 'Nothing flagged by the AI screen.'} <span class="muted">OpenVibe.AI reads each listing a person posts or edits for the signs of a rental scam; a flag only asks for a look, and the listing stays up until you decide.</span></p>
<form class="card filters" method="get" action="/staff">
<div class="field"><label for="state">Show</label><select id="state" name="state">
${['flagged', 'hidden', 'active', 'removed', 'all'].map((x) => html`<option value="${x}"${x === state ? raw(' selected') : ''}>${x === 'hidden' ? 'hidden (needs a look)' : x === 'flagged' ? 'flagged by the AI screen' : x}</option>`)}
</select></div>
<p><button class="sc-btn sc-primary" type="submit">Filter</button> <a class="sc-btn" href="/staff">Clear</a></p>
</form>
${items.length ? items.map((it) => html`<section class="card staff-item">
<h2><a href="/listings/${it.row.id}">${truncate(it.row.title, 80)}</a> ${stateBadge(it.row.state)}</h2>
<p class="small muted">Posted by <code>${it.row.owner}</code> · ${whereOf(it.row)} · ${priceOf(it.row)} · ${it.row.report_count} report${Number(it.row.report_count) === 1 ? '' : 's'}</p>
${textBlock(truncate(it.row.description, 400))}
${it.row.check_signals !== undefined ? html`<div class="screen-flag small"><p><b>The AI screen saw:</b> ${listOf(it.row.check_signals).map((x) => SIGN_TEXT[x] || x).join('; ')}</p>
${it.row.check_rationale ? html`<p class="muted">${truncate(it.row.check_rationale, 400)}</p>` : ''}
${listOf(it.row.check_spans).length ? html`<ul>${listOf(it.row.check_spans).map((sp) => html`<li>“${truncate(sp.quote, 200)}”${sp.signal && SIGN_TEXT[sp.signal] ? html` <span class="muted">(${SIGN_TEXT[sp.signal]})</span>` : ''}</li>`)}</ul>` : ''}
<form class="inline" method="post" action="/listings/${it.row.id}/check"><button class="sc-btn" type="submit">Looks fine</button></form></div>` : ''}
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

    // A member of staff looked at a listing the AI screen flagged and left it up: it leaves the flagged queue until its
    // words change and the screen flags it again.
    r.post('/listings/:id/check', async (req, res) => {
        if (!signedIn(req) || !staffViewer(req)) return page(req, res, {
            title: 'Staff only',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>Staff only</h1><p class="muted">Reviewing a flagged listing is for OpenVibe staff.</p>`,
        }, signedIn(req) ? 403 : 401);
        if (!sameSite(req, res, '/staff?state=flagged')) return;
        if (listings.isListingId(req.params.id)) await store.markCheckReviewed(s, req.params.id, requesterOf(req));
        return res.redirect(303, '/staff?state=flagged');
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
        description: 'Every change deployed to OpenVibe.Rent, newest first, from the OpenVibe network\'s shared update log.',
        body: raw(frame.updatesBody({ service: 'rent', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes };
