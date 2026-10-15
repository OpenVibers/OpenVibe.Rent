'use strict';

/**
 * Search everywhere: the rental aggregator's front door. One place and one set of filters open every major rental
 * site's own search for that place — Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper, Rent.com,
 * RentCafe, Apartment List, PadMapper, HotPads, Trulia, Realtor.com, Roomies, Furnished Finder, Airbnb, LoopNet,
 * SpotHero, SpareFoot and Turo — next to what OpenVibe.Rent has itself (listings posted here, affordable housing from
 * HUD). The listings stay on each site: a link opens that site's own results, in the person's own browser and account.
 * This is the permitted way to aggregate sites whose terms forbid automated collection (the owner's 2026-09-28 Q8:
 * deep links out, a browser extension inside the person's own sessions, licensed APIs, people posting).
 *
 * Every URL pattern here was opened in a real browser for several cities, one-word and multi-word, on 2026-10-15
 * (tools/rent-links-check.js). Sites that answer automated checks with a bot wall (Zillow, Apartments.com, HotPads,
 * Trulia, Realtor.com, LoopNet) use their public, long-standing URL forms and open normally for a person.
 *
 * US places first (the owner's Q9); a place outside the US gets the sites that work worldwide.
 */

const KINDS = ['apartment', 'house', 'room', 'stay', 'commercial', 'parking', 'storage', 'vehicle'];
const KIND_TEXT = {
    apartment: 'Apartments', house: 'Houses', room: 'Rooms and shares', stay: 'Furnished and monthly stays',
    commercial: 'Commercial and office space', parking: 'Parking', storage: 'Storage', vehicle: 'Cars and vehicles',
};

const US_STATE_NAMES = {
    AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
    DC: 'district-of-columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
    KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
    MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new-hampshire', NJ: 'new-jersey',
    NM: 'new-mexico', NY: 'new-york', NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon',
    PA: 'pennsylvania', RI: 'rhode-island', SC: 'south-carolina', SD: 'south-dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
    VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west-virginia', WI: 'wisconsin', WY: 'wyoming', PR: 'puerto-rico',
};

/** "Salt Lake City" → "salt-lake-city"; accents and punctuation dropped. */
const slug = (v) => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** "Salt Lake City" → "Salt-Lake-City" (SpareFoot, Airbnb keep the capitals). */
const titleSlug = (v) => slug(v).split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('-');
const q = (params) => {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') out.set(k, String(v));
    const s = out.toString();
    return s ? `?${s}` : '';
};

/**
 * The sites. `kinds` says which searches each one answers; `build(place, f)` returns the URL for a place
 * ({ city, state, country, postcode, lat, lon }) and filters ({ kind, maxPrice, minBeds }), or null when it cannot
 * serve that place. `us: true` sites need a US city and state. `host` is the site's domain (its listings may sit on a
 * subdomain, e.g. saltlakecity.craigslist.org).
 */
const SITES = [
    {
        id: 'craigslist', name: 'Craigslist', host: 'craigslist.org', us: true,
        kinds: ['apartment', 'house', 'room', 'stay', 'commercial', 'parking', 'storage'],
        best: 'Local listings from owners and small landlords, often not anywhere else.',
        build: (p, f) => {
            const cat = { apartment: 'apa', house: 'apa', room: 'roo', stay: 'sub', commercial: 'off', parking: 'prk', storage: 'prk' }[f.kind];
            const beds = ['apartment', 'house'].includes(f.kind) ? f.minBeds : null;
            return `https://www.craigslist.org/search/city/${slug(p.city)}-${p.state.toLowerCase()}${q({ cat, max_price: f.maxPrice, min_bedrooms: beds, postal: p.postcode, radius: p.postcode ? 10 : null })}`;
        },
    },
    {
        id: 'facebook', name: 'Facebook Marketplace', host: 'facebook.com', us: false,
        kinds: ['apartment', 'house', 'room'],
        best: 'Rooms, sublets and homes from people nearby; sign in to Facebook to see them all.',
        build: (p) => `https://www.facebook.com/marketplace/${slug(p.city).replace(/-/g, '')}/propertyrentals`,
    },
    {
        id: 'zillow', name: 'Zillow', host: 'zillow.com', us: true, kinds: ['apartment', 'house'],
        best: 'The largest US listing database, with a map and price history.',
        build: (p, f) => `https://www.zillow.com/${slug(p.city)}-${p.state.toLowerCase()}/${f.kind === 'house' ? 'rent-houses' : 'rentals'}/`,
    },
    {
        id: 'apartments', name: 'Apartments.com', host: 'apartments.com', us: true, kinds: ['apartment'],
        best: 'Managed apartment buildings with floor plans and availability.',
        build: (p, f) => {
            const parts = [f.minBeds ? `${f.minBeds}-bedrooms` : null, f.maxPrice ? `under-${f.maxPrice}` : null].filter(Boolean).join('-');
            return `https://www.apartments.com/${slug(p.city)}-${p.state.toLowerCase()}/${parts ? `${parts}/` : ''}`;
        },
    },
    {
        id: 'zumper', name: 'Zumper', host: 'zumper.com', us: true, kinds: ['apartment', 'house', 'room'],
        best: 'Fresh listings updated daily, including rooms and houses.',
        build: (p, f) => `https://www.zumper.com/${{ house: 'houses-for-rent', room: 'rooms-for-rent' }[f.kind] || 'apartments-for-rent'}/${slug(p.city)}-${p.state.toLowerCase()}`,
    },
    {
        id: 'rentcom', name: 'Rent.com', host: 'rent.com', us: true, kinds: ['apartment', 'house'],
        best: 'Apartments and houses with verified photos and pricing.',
        build: (p, f) => (US_STATE_NAMES[p.state] ? `https://www.rent.com/${US_STATE_NAMES[p.state]}/${slug(p.city)}-${f.kind === 'house' ? 'houses' : 'apartments'}` : null),
    },
    {
        id: 'rentcafe', name: 'RentCafe', host: 'rentcafe.com', us: true, kinds: ['apartment'],
        best: 'Apartment communities with online applications.',
        build: (p) => `https://www.rentcafe.com/apartments-for-rent/${slug(p.city)}-${p.state.toLowerCase()}/`,
    },
    {
        id: 'apartmentlist', name: 'Apartment List', host: 'apartmentlist.com', us: true, kinds: ['apartment'],
        best: 'Matches you to buildings by budget and commute.',
        build: (p) => `https://www.apartmentlist.com/${p.state.toLowerCase()}/${slug(p.city)}`,
    },
    {
        id: 'padmapper', name: 'PadMapper', host: 'padmapper.com', us: true, kinds: ['apartment', 'house'],
        best: 'A map view across many listing sources.',
        build: (p) => `https://www.padmapper.com/apartments/${slug(p.city)}-${p.state.toLowerCase()}`,
    },
    {
        id: 'hotpads', name: 'HotPads', host: 'hotpads.com', us: true, kinds: ['apartment', 'house'],
        best: 'Map-first search with many houses and condos.',
        build: (p, f) => `https://hotpads.com/${slug(p.city)}-${p.state.toLowerCase()}/${f.kind === 'house' ? 'houses-for-rent' : 'apartments-for-rent'}`,
    },
    {
        id: 'trulia', name: 'Trulia', host: 'trulia.com', us: true, kinds: ['apartment', 'house'],
        best: 'Neighbourhood details: commute, schools, crime.',
        build: (p) => `https://www.trulia.com/for_rent/${titleSlug(p.city).replace(/-/g, '_')},${p.state}/`,
    },
    {
        id: 'realtor', name: 'Realtor.com', host: 'realtor.com', us: true, kinds: ['apartment', 'house'],
        best: 'Rentals listed by agents.',
        build: (p) => `https://www.realtor.com/apartments/${titleSlug(p.city)}_${p.state}`,
    },
    {
        id: 'roomies', name: 'Roomies', host: 'roomies.com', us: true, kinds: ['room'],
        best: 'Rooms and roommates.',
        build: (p) => `https://www.roomies.com/rooms/${slug(p.city)}-${p.state.toLowerCase()}`,
    },
    {
        id: 'furnishedfinder', name: 'Furnished Finder', host: 'furnishedfinder.com', us: true, kinds: ['stay', 'room'],
        best: 'Furnished monthly rentals (made for travel nurses, open to all).',
        build: (p) => `https://www.furnishedfinder.com/housing/us--${p.state.toLowerCase()}--${slug(p.city)}`,
    },
    {
        id: 'airbnb', name: 'Airbnb (monthly)', host: 'airbnb.com', us: false, kinds: ['stay'],
        best: 'Furnished stays of a month or more, worldwide.',
        build: (p) => `https://www.airbnb.com/s/${titleSlug(p.city)}--${p.state || titleSlug(p.countryName || '')}/homes?monthly_stay=true`,
    },
    {
        id: 'loopnet', name: 'LoopNet', host: 'loopnet.com', us: true, kinds: ['commercial'],
        best: 'Office, retail and industrial space for lease.',
        build: (p) => `https://www.loopnet.com/search/commercial-real-estate/${slug(p.city)}-${p.state.toLowerCase()}/for-lease/`,
    },
    {
        id: 'spothero', name: 'SpotHero', host: 'spothero.com', us: true, kinds: ['parking'],
        best: 'Monthly and daily parking in garages and lots.',
        build: (p) => (p.lat != null && p.lon != null ? `https://spothero.com/search${q({ latitude: Number(p.lat).toFixed(4), longitude: Number(p.lon).toFixed(4), kind: 'monthly' })}` : null),
    },
    {
        id: 'sparefoot', name: 'SpareFoot', host: 'sparefoot.com', us: true, kinds: ['storage'],
        best: 'Self-storage units compared by price and size.',
        build: (p) => `https://www.sparefoot.com/${titleSlug(p.city)}-${p.state}-self-storage.html`,
    },
    {
        id: 'turo', name: 'Turo', host: 'turo.com', us: true, kinds: ['vehicle'],
        best: 'Cars rented from their owners.',
        build: (p) => `https://turo.com/us/en/search${q({ country: 'US', location: `${p.city}, ${p.state}` })}`,
    },
];

/**
 * The links for one place and filter set, in the catalog's order. `place.state` is a two-letter US state code (or
 * null), `place.country` a two-letter country code. A site that cannot serve the place is left out, never guessed.
 */
function linksFor(place, { kind = 'apartment', maxPrice = null, minBeds = null } = {}) {
    if (!place || !place.city) return [];
    const k = KINDS.includes(kind) ? kind : 'apartment';
    const inUs = (place.country || 'us') === 'us' && /^[A-Z]{2}$/.test(String(place.state || ''));
    const f = { kind: k, maxPrice: positiveInt(maxPrice, 100000), minBeds: positiveInt(minBeds, 10) };
    const out = [];
    for (const site of SITES) {
        if (!site.kinds.includes(k)) continue;
        if (site.us && !inUs) continue;
        let url = null;
        try { url = site.build(place, f); } catch { url = null; }
        if (!url || !/^https:\/\//.test(url)) continue;
        out.push({ id: site.id, name: site.name, url, best: site.best });
    }
    return out;
}

/** The catalog site a host belongs to (www. and city subdomains included), or null. */
function siteForHost(host) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    return SITES.find((x) => h === x.host || h.endsWith(`.${x.host}`)) || null;
}

function positiveInt(v, max) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

module.exports = { KINDS, KIND_TEXT, SITES, US_STATE_NAMES, linksFor, siteForHost, slug, titleSlug };
