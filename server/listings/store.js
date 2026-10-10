'use strict';

/**
 * Listings, reports and saved searches in OpenVibe.Rent's PostgreSQL database (migrations/0002_rent.sql). Every
 * function takes the store (server/db.js createStore) first; the clock is the store's own, so a test can move time
 * and watch a listing expire.
 *
 * Search is one shape for /listings, GET /api/v1/listings, a saved search and its "new since you last looked"
 * count: a filter set (server/listings/listings.js normalizeFilters) compiled to one WHERE clause, so the three can
 * never mean different things. Only active listings are ever listed; a hidden, expired or removed one stays
 * reachable by its owner and by staff, and by nobody else.
 */

const listings = require('./listings');

const DAY_MS = 86_400_000;

/** A write changed this listing: OpenVibe.Search syncs it shortly (server/search-index.js; absent in some tests). */
const touched = (s, id) => { if (s.search) s.search.touch(id); };

/** The WHERE clause for a filter set. `exclude` leaves one dimension out — how the kind and country facets count. */
function buildWhere(f, { exclude = [], sinceISO = null } = {}) {
    const parts = ["state = 'active'"];
    const values = [];
    const p = (v) => { values.push(v); return `$${values.length}`; };
    if (f.q && !exclude.includes('q')) {
        const ph = p(f.q.toLowerCase());
        parts.push(`(strpos(lower(title), ${ph}) > 0 OR strpos(lower(description), ${ph}) > 0 OR strpos(lower(city), ${ph}) > 0 OR strpos(lower(coalesce(region, '')), ${ph}) > 0 OR strpos(lower(coalesce(neighbourhood, '')), ${ph}) > 0)`);
    }
    if (f.kind && !exclude.includes('kind')) parts.push(`kind = ${p(f.kind)}`);
    if (f.city && !exclude.includes('city')) parts.push(`lower(city) = lower(${p(f.city)})`);
    if (f.country && !exclude.includes('country')) parts.push(`country = ${p(f.country)}`);
    if (f.period && !exclude.includes('period')) parts.push(`period = ${p(f.period)}`);
    if (f.min != null && !exclude.includes('price')) parts.push(`price >= ${p(f.min)}`);
    if (f.max != null && !exclude.includes('price')) parts.push(`price <= ${p(f.max)}`);
    if (sinceISO) parts.push(`created_at > ${p(sinceISO)}`);
    return { sql: parts.join(' AND '), values };
}

async function insert(s, row) {
    await s.db.query(
        `INSERT INTO rent_listings (id, owner, kind, title, description, price, currency, period, city, region, country,
                neighbourhood, bedrooms, available_from, contact_url, state, report_count, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'active', 0, $16, $16, $17)`,
        [row.id, row.owner, row.kind, row.title, row.description, row.price, row.currency, row.period, row.city,
            row.region, row.country, row.neighbourhood, row.bedrooms, row.available_from, row.contact_url,
            row.created_at, row.expires_at]);
    touched(s, row.id);
    return get(s, row.id);
}

const get = (s, id) => s.db.maybe('SELECT * FROM rent_listings WHERE id = $1', [id]);

/** Newest first, a page at a time, by cursor: the ULID's own order is the listing's order. */
async function search(s, filters, { limit = listings.PAGE_SIZE, before = null } = {}) {
    const w = buildWhere(filters);
    const values = [...w.values];
    let sql = `SELECT * FROM rent_listings WHERE ${w.sql}`;
    if (before) { values.push(before); sql += ` AND id < $${values.length}`; }
    values.push(limit + 1);
    sql += ` ORDER BY id DESC LIMIT $${values.length}`;
    const rows = await s.db.many(sql, values);
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? page[page.length - 1].id : null };
}

const countMatching = async (s, filters, { sinceISO = null } = {}) => {
    const w = buildWhere(filters, { sinceISO });
    return Number(await s.db.value(`SELECT count(*) FROM rent_listings WHERE ${w.sql}`, w.values));
};

/** How many listings each kind and each country has, under the filters that are not that dimension. */
async function facets(s, filters) {
    const group = async (column) => {
        const w = buildWhere(filters, { exclude: [column === 'kind' ? 'kind' : 'country'] });
        const rows = await s.db.many(`SELECT ${column} AS value, count(*) AS n FROM rent_listings WHERE ${w.sql} GROUP BY ${column} ORDER BY n DESC, value ASC`, w.values);
        return rows.map((r) => ({ value: r.value, count: Number(r.n) }));
    };
    return { kind: await group('kind'), country: await group('country') };
}

/** Patch the columns a person may change (only the ones named); updated_at always moves. */
async function update(s, id, patch) {
    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 3}`);
    await s.db.query(`UPDATE rent_listings SET ${sets.join(', ')}, updated_at = $2 WHERE id = $1`, [id, s.iso(), ...cols.map((c) => patch[c])]);
    touched(s, id);
    return get(s, id);
}

/** Every active listing whose 30 days are up becomes expired — the sweep a timer runs in production. */
async function expireListings(s) {
    const now = s.iso();
    const n = Number(await s.db.exec("UPDATE rent_listings SET state = 'expired', updated_at = $1 WHERE state = 'active' AND expires_at <= $1", [now]));
    if (n && s.search) s.search.afterExpiry();
    return n;
}

/** The owner may renew: 30 days from now (not a top-up that could run far past it), and an expired listing returns. */
async function renew(s, id) {
    const now = s.now();
    const expires = new Date(now + listings.EXPIRY_DAYS * DAY_MS).toISOString();
    await s.db.query("UPDATE rent_listings SET expires_at = $2, updated_at = $3, state = CASE WHEN state = 'expired' THEN 'active' ELSE state END WHERE id = $1", [id, expires, s.iso()]);
    touched(s, id);
    return get(s, id);
}

/** Staff action: restore (active), hide or remove. */
async function setState(s, id, state) {
    await s.db.query('UPDATE rent_listings SET state = $2, updated_at = $3 WHERE id = $1', [id, state, s.iso()]);
    touched(s, id);
    return get(s, id);
}

async function remove(s, id) {
    const n = await s.db.exec('DELETE FROM rent_listings WHERE id = $1', [id]);
    touched(s, id);
    return n;
}

const countActiveByOwner = (s, owner) => s.db.value("SELECT count(*) FROM rent_listings WHERE owner = $1 AND state = 'active'", [owner]).then(Number);

/** Listings this person posted today (UTC) — the 5-a-day cap. */
const countCreatedToday = (s, owner) => s.db.value('SELECT count(*) FROM rent_listings WHERE owner = $1 AND created_at >= $2', [owner, new Date(s.now()).toISOString().slice(0, 10)])
    .then(Number);

const listByOwner = (s, owner, { limit = 100 } = {}) => s.db.many('SELECT * FROM rent_listings WHERE owner = $1 ORDER BY id DESC LIMIT $2', [owner, limit]);

// ── Reports ────────────────────────────────────────────────────────────────────────────────────────────────────

const reportBy = (s, listingId, reporter) => s.db.maybe('SELECT * FROM rent_reports WHERE listing_id = $1 AND reporter = $2', [listingId, reporter]);
const reportsFor = (s, listingId) => s.db.many('SELECT * FROM rent_reports WHERE listing_id = $1 ORDER BY created_at, id', [listingId]);

/**
 * Record a report. One per reporter per listing (the unique index is the truth, not a read-then-write). The third
 * distinct report hides the listing until staff look — counted once, when the threshold is crossed, so a listing a
 * member of staff has restored is not hidden again by the same reports.
 */
async function addReport(s, listingId, { id, reporter, reason, note, createdAt }) {
    const out = await s.tx(async () => {
        const row = await s.db.maybe('SELECT * FROM rent_listings WHERE id = $1', [listingId]);
        if (!row) return { error: 'listing.not_found' };
        if (row.state === 'removed') return { error: 'listing.removed' };
        if (await reportBy(s, listingId, reporter)) return { error: 'report.duplicate' };
        let report = null;
        try {
            report = await s.db.maybe('INSERT INTO rent_reports (id, listing_id, reporter, reason, note, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                [id, listingId, reporter, reason, note, createdAt]);
        } catch (err) {
            if (err && err.code === '23505') return { error: 'report.duplicate' };
            throw err;
        }
        const count = Number(await s.db.value('SELECT count(*) FROM rent_reports WHERE listing_id = $1', [listingId]));
        const hide = row.state === 'active' && Number(row.report_count) < listings.HIDE_AT_REPORTS && count >= listings.HIDE_AT_REPORTS;
        const after = await s.db.maybe(
            `UPDATE rent_listings SET report_count = $2, updated_at = $3, state = CASE WHEN $4 THEN 'hidden' ELSE state END WHERE id = $1 RETURNING *`,
            [listingId, count, s.iso(), hide]);
        return { row: after, report, hidden: hide };
    });
    if (out && out.hidden) touched(s, listingId);
    return out;
}

/**
 * The queue staff read: the listings somebody reported, newest posting first, cursor-paged like search. `state`
 * filters to the ones hidden by reports (the default), the ones still active or the ones staff removed.
 */
async function staffQueue(s, { state = 'hidden', limit = 50, before = null } = {}) {
    const values = [];
    const parts = ["report_count > 0"];
    if (state === 'hidden') parts.push("state = 'hidden'");
    if (state === 'active') parts.push("state = 'active'");
    if (state === 'removed') parts.push("state = 'removed'");
    let sql = `SELECT * FROM rent_listings WHERE ${parts.join(' AND ')}`;
    if (before) { values.push(before); sql += ` AND id < $${values.length}`; }
    values.push(limit + 1);
    sql += ` ORDER BY id DESC LIMIT $${values.length}`;
    const rows = await s.db.many(sql, values);
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? page[page.length - 1].id : null };
}

const staffCounts = async (s) => ({
    hidden: Number(await s.db.value("SELECT count(*) FROM rent_listings WHERE report_count > 0 AND state = 'hidden'")),
    active: Number(await s.db.value("SELECT count(*) FROM rent_listings WHERE report_count > 0 AND state = 'active'")),
    removed: Number(await s.db.value("SELECT count(*) FROM rent_listings WHERE report_count > 0 AND state = 'removed'")),
});

// ── Saved searches ─────────────────────────────────────────────────────────────────────────────────────────────

async function saveSearch(s, { id, subject, filters, key, createdAt }) {
    await s.db.query(
        `INSERT INTO rent_saved_searches (id, subject, filters, filters_key, created_at, last_seen_at) VALUES ($1, $2, $3::jsonb, $4, $5, $5)
         ON CONFLICT (subject, filters_key) DO NOTHING`,
        [id, subject, JSON.stringify(filters), key, createdAt]);
    return s.db.maybe('SELECT * FROM rent_saved_searches WHERE subject = $1 AND filters_key = $2', [subject, key]);
}

const listSaved = (s, subject) => s.db.many('SELECT * FROM rent_saved_searches WHERE subject = $1 ORDER BY id DESC', [subject]);
const getSaved = (s, id) => s.db.maybe('SELECT * FROM rent_saved_searches WHERE id = $1', [id]);
const deleteSaved = (s, id, subject) => s.db.exec('DELETE FROM rent_saved_searches WHERE id = $1 AND subject = $2', [id, subject]);
const markSavedSeen = (s, id, at) => s.db.exec('UPDATE rent_saved_searches SET last_seen_at = $2 WHERE id = $1', [id, at]);

module.exports = {
    insert, get, search, countMatching, facets, update, expireListings, renew, setState, remove,
    countActiveByOwner, countCreatedToday, listByOwner,
    reportsFor, addReport, staffQueue, staffCounts,
    saveSearch, listSaved, getSaved, deleteSaved, markSavedSeen,
    DAY_MS,
};
