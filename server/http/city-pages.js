'use strict';

/**
 * Rent by city: a page for every US place of 50,000 people or more (and each state's largest), what rent usually
 * costs there and every rental site's search for it, plus the fair-rent check (server/aggregate/cities.js, Census
 * ACS 5-year medians, public domain). The owner's Rent ask names "alerts and seo": these are the pages a person
 * searching "rent in Austin" lands on, and the check judges a price quoted on any site.
 *
 *   GET /in                     every state, and the largest cities with their typical 2-bedroom rent
 *   GET /in/:state              a state's cities and their typical rents by size
 *   GET /in/:state/:city        one city: typical rents, a fair-rent check, every site's search, what is here, nearby
 *   GET /fair                   is a rent fair? (city, bedrooms, monthly rent) → where it sits against the median
 *
 * Where HUD's Fair Market Rents are known for a city's area (server/housing/fair-market-rents.js, from OpenVibe.Sources),
 * the city page shows them beside the Census medians and the check names the one for that size.
 */

const seo = require('openvibe-shared/seo');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { html, raw } = require('../render/html');
const cities = require('../aggregate/cities');
const everywhere = require('../aggregate/everywhere');
const listings = require('../listings/listings');

const PUBLIC = cache.htmlHeaders({ maxAge: 3600 });
const STYLES = ['css/everywhere.css', 'css/cities.css'];
const HOMES_URL = 'https://openvibe.homes';

const source = () => html`<p class="small muted city-source">Median gross rent (rent plus the utilities the renter pays): half of rentals cost less, half more. <a href="${cities.SOURCE.url}" rel="noopener">${cities.SOURCE.name}</a>, ${cities.SOURCE.years} (public domain). The ± is the Census' 90% margin of error.</p>`;
const cell = (c, key) => {
    const v = cities.rentText(c.rent[key]);
    return v ? html`${v}${c.moe[key] && c.rent[key] < 3501 ? html` <span class="moe">±$${c.moe[key].toLocaleString('en-US')}</span>` : ''}` : html`<span class="muted">not published</span>`;
};
const placeLabel = (c) => `${c.name}, ${c.state}`;
const { HUD_URL } = require('../housing/fair-market-rents');
const { NOTE: CPI_NOTE, NATIONAL: CPI_NATIONAL } = require('../housing/rent-cpi');
const fmrText = (n) => (n == null ? null : `$${n.toLocaleString('en-US')}`);
/** What a Fair Market Rent is, under the city table (HUD's own definition and use, in short). */
const fmrSource = (area) => html`<p class="small muted city-source">HUD Fair Market Rent for the ${area.name}: what a modest rental there costs, rent plus essential utilities, by HUD's estimate. HUD sets them each October; Housing Choice Vouchers pay up to 90% to 110% of them. <a href="${HUD_URL}" rel="noopener">HUD</a> (public domain), through OpenVibe.Sources.</p>`;

/** A small line for a BLS CPI trend: one point per month, the last 13 at most. */
function trendSvg(trend, label) {
    const points = (trend && trend.points) || [];
    if (points.length < 2) return '';
    const values = points.map((p) => Number(p.value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const x = (i) => 4 + (i * 312) / (points.length - 1);
    const y = (v) => 60 - ((v - min) / span) * 56;
    const poly = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    return html`<svg class="rent-trend" viewBox="0 0 320 64" width="320" height="64" role="img" aria-label="${label}"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${poly}"/></svg>`;
}

/** The BLS trend lines a page shows: the national line and, where BLS publishes one, a city's metro line. */
function cpiBlock(cpi) {
    if (!cpi) return '';
    const lines = [cpi.national, cpi.metro].filter(Boolean).filter((t, i, all) => all.findIndex((x) => x.series === t.series) === i);
    if (!lines.length) return '';
    return html`<section class="sc-sec rent-cpi" aria-labelledby="h-cpi"><h2 id="h-cpi">Are rents rising?</h2>
${lines.map((t) => html`<div class="rent-cpi-line"><p>${t.text} <a href="${t.url}" rel="noopener">BLS series ${t.series}</a></p>${trendSvg(t, `Rent of primary residence CPI, ${t.area}, last 13 months`)}</div>`)}
<p class="small muted city-source">Rent of primary residence CPI from the <a href="${lines[0].url}" rel="noopener">U.S. Bureau of Labor Statistics</a> (public domain), through OpenVibe.Sources. ${CPI_NOTE}</p></section>`;
}

function mountCityPages(r, { config, page, fmr = null, rentCpi = null }) {
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const crumbsLd = (items) => seo.jsonLd.breadcrumbs(items.map((i) => ({ name: i.label, url: `${base()}${i.href}` })));

    const fairForm = (v = {}, { city = null } = {}) => html`<form class="search-form fair-form" method="get" action="/fair">
${city ? html`<input type="hidden" name="city" value="${city.state.toLowerCase()}/${city.slug}">` : html`<div class="field"><label for="fc">City</label><input id="fc" name="where" type="search" required maxlength="120" placeholder="City and state, e.g. Austin, TX" value="${v.where || ''}" autocomplete="address-level2"></div>`}
<div class="fair-row"><div class="field"><label for="fb">Bedrooms</label><select id="fb" name="beds">${cities.SIZES.map((s) => html`<option value="${s.beds}"${String(s.beds) === String(v.beds ?? 1) ? raw(' selected') : ''}>${s.text}</option>`)}</select></div>
<div class="field"><label for="fr">Monthly rent, $</label><input id="fr" name="rent" type="number" min="1" max="100000" step="1" inputmode="numeric" required placeholder="1500" value="${v.rent || ''}"></div></div>
<p><button class="sc-btn sc-primary" type="submit">Check the rent</button></p>
${city ? html`<p class="small muted fair-how">Within the Census' margin of the middle rent reads as typical; well below it can mean a scam, so never pay before you have seen the place.</p>` : ''}</form>`;

    // ── /in: every state ──
    r.get('/in', (req, res) => {
        const largest = [...cities.cities].sort((a, b) => b.population - a.population).slice(0, 30);
        const national = rentCpi ? rentCpi.forSeries(CPI_NATIONAL.series) : null;
        page(req, res, {
            title: 'Rent by city: typical rents across the US',
            description: `What rent usually costs in ${cities.cities.length} US cities, by number of bedrooms, from the Census Bureau, and every rental site's search for each city in one place.`,
            index: true, cache: PUBLIC, crumbs: [{ label: 'Home', href: '/' }, { label: 'Rent by city' }],
            jsonLd: [crumbsLd([{ label: 'OpenVibe.Rent', href: '/' }, { label: 'Rent by city', href: '/in' }])],
            styles: [showcase.STYLESHEET], localStyles: STYLES,
            body: html`<h1>Rent by city</h1>
<p class="sc-lede">What rent usually costs in ${cities.cities.length.toLocaleString('en-US')} US cities, by number of bedrooms, and every rental site's search for each city in one place. Pick a state, or <a href="/fair">check a rent you were quoted</a>.</p>
<ul class="state-grid">${cities.states().map((s) => html`<li><a href="/in/${s.slug}"><span class="state-name">${s.name}</span><span class="state-meta">${s.count} ${s.count === 1 ? 'city' : 'cities'} · ${s.largest.name}</span></a></li>`)}</ul>
<section class="sc-sec" aria-labelledby="h-big"><h2 id="h-big">The largest cities</h2>
<div class="table-wrap"><table class="city-table"><caption class="sr-only">Typical rents in the 30 largest US cities</caption>
<thead><tr><th scope="col">City</th><th scope="col">1 bedroom</th><th scope="col">2 bedrooms</th><th scope="col">3 bedrooms</th></tr></thead>
<tbody>${largest.map((c) => html`<tr><th scope="row"><a href="${c.path}">${placeLabel(c)}</a></th><td>${cell(c, 'b1')}</td><td>${cell(c, 'b2')}</td><td>${cell(c, 'b3')}</td></tr>`)}</tbody></table></div>
${source()}</section>${cpiBlock({ national, metro: null })}`,
        });
    });

    // ── /in/:state ──
    r.get('/in/:state', (req, res, next) => {
        const code = /^[a-z]{2}$/.test(req.params.state) ? req.params.state.toUpperCase() : null;
        const list = code ? cities.inState(code) : [];
        if (!list.length) return next();
        const name = cities.STATE_NAMES[code];
        page(req, res, {
            title: `Rent in ${name}: typical rents by city`,
            description: `What rent usually costs in ${list.length} ${name} ${list.length === 1 ? 'city' : 'cities'}, from a studio to three bedrooms, and every rental site's search for each one.`,
            index: true, cache: PUBLIC, crumbs: [{ label: 'Home', href: '/' }, { label: 'Rent by city', href: '/in' }, { label: name }],
            jsonLd: [crumbsLd([{ label: 'OpenVibe.Rent', href: '/' }, { label: 'Rent by city', href: '/in' }, { label: name, href: `/in/${code.toLowerCase()}` }])],
            styles: [showcase.STYLESHEET], localStyles: STYLES,
            body: html`<h1>Renting in ${name}</h1>
<p class="sc-lede">${list.length === 1 ? html`${list[0].name} is ${name}'s largest city` : html`${list.length} cities in ${name}, largest first`}: what rent usually costs, and a page for each with every rental site's search for it.</p>
<div class="table-wrap"><table class="city-table"><caption class="sr-only">Typical rents by city in ${name}</caption>
<thead><tr><th scope="col">City</th><th scope="col">Studio</th><th scope="col">1 bedroom</th><th scope="col">2 bedrooms</th><th scope="col">3 bedrooms</th></tr></thead>
<tbody>${list.map((c) => html`<tr><th scope="row"><a href="${c.path}">${c.name}</a></th><td>${cell(c, 'studio')}</td><td>${cell(c, 'b1')}</td><td>${cell(c, 'b2')}</td><td>${cell(c, 'b3')}</td></tr>`)}</tbody></table></div>
${source()}
<p><a href="/in">Every state</a> · <a href="/fair">Check a rent</a></p>`,
        });
    });

    // ── /in/:state/:city ──
    r.get('/in/:state/:city', (req, res, next) => {
        const c = cities.find(req.params.state, req.params.city);
        if (!c) return next();
        const where = placeLabel(c);
        const place = { city: c.name, state: c.state, country: 'us', lat: c.lat, lon: c.lon };
        const links = everywhere.linksFor(place, { kind: 'apartment' });
        const q = `${c.name}, ${c.state}`;
        const kindHref = (k) => `/everywhere?${new URLSearchParams({ q, kind: k })}`;
        const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
        const near = cities.nearby(c, 8);
        const two = cities.rentText(c.rent.b2);
        const area = fmr ? fmr.forCity(c) : null;
        const cpi = rentCpi ? rentCpi.trendForCity(c) : null;
        page(req, res, {
            title: `Rent in ${where}: typical rents and every rental site`,
            description: `${two ? `A typical 2-bedroom in ${where} rents for ${two} a month. ` : ''}Every rental site's search for ${c.name} in one place: Craigslist, Zillow, Apartments.com, Zumper and more, with typical rents by size and affordable housing nearby.`,
            index: true, cache: PUBLIC,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Rent by city', href: '/in' }, { label: c.stateName, href: `/in/${c.state.toLowerCase()}` }, { label: c.name }],
            jsonLd: [crumbsLd([{ label: 'OpenVibe.Rent', href: '/' }, { label: 'Rent by city', href: '/in' }, { label: c.stateName, href: `/in/${c.state.toLowerCase()}` }, { label: c.name, href: c.path }])],
            styles: [showcase.STYLESHEET], localStyles: STYLES,
            body: html`<h1>Renting in ${where}</h1>
<p class="sc-lede">Every rental site's search for ${c.name} in one place, what rent usually costs here, and a quick check for a price you were quoted.</p>
<div class="city-top">
<section class="rent-card" aria-labelledby="h-typical"><h2 id="h-typical">What rent costs in ${c.name}</h2>
${area ? html`<table class="rent-sizes rent-sizes-fmr"><caption class="sr-only">Median gross rent (Census) and HUD Fair Market Rent by size in ${where}</caption>
<thead><tr><td></td><th scope="col">Middle rent</th><th scope="col">HUD fair market</th></tr></thead><tbody>
${cities.SIZES.map((s) => html`<tr><th scope="row">${s.text}</th><td>${cell(c, s.key)}</td><td>${fmrText(area.rents[s.key]) || html`<span class="muted">—</span>`}</td></tr>`)}
<tr class="rent-all"><th scope="row">All rentals</th><td>${cell(c, 'all')}</td><td></td></tr></tbody></table>
${source()}${fmrSource(area)}` : html`<table class="rent-sizes"><caption class="sr-only">Median gross rent by size in ${where}</caption><tbody>
${cities.SIZES.map((s) => html`<tr><th scope="row">${s.text}</th><td>${cell(c, s.key)}</td></tr>`)}
<tr class="rent-all"><th scope="row">All rentals</th><td>${cell(c, 'all')}</td></tr></tbody></table>
${source()}`}</section>
<section class="fair-card" aria-labelledby="h-fair"><h2 id="h-fair">Is a rent fair?</h2><p class="small muted">Compare a price from any site with the middle rent in ${c.name}.</p>${fairForm({}, { city: c })}</section>
</div>
${cpiBlock(cpi)}
<section class="sc-sec" aria-labelledby="h-sites"><h2 id="h-sites">Apartments in ${c.name}, on every site</h2>
<ul class="everywhere-sites">${links.map((l) => html`<li class="ew-site"><a class="ew-open" href="${l.url}" target="_blank" rel="noopener nofollow"><span class="ew-name">${l.name}</span><span class="ew-host">${hostOf(l.url)} ↗</span></a><p class="ew-best">${l.best}</p></li>`)}</ul>
<nav class="everywhere-kinds" aria-label="Other things to rent in ${c.name}">${everywhere.KINDS.filter((k) => k !== 'apartment').map((k) => html`<a class="ew-kind" href="${kindHref(k)}">${everywhere.KIND_TEXT[k]}</a>`)}</nav>
<p class="small muted">Each link opens that site's own search for ${c.name} in a new tab. Never pay a deposit before you have seen a place (<a href="/safety">renting safely</a>).</p></section>
<section class="sc-sec" aria-labelledby="h-here"><h2 id="h-here">Also for ${c.name}</h2><ul class="everywhere-here">
<li><a href="/listings?${listings.filtersToQuery({ city: c.name, country: 'US' })}">Listings people posted on OpenVibe.Rent</a>, or <a href="/post">post your own</a></li>
<li><a href="/housing?${new URLSearchParams({ q })}">Affordable housing near ${c.name}</a>: public housing, tax-credit and HUD-assisted homes</li>
<li><a href="${HOMES_URL}${c.path}">Homes for sale in ${c.name}</a>${c.value != null ? html` (median value ${cities.valueText(c.value)})` : ''} on every for-sale site, through OpenVibe.Homes</li>
<li><a href="/board">Your board</a>: keep listings from every site in one list, with your notes</li></ul></section>
${near.length ? html`<section class="sc-sec" aria-labelledby="h-near"><h2 id="h-near">Nearby in ${c.stateName}</h2><ul class="city-chips">${near.map((n) => html`<li><a href="${n.path}"><span>${n.name}</span>${n.rent.b2 != null ? html`<span class="chip-rent">2 bd ${cities.rentText(n.rent.b2)}</span>` : ''}</a></li>`)}</ul></section>` : ''}`,
        });
    });

    // ── /fair ──
    r.get('/fair', (req, res) => {
        const v = { where: typeof req.query.where === 'string' ? req.query.where.slice(0, 120) : '', beds: req.query.beds, rent: typeof req.query.rent === 'string' ? req.query.rent.slice(0, 8) : '' };
        let city = null;
        if (typeof req.query.city === 'string' && /^[a-z]{2}\/[a-z0-9-]{1,80}$/.test(req.query.city)) { const [st, sl] = req.query.city.split('/'); city = cities.find(st, sl); }
        if (!city && v.where) city = cities.match(v.where);
        // Opened from a listing (the OpenVibe Companion's "Check the rent", or a link): what its address and title say
        // fills what the person did not type, and the page says which values were read so they can check them.
        let fromListing = null;
        if (typeof req.query.url === 'string' || typeof req.query.title === 'string') {
            fromListing = cities.readListing({ url: String(req.query.url || '').slice(0, 2000), title: String(req.query.title || '').slice(0, 300) });
            if (!v.rent && fromListing.rent) v.rent = String(fromListing.rent);
            if (v.beds == null && fromListing.beds != null) v.beds = String(fromListing.beds);
            if (!city && fromListing.city) city = fromListing.city;
        }
        const asked = Boolean(v.rent && (req.query.city || v.where || city));
        const result = asked && city ? cities.fair({ city, beds: v.beds, rent: v.rent }) : null;
        if (city && !v.where) v.where = placeLabel(city);
        const problem = asked && !city ? `No city of ${cities.MIN_POPULATION.toLocaleString('en-US')} people or more called “${v.where}” in the list. Try “City, ST”, or pick it from Rent by city.`
            : asked && !result ? 'The Census publishes no median for that size there. Try another number of bedrooms.' : null;
        page(req, res, {
            title: result ? `${result.size.text} at $${Number(v.rent).toLocaleString('en-US')} in ${placeLabel(city)}: is it fair?` : 'Is this rent fair?',
            description: 'Check a monthly rent from any site against the middle rent for that size in the city, from the Census Bureau\'s American Community Survey.',
            index: !asked && !fromListing, cache: asked || fromListing ? null : PUBLIC,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Rent by city', href: '/in' }, { label: 'Is this rent fair?' }],
            styles: [showcase.STYLESHEET], localStyles: STYLES,
            body: html`<h1>Is this rent fair?</h1>
<p class="sc-lede">Put in a price from Craigslist, Zillow or anywhere else: it is compared with the middle rent for that size in the city, from the Census Bureau.</p>
${fromListing ? html`<p class="notice" role="status">${fromListing.read.length ? html`Read from the listing: ${fromListing.read.map((k) => ({ rent: `the rent ($${Number(v.rent).toLocaleString('en-US')})`, beds: `${Number(v.beds) === 0 ? 'a studio' : `${v.beds} bedroom${Number(v.beds) === 1 ? '' : 's'}`}`, city: `the city (${city ? `${city.name}, ${city.state}` : ''})` }[k])).join(', ')}. Check them below${fromListing.read.length < 3 ? ' and fill in the rest' : ''}.` : 'The listing\'s page did not say its rent, size and city plainly: fill them in below.'}</p>` : ''}
${result ? fairResult(city, result, Number(v.rent)) : ''}
${problem && !(fromListing && !v.rent) ? html`<p class="notice warn" role="status">${problem}</p>` : ''}
<section class="fair-card fair-page">${fairForm(v)}</section>
${source()}`,
        });
    });

    /** The verdict and a bar: the middle rent with its margin, and where the asked rent falls. */
    function fairResult(city, f, rent) {
        const area = fmr ? fmr.forCity(city) : null;
        const cpi = rentCpi ? rentCpi.trendForCity(city) : null;
        const max = Math.max(rent, f.median) * 1.35;
        const pct = (n) => Math.max(0, Math.min(100, (n / max) * 100)).toFixed(1);
        const lo = Math.max(0, f.median - f.moe); const hi = f.median + f.moe;
        return html`<section class="fair-result verdict-${f.verdict}" aria-labelledby="h-verdict" role="status">
<h2 id="h-verdict">${{ typical: 'About typical', low: 'Below typical', 'very-low': 'Well below typical', high: 'Above typical', 'very-high': 'Well above typical', 'high-end': 'In the high-end range' }[f.verdict]}</h2>
<p>${f.text}</p>
<div class="fair-bar" aria-hidden="true"><span class="fair-band" style="left:${pct(lo)}%;width:${(pct(hi) - pct(lo)).toFixed(1)}%"></span><span class="fair-median" style="left:${pct(f.median)}%"></span><span class="fair-you" style="left:${pct(rent)}%"></span></div>
<p class="fair-legend small"><span class="lg lg-median"></span> Middle rent ${f.topped ? '$3,500 or more' : `$${f.median.toLocaleString('en-US')}`}${f.moe && !f.topped ? ` (±$${f.moe.toLocaleString('en-US')})` : ''} <span class="lg lg-you"></span> This rent $${rent.toLocaleString('en-US')}</p>
${area && fmrText(area.rents[f.size.key]) ? html`<p class="small">HUD's Fair Market Rent for ${f.size.long} in the ${area.name} is ${fmrText(area.rents[f.size.key])} a month, rent plus essential utilities: the figure a Housing Choice Voucher is measured against.</p>` : ''}
${cpi && cpi.text ? html`<p class="small">${cpi.text} <a href="${cpi.url}" rel="noopener">BLS series ${cpi.series}</a>.</p>` : ''}
<p class="small"><a href="${city.path}">Typical rents and every rental site in ${city.name}</a></p>
</section>`;
    }
}

/**
 * The fair-rent line for a listing posted here, when it can be judged: a US monthly rent in dollars for an apartment or
 * house with a bedroom count, in a city on the list (its region naming the state). → html or ''.
 */
function listingFairLine(row) {
    if (!row || String(row.country || '').toUpperCase() !== 'US' || row.currency !== 'USD' || row.period !== 'month' || !['apartment', 'house'].includes(row.kind) || row.bedrooms == null) return '';
    const st = cities.stateCode(row.region);
    const city = st ? cities.match(`${row.city}, ${st}`) : null;
    const f = city ? cities.fair({ city, beds: row.bedrooms, rent: row.price }) : null;
    return f ? html`<p class="fair-line verdict-${f.verdict}">${f.text} <a href="${city.path}">Rents in ${city.name}</a></p>` : '';
}

module.exports = { mountCityPages, listingFairLine };
