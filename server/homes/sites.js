'use strict';

/**
 * OpenVibe.Homes: buying, the way OpenVibe.Rent does renting. One place and a few filters open every major for-sale
 * site's own search for it, plus the government and bank-owned homes (HUD Homestore, Fannie Mae HomePath, Auction.com)
 * and the county's own property records. The listings stay on each site; nothing is fetched or copied from them.
 *
 * URL forms were opened in a real headless Chromium on 2026-10-15 (tools/rent-links-check.js) for Salt Lake City and
 * Portland: Craigslist (real estate for sale), HUD Homestore, Auction.com (by state), HomePath, Redfin (by ZIP) and
 * NETR Online answered with results; Zillow, Realtor.com, Homes.com, Trulia, LandWatch and LoopNet stop headless
 * browsers at a bot wall, and these are their public, long-standing addresses that open normally for a person.
 * Left out: Redfin by city name (its city pages need Redfin's own id), Xome (no address form that works).
 *
 *   KINDS        home | land | foreclosure | commercial
 *   linksFor(place, { kind, maxPrice, minBeds }) → [{ id, name, url, best }]   (US places; place.state a two-letter code)
 *   recordsUrl(state) → NETR Online's directory of that state's county assessors and recorders
 */
const { US_STATE_NAMES, slug, titleSlug } = require('../aggregate/everywhere');

const KINDS = ['home', 'land', 'foreclosure', 'commercial'];
const KIND_TEXT = { home: 'Homes for sale', land: 'Land', foreclosure: 'Foreclosures and government homes', commercial: 'Commercial property' };

const q = (params) => {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') out.set(k, String(v));
    const s = out.toString();
    return s ? `?${s}` : '';
};

const SITES = [
    { id: 'zillow', name: 'Zillow', host: 'zillow.com', kinds: ['home'], best: 'The largest US listing database, with Zestimates and price history.',
        build: (p) => `https://www.zillow.com/${slug(p.city)}-${p.state.toLowerCase()}/` },
    { id: 'realtor', name: 'Realtor.com', host: 'realtor.com', kinds: ['home'], best: 'Listings straight from the agents\' MLS feeds, updated often.',
        build: (p, f) => `https://www.realtor.com/realestateandhomes-search/${titleSlug(p.city)}_${p.state}${f.minBeds ? `/beds-${f.minBeds}` : ''}${f.maxPrice ? `/price-na-${f.maxPrice}` : ''}` },
    { id: 'redfin', name: 'Redfin', host: 'redfin.com', kinds: ['home'], best: 'MLS listings with its own agents and quick tour booking.',
        build: (p) => (/^\d{5}$/.test(String(p.postcode || '')) ? `https://www.redfin.com/zipcode/${p.postcode}` : null) },
    { id: 'homes', name: 'Homes.com', host: 'homes.com', kinds: ['home'], best: 'Agent listings with school and neighbourhood details.',
        build: (p) => `https://www.homes.com/${slug(p.city)}-${p.state.toLowerCase()}/` },
    { id: 'trulia', name: 'Trulia', host: 'trulia.com', kinds: ['home'], best: 'Neighbourhood notes from people who live there, with crime and commute maps.',
        build: (p) => `https://www.trulia.com/${p.state}/${titleSlug(p.city).replace(/-/g, '_')}/` },
    { id: 'craigslist', name: 'Craigslist', host: 'craigslist.org', kinds: ['home', 'land'], best: 'Homes and land sold by their owners, often nowhere else.',
        build: (p, f) => `https://www.craigslist.org/search/city/${slug(p.city)}-${p.state.toLowerCase()}${q({ cat: 'rea', max_price: f.maxPrice, min_bedrooms: f.kind === 'home' ? f.minBeds : null })}` },
    { id: 'landwatch', name: 'LandWatch', host: 'landwatch.com', kinds: ['land'], best: 'Land, farms and ranches, the largest land marketplace.',
        build: (p) => (US_STATE_NAMES[p.state] ? `https://www.landwatch.com/${US_STATE_NAMES[p.state]}-land-for-sale/${slug(p.city)}` : null) },
    { id: 'hud', name: 'HUD Homestore', host: 'hudhomestore.gov', kinds: ['foreclosure'], best: 'Homes HUD took back on FHA loans, offered first to people who will live in them.',
        build: (p) => `https://www.hudhomestore.gov/searchresult${q({ citystate: p.state })}` },
    { id: 'homepath', name: 'Fannie Mae HomePath', host: 'fanniemae.com', kinds: ['foreclosure'], best: 'Fannie Mae\'s own foreclosed homes, with a first look for buyers who will live there.',
        build: (p) => `https://homepath.fanniemae.com/property-finder${q({ location: `${p.city}, ${p.state}` })}` },
    { id: 'auction', name: 'Auction.com', host: 'auction.com', kinds: ['foreclosure'], best: 'Foreclosure and bank-owned auctions, online and on the courthouse steps.',
        build: (p) => `https://www.auction.com/residential/${p.state.toLowerCase()}` },
    { id: 'loopnet', name: 'LoopNet', host: 'loopnet.com', kinds: ['commercial'], best: 'Commercial property for sale: offices, retail, industrial, land.',
        build: (p) => `https://www.loopnet.com/search/commercial-real-estate/${slug(p.city)}-${p.state.toLowerCase()}/for-sale/` },
];

function positiveInt(v, max) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

function linksFor(place, { kind = 'home', maxPrice = null, minBeds = null } = {}) {
    if (!place || !place.city || !/^[A-Z]{2}$/.test(String(place.state || '')) || (place.country || 'us') !== 'us') return [];
    const k = KINDS.includes(kind) ? kind : 'home';
    const f = { kind: k, maxPrice: positiveInt(maxPrice, 100_000_000), minBeds: positiveInt(minBeds, 10) };
    const out = [];
    for (const site of SITES) {
        if (!site.kinds.includes(k)) continue;
        let url = null;
        try { url = site.build(place, f); } catch { url = null; }
        if (url && /^https:\/\//.test(url)) out.push({ id: site.id, name: site.name, url, best: site.best });
    }
    return out;
}

/** NETR Online's directory of a state's county assessor, recorder and treasurer sites (the official records). */
const recordsUrl = (state) => (/^[A-Z]{2}$/.test(String(state || '')) && US_STATE_NAMES[state] ? `https://publicrecords.netronline.com/state/${state}` : null);

module.exports = { KINDS, KIND_TEXT, SITES, linksFor, recordsUrl };
