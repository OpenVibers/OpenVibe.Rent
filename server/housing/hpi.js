'use strict';

/**
 * "Home prices around here" on Rent's affordable-housing page: the FHFA House Price Index (U.S. Federal Housing
 * Finance Agency; public domain, U.S. government work). The monthly master CSV is streamed line by line (never held
 * whole), the rows this product uses are kept — traditional, all-transactions, quarterly, State or MSA — and replaced
 * in one transaction, so a failed refresh leaves the previous rows untouched.
 *
 * The index is a repeat-sales index, not a price: callers must say so and link it back (the page and API do).
 */

const SOURCE = {
    name: 'FHFA House Price Index',
    url: 'https://www.fhfa.gov/data/hpi',
};
const ATTRIBUTION = {
    text: 'Source: FHFA House Price Index',
    url: SOURCE.url,
    license: 'Public domain (U.S. government work)',
};
const DEFAULT_URL = 'https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const YEARS = 6;

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (latest, earlier) => (Number.isFinite(earlier) && earlier !== 0 ? (latest / earlier - 1) * 100 : null);

/**
 * A streaming CSV reader over decoded string chunks. It handles quoted fields (with commas) and a quoted field that
 * happens to span a chunk boundary, while holding only the current record plus the unread tail — never the file.
 */
async function* csvRecords(chunks) {
    let buf = '';
    let row = [];
    let field = '';
    let quoted = false;
    let i = 0;

    for await (const chunk of chunks) {
        buf += chunk;
        while (i < buf.length) {
            const c = buf[i];
            if (quoted) {
                if (c === '"') {
                    if (i + 1 >= buf.length) break;   // need the next chunk to tell "" from a closing quote
                    if (buf[i + 1] === '"') { field += '"'; i += 2; continue; }
                    quoted = false; i += 1; continue;
                }
                field += c; i += 1; continue;
            }
            if (c === '"') { quoted = true; i += 1; continue; }
            if (c === ',') { row.push(field); field = ''; i += 1; continue; }
            if (c === '\n') { row.push(field); field = ''; const done = row; row = []; i += 1; yield done; continue; }
            if (c === '\r') { i += 1; continue; }
            field += c; i += 1; continue;
        }
        if (i > 0) { buf = buf.slice(i); i = 0; }
    }
    if (field !== '' || row.length) { row.push(field); yield row; }
}

const mapRow = (header, cells) => {
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = cells[i];
    return o;
};

const eq = (v, want) => String(v == null ? '' : v).trim().toLowerCase() === want;

const matches = (o) => eq(o.hpi_type, 'traditional')
    && eq(o.hpi_flavor, 'all-transactions')
    && eq(o.frequency, 'quarterly')
    && ['state', 'msa'].includes(String(o.level == null ? '' : o.level).trim().toLowerCase());

/** The two-letter state code(s) a place covers: a state's own code, or the code(s) after an MSA's last comma. */
function statesOf(level, placeId, placeName) {
    if (level === 'state') {
        const code = upper(placeId);
        return /^[A-Z]{2}$/.test(code) ? [code] : [];
    }
    const part = String(placeName == null ? '' : placeName).split(',').pop() || '';
    return part.split('-').map((x) => upper(x)).filter((x) => /^[A-Z]{2}$/.test(x));
}

/** The city names that make up an MSA's place_name: "Denver-Aurora-Centennial, CO" → denver, aurora, centennial. */
function cityListOf(placeName) {
    const head = String(placeName == null ? '' : placeName).split(',')[0] || '';
    return new Set(head.split('-').map(norm).filter(Boolean));
}

/** Replace every row in one transaction; on any failure the DELETE and INSERTs roll back together. */
async function replaceAll(s, rows, fetchedAt) {
    await s.db.tx(async (t) => {
        await t.query('DELETE FROM area_price_index', []);
        for (const r of rows) {
            await t.query(
                `INSERT INTO area_price_index (level, place_id, place_name, states, yr, quarter, index_nsa, fetched_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [r.level, r.place_id, r.place_name, r.states, r.yr, r.quarter, String(r.index_nsa), fetchedAt]);
        }
    });
}

/**
 * Stream `chunks` (an async iterable of decoded CSV text chunks) and replace the table with the rows this product
 * keeps. Returns the number of data rows scanned and kept; the latest six calendar years are kept.
 */
async function ingestFromStream(s, chunks, { fetchedAt = new Date().toISOString(), log = console } = {}) {
    let header = null;
    let maxYr = null;
    let scanned = 0;
    const matching = [];

    for await (const cells of csvRecords(chunks)) {
        if (!header) { header = cells; continue; }
        scanned += 1;
        const o = mapRow(header, cells);
        if (!matches(o)) continue;
        const yr = Number.parseInt(o.yr, 10);
        const quarter = Number.parseInt(o.period, 10);
        const index = Number(o.index_nsa);
        if (!Number.isInteger(yr) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) continue;
        if (!Number.isFinite(index)) continue;
        const level = String(o.level).trim().toLowerCase() === 'msa' ? 'msa' : 'state';
        const placeId = String(o.place_id == null ? '' : o.place_id).trim();
        const placeName = String(o.place_name == null ? '' : o.place_name).trim();
        if (!placeId) continue;
        const states = statesOf(level, placeId, placeName);
        if (!states.length) continue;
        matching.push({ level, place_id: placeId, place_name: placeName, states: states.join(','), yr, quarter, index_nsa: index });
        if (maxYr == null || yr > maxYr) maxYr = yr;
    }

    if (header == null || maxYr == null) throw new Error('FHFA HPI refresh found no usable rows');
    const kept = matching.filter((r) => r.yr >= maxYr - (YEARS - 1));
    await replaceAll(s, kept, fetchedAt);
    return { scanned, kept: kept.length };
}

const latestFetchedAt = (s) => s.db.value('SELECT max(fetched_at) AS v FROM area_price_index');

/**
 * The background refresh: one fetch at most every `ttlMs` (7 days by default), streamed and replaced in a
 * transaction. A fetch or parse failure throws — the caller logs one line and the old rows stay.
 */
async function refresh(s, {
    url = DEFAULT_URL,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = 60_000,
    userAgent = 'OpenVibeRent/0.1',
    force = false,
    log = console,
} = {}) {
    if (!force) {
        const last = await latestFetchedAt(s);
        if (last && now() - Date.parse(last) < ttlMs) return { skipped: true };
    }

    let res;
    try {
        res = await fetchImpl(url, {
            headers: { 'User-Agent': userAgent, Accept: 'text/csv' },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw new Error(`could not reach FHFA right now (${err && err.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
    }
    if (!res.ok) throw new Error(`could not reach FHFA right now (FHFA answered ${res.status})`);
    if (!res.body) throw new Error('could not reach FHFA right now (the answer had no body)');

    const decoder = new TextDecoder();
    const chunks = (async function* () {
        for await (const part of res.body) yield decoder.decode(part, { stream: true });
        yield decoder.decode();
    })();

    const out = await ingestFromStream(s, chunks, { fetchedAt: new Date(now()).toISOString(), log });
    return { ...out, skipped: false };
}

/** The change over the past year and five years, and the latest quarter label, from an ordered quarter series. */
function changes(series) {
    if (!Array.isArray(series) || !series.length) return null;
    const sorted = [...series].sort((a, b) => a.yr - b.yr || a.quarter - b.quarter);
    const byKey = new Map();
    for (const r of sorted) {
        const v = Number(r.index_nsa);
        if (Number.isFinite(v)) byKey.set(`${r.yr}:${r.quarter}`, v);
    }
    const latest = sorted[sorted.length - 1];
    const latestVal = byKey.get(`${latest.yr}:${latest.quarter}`);
    if (latestVal == null) return null;
    const yearAgo = byKey.get(`${latest.yr - 1}:${latest.quarter}`);
    const fiveAgo = byKey.get(`${latest.yr - 5}:${latest.quarter}`);
    return {
        year_change_pct: yearAgo == null ? null : round1(pct(latestVal, yearAgo)),
        five_year_change_pct: fiveAgo == null ? null : round1(pct(latestVal, fiveAgo)),
        latest: `Q${latest.quarter} ${latest.yr}`,
    };
}

const stateOf = (loc) => {
    const s = upper(loc && loc.state);
    return /^[A-Z]{2}$/.test(s) ? s : null;
};

async function pickMsa(s, city, state) {
    const rows = await s.db.many(
        "SELECT DISTINCT level, place_id, place_name, states FROM area_price_index WHERE level = 'msa' AND $1 = ANY(string_to_array(states, ',')) ORDER BY place_name",
        [state]);
    const want = norm(city);
    if (!want) return null;
    return rows.find((r) => cityListOf(r.place_name).has(want)) || null;
}

const pickState = (s, state) => s.db.maybe(
    "SELECT level, place_id, place_name, states FROM area_price_index WHERE level = 'state' AND place_id = $1",
    [state]);

/**
 * The area price context for a geocoded location (its `city` and `state` from searchPlaces' location): the MSA whose
 * city list contains the place's city, else the state. Null when there is no data or the location has no usable state.
 */
async function areaPricesFor(s, location) {
    const state = stateOf(location);
    if (!state) return null;
    const city = location && location.city ? String(location.city).trim() : null;

    let pick = null;
    if (city) pick = await pickMsa(s, city, state);
    if (!pick) pick = await pickState(s, state);
    if (!pick) return null;

    const series = await s.db.many(
        'SELECT yr, quarter, index_nsa FROM area_price_index WHERE level = $1 AND place_id = $2 ORDER BY yr, quarter',
        [pick.level, pick.place_id]);
    const c = changes(series);
    if (!c) return null;
    return { place: pick.place_name, level: pick.level, ...c, source: { name: SOURCE.name, url: SOURCE.url } };
}

/**
 * The past year's change for every state and metro area, for the homes' "where prices moved" lists: the latest quarter
 * against the same quarter a year before, from the stored rows only. → { latest: 'Q2 2026', states: [...], metros:
 * [...] } with each row { level, place_id, place_name, states, year_change_pct }, highest change first, or null when
 * nothing is stored. Held for an hour per store (the index is published monthly), so a home page costs no query.
 */
const MOVES_TTL_MS = 60 * 60 * 1000;
const movesCache = new WeakMap();
async function areaMoves(s, { now = Date.now() } = {}) {
    const hit = movesCache.get(s);
    if (hit && now - hit.at < MOVES_TTL_MS) return hit.value;
    const rows = await s.db.many(
        `SELECT level, place_id, place_name, states, yr, quarter, index_nsa FROM area_price_index
          WHERE yr >= (SELECT max(yr) - 1 FROM area_price_index) ORDER BY level, place_id, yr, quarter`, []);
    const groups = new Map();
    let top = null;
    for (const r of rows) {
        const k = Number(r.yr) * 10 + Number(r.quarter);
        if (top == null || k > top) top = k;
        const key = `${r.level}:${r.place_id}`;
        if (!groups.has(key)) groups.set(key, { level: r.level, place_id: r.place_id, place_name: r.place_name, states: r.states, series: [] });
        groups.get(key).series.push(r);
    }
    const latest = top == null ? null : `Q${top % 10} ${Math.floor(top / 10)}`;
    const out = { states: [], metros: [] };
    for (const g of groups.values()) {
        const c = changes(g.series);
        if (!c || c.year_change_pct == null) continue;
        (g.level === 'state' ? out.states : out.metros).push({ level: g.level, place_id: g.place_id, place_name: g.place_name, states: g.states, year_change_pct: c.year_change_pct, latest: c.latest });
    }
    const byChange = (a, b) => b.year_change_pct - a.year_change_pct || a.place_name.localeCompare(b.place_name);
    out.states.sort(byChange);
    out.metros.sort(byChange);
    // Only places on the most recent quarter count, so a place whose series stopped early is not ranked as current.
    const recent = (list) => list.filter((x) => x.latest === latest);
    const value = latest ? { latest, states: recent(out.states), metros: recent(out.metros), source: { name: SOURCE.name, url: SOURCE.url } } : null;
    if (value) movesCache.set(s, { at: now, value });   // an empty table (before the first ingest) is asked again
    return value;
}

/** The background ingest timer, started only by the process entry (server/index.js), never by a request or a test. */
function startHpiTimer(config, s, {
    log = console,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    everyMs = 24 * 60 * 60 * 1000,
} = {}) {
    const hpi = config.hpi || {};
    let running = false;
    const tick = async () => {
        if (running) return { skipped: true };
        running = true;
        try {
            return await refresh(s, {
                url: hpi.url, fetchImpl, now, ttlMs: hpi.refreshTtlMs, timeoutMs: hpi.timeoutMs,
                userAgent: config.housing && config.housing.userAgent, log,
            });
        } catch (err) {
            log.warn('[OpenVibe.Rent] FHFA HPI refresh failed:', err && err.message ? err.message : err);
            return { skipped: true, error: err && err.message ? err.message : String(err) };
        } finally {
            running = false;
        }
    };
    tick();
    const timer = setInterval(tick, everyMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { timer, tick };
}

module.exports = {
    SOURCE, ATTRIBUTION, DEFAULT_URL, DEFAULT_TTL_MS, YEARS,
    csvRecords, ingestFromStream, refresh, replaceAll, areaPricesFor, areaMoves, changes, startHpiTimer,
};
