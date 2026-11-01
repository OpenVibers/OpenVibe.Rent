'use strict';

/**
 * Homes by city on OpenVibe.Homes: the buying side of Rent's city pages (server/http/city-pages.js), from the same
 * Census data (server/aggregate/cities.js: the median value of owner-occupied homes, B25077, beside the median rents).
 * The owner's ask was the homes version of openvibe.rent, interconnected: each city page links its Rent twin and back.
 *
 *   GET /in                     every state, and the largest cities with their median home value
 *   GET /in/:state              a state's cities: median home value and the typical 2-bedroom rent
 *   GET /in/:state/:city        one city: the median value, the FHFA trend, what a typical home costs a month (the
 *                               calculator, with the person's own rate), renting there instead, every for-sale site,
 *                               the county records, nearby cities
 */

const seo = require('openvibe-shared/seo');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { html } = require('../render/html');
const cities = require('../aggregate/cities');
const sites = require('./sites');
const housingHpi = require('../housing/hpi');

const PUBLIC = cache.htmlHeaders({ maxAge: 3600 });
const STYLES = ['css/everywhere.css', 'css/housing.css', 'css/homes.css', 'css/cities.css'];

const valueCell = (c) => {
    const v = cities.valueText(c.value);
    return v ? html`${v}${c.valueMoe && c.value < 2000001 ? html` <span class="moe">±$${c.valueMoe.toLocaleString('en-US')}</span>` : ''}` : html`<span class="muted">not published</span>`;
};
const source = () => html`<p class="small muted city-source">Median value of owner-occupied homes (the owners' own estimate of what their home would sell for), and median gross rent. <a href="${cities.SOURCE.url}" rel="noopener">${cities.SOURCE.name}</a>, ${cities.SOURCE.years} (public domain). The ± is the Census' 90% margin of error.</p>`;
/** A figure's source in the figure's own card, never a footnote (market outcome 5): who, which table, which years. */
const sourceLine = (what) => html`<p class="fig-src"><a href="${cities.SOURCE.url}" rel="noopener">${cities.SOURCE.name.replace('U.S. Census Bureau, ', 'Census ')}</a>, ${cities.SOURCE.years}${what ? html` · ${what}` : ''}</p>`;
const pct = (n) => { const x = Math.round(n * 10) / 10; return `${x > 0 ? '+' : ''}${x.toFixed(1)} %`; };

function mountHomesCityPages(r, { config, s, page }) {
    const base = String(config.homes.url).replace(/\/+$/, '');
    const rentBase = String(config.baseUrl).replace(/\/+$/, '');
    const crumbsLd = (items) => seo.jsonLd.breadcrumbs(items.map((i) => ({ name: i.label, url: `${base}${i.href}` })));
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

    r.get('/in', (req, res) => {
        const largest = [...cities.cities].sort((a, b) => b.population - a.population).slice(0, 30);
        page(req, res, {
            title: 'Home values by city across the US',
            description: `The median home value in ${cities.cities.length} US cities from the Census Bureau, and every for-sale site's search for each city in one place.`,
            index: true, cache: PUBLIC, crumbs: [{ label: 'Home', href: '/' }, { label: 'Homes by city' }],
            jsonLd: [crumbsLd([{ label: 'OpenVibe.Homes', href: '/' }, { label: 'Homes by city', href: '/in' }])],
            styles: [showcase.STYLESHEET], localStyles: STYLES,
            body: html`<h1>Homes by city</h1>
<p class="sc-lede">What homes are worth in ${cities.cities.length.toLocaleString('en-US')} US cities, and every for-sale site's search for each one in one place. Pick a state.</p>
<ul class="state-grid">${cities.states().map((st) => html`<li><a href="/in/${st.slug}"><span class="state-name">${st.name}</span><span class="state-meta">${st.count} ${st.count === 1 ? 'city' : 'cities'} · ${st.largest.name}</span></a></li>`)}</ul>
<section class="sc-sec" aria-labelledby="h-big"><h2 id="h-big">The largest cities</h2>
<div class="table-wrap"><table class="city-table"><caption class="sr-only">Median home value and typical 2-bedroom rent in the 30 largest US cities</caption>
<thead><tr><th scope="col">City</th><th scope="col">Median home value</th><th scope="col">2-bedroom rent</th></tr></thead>
<tbody>${largest.map((c) => html`<tr><th scope="row"><a href="${c.path}">${c.name}, ${c.state}</a></th><td data-label="Median home value">${valueCell(c)}</td><td data-label="2-bedroom rent">${cities.rentText(c.rent.b2) || html`<span class="muted">not published</span>`}</td></tr>`)}</tbody></table></div>
${source()}</section>`,
        });
    });

    r.get('/in/:state', (req, res, next) => {
        const code = /^[a-z]{2}$/.test(req.params.state) ? req.params.state.toUpperCase() : null;
        const list = code ? cities.inState(code) : [];
        if (!list.length) return next();
        const name = cities.STATE_NAMES[code];
        page(req, res, {
            title: `Home values in ${name} by city`,
            description: `The median home value in ${list.length} ${name} ${list.length === 1 ? 'city' : 'cities'}, beside the typical rent, with every for-sale site's search for each one.`,
            index: true, cache: PUBLIC, crumbs: [{ label: 'Home', href: '/' }, { label: 'Homes by city', href: '/in' }, { label: name }],
            jsonLd: [crumbsLd([{ label: 'OpenVibe.Homes', href: '/' }, { label: 'Homes by city', href: '/in' }, { label: name, href: `/in/${code.toLowerCase()}` }])],
            styles: [showcase.STYLESHEET], localStyles: STYLES,
            body: html`<h1>Buying a home in ${name}</h1>
<p class="sc-lede">${list.length === 1 ? html`${list[0].name} is ${name}'s largest city` : html`${list.length} cities in ${name}, largest first`}: what homes are worth, what renting costs, and a page for each with every for-sale site's search.</p>
<div class="table-wrap"><table class="city-table"><caption class="sr-only">Median home value and typical rent by city in ${name}</caption>
<thead><tr><th scope="col">City</th><th scope="col">Median home value</th><th scope="col">2-bedroom rent</th></tr></thead>
<tbody>${list.map((c) => html`<tr><th scope="row"><a href="${c.path}">${c.name}</a></th><td data-label="Median home value">${valueCell(c)}</td><td data-label="2-bedroom rent">${cities.rentText(c.rent.b2) || html`<span class="muted">not published</span>`}</td></tr>`)}</tbody></table></div>
${source()}
<p><a href="/in">Every state</a> · <a href="/records">Property records</a> · <a href="/mortgage">Mortgage calculator</a></p>`,
        });
    });

    // Homes' router is a plain express Router: an async handler hands its failures to next() itself.
    r.get('/in/:state/:city', (req, res, next) => cityPage(req, res, next).catch(next));
    async function cityPage(req, res, next) {
        const c = cities.find(req.params.state, req.params.city);
        if (!c) return next();
        const where = `${c.name}, ${c.state}`;
        const q = where;
        const links = sites.linksFor({ city: c.name, state: c.state, country: 'us' }, { kind: 'home' });
        let prices = null;
        if (config.hpi && config.hpi.enabled) { try { prices = await housingHpi.areaPricesFor(s, { city: c.name, state: c.state }); } catch { prices = null; } }
        const value = cities.valueText(c.value);
        const two = cities.rentText(c.rent.b2);
        const near = cities.nearby(c, 8);
        const calc = c.value && c.value < 2000001 ? `/mortgage?${new URLSearchParams({ price: String(c.value), down: '20' })}` : '/mortgage';
        page(req, res, {
            title: `Homes for sale in ${where}: home values and every site`,
            description: `${value ? `The median home in ${where} is worth ${value}. ` : ''}Every for-sale site's search for ${c.name} in one place: Zillow, Realtor.com, Homes.com, Trulia and more, with county records and the mortgage on a typical home.`,
            index: true, cache: PUBLIC,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Homes by city', href: '/in' }, { label: c.stateName, href: `/in/${c.state.toLowerCase()}` }, { label: c.name }],
            jsonLd: [crumbsLd([{ label: 'OpenVibe.Homes', href: '/' }, { label: 'Homes by city', href: '/in' }, { label: c.stateName, href: `/in/${c.state.toLowerCase()}` }, { label: c.name, href: c.path }])],
            styles: [showcase.STYLESHEET], localStyles: STYLES,
            body: html`<h1>Buying a home in ${where}</h1>
<p class="sc-lede">Every for-sale site's search for ${c.name} in one place, what homes here are worth, and what renting costs instead.</p>
<div class="homes-cards city-homes-cards">
<aside class="homes-card value-card"><h3>Median home value</h3><p class="value-num">${valueCell(c)}</p><p class="small muted">Half of the owner-occupied homes in ${c.name} are worth less, half more, by their owners' own estimate.</p>${sourceLine(c.valueMoe ? 'the ± is its 90% margin of error' : 'table B25077')}</aside>
${prices ? html`<aside class="hpi-card"><h3 class="hpi-title">Home prices around ${prices.place}</h3><div class="hpi-stats">${prices.year_change_pct != null ? html`<div class="hpi-stat"><span class="hpi-num${prices.year_change_pct < 0 ? ' hpi-down' : ''}">${pct(prices.year_change_pct)}</span><span class="hpi-label">over the past year</span></div>` : ''}${prices.five_year_change_pct != null ? html`<div class="hpi-stat"><span class="hpi-num${prices.five_year_change_pct < 0 ? ' hpi-down' : ''}">${pct(prices.five_year_change_pct)}</span><span class="hpi-label">over five years</span></div>` : ''}</div>
<p class="hpi-note">FHFA all-transactions index, ${prices.latest}. An index of repeat sales, not a price. <a href="${prices.source.url}" rel="noopener">Source: ${prices.source.name}</a></p></aside>` : ''}
<aside class="homes-card"><h3>What would it cost a month?</h3><p><a href="${calc}">Work out the mortgage on ${value && c.value < 2000001 ? `a ${value} home` : 'a home'}</a> with 20% down: put in your own rate, taxes and insurance.</p></aside>
<aside class="homes-card"><h3>Renting instead?</h3><p>${two ? html`A typical 2-bedroom in ${c.name} rents for ${two} a month. ` : ''}<a href="${rentBase}${c.path}">Rents and every rental site in ${c.name}</a> on OpenVibe.Rent.</p>${two ? sourceLine('median gross rent, rent plus utilities') : ''}</aside>
</div>
<section class="sc-sec" aria-labelledby="h-sites"><h2 id="h-sites">Homes for sale in ${c.name}, on every site</h2>
<ul class="everywhere-sites">${links.map((l) => html`<li class="ew-site"><a class="ew-open" href="${l.url}" target="_blank" rel="noopener nofollow"><span class="ew-name">${l.name}</span><span class="ew-host">${hostOf(l.url)} ↗</span></a><p class="ew-best">${l.best}</p></li>`)}</ul>
<nav class="everywhere-kinds" aria-label="Other things to buy in ${c.name}">${sites.KINDS.filter((k) => k !== 'home').map((k) => html`<a class="ew-kind" href="/search?${new URLSearchParams({ q, kind: k })}">${sites.KIND_TEXT[k]}</a>`)}</nav>
<p class="homes-nofee"><b>Nobody pays us for these links, and we sell no leads.</b> Each opens that site's own search for ${c.name} in a new tab; offers, inspections and payments happen with the seller or an agent there.</p></section>
<section class="sc-sec" aria-labelledby="h-records"><h2 id="h-records">Records and next steps</h2><ul class="everywhere-here">
<li><a href="${sites.recordsUrl(c.state)}" target="_blank" rel="noopener nofollow">The county assessor and recorder in ${c.stateName} ↗</a>: owners, past sales, assessed values, taxes and deeds</li>
<li><a href="${rentBase}/board">Your board</a> on OpenVibe.Rent: keep homes from every site in one list, with your notes</li></ul></section>
${near.length ? html`<section class="sc-sec" aria-labelledby="h-near"><h2 id="h-near">Nearby in ${c.stateName}</h2><ul class="city-chips">${near.map((n) => html`<li><a href="${n.path}"><span>${n.name}</span>${n.value != null ? html`<span class="chip-rent">${cities.valueText(n.value)}</span>` : ''}</a></li>`)}</ul></section>` : ''}`,
        });
    }
}

/** Every Homes-by-city page, for the Homes sitemap. */
const cityPaths = () => ['/in', ...cities.states().map((st) => `/in/${st.slug}`), ...cities.cities.map((c) => c.path)];

module.exports = { mountHomesCityPages, cityPaths };
