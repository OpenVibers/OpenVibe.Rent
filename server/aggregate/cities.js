'use strict';

/**
 * US cities with their typical rents (server/data/cities.json, built by tools/build-cities.js from the Census Bureau's
 * American Community Survey 5-year estimates, public domain): the city pages (/in/<state>/<city>), the state pages
 * and the fair-rent check (/fair). Read once at start-up; nothing is fetched.
 *
 *   find(state, slug)        one city, or null
 *   inState(state)           a state's cities, largest first
 *   states()                 [{ code, name, slug, count, largest }] alphabetically
 *   nearby(city, n)          the n nearest other cities in its state
 *   match(text)              "Austin, TX" / "austin tx" / "Austin" → the best city, or null
 *   fair({ city, beds, rent })  where a monthly rent sits against the city's median gross rent for that size
 */

const DATA = require('../data/cities.json');

const STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
    DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
    NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};
// What a bedroom count is called on the pages; `studio` is the Census' "no bedroom".
const SIZES = [
    { key: 'studio', beds: 0, text: 'Studio', long: 'a studio', plural: 'studio rentals' },
    { key: 'b1', beds: 1, text: '1 bedroom', long: 'a 1-bedroom', plural: '1-bedroom rentals' },
    { key: 'b2', beds: 2, text: '2 bedrooms', long: 'a 2-bedroom', plural: '2-bedroom rentals' },
    { key: 'b3', beds: 3, text: '3 bedrooms', long: 'a 3-bedroom', plural: '3-bedroom rentals' },
    { key: 'b4', beds: 4, text: '4 bedrooms', long: 'a 4-bedroom', plural: '4-bedroom rentals' },
    { key: 'b5', beds: 5, text: '5 or more', long: 'a 5-bedroom or larger', plural: 'rentals with 5 or more bedrooms' },
];
const TOP = 3501;

const cities = DATA.cities.map((c) => ({ ...c, stateName: STATE_NAMES[c.state] || c.state, path: `/in/${c.state.toLowerCase()}/${c.slug}` }));
const byKey = new Map(cities.map((c) => [`${c.state}/${c.slug}`, c]));
const byState = new Map();
for (const c of cities) { if (!byState.has(c.state)) byState.set(c.state, []); byState.get(c.state).push(c); }
for (const list of byState.values()) list.sort((a, b) => b.population - a.population);

const norm = (v) => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stateCode = (v) => {
    const t = String(v || '').trim();
    if (/^[A-Za-z]{2}$/.test(t) && STATE_NAMES[t.toUpperCase()]) return t.toUpperCase();
    const n = norm(t);
    return Object.keys(STATE_NAMES).find((k) => norm(STATE_NAMES[k]) === n) || null;
};

function find(state, slug) {
    const st = stateCode(state);
    return st ? byKey.get(`${st}/${String(slug || '').toLowerCase()}`) || null : null;
}
const inState = (state) => byState.get(stateCode(state)) || [];
function states() {
    return Object.keys(STATE_NAMES).filter((k) => byState.has(k)).map((k) => ({ code: k, name: STATE_NAMES[k], slug: k.toLowerCase(), count: byState.get(k).length, largest: byState.get(k)[0] }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function distanceKm(a, b) {
    if (a.lat == null || b.lat == null) return Infinity;
    const r = Math.PI / 180;
    const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
    const y = (b.lat - a.lat) * r;
    return Math.sqrt(x * x + y * y) * 6371;
}
const nearby = (city, n = 6) => inState(city.state).filter((c) => c !== city).map((c) => ({ c, d: distanceKm(city, c) })).sort((a, b) => a.d - b.d).slice(0, n).map((x) => x.c);

/** "Austin, TX", "austin tx", "Salt Lake City, Utah" or a lone name (the largest place of that name). */
function match(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 120) return null;
    const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
    let name = parts[0]; let st = parts.length > 1 ? stateCode(parts[parts.length - 1]) : null;
    if (!st) {
        const m = /^(.*)\s+([A-Za-z]{2})$/.exec(t.replace(/,/g, ' ').trim());
        if (m && stateCode(m[2])) { name = m[1]; st = stateCode(m[2]); }
    }
    const n = norm(name);
    const pool = st ? inState(st) : cities;
    return pool.find((c) => norm(c.name) === n) || null;
}

const moneyText = (n) => `$${Number(n).toLocaleString('en-US')}`;
/** "$1,845" or "$3,500 or more" (the Census top code). */
const rentText = (n) => (n == null ? null : n >= TOP ? '$3,500 or more' : moneyText(n));
/** A median home value: "$555,300", or "$2,000,000 or more" (the Census top code). */
const valueText = (n) => (n == null ? null : n >= 2000001 ? '$2,000,000 or more' : moneyText(n));

/**
 * Where `rent` (dollars a month) sits for `beds` bedrooms in `city`: the median and its margin of error, the
 * difference, and a plain verdict. The margin is the Census' 90 % one: within it, the rent is "about typical".
 * → { size, median, moe, diff, pct, verdict, text } or null when the Census has no median for that size.
 */
function fair({ city, beds, rent }) {
    const size = SIZES.find((s) => s.beds === Math.min(5, Math.max(0, Math.floor(Number(beds))))) || null;
    const amount = Math.round(Number(rent));
    if (!city || !size || !Number.isFinite(amount) || amount <= 0 || amount > 100000) return null;
    const median = city.rent[size.key];
    if (median == null) return null;
    const moe = city.moe[size.key] || 0;
    const topped = median >= TOP;
    const diff = amount - median;
    const pct = Math.round((diff / median) * 100);
    let verdict;
    if (topped && amount >= TOP) verdict = 'high-end';
    else if (Math.abs(diff) <= Math.max(moe, median * 0.05)) verdict = 'typical';
    else if (diff < 0) verdict = pct <= -25 ? 'very-low' : 'low';
    else verdict = topped ? 'high-end' : pct >= 25 ? 'very-high' : 'high';
    const where = `${city.name}, ${city.state}`;
    const typical = topped ? `$3,500 or more` : moneyText(median);
    const text = {
        typical: `${moneyText(amount)} is about typical for ${size.long} in ${where}, where the middle rent is ${typical}.`,
        low: `${moneyText(amount)} is ${Math.abs(pct)}% below the middle rent for ${size.long} in ${where} (${typical}).`,
        'very-low': `${moneyText(amount)} is ${Math.abs(pct)}% below the middle rent for ${size.long} in ${where} (${typical}). A price this low can be a scam: never pay before you have seen the place.`,
        high: `${moneyText(amount)} is ${pct}% above the middle rent for ${size.long} in ${where} (${typical}).`,
        'very-high': `${moneyText(amount)} is ${pct}% above the middle rent for ${size.long} in ${where} (${typical}).`,
        'high-end': `Half of ${size.plural} in ${where} cost $3,500 or more a month, so ${moneyText(amount)} is within the range the Census reports there.`,
    }[verdict];
    return { size, median, moe, diff, pct, verdict, text, topped };
}

module.exports = { SOURCE: DATA.source, MIN_POPULATION: DATA.minPopulation, SIZES, STATE_NAMES, cities, find, inState, states, nearby, match, fair, rentText, valueText, stateCode, distanceKm };

/**
 * What a rental listing's own address and title say, for /fair opened from the OpenVibe Companion ("Check the rent"):
 * the monthly rent (the first $ amount from $100 to $100,000), the bedrooms ("2br", "2 bd", "3 bedrooms", "studio")
 * and the city (a Craigslist city subdomain; "…-austin-tx…" in a Zillow, Apartments.com, Zumper or Trulia address;
 * "Austin, TX" in the title). Only what is plainly there: anything else is left for the person to fill in.
 *   → { rent, beds, city, read: ['rent', 'beds', 'city'] (what was found) }
 */
function readListing({ url, title } = {}) {
    const t = String(title || '').replace(/\s+/g, ' ').slice(0, 300);
    const out = { rent: null, beds: null, city: null, read: [] };
    const money = /\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{2})?(?!\d)/.exec(t);
    if (money) { const n = Number(money[1].replace(/,/g, '')); if (n >= 100 && n <= 100000) { out.rent = n; out.read.push('rent'); } }
    const beds = /\b(\d{1,2})\s*(?:br|bd|bds|bed|beds|bedrooms?)\b/i.exec(t);
    if (beds && Number(beds[1]) <= 20) { out.beds = Number(beds[1]); out.read.push('beds'); } else if (/\bstudio\b/i.test(t)) { out.beds = 0; out.read.push('beds'); }
    let u = null;
    try { u = new URL(String(url || '')); } catch { u = null; }
    if (u && /^https?:$/.test(u.protocol)) {
        const host = u.hostname.toLowerCase();
        const cl = /^([a-z]+)\.craigslist\.org$/.exec(host);
        if (cl) out.city = cities.find((c) => c.slug.replace(/-/g, '') === cl[1]) || null;
        if (!out.city) {
            // "…-salt-lake-city-ut-84111…" or "…/the-bowie-austin-tx/…": the longest run of words before a state code that names a listed city.
            const words = decodeURIComponent(u.pathname).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            for (let i = words.length - 1; i > 0 && !out.city; i--) {
                const st = /^[a-z]{2}$/.test(words[i]) ? stateCode(words[i]) : null;
                if (!st) continue;
                for (let k = Math.min(4, i); k >= 1 && !out.city; k--) out.city = find(st, words.slice(i - k, i).join('-'));
            }
        }
    }
    if (!out.city) {
        const named = /([A-Z][A-Za-z.' -]{1,40}),\s*([A-Z]{2})\b/.exec(t);
        if (named) out.city = match(`${named[1].trim()}, ${named[2]}`);
    }
    if (out.city) out.read.push('city');
    return out;
}

module.exports.readListing = readListing;
