'use strict';

/**
 * OpenVibe.Homes (https://openvibe.homes): buying a home, the owning side of OpenVibe.Rent (the owner's 09-28 ask:
 * "the homes and property and records version of openvibe.rent… interconnect them"). Served by Rent's process for its
 * own host (server/app.js); every page is server-rendered and works without JavaScript.
 *
 *   /             what Homes is, and the search
 *   /search       one place → every for-sale site's own search, foreclosures and government homes, the county's
 *                 records, the FHFA price index for the area, and Rent's search for the same place
 *   /records      each state's county assessor and recorder sites (NETR Online's directory), and what they hold
 *   /mortgage     the monthly cost of a loan, from what you type (server/homes/mortgage.js)
 *   /robots.txt /sitemap.xml /llms.txt
 *
 * Nothing is fetched from the listing sites; the place search spends the same per-caller budget as Rent's
 * (rent.housing.search, the OpenStreetMap geocode).
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const showcase = require('openvibe-shared/showcase');
const { send } = require('../render/layout');
const { html, raw, notice } = require('../render/html');
const sites = require('./sites');
const { monthly } = require('./mortgage');
const housingPlaces = require('../housing/places');
const housingHpi = require('../housing/hpi');
const { US_STATE_NAMES } = require('../aggregate/everywhere');

const STATE_TITLE = Object.fromEntries(Object.entries(US_STATE_NAMES).map(([code, s]) => [code, s.split('-').map((w) => (w === 'of' ? w : w[0].toUpperCase() + w.slice(1))).join(' ')]));
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function createHomesRoutes(ctx) {
    const { config, s } = ctx;
    const r = express.Router();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const base = String(config.homes.url).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: { kind: 'anonymous' }, config, path: req.originalUrl, site: 'homes', ...o });
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

    const searchForm = (v) => html`<form class="search-form everywhere-form" method="get" action="/search" role="search">
<div class="field"><label for="hq">Where</label><input id="hq" name="q" type="search" required maxlength="120" placeholder="A city and state, or a ZIP code" value="${v.q || ''}" autocomplete="address-level2"></div>
<div class="field-row">
<div class="field"><label for="hk">Looking for</label><select id="hk" name="kind">${sites.KINDS.map((k) => html`<option value="${k}"${k === v.kind ? raw(' selected') : ''}>${sites.KIND_TEXT[k]}</option>`)}</select></div>
<div class="field"><label for="hm">Up to</label><input id="hm" name="max" type="number" min="1" max="100000000" step="1" inputmode="numeric" placeholder="Any price" value="${v.max || ''}"></div>
<div class="field"><label for="hb">Bedrooms</label><select id="hb" name="beds"><option value="">Any</option>${[1, 2, 3, 4, 5].map((n) => html`<option value="${n}"${String(n) === String(v.beds || '') ? raw(' selected') : ''}>${n}+</option>`)}</select></div>
</div>
<p><button class="sc-btn sc-primary" type="submit">Search every site</button></p></form>`;

    // ── Home ─────────────────────────────────────────────────
    r.get('/', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        description: 'Buying a home: one search opens Zillow, Realtor.com, Redfin, Homes.com, Trulia and Craigslist, with HUD and Fannie Mae homes, foreclosure auctions, county property records and a mortgage calculator.',
        styles: [showcase.STYLESHEET], localStyles: ['css/everywhere.css', 'css/homes.css'],
        body: html`${raw(showcase.hero({
            eyebrow: 'OpenVibe.Homes', title: 'Buying a home?', accent: 'Search every site at once.',
            lede: 'Type a place once and every big for-sale site searches it for you: Zillow, Realtor.com, Redfin, Homes.com, Trulia and Craigslist, next to HUD and Fannie Mae homes, foreclosure auctions and the county\'s property records. Keep the homes you like on one board, whichever site they came from.',
            actions: [{ label: 'Search every site', href: '#search', primary: true }, { label: 'Mortgage calculator', href: '/mortgage' }, { label: 'Property records', href: '/records' }],
        }))}
<section class="sc-sec" id="search" aria-labelledby="h-search"><h2 id="h-search">Search</h2>${searchForm({ kind: 'home' })}</section>
${raw(showcase.features({
            title: 'What is here',
            items: [
                { icon: 'ov:search', title: 'Every for-sale site', text: 'Zillow, Realtor.com, Redfin, Homes.com, Trulia and Craigslist, each opened at your place and price.' },
                { icon: 'ov:shield', title: 'Government and bank homes', text: 'HUD Homestore, Fannie Mae HomePath and foreclosure auctions, often below market and first offered to people who will live there.' },
                { icon: 'ov:docs', title: 'Property records', text: 'The county assessor and recorder for any US state: owners, sales, taxes and deeds, from the official sites.' },
                { icon: 'ov:gauge', title: 'Mortgage calculator', text: 'The monthly cost of a loan with taxes, insurance and HOA, from the numbers you type.' },
                { icon: 'ov:rent', title: 'Keep them on your board', text: 'Your OpenVibe.Rent board keeps homes from every site in one list, with your notes.', href: `${config.baseUrl}/board` },
            ],
        }))}`,
    }));

    // ── One place, every site ────────────────────────────────
    const budget = ctx.limits.budget('rent.housing.search');
    async function searchPage(req, res, { limited = false } = {}) {
        const v = { q: str(req.query.q), kind: sites.KINDS.includes(String(req.query.kind)) ? String(req.query.kind) : 'home', max: str(req.query.max, 9), beds: str(req.query.beds, 2) };
        let place = null;
        let problem = null;
        if (limited) problem = 'Too many searches from you just now. Try again in a minute.';
        else if (v.q) {
            try { place = await housingPlaces.geocodePlace(ctx.upstream, v.q); } catch (err) {
                problem = err && err.code === 'housing.place.not_found' ? err.message : 'The place search is unavailable right now. Try again in a few minutes.';
            }
        }
        const inUs = place && (place.country_code || 'us') === 'us' && /^[A-Z]{2}$/.test(String(place.state || ''));
        if (place && !inUs) problem = 'OpenVibe.Homes covers the United States for now. Try a US city and state, or a ZIP code.';
        const label = inUs ? `${place.city || place.name}, ${place.state}` : null;
        const links = inUs ? sites.linksFor({ city: place.city, state: place.state, country: 'us', postcode: place.postcode }, { kind: v.kind, maxPrice: v.max, minBeds: v.beds }) : [];
        let prices = null;
        if (inUs && config.hpi && config.hpi.enabled) { try { prices = await housingHpi.areaPricesFor(s, { city: place.city, state: place.state }); } catch { prices = null; } }
        const records = inUs ? sites.recordsUrl(place.state) : null;
        const tab = (k) => `/search?${new URLSearchParams({ q: v.q || '', kind: k, ...(v.max ? { max: v.max } : {}), ...(v.beds ? { beds: v.beds } : {}) })}`;
        const pct = (n) => { const x = Math.round(n * 10) / 10; return `${x > 0 ? '+' : ''}${x.toFixed(1)} %`; };
        return page(req, res, {
            title: label ? `${sites.KIND_TEXT[v.kind]} near ${label}` : 'Search every site for a home to buy',
            description: 'One search across Zillow, Realtor.com, Redfin, Homes.com, Trulia, Craigslist, HUD Homestore, HomePath and foreclosure auctions.',
            index: !v.q, cache: v.q ? null : PUBLIC_CACHE,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Search' }],
            styles: [showcase.STYLESHEET], localStyles: ['css/everywhere.css', 'css/housing.css', 'css/homes.css'],
            body: html`<h1>${label ? html`${sites.KIND_TEXT[v.kind]} near ${label}` : 'Search every site for a home to buy'}</h1>
${searchForm(v)}
${problem ? notice(problem, 'warn') : ''}
${inUs ? html`<nav class="everywhere-kinds" aria-label="What to look for">${sites.KINDS.map((k) => (k === v.kind ? html`<span class="ew-kind on" aria-current="page">${sites.KIND_TEXT[k]}</span>` : html`<a class="ew-kind" href="${tab(k)}">${sites.KIND_TEXT[k]}</a>`))}</nav>
<section class="sc-sec" aria-labelledby="h-sites"><h2 id="h-sites">On every site</h2>
${links.length ? html`<ul class="everywhere-sites">${links.map((l) => html`<li class="ew-site"><a class="ew-open" href="${l.url}" target="_blank" rel="noopener nofollow"><span class="ew-name">${l.name}</span><span class="ew-host">${hostOf(l.url)} ↗</span></a><p class="ew-best">${l.best}</p></li>`)}</ul>
<p class="small muted">Each link opens that site's own search in a new tab, with your filters where the site takes them. Offers, inspections and payments happen with the seller or an agent, never through a stranger's link.</p>` : html`<p class="muted">No site covers this place for this kind yet.</p>`}
<p class="ew-board">Found one? <a href="${config.baseUrl}/board">Keep it on your board</a> on OpenVibe.Rent: homes from every site in one list, with your notes.</p></section>
<section class="sc-sec homes-context" aria-labelledby="h-context"><h2 id="h-context">Around ${label}</h2><div class="homes-cards">
${prices ? html`<aside class="hpi-card"><h3 class="hpi-title">Home prices around ${prices.place}</h3><div class="hpi-stats">${prices.year_change_pct != null ? html`<div class="hpi-stat"><span class="hpi-num${prices.year_change_pct < 0 ? ' hpi-down' : ''}">${pct(prices.year_change_pct)}</span><span class="hpi-label">over the past year</span></div>` : ''}${prices.five_year_change_pct != null ? html`<div class="hpi-stat"><span class="hpi-num${prices.five_year_change_pct < 0 ? ' hpi-down' : ''}">${pct(prices.five_year_change_pct)}</span><span class="hpi-label">over five years</span></div>` : ''}</div>
<p class="hpi-note">FHFA all-transactions index, ${prices.latest}. An index of repeat sales, not a price. <a href="${prices.source.url}" rel="noopener">Source: ${prices.source.name}</a></p></aside>` : ''}
${records ? html`<aside class="homes-card"><h3>Property records in ${STATE_TITLE[place.state] || place.state}</h3><p>Owners, past sales, assessed values, taxes and deeds are kept by each county. <a href="${records}" target="_blank" rel="noopener nofollow">Find the county's assessor and recorder ↗</a></p></aside>` : ''}
<aside class="homes-card"><h3>What would it cost a month?</h3><p><a href="/mortgage${v.max ? `?price=${encodeURIComponent(v.max)}` : ''}">The mortgage calculator</a>: principal, interest, taxes, insurance and HOA.</p></aside>
<aside class="homes-card"><h3>Renting instead?</h3><p><a href="${config.baseUrl}/everywhere?${new URLSearchParams({ q: v.q || '' })}">Every rental site near ${place.city}</a>, and affordable housing from HUD, on OpenVibe.Rent.</p></aside>
</div></section>` : ''}`,
        }, limited ? 429 : 200);
    }
    r.get('/search', (req, res) => {
        if (!str(req.query.q)) return searchPage(req, res);
        let settled = false;
        let retryAfter = '60';
        const allowed = () => { if (!settled) { settled = true; searchPage(req, res); } };
        const refused = () => { if (settled) return; settled = true; res.set('Retry-After', retryAfter); searchPage(req, res, { limited: true }); };
        return budget(req, { statusCode: 200, setHeader: (k, val) => { if (String(k).toLowerCase() === 'retry-after') retryAfter = String(val); }, end: refused }, allowed);
    });

    // ── Property records ─────────────────────────────────────
    r.get('/records', (req, res) => {
        const chosen = /^[A-Z]{2}$/.test(String(req.query.state || '').toUpperCase()) ? String(req.query.state).toUpperCase() : null;
        const list = Object.keys(US_STATE_NAMES).sort((a, b) => STATE_TITLE[a].localeCompare(STATE_TITLE[b]));
        return page(req, res, {
            title: chosen && STATE_TITLE[chosen] ? `Property records in ${STATE_TITLE[chosen]}` : 'Property records, county by county',
            description: 'Owners, sales, assessed values, taxes and deeds: each US county\'s assessor and recorder sites, by state.',
            index: true, cache: PUBLIC_CACHE,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Property records' }],
            localStyles: ['css/homes.css'],
            body: html`<h1>Property records, county by county</h1>
<p class="sc-lede">In the United States each county keeps its own records: the <b>assessor</b> (owner, assessed value, property details), the <b>recorder</b> or clerk (deeds, mortgages, liens) and the <b>treasurer</b> (property taxes). Most are searchable online for free. Pick a state for its counties' official sites, listed by NETR Online.</p>
<ul class="homes-states">${list.map((st) => html`<li${st === chosen ? raw(' class="on"') : ''}><a href="${sites.recordsUrl(st)}" target="_blank" rel="noopener nofollow">${STATE_TITLE[st]}</a></li>`)}</ul>
<p class="small muted">The directory is NETR Online's (publicrecords.netronline.com); the records are each county's. OpenVibe.Homes copies none of them.</p>`,
        });
    });

    // ── Mortgage calculator ──────────────────────────────────
    r.get('/mortgage', (req, res) => {
        const q = req.query;
        const v = { price: str(q.price, 12), down: str(q.down, 5) || '20', rate: str(q.rate, 6), years: str(q.years, 2) || '30', tax: str(q.tax, 9), ins: str(q.ins, 9), hoa: str(q.hoa, 7) };
        const asked = Boolean(v.price && v.rate);
        const out = asked ? monthly({ price: v.price, downPercent: v.down, ratePercent: v.rate, years: Number(v.years), taxPerYear: v.tax, insurancePerYear: v.ins, hoaPerMonth: v.hoa }) : null;
        const field = (id, label, value, hint, attrs = '') => html`<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" inputmode="decimal" maxlength="12" value="${value || ''}" placeholder="${hint}"${raw(attrs)}></div>`;
        return page(req, res, {
            title: 'Mortgage calculator', description: 'The monthly cost of a fixed-rate mortgage: principal and interest, property tax, insurance and HOA.',
            index: !asked, cache: asked ? null : PUBLIC_CACHE,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Mortgage calculator' }],
            localStyles: ['css/everywhere.css', 'css/homes.css'],
            body: html`<h1>Mortgage calculator</h1>
<p class="sc-lede">A fixed-rate loan's monthly cost, worked out from the numbers you type. Nothing is saved or sent anywhere; the rate is yours to find (a lender's quote, or today's average).</p>
<form class="search-form homes-calc" method="get" action="/mortgage">
${field('price', 'Home price ($)', v.price, '450000', ' required')}
${field('down', 'Down payment (%)', v.down, '20')}
${field('rate', 'Interest rate (% a year)', v.rate, '6.5', ' required')}
<div class="field"><label for="years">Loan term</label><select id="years" name="years">${[30, 20, 15, 10].map((y) => html`<option value="${y}"${String(y) === v.years ? raw(' selected') : ''}>${y} years</option>`)}</select></div>
${field('tax', 'Property tax ($ a year)', v.tax, 'Optional')}
${field('ins', 'Home insurance ($ a year)', v.ins, 'Optional')}
${field('hoa', 'HOA ($ a month)', v.hoa, 'Optional')}
<p><button class="sc-btn sc-primary" type="submit">Work it out</button></p></form>
${out && out.error ? notice(out.error, 'warn') : ''}
${out && !out.error ? html`<section class="homes-result" aria-labelledby="h-result"><h2 id="h-result">About ${money(out.total)} a month</h2>
<table class="homes-table"><tbody>
<tr><th scope="row">Loan</th><td>${money(out.loan)}</td></tr>
<tr><th scope="row">Principal and interest</th><td>${money(out.principalAndInterest)}</td></tr>
${out.tax ? html`<tr><th scope="row">Property tax</th><td>${money(out.tax)}</td></tr>` : ''}
${out.insurance ? html`<tr><th scope="row">Insurance</th><td>${money(out.insurance)}</td></tr>` : ''}
${out.hoa ? html`<tr><th scope="row">HOA</th><td>${money(out.hoa)}</td></tr>` : ''}
<tr class="homes-total"><th scope="row">Each month</th><td>${money(out.total)}</td></tr>
<tr><th scope="row">Interest over ${out.payments} payments</th><td>${money(out.totalInterest)}</td></tr>
</tbody></table>
<p class="small muted">A down payment under 20 % usually adds mortgage insurance (PMI), which is not included. Lenders also charge closing costs. This is arithmetic, not a loan offer.</p></section>` : ''}`,
        });
    });

    // ── Crawlers ─────────────────────────────────────────────
    r.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(`User-agent: *\nDisallow: /search?\nAllow: /\nSitemap: ${base}/sitemap.xml\n`));
    r.get('/sitemap.xml', (req, res) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/search', '/records', '/mortgage'].map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>\n`));
    r.get('/llms.txt', (req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(`# OpenVibe.Homes\n\n> Buying a home in the United States: one search opens every for-sale site's own search (Zillow, Realtor.com, Redfin, Homes.com, Trulia, Craigslist), HUD Homestore, Fannie Mae HomePath and foreclosure auctions, with county property records and a mortgage calculator. Listings stay on those sites.\n\n- [Search every site](${base}/search)\n- [Property records by state](${base}/records)\n- [Mortgage calculator](${base}/mortgage)\n- [Renting: OpenVibe.Rent](${config.baseUrl}/everywhere)\n`));

    // The rest of the Homes host: not found here (assets, /shared and /auth are served before this router).
    r.use((req, res) => page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>No page here. <a href="/">OpenVibe.Homes</a>.</p>` }, 404));
    return r;
}

module.exports = { createHomesRoutes };
