'use strict';

/**
 * The board: listings from any site, in one OpenVibe list. Search everywhere (server/aggregate/everywhere.js) opens
 * every rental site's own search; the board is where a person keeps what they found there — the link to the listing
 * on its own site, what they want to remember (title, price, place, notes) and how far they got.
 *
 * Rent never fetches the listing: the details come from the person, or from their own browser (the OpenVibe
 * Companion extension, a bookmarklet that opens /board?url=…&title=… with the page they are on). That keeps every site
 * in its own terms while the person gets one place for all of them (the owner's 2026-09-28 Q8).
 *
 * At most MAX_ITEMS per person; one row per link (saving it again updates it).
 */
const listings = require('../listings/listings');
const everywhere = require('../aggregate/everywhere');

const STATUSES = ['interested', 'contacted', 'viewing', 'applied', 'declined', 'rented'];
const STATUS_TEXT = { interested: 'Interested', contacted: 'Contacted', viewing: 'Viewing booked', applied: 'Applied', declined: 'Not for me', rented: 'Rented it' };
const MAX_ITEMS = 500;
const ID_RE = /^rbi_[0-9A-HJKMNP-TV-Z]{26}$/;
const LIMITS = { url: 2000, title: 200, place: 120, notes: 2000 };

/** The host a link lives on, without "www."; null when it is not an http(s) URL. */
function siteOf(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.username || u.password) return null;
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch { return null; }
}

/** A friendly name for a site: the search-everywhere catalog's name when it is one of those sites, else the host. */
function siteName(site) {
    const known = everywhere.siteForHost(site);
    return known ? known.name.replace(/ \(.*\)$/, '') : String(site || '');
}

/** A page title as a browser gives it, "9 Elm St | Zillow", without the site's own name at the end. */
function withoutSiteSuffix(title, site) {
    const known = site ? everywhere.siteForHost(site) : null;
    const names = [site, known && known.name.replace(/ \(.*\)$/, ''), known && known.host.split('.')[0]].filter(Boolean).map((x) => x.toLowerCase());
    const m = /^(.{3,}?)\s+[|\-–—·:]\s+([^|\-–—·:]{1,60})$/.exec(title);
    return m && names.some((n) => m[2].toLowerCase().includes(n)) ? m[1].trim() : title;
}

/**
 * Check and normalise what a person sends for one item. { ok: true, item } or { ok: false, code, detail }. `partial`
 * (an update) lets fields be left out; a full item needs a link.
 */
function validate(input = {}, { partial = false } = {}) {
    const out = {};
    if (!partial || input.url !== undefined) {
        const url = String(input.url || '').trim();
        if (!url) return { ok: false, code: 'board.invalid', detail: 'url: the listing\'s address on its own site' };
        if (url.length > LIMITS.url || !siteOf(url)) return { ok: false, code: 'board.invalid', detail: 'url: an http or https address' };
        out.url = new URL(url).href;
        out.site = siteOf(url);
    }
    if (!partial || input.title !== undefined) {
        const title = withoutSiteSuffix(listings.cleanText(input.title, LIMITS.title + 1).slice(0, LIMITS.title).trim(), out.site);
        out.title = title || (out.site ? `A listing on ${siteName(out.site)}` : '');
        if (partial && !title) return { ok: false, code: 'board.invalid', detail: 'title: a few words' };
    }
    if (input.price !== undefined) {
        const text = String(input.price == null ? '' : input.price).replace(/[,$€£\s]/g, '');
        if (text === '') out.price = null;
        else {
            const n = Number(text);
            if (!Number.isFinite(n) || n < 0 || n > listings.MAX_PRICE) return { ok: false, code: 'board.invalid', detail: `price: a number from 0 to ${listings.MAX_PRICE}` };
            out.price = Math.round(n * 100) / 100;
        }
    }
    if (input.currency !== undefined) {
        const c = String(input.currency || '').trim().toUpperCase();
        if (c && !listings.isCurrency(c)) return { ok: false, code: 'board.invalid', detail: 'currency: a three-letter code such as USD' };
        out.currency = c || null;
    }
    if (input.period !== undefined) {
        const p = String(input.period || '').trim().toLowerCase();
        if (p && !listings.PERIODS.includes(p)) return { ok: false, code: 'board.invalid', detail: `period: one of ${listings.PERIODS.join(', ')}` };
        out.period = p || null;
    }
    if (input.place !== undefined) out.place = listings.cleanText(input.place, LIMITS.place + 1).slice(0, LIMITS.place).trim() || null;
    if (input.notes !== undefined) out.notes = String(input.notes == null ? '' : input.notes).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, LIMITS.notes).trim() || null;
    if (input.status !== undefined) {
        const st = String(input.status || '').trim().toLowerCase();
        if (!STATUSES.includes(st)) return { ok: false, code: 'board.invalid', detail: `status: one of ${STATUSES.join(', ')}` };
        out.status = st;
    }
    if (out.price != null && !out.currency && !partial) out.currency = 'USD';
    return { ok: true, item: out };
}

// ── store ───────────────────────────────────────────────────

const COLS = ['url', 'site', 'title', 'price', 'currency', 'period', 'place', 'notes', 'status'];

const list = (s, subject) => s.db.many('SELECT * FROM rent_board_items WHERE subject = $1 ORDER BY updated_at DESC, id DESC', [subject]);
const get = (s, id) => s.db.maybe('SELECT * FROM rent_board_items WHERE id = $1', [id]);
const count = async (s, subject) => Number(await s.db.value('SELECT count(*) FROM rent_board_items WHERE subject = $1', [subject]));

/** Save a link to a person's board; the same link again updates the row. { ok, row, created } or a refusal. */
async function save(s, subject, item) {
    const existing = await s.db.maybe('SELECT * FROM rent_board_items WHERE subject = $1 AND url = $2', [subject, item.url]);
    if (existing) return { ok: true, row: await update(s, existing.id, item), created: false };
    if (await count(s, subject) >= MAX_ITEMS) return { ok: false, code: 'board.full', detail: `Your board holds ${MAX_ITEMS} listings, the most it can. Remove some you no longer need first.` };
    const now = s.iso();
    const row = { id: s.newId('rbi'), subject, status: 'interested', price: null, currency: null, period: null, place: null, notes: null, ...item, created_at: now, updated_at: now };
    await s.db.query(
        `INSERT INTO rent_board_items (id, subject, url, site, title, price, currency, period, place, notes, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [row.id, subject, row.url, row.site, row.title, row.price, row.currency, row.period, row.place, row.notes, row.status, now, now]);
    return { ok: true, row: await get(s, row.id), created: true };
}

async function update(s, id, patch) {
    const cols = COLS.filter((c) => patch[c] !== undefined);
    if (!cols.length) return get(s, id);
    await s.db.query(`UPDATE rent_board_items SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = $2 WHERE id = $1`, [id, s.iso(), ...cols.map((c) => patch[c])]);
    return get(s, id);
}

const remove = (s, id, subject) => s.db.exec('DELETE FROM rent_board_items WHERE id = $1 AND subject = $2', [id, subject]);

const toWire = (row) => ({
    id: row.id, url: row.url, site: row.site, site_name: siteName(row.site), title: row.title,
    price: row.price == null ? null : Number(row.price), currency: row.currency || null, period: row.period || null,
    place: row.place || null, notes: row.notes || null, status: row.status, created_at: row.created_at, updated_at: row.updated_at,
});

module.exports = { STATUSES, STATUS_TEXT, MAX_ITEMS, LIMITS, ID_RE, isItemId: (id) => ID_RE.test(String(id || '')), siteOf, siteName, withoutSiteSuffix, validate, list, get, count, save, update, remove, toWire };
