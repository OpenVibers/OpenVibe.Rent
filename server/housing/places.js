'use strict';

/**
 * "Affordable housing near you": public housing, tax-credit (LIHTC) properties, HUD-assisted multifamily properties,
 * public housing authorities and housing counselling agencies near a place a visitor types, from the U.S. Department
 * of Housing and Urban Development's open data (public domain) on ArcGIS. The field names and the five layers are
 * from the verified HUD research; a missing value stays null (never invented), and server/housing/upstream.js paces
 * and caches every request.
 *
 * Everything this module returns is HUD public-domain data. Callers must show the attribution and link it back — the
 * pages do (server/http/pages.js), and the API returns it with every answer.
 */

const { UpstreamError } = require('./upstream');

const ATTRIBUTION = {
    text: 'Source: U.S. Department of Housing and Urban Development (HUD), public domain',
    url: 'https://hudgis-hud.opendata.arcgis.com/',
    license: 'Public domain (USA.gov)',
    license_url: 'https://www.usa.gov/government-copyright',
};
const SOURCE = {
    name: 'U.S. Department of Housing and Urban Development (HUD)',
    url: 'https://hudgis-hud.opendata.arcgis.com/',
    via: 'ArcGIS FeatureServer',
    license: 'Public domain',
    fetched_note: 'fetched by OpenVibe.Rent and cached for 7 days',
};

const KINDS = ['public_housing', 'lihtc', 'multifamily', 'housing_authority', 'counseling', 'hud_home'];
const KIND_TEXT = {
    public_housing: 'Public housing',
    lihtc: 'Tax-credit (LIHTC) properties',
    multifamily: 'HUD-assisted multifamily',
    housing_authority: 'Public housing authorities',
    counseling: 'Housing counselling agencies',
    hud_home: 'HUD homes for sale',
};
const KIND_DESCRIPTIONS = {
    public_housing: 'Public housing: homes owned by a local housing authority, rent based on income.',
    lihtc: 'Tax-credit (LIHTC) properties: privately owned apartments with rents kept low through a federal tax credit.',
    multifamily: 'HUD-assisted multifamily: privately owned apartments where HUD helps keep the rent affordable.',
    housing_authority: 'Public housing authorities: the local agency to apply to for public housing and housing vouchers.',
    counseling: 'Housing counselling agencies: HUD-approved local help with renting, buying and keeping a home.',
    hud_home: 'HUD homes for sale: houses HUD took back after an FHA loan, sold through HUD Homestore. From HUD\'s published snapshot (March 2026), so a home may have sold since: confirm it on HUD Homestore before you plan around it.',
};

// Counts, rents and coordinates-free numbers: HUD marks a missing or suppressed value with a negative sentinel (-1, -4,
// -5), so a negative number is missing, never shown.
const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
};
// A coordinate may be negative (every US longitude is); only a non-number is missing.
const coord = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null || v === '' ? null : String(v).trim());
// A US ZIP code: numeric fields lose their leading zero (LIHTC's PROJ_ZIP gives 5401 for 05401); ZIP+4 is kept.
const zip5 = (v) => {
    const t = str(v);
    if (!t) return null;
    return /^\d{1,5}$/.test(t) ? t.padStart(5, '0') : t;
};
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
// HUD's multifamily contract dates read "30-JUN-41"; a two-digit year is 20xx (these contracts run forward).
const hudDate = (v) => {
    const m = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(str(v) || '');
    return m && MONTHS[m[2]] ? `20${m[3]}-${MONTHS[m[2]]}-${m[1]}` : str(v);
};
const epochIso = (v) => {
    const n = num(v);
    if (n == null) return null;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** A HUD-supplied URL, kept only when it parses and speaks http(s): it must never become a hostile href. */
function safeUrl(v) {
    if (typeof v !== 'string' || !v.trim()) return null;
    try {
        const u = new URL(v.trim());
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
        return null;
    }
}

const idOf = (prefix, ...parts) => {
    for (const p of parts) {
        const v = p == null ? '' : String(p).trim();
        if (v) return `${prefix}-${v}`;
    }
    return null;
};

// The five layers, each normalised to the same shape. `fields` is exactly what the query asks for, nothing more.
const LAYERS = [
    {
        kind: 'public_housing',
        service: 'Public_Housing_Developments',
        layer: 0,
        fields: ['OBJECTID', 'PROJECT_NAME', 'STD_ADDR', 'STD_CITY', 'STD_ST', 'STD_ZIP5', 'TOTAL_DWELLING_UNITS', 'TOTAL_UNITS', 'HA_PHN_NUM', 'FORMAL_PARTICIPANT_NAME', 'LAT', 'LON', 'RENT_PER_MONTH', 'LAST_UPDT_DTTM'],
        normalize(a) {
            return {
                id: idOf('hud-ph', a.OBJECTID),
                name: str(a.PROJECT_NAME),
                address: str(a.STD_ADDR),
                city: str(a.STD_CITY),
                state: str(a.STD_ST),
                zip: zip5(a.STD_ZIP5),
                phone: str(a.HA_PHN_NUM),
                units: { total: num(a.TOTAL_DWELLING_UNITS) ?? num(a.TOTAL_UNITS), low_income: null },
                extra: { authority: str(a.FORMAL_PARTICIPANT_NAME), rent_per_month: num(a.RENT_PER_MONTH), last_updated: epochIso(a.LAST_UPDT_DTTM) },
            };
        },
    },
    {
        kind: 'lihtc',
        service: 'LIHTC',
        layer: 0,
        fields: ['OBJECTID', 'HUD_ID', 'PROJECT', 'PROJ_ADD', 'PROJ_CTY', 'PROJ_ST', 'PROJ_ZIP', 'N_UNITS', 'LI_UNITS', 'YR_PIS', 'YR_ALLOC', 'LAT', 'LON'],
        normalize(a) {
            return {
                id: idOf('hud-lihtc', a.HUD_ID, a.OBJECTID),
                name: str(a.PROJECT),
                address: str(a.PROJ_ADD),
                city: str(a.PROJ_CTY),
                state: str(a.PROJ_ST),
                zip: zip5(a.PROJ_ZIP),
                phone: null,
                units: { total: num(a.N_UNITS), low_income: num(a.LI_UNITS) },
                extra: { year_placed: str(a.YR_PIS), year_allocated: str(a.YR_ALLOC) },
            };
        },
    },
    {
        kind: 'multifamily',
        service: 'MULTIFAMILY_PROPERTIES_ASSISTED',
        layer: 0,
        fields: ['OBJECTID', 'PROPERTY_ID', 'PROPERTY_NAME_TEXT', 'ADDRESS_LINE1_TEXT', 'STD_CITY', 'STD_ST', 'STD_ZIP5', 'TOTAL_UNIT_COUNT', 'TOTAL_ASSISTED_UNIT_COUNT', 'PROPERTY_CATEGORY_NAME', 'EXPIRATION_DATE1', 'LAST_UPDT_DTTM', 'LAT', 'LON'],
        normalize(a) {
            return {
                id: idOf('hud-mf', a.PROPERTY_ID, a.OBJECTID),
                name: str(a.PROPERTY_NAME_TEXT),
                address: str(a.ADDRESS_LINE1_TEXT),
                city: str(a.STD_CITY),
                state: str(a.STD_ST),
                zip: zip5(a.STD_ZIP5),
                phone: null,
                units: { total: num(a.TOTAL_UNIT_COUNT), low_income: num(a.TOTAL_ASSISTED_UNIT_COUNT) },
                extra: { property_category: str(a.PROPERTY_CATEGORY_NAME), expiration_date: hudDate(a.EXPIRATION_DATE1), last_updated: epochIso(a.LAST_UPDT_DTTM) },
            };
        },
    },
    {
        kind: 'housing_authority',
        service: 'Public_Housing_Authorities',
        layer: 0,
        fields: ['OBJECTID', 'FORMAL_PARTICIPANT_NAME', 'STD_ADDR', 'STD_CITY', 'STD_ST', 'STD_ZIP5', 'TOTAL_UNITS', 'SECTION8_UNITS_CNT', 'HA_PHN_NUM', 'HA_EMAIL_ADDR_TEXT', 'LAST_UPDT_DTTM'],
        normalize(a) {
            return {
                id: idOf('hud-pha', a.OBJECTID),
                name: str(a.FORMAL_PARTICIPANT_NAME),
                address: str(a.STD_ADDR),
                city: str(a.STD_CITY),
                state: str(a.STD_ST),
                zip: zip5(a.STD_ZIP5),
                phone: str(a.HA_PHN_NUM),
                units: { total: num(a.TOTAL_UNITS), low_income: null },
                extra: { section8_units: num(a.SECTION8_UNITS_CNT), email: str(a.HA_EMAIL_ADDR_TEXT), last_updated: epochIso(a.LAST_UPDT_DTTM) },
            };
        },
    },
    {
        kind: 'counseling',
        service: 'Housing_Counseling_Agencies_UAUC',
        layer: 0,
        fields: ['OBJECTID', 'AGC_NAME', 'AGC_ADDRESS', 'AGC_CITY', 'AGC_STATE', 'AGC_ZIP_CODE', 'STD_ADDR', 'STD_CITY', 'STD_ST', 'STD_ZIP5', 'AGC_PHONE_NBR', 'AGC_WEB_SITE', 'COUNSEL_SRV_DESC', 'LANGUAGE_DESC', 'LAT', 'LON'],
        normalize(a) {
            return {
                id: idOf('hud-counsel', a.OBJECTID),
                name: str(a.AGC_NAME),
                // The agency's own address fields mix "NC" and "North Carolina"; HUD's standardised STD_* fields do not.
                address: str(a.STD_ADDR) || str(a.AGC_ADDRESS),
                city: str(a.STD_CITY) || str(a.AGC_CITY),
                state: str(a.STD_ST) || str(a.AGC_STATE),
                zip: zip5(a.STD_ZIP5) || str(a.AGC_ZIP_CODE),
                phone: str(a.AGC_PHONE_NBR),
                units: { total: null, low_income: null },
                extra: { website: safeUrl(a.AGC_WEB_SITE), services: str(a.COUNSEL_SRV_DESC), languages: str(a.LANGUAGE_DESC) },
            };
        },
    },    {
        kind: 'hud_home',
        service: 'SF_REO',
        layer: 0,
        fields: ['OBJECTID', 'CASE_NUM', 'STREET_NUM', 'DIRECTION_PREFIX', 'STREET_NAME', 'ADDRESS', 'CITY', 'STATE_CODE', 'DISPLAY_ZIP_CODE', 'DATE_ACQUIRED', 'DATE_CLOSED', 'MAP_LATITUDE', 'MAP_LONGITUDE'],
        normalize(a) {
            // The street fields are padded; ADDRESS already joins number, prefix and street when it is set.
            const street = str(a.ADDRESS) || [str(a.STREET_NUM), str(a.DIRECTION_PREFIX), str(a.STREET_NAME)].filter(Boolean).join(' ') || null;
            const city = str(a.CITY);
            const state = str(a.STATE_CODE);
            return {
                id: idOf('hud-reo', a.CASE_NUM, a.OBJECTID),
                name: street,
                address: street,
                city,
                state,
                zip: zip5(a.DISPLAY_ZIP_CODE),
                phone: null,
                units: { total: null, low_income: null },
                extra: {
                    case_number: str(a.CASE_NUM),
                    acquired: epochIso(a.DATE_ACQUIRED),
                    // HUD Homestore has no per-case link HUD publishes; its city search finds the home by its case number.
                    homestore_url: city && state ? `https://www.hudhomestore.gov/searchresult?citystate=${encodeURIComponent(`${city}, ${state}`)}` : 'https://www.hudhomestore.gov/',
                },
            };
        },
    },
];

function haversineKm(aLat, aLon, bLat, bLon) {
    const R = 6371.0088;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const KM_PER_DEG_LAT = 111.32;

/** A Nominatim boundingbox (`[south, north, west, east]`) as numbers, or null when it is unusable. */
function parseBbox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const [south, north, west, east] = bbox.map(Number);
    if (![south, north, west, east].every(Number.isFinite)) return null;
    if (!(north > south) || !(east > west)) return null;
    return [south, north, west, east];
}

/**
 * The ArcGIS envelope for a place, bounded to at most `maxKm` across. A place's own bounding box is used when it is
 * no larger than the cap; a bigger place (or one with no usable box) is clipped to the cap around its centre.
 */
function envelopeFor(place, maxKm) {
    const lat = place.lat;
    const lon = place.lon;
    const cosLat = Math.cos(lat * Math.PI / 180) || 0.0001;
    const halfLat = maxKm / 2 / KM_PER_DEG_LAT;
    const halfLon = maxKm / 2 / (KM_PER_DEG_LAT * cosLat);
    const centred = { xmin: lon - halfLon, ymin: lat - halfLat, xmax: lon + halfLon, ymax: lat + halfLat };
    const b = place.bbox;
    if (b) {
        const [south, north, west, east] = b;
        const wKm = Math.abs(east - west) * KM_PER_DEG_LAT * cosLat;
        const hKm = Math.abs(north - south) * KM_PER_DEG_LAT;
        if (wKm <= maxKm && hKm <= maxKm) return { xmin: west, ymin: south, xmax: east, ymax: north };
    }
    return centred;
}

/** One ArcGIS feature → one normalised result, or null when it carries no usable identity or position. */
function normalizeFeature(feature, def) {
    const attrs = (feature && feature.attributes) || {};
    const geom = feature && feature.geometry;
    const base = def.normalize(attrs, geom);
    if (!base.id) return null;   // a record with no identity is skipped, exactly as the Sources adapter does
    const lat = coord(attrs.LAT) ?? coord(geom && geom.y);
    const lon = coord(attrs.LON) ?? coord(geom && geom.x);
    if (lat == null || lon == null) return null;
    return { kind: def.kind, ...base, lat, lon, source_url: SOURCE.url };
}

function toResult(feature, def, origin) {
    const r = normalizeFeature(feature, def);
    if (!r) return null;
    r.distance_km = Math.round(haversineKm(origin.lat, origin.lon, r.lat, r.lon) * 10) / 10;
    return r;
}

/** Features → results, deduplicated by identity, nearest first, at most `limit`. */
function elementsToResults(features, def, origin, limit) {
    const seen = new Set();
    const out = [];
    for (const f of features || []) {
        const r = toResult(f, def, origin);
        if (!r) continue;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
    }
    out.sort((a, b) => a.distance_km - b.distance_km || (a.name == null ? -1 : b.name == null ? 1 : String(a.name).localeCompare(String(b.name))));
    return limit ? out.slice(0, limit) : out;
}

/**
 * The place search behind both the API and the pages.
 *
 *   { q, kinds }
 *
 * A name (q) is geocoded with Nominatim, once, and cached; each layer's area query is cached too. Throws
 * UpstreamError (housing.place.invalid on bad input, housing.place.not_found when no place matches,
 * housing.place.upstream when Nominatim or HUD cannot be reached). A place outside the United States answers
 * `in_us: false` and no results — never an error, because the geocode itself succeeded.
 */
async function searchPlaces(upstream, { q = null, kinds = null } = {}, config) {
    const raw = kinds == null || kinds === '' ? KINDS : String(kinds).split(',').map((x) => x.trim()).filter(Boolean);
    if (!raw.length || !raw.every((k) => KINDS.includes(k))) {
        throw new UpstreamError('housing.place.invalid', `kind: one or more of ${KINDS.join(', ')}`, { status: 422 });
    }
    const requested = KINDS.filter((k) => raw.includes(k));

    let place = null;
    if (q && String(q).trim()) {
        const g = await upstream.geocode(q, { limit: 1 });
        const hit = Array.isArray(g.body) ? g.body[0] : null;
        if (!hit) throw new UpstreamError('housing.place.not_found', `no place called “${String(q).slice(0, 80)}”; try a city and state, or a ZIP code`, { status: 404 });
        const la = Number(hit.lat);
        const lo = Number(hit.lon);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new UpstreamError('housing.place.upstream', 'could not reach the place service right now (no coordinates for that place)');
        const country = hit.address && (hit.address.country_code || hit.address.country)
            ? String(hit.address.country_code || hit.address.country).toLowerCase() : null;
        // The two pieces the FHFA House Price Index lookup matches on (server/housing/hpi.js): a city and the
        // two-letter state code. Nominatim gives the code as address.state_code for US places.
        const addr = hit.address || {};
        const city = str(addr.city) || str(addr.town) || str(addr.village) || str(addr.hamlet) || str(addr.municipality)
            || str(addr.county) || str(addr.suburb) || str(addr.city_district);
        const state = str(addr.state_code);
        place = { name: hit.display_name || String(q), lat: la, lon: lo, from: 'geocode', geocoded_at: g.fetched_at, country_code: country, bbox: parseBbox(hit.boundingbox), city, state };
    } else {
        throw new UpstreamError('housing.place.invalid', 'q: a place to search for', { status: 422 });
    }

    const maxKm = (config && config.housing && config.housing.maxBoxKm) || 50;
    const box = envelopeFor(place, maxKm);
    const inUs = place.country_code == null || place.country_code === 'us';

    const out = {
        location: { name: place.name, lat: place.lat, lon: place.lon, from: place.from, geocoded_at: place.geocoded_at, country_code: place.country_code, city: place.city, state: place.state },
        in_us: inUs,
        box,
        kinds: requested,
        results: [],
        per_kind: {},
        counts: { total: 0 },
        fetched_at: null,
        cached: true,
        attribution: ATTRIBUTION,
        source: SOURCE,
    };

    if (!inUs) return out;

    const cap = (config && config.housing && config.housing.maxResults) || 500;
    let fetchedAt = null;
    let cached = true;
    for (const k of requested) {
        const def = LAYERS.find((l) => l.kind === k);
        const r = await upstream.arcGis(def.service, def.layer, box, def.fields);
        out.per_kind[k] = elementsToResults(r.body && r.body.features, def, place, cap);
        if (!r.cached) cached = false;
        if (!fetchedAt || r.fetched_at > fetchedAt) fetchedAt = r.fetched_at;
    }
    out.results = requested.flatMap((k) => out.per_kind[k] || []);
    out.counts.total = out.results.length;
    for (const k of requested) out.counts[k] = (out.per_kind[k] || []).length;
    out.fetched_at = fetchedAt;
    out.cached = cached;
    return out;
}

module.exports = {
    searchPlaces, haversineKm, envelopeFor, parseBbox, normalizeFeature, toResult, elementsToResults, safeUrl,
    LAYERS, KINDS, KIND_TEXT, KIND_DESCRIPTIONS, ATTRIBUTION, SOURCE, UpstreamError,
};
