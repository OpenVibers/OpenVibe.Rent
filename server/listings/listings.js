'use strict';

/**
 * What a listing is, on both sides of the wire — the rules the pages (http/pages.js) and the API (http/api.js)
 * share, so a form and a POST can never disagree:
 *
 *   id         rnt_<ULID>   (rpt_<ULID> for a report, ssv_<ULID> for a saved search)
 *   kind       apartment | room | house | commercial | parking | equipment | other
 *   price      a positive number with an ISO 4217 currency and a period (month, week, day, hour, once)
 *   place      city + ISO 3166-1 alpha-2 country, an optional region and neighbourhood
 *   state      active | hidden | expired | removed
 *
 * A listing is posted by a person, never by an app or a service, and a person may have at most 10 active listings
 * and post 5 new ones a day. It expires 30 days after posting unless the owner renews it. Three distinct reports
 * hide it until staff look.
 *
 * One rule has no exception: a neighbourhood, a city, a title or a description is NEVER a street address. A house
 * number together with a street is refused with a message that says what to write instead — the same check for the
 * form and the API, so nothing can slip through one of them.
 *
 * Nothing here fetches anything: a contact URL is text somebody typed, checked for shape, and shown only to a
 * signed-in person.
 */

const KINDS = ['apartment', 'room', 'house', 'commercial', 'parking', 'equipment', 'other'];
const PERIODS = ['month', 'week', 'day', 'hour', 'once'];
const STATES = ['active', 'hidden', 'expired', 'removed'];
const REASONS = ['scam', 'wrong', 'offensive', 'other'];
// A short list on purpose: the currencies OpenVibe.Rent shows a price in, never anything a caller invents.
const CURRENCIES = [
    'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON',
    'BRL', 'MXN', 'INR', 'SGD', 'HKD', 'CNY', 'KRW', 'ZAR', 'TRY', 'AED', 'ILS', 'THB', 'IDR', 'PHP', 'MYR',
];
// ISO 3166-1 alpha-2, the countries a listing may name (a short list, the same for the form and the API).
const COUNTRIES = [
    'AR', 'AT', 'AU', 'BE', 'BG', 'BR', 'CA', 'CH', 'CL', 'CN', 'CO', 'CZ', 'DE', 'DK', 'EE', 'EG', 'ES', 'FI',
    'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'ID', 'IE', 'IL', 'IN', 'IS', 'IT', 'JP', 'KE', 'KR', 'LT', 'LU', 'LV',
    'MA', 'MX', 'MY', 'NG', 'NL', 'NO', 'NZ', 'PE', 'PH', 'PL', 'PT', 'RO', 'RS', 'SE', 'SG', 'SI', 'SK', 'TH',
    'TR', 'TW', 'UA', 'US', 'VN', 'ZA',
];

const LIMITS = { title: 120, description: 4000, city: 80, region: 80, neighbourhood: 80, contactUrl: 500, note: 500, q: 200 };
const EXPIRY_DAYS = 30;
const MAX_ACTIVE = 10;
const MAX_PER_DAY = 5;
const HIDE_AT_REPORTS = 3;
const PAGE_SIZE = 30;
const MAX_PRICE = 1e9;

/** The safety note every listing page carries, word for word. */
const SAFETY = 'Never pay or send a deposit before you have seen the place and signed an agreement. OpenVibe does not handle payments for listings.';

const ID_RE = {
    listing: /^rnt_[0-9A-HJKMNP-TV-Z]{26}$/,
    report: /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/,
    saved: /^ssv_[0-9A-HJKMNP-TV-Z]{26}$/,
};

const isListingId = (id) => ID_RE.listing.test(String(id || ''));
const isReportId = (id) => ID_RE.report.test(String(id || ''));
const isSavedId = (id) => ID_RE.saved.test(String(id || ''));

/** Plain text as it will be stored: CRLF normalised, no control characters (keeping tab and newline), trimmed. */
function cleanText(value, max) {
    const s = String(value == null ? '' : value)
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .trim();
    return max != null ? s.slice(0, max) : s;
}

// A street address is a number and a street. These words name a street in the languages that matter here; every
// rule below still needs a digit beside one of them, so "Shoreditch" and "Greenwich Village" are never refused.
const STREET_WORDS = [
    'street', 'st', 'road', 'rd', 'avenue', 'ave', 'lane', 'ln', 'drive', 'dr', 'boulevard', 'blvd', 'way',
    'court', 'ct', 'place', 'pl', 'terrace', 'crescent', 'close', 'grove', 'square', 'sq', 'highway', 'hwy',
    'route', 'rue', 'straße', 'strasse', 'str', 'weg', 'calle', 'via', 'avenida', 'rua', 'ulica', 'piazza',
    'platz', 'gasse', 'quai', 'allée', 'allee', 'chemin', 'impasse',
].join('|');
const STREET = new RegExp(`\\b(?:${STREET_WORDS})\\b`, 'i');
// German-style compounds append the street word to the name ("Hauptstraße"), so those suffixes are matched
// without a word boundary in front of them; every other rule still needs a digit beside the street word.
const COMPOUND_SUFFIX = '(?:straße|strasse|str|weg|gasse|platz|allee|chaussee)';
const REFUSALS = [
    /\b(?:flat|unit|apt|apartment|suite|building|block|room|no|number)\s*\.?\s*#?\s*\d/i,   // "Flat 3, 12 High Street"
    /#\s*\d/,                                                                                // "#4 Cherry Lane"
    new RegExp(`\\d[\\w-]*(?:\\s+[\\w'’.,-]+){0,4}\\s+(?:${STREET_WORDS})\\b`, 'i'),         // "221B Baker Street"
    new RegExp(`\\b(?:${STREET_WORDS})\\b\\.?(?:\\s+[\\w'’.-]+){0,3}\\s+\\d+\\s*$`, 'i'),    // "Rue de la Paix 12"
    new RegExp(`${COMPOUND_SUFFIX}\\.?\\s*\\d{1,4}[a-z]?\\s*$`, 'i'),                        // "Hauptstraße 12"
];

/**
 * Does this text look like a house number and a street? ("12 Rue de la Paix", "Flat 3, 12 High St", "Hauptstraße 12").
 * Used on every free-text place field: a listing must never publish where somebody lives.
 */
function looksLikeStreetAddress(text) {
    const t = String(text == null ? '' : text);
    if (!t) return false;
    if (REFUSALS.some((re) => re.test(t))) return true;
    // A number at the end of a text that names a street ("Rue de la Paix 12").
    return STREET.test(t) && /\d+\s*[a-z]?\s*$/i.test(t);
}

/** The one message a person gets, whether they used the form or the API. */
const STREET_REFUSAL = (field) => `${field}: use the area, not a street address — OpenVibe.Rent never publishes a house number with a street. Try "Shoreditch", "Le Marais" or "Kreuzberg".`;

/** How text that got past the shape checks is refused: the same wording everywhere. */
const refuse = (field, detail) => ({ ok: false, code: 'listing.invalid', detail: `${field}: ${detail}` });

/** An ISO 4217 currency from the short list, and nothing else. */
const isCurrency = (c) => CURRENCIES.includes(String(c || '').toUpperCase());
const isCountry = (c) => COUNTRIES.includes(String(c || '').toUpperCase());

/** An optional https URL, or a mailto: — never http, never anything else a browser would not follow. */
function checkContactUrl(value) {
    const raw = cleanText(value, LIMITS.contactUrl + 1);
    if (raw.length > LIMITS.contactUrl) return { error: `at most ${LIMITS.contactUrl} characters` };
    if (!raw) return { value: null };
    if (/^mailto:/i.test(raw)) {
        const address = raw.slice(7).split('?')[0];
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? { value: `mailto:${address}` } : { error: 'mailto: needs one email address, like mailto:you@example.com' };
    }
    let url = null;
    try { url = new URL(raw); } catch { return { error: 'an https:// link or a mailto: address' }; }
    if (url.protocol !== 'https:') return { error: 'an https:// link (http is not accepted) or a mailto: address' };
    return { value: url.href };
}

/** A date-only string (YYYY-MM-DD) that is a real date, or null. */
function checkDate(value, field) {
    const s = cleanText(value, 11);
    if (!s) return { value: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: `${field}: a date as YYYY-MM-DD` };
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { error: `${field}: a real date as YYYY-MM-DD` };
    return { value: s };
}

/**
 * Check a listing as it is posted or edited. Answers { ok, fields } or { ok: false, code, detail } — one shape for
 * the form (which re-renders what was typed) and the API (which sends it as problem+json).
 */
function validate(input = {}) {
    const kind = cleanText(input.kind, 20).toLowerCase();
    if (!KINDS.includes(kind)) return { ok: false, code: 'listing.invalid', detail: `kind: one of ${KINDS.join(', ')}` };

    const title = cleanText(input.title, LIMITS.title + 1);
    if (!title) return refuse('title', 'say what you are renting (1 to 120 characters)');
    if (title.length > LIMITS.title) return refuse('title', `at most ${LIMITS.title} characters`);
    if (looksLikeStreetAddress(title)) return { ok: false, code: 'listing.address_refused', detail: STREET_REFUSAL('title') };

    const description = cleanText(input.description, LIMITS.description + 1);
    if (!description) return refuse('description', 'describe it (1 to 4000 characters)');
    if (description.length > LIMITS.description) return refuse('description', `at most ${LIMITS.description} characters`);
    if (looksLikeStreetAddress(description)) return { ok: false, code: 'listing.address_refused', detail: STREET_REFUSAL('description') };

    const priceRaw = typeof input.price === 'number' ? input.price : Number(cleanText(input.price, 24).replace(/,/g, ''));
    if (!Number.isFinite(priceRaw) || priceRaw <= 0) return refuse('price', 'a number greater than zero');
    if (priceRaw > MAX_PRICE) return refuse('price', 'a number no greater than 1,000,000,000');
    const price = Math.round(priceRaw * 100) / 100;

    const currency = cleanText(input.currency, 8).toUpperCase();
    if (!isCurrency(currency)) return refuse('currency', `one of ${CURRENCIES.slice(0, 8).join(', ')}… (an ISO 4217 code we support)`);

    const period = cleanText(input.period, 10).toLowerCase();
    if (!PERIODS.includes(period)) return refuse('period', `one of ${PERIODS.join(', ')}`);

    const city = cleanText(input.city, LIMITS.city + 1);
    if (!city) return refuse('city', 'the city or town (1 to 80 characters)');
    if (city.length > LIMITS.city) return refuse('city', `at most ${LIMITS.city} characters`);
    if (looksLikeStreetAddress(city)) return { ok: false, code: 'listing.address_refused', detail: STREET_REFUSAL('city') };

    const region = cleanText(input.region, LIMITS.region + 1);
    if (region.length > LIMITS.region) return refuse('region', `at most ${LIMITS.region} characters`);
    if (looksLikeStreetAddress(region)) return { ok: false, code: 'listing.address_refused', detail: STREET_REFUSAL('region') };

    const country = cleanText(input.country, 8).toUpperCase();
    if (!isCountry(country)) return refuse('country', 'a two-letter ISO 3166-1 country code we support (US, GB, DE, FR…)');

    const neighbourhood = cleanText(input.neighbourhood, LIMITS.neighbourhood + 1);
    if (neighbourhood.length > LIMITS.neighbourhood) return refuse('neighbourhood', `at most ${LIMITS.neighbourhood} characters`);
    if (looksLikeStreetAddress(neighbourhood)) return { ok: false, code: 'listing.address_refused', detail: STREET_REFUSAL('neighbourhood') };

    let bedrooms = null;
    const bedroomsRaw = cleanText(input.bedrooms, 6);
    if (bedroomsRaw) {
        if (!/^\d{1,2}$/.test(bedroomsRaw)) return refuse('bedrooms', 'a whole number (0 to 50)');
        bedrooms = Number(bedroomsRaw);
        if (bedrooms > 50) return refuse('bedrooms', 'a whole number (0 to 50)');
    }

    const from = checkDate(input.availableFrom != null ? input.availableFrom : input.available_from, 'available_from');
    if (from.error) return refuse('available_from', from.error.replace(/^available_from: /, ''));

    const contact = checkContactUrl(input.contactUrl != null ? input.contactUrl : input.contact_url);
    if (contact.error) return refuse('contact_url', contact.error);

    return {
        ok: true,
        fields: {
            kind, title, description, price, currency, period, city,
            region: region || null, country, neighbourhood: neighbourhood || null,
            bedrooms, availableFrom: from.value, contactUrl: contact.value,
        },
    };
}

/** A report's own fields: a reason from the list, an optional note. */
function validateReport({ reason, note } = {}) {
    const r = cleanText(reason, 20).toLowerCase();
    if (!REASONS.includes(r)) return { ok: false, code: 'report.invalid', detail: `reason: one of ${REASONS.join(', ')}` };
    const text = cleanText(note, LIMITS.note + 1);
    if (text.length > LIMITS.note) return { ok: false, code: 'report.invalid', detail: `note: at most ${LIMITS.note} characters` };
    return { ok: true, fields: { reason: r, note: text || null } };
}

/**
 * The search filters, normalised: what /listings, GET /api/v1/listings, a saved search and its "new since you last
 * looked" count all share. A filter that is not one we know is ignored, never an error — a stale bookmark still
 * shows listings.
 */
function normalizeFilters(input = {}) {
    const q = cleanText(input.q, LIMITS.q + 1).slice(0, LIMITS.q);
    const kind = KINDS.includes(String(input.kind || '').toLowerCase()) ? String(input.kind).toLowerCase() : null;
    const city = cleanText(input.city, LIMITS.city + 1).slice(0, LIMITS.city) || null;
    const country = isCountry(input.country) ? String(input.country).toUpperCase() : null;
    const period = PERIODS.includes(String(input.period || '').toLowerCase()) ? String(input.period).toLowerCase() : null;
    const num = (v) => {
        const text = cleanText(v, 24).replace(/,/g, '').trim();
        if (!text) return null;                       // an empty box is no filter, not a price of zero
        const n = Number(text);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    let min = num(input.min);
    let max = num(input.max);
    if (min != null && max != null && min > max) { const t = min; min = max; max = t; }
    return { q: q || null, kind, city, country, period, min, max };
}

/** The canonical string of a filter set: one saved search per distinct set, and the count query's key. */
const filtersKey = (f) => JSON.stringify([f.q || null, f.kind || null, f.city || null, f.country || null, f.period || null, f.min == null ? null : Number(f.min), f.max == null ? null : Number(f.max)]);

/** The query string a filter set round-trips through (links, the form, a saved search). */
function filtersToQuery(f) {
    const p = new URLSearchParams();
    for (const [k, v] of [['q', f.q], ['kind', f.kind], ['city', f.city], ['country', f.country], ['period', f.period], ['min', f.min], ['max', f.max]]) {
        if (v != null && v !== '') p.set(k, String(v));
    }
    return p.toString();
}

const isState = (s) => STATES.includes(String(s || ''));
const isReason = (r) => REASONS.includes(String(r || ''));

const KIND_TEXT = { apartment: 'Apartment', room: 'Room', house: 'House', commercial: 'Commercial space', parking: 'Parking or storage', equipment: 'Equipment', other: 'Other' };
const PERIOD_TEXT = { month: 'a month', week: 'a week', day: 'a day', hour: 'an hour', once: 'once' };

/** "€1,200 a month" — the price as a person reads it. The currency is a code, not a symbol: we never guess one. */
function priceText(row) {
    const n = Number(row.price);
    const amount = Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) : String(row.price);
    return `${amount} ${row.currency} ${PERIOD_TEXT[row.period] || row.period}`;
}

/**
 * A listing row → the JSON the API answers with. contact_url is included only when the caller is a signed-in
 * person: the whole point of the field is that a stranger cannot harvest it from a public page.
 */
function toWire(row, { contact = false } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        description: row.description,
        price: Number(row.price),
        currency: row.currency,
        period: row.period,
        city: row.city,
        region: row.region || null,
        country: row.country,
        neighbourhood: row.neighbourhood || null,
        bedrooms: row.bedrooms == null ? null : Number(row.bedrooms),
        available_from: row.available_from || null,
        contact_url: contact ? (row.contact_url || null) : undefined,
        state: row.state,
        report_count: Number(row.report_count || 0),
        created_at: row.created_at,
        updated_at: row.updated_at,
        expires_at: row.expires_at,
    };
}

const toWireReport = (row) => ({
    id: row.id,
    listing_id: row.listing_id,
    reporter: { type: 'user', id: String(row.reporter).replace(/^user:/, '') },
    reason: row.reason,
    note: row.note || null,
    created_at: row.created_at,
});

const toWireSaved = (row, { newCount = null } = {}) => ({
    id: row.id,
    filters: typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters,
    url: `/listings?${filtersToQuery(typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters)}`,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    ...(newCount == null ? {} : { new_count: newCount }),
});

module.exports = {
    KINDS, PERIODS, STATES, REASONS, CURRENCIES, COUNTRIES, LIMITS,
    EXPIRY_DAYS, MAX_ACTIVE, MAX_PER_DAY, HIDE_AT_REPORTS, PAGE_SIZE, MAX_PRICE, SAFETY,
    KIND_TEXT, PERIOD_TEXT,
    isListingId, isReportId, isSavedId, isState, isReason, isCurrency, isCountry,
    cleanText, looksLikeStreetAddress, STREET_REFUSAL, validate, validateReport,
    normalizeFilters, filtersKey, filtersToQuery, priceText, toWire, toWireReport, toWireSaved,
};
