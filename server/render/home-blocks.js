'use strict';

/**
 * The pieces OpenVibe.Rent's and OpenVibe.Homes' front pages share. A front page is a taste and a door, not the index
 * (the owner, 2026-10-28: "act more like an app, not a huge long web page"), so these are the shared kit's pieces
 * (openvibe-shared/kit: kit.css for the numbers and folds, room.css for the cards and rails) around the few things
 * each home draws itself (a ranked list, state chips; public/css/home.css). Each takes real rows only and renders
 * nothing when it has none, so a block never stands empty.
 */
const kit = require('openvibe-shared/kit');
const { html, raw, render } = require('./html');
const cities = require('../aggregate/cities');

/** The stylesheets a front page loads after app.css: the kit's controls and folds, then its cards and rails. */
const STYLES = ['kit.css', 'room.css'];

/** Counts that are true right now, as one strip (it scrolls sideways on a phone): [{ value, label, href? }]. */
const stats = (items, { label = 'In numbers' } = {}) => raw(kit.stats((items || []).filter(Boolean).map((i) => [i.value, i.label, i.href || null]), { label }));

/** The section wrapper a home block uses: an h2 with an id, a lede, the body. */
const section = (id, title, lede, body) => (render(body).trim()
    ? html`<section class="sc-sec" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${lede ? html`<p class="sc-lede">${lede}</p>` : ''}${body}</section>`
    : '');

/**
 * The largest cities as bars, the dearest first (2026-11-01): one look compares them, where a rail of cards drew the
 * same map icon twelve times. Each row is a link to its city: the name and state, a bar as long as its rent against
 * the dearest, and the figure. `value(c)` is the number the bar measures, `text(c)` how it reads; cities without a
 * value are left out (their pages say why).
 */
function cityBars({ id, title, more, list, value, text, href = (c) => c.path }) {
    const rows = (list || []).filter((c) => Number.isFinite(value(c)) && value(c) > 0).sort((a, b) => value(b) - value(a));
    if (!rows.length) return '';
    const max = value(rows[0]);
    return html`<div class="home-bars-head"><h2 id="h-${id}">${title}</h2>${more ? html`<a class="home-more" href="${more.href}">${more.label}</a>` : ''}</div>
<ol class="home-bars" aria-labelledby="h-${id}">${rows.map((c) => html`<li><a href="${href(c)}"><span class="hb-name">${c.name}<small>${c.state}</small></span><span class="hb-bar" aria-hidden="true"><i style="width:${Math.max(6, Math.round((value(c) / max) * 100))}%"></i></span><span class="hb-n">${text(c)}</span></a></li>`)}</ol>`;
}

/** A part read once, folded: the title says what is inside, `meta` how much. */
const fold = (id, title, meta, body) => (render(body).trim() ? raw(kit.fold({ id, title, meta, body: render(body) })) : '');

/** A numbered list of [{ name, href?, value }], for "lowest" and "highest" pairs side by side. */
function ranked(title, rows) {
    if (!rows.length) return '';
    return html`<div class="home-rank"><h3>${title}</h3><ol>${rows.map((r) => html`<li>${r.href ? html`<a href="${r.href}">${r.name}</a>` : r.name}<span class="hr-val">${r.value}</span></li>`)}</ol></div>`;
}

/** Every state with cities, as chips to its page. */
const stateChips = (prefix = '/in') => html`<ul class="home-chips">${cities.states().map((st) => html`<li><a href="${prefix}/${st.slug}">${st.name} <span>${st.count}</span></a></li>`)}</ul>`;

/** The sites a search opens, for the fold that names them: [{ name, host, best }]. */
const siteList = (list, note = '') => html`<ul class="home-sites">${list.map((x) => html`<li><b>${x.name}</b> <span>${x.host}</span><p>${x.best}</p></li>`)}</ul>${note ? html`<p class="small muted">${note}</p>` : ''}`;

/** The questions people ask (the product's own FAQ from openvibe-contracts), each a fold, readable without JS. */
const faq = (items) => (items || []).map((f) => raw(kit.fold({ title: f.question, body: render(html`<p>${f.answer}</p>`) })));

/**
 * The search a home opens with (kit.find): the place, what kind (a select inside the pill) and a round go button.
 * Price and bedrooms are on the results page, which keeps the place typed here.
 */
function search({ action, placeholder, label = 'Where', kinds, kindText, kind, kindLabel = 'Looking for', go }) {
    const select = html`<select name="kind" aria-label="${kindLabel}">${kinds.map((k) => html`<option value="${k}"${k === kind ? raw(' selected') : ''}>${kindText[k]}</option>`)}</select>`;
    return raw(kit.find({ action, name: 'q', placeholder, label, required: true, maxlength: 200, extra: render(select), button: { icon: 'forward', label: go }, id: 'home-q' }));
}

/** Up to two small doors under the search: [{ href, label }]. */
const doors = (list) => html`<p class="home-doors">${raw(list.slice(0, 2).map((d) => kit.button({ href: d.href, label: d.label, kind: 'quiet', small: true })).join(' '))}</p>`;

/** Cities with at least `min` people, largest first. */
const bigCities = (min) => cities.cities.filter((c) => c.population >= min).sort((a, b) => b.population - a.population);

module.exports = { STYLES, stats, section, cityBars, fold, ranked, stateChips, siteList, faq, search, doors, bigCities };
