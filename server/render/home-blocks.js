'use strict';

/**
 * The pieces OpenVibe.Rent's and OpenVibe.Homes' home pages share (public/css/home.css): a row of counts, city cards,
 * a ranked list, state chips and the questions people ask. Each takes real rows only and renders nothing when it has
 * none, so a section never stands empty.
 */
const { html, render } = require('./html');
const cities = require('../aggregate/cities');

/** Counts that are true right now: [{ value, label, href? }]; an item without a value is left out. */
function stats(items, { label = 'In numbers' } = {}) {
    const real = (items || []).filter((i) => i && i.value != null && i.value !== '' && i.value !== 0);
    if (!real.length) return '';
    return html`<ul class="home-stats" aria-label="${label}">${real.map((i) => html`<li>${i.href ? html`<a href="${i.href}"><b>${i.value}</b><span>${i.label}</span></a>` : html`<b>${i.value}</b><span>${i.label}</span>`}</li>`)}</ul>`;
}

/** The section wrapper every home block uses: an h2 with an id, a lede, the body. */
const section = (id, title, lede, body) => (render(body).trim()
    ? html`<section class="sc-sec" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${lede ? html`<p class="sc-lede">${lede}</p>` : ''}${body}</section>`
    : '');

/**
 * City cards: the name, the headline number and a smaller line under it. `pick(c)` → { main, mainLabel, sub }.
 * `href(c)` is where the card goes (the city page by default).
 */
function cityCards(list, pick, { href = (c) => c.path } = {}) {
    if (!list.length) return '';
    return html`<ul class="home-cities">${list.map((c) => {
        const p = pick(c);
        return html`<li><a href="${href(c)}"><span class="hc-name">${c.name}<span class="hc-state">${c.state}</span></span><span class="hc-main"><b>${p.main || 'not published'}</b> <span>${p.mainLabel}</span></span>${p.sub ? html`<span class="hc-sub">${p.sub}</span>` : ''}</a></li>`;
    })}</ul>`;
}

/** A numbered list of [{ name, href?, value, note? }], for "lowest" and "highest" pairs side by side. */
function ranked(title, rows) {
    if (!rows.length) return '';
    return html`<div class="home-rank"><h3>${title}</h3><ol>${rows.map((r) => html`<li>${r.href ? html`<a href="${r.href}">${r.name}</a>` : r.name}<span class="hr-val">${r.value}</span></li>`)}</ol></div>`;
}

/** Every state with cities, as chips to its page. */
const stateChips = (prefix = '/in') => html`<ul class="home-chips">${cities.states().map((st) => html`<li><a href="${prefix}/${st.slug}">${st.name} <span>${st.count}</span></a></li>`)}</ul>`;

/** The questions people ask (the product's own FAQ from openvibe-contracts), open on click, readable without JS. */
function faq(items) {
    if (!items || !items.length) return '';
    return html`<div class="home-faq">${items.map((f) => html`<details><summary>${f.question}</summary><p>${f.answer}</p></details>`)}</div>`;
}

/** Cities with at least `min` people, largest first. */
const bigCities = (min) => cities.cities.filter((c) => c.population >= min).sort((a, b) => b.population - a.population);

module.exports = { stats, section, cityCards, ranked, stateChips, faq, bigCities };
