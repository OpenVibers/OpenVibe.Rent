'use strict';

/**
 * HUD's Fair Market Rents, read from OpenVibe.Sources (source hud-fair-market-rents, category housing), never from HUD:
 * Sources reads HUD's own FMR layer every week under its robots and terms checks, and Rent follows Sources' change
 * feed (openvibe-publishing/ingest: the cursor in rent_ingest_cursor, one transaction per page) into rent_fmr_areas,
 * one row per FMR area as HUD states it. An item Sources removes is deleted here.
 *
 * A Fair Market Rent is HUD's estimate of what a modest rental costs in an area, rent plus essential utilities (the
 * 40th percentile, for most areas), from a studio to four bedrooms. HUD sets them each October; Housing Choice
 * Vouchers pay up to a payment standard between 90% and 110% of them.
 *
 * The city pages ask forCity(city) synchronously: every area (about 2,600) is held in memory, loaded at start and
 * after a pull that changed something. A city finds its area through server/data/city-fmr-areas.json (built by
 * tools/build-fmr-areas.js from each city's Census point).
 *
 * Pulls 30 seconds after start and then every six hours. Off without OV_SOURCES_INTERNAL_URL and the OAuth client
 * secret (a test passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');
const AREAS = require('../data/city-fmr-areas.json');

const SOURCE_KEY = 'hud-fair-market-rents';
const CURSOR = 'sources.housing.after';
const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 30 * 1000;
const CODE_RE = /^[A-Z0-9]{6,40}$/;
const SIZES = [['studio', 'fmr_0br'], ['b1', 'fmr_1br'], ['b2', 'fmr_2br'], ['b3', 'fmr_3br'], ['b4', 'fmr_4br']];
const HUD_URL = 'https://www.huduser.gov/portal/datasets/fmr.html';

const dollars = (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : null));
const okRent = (v) => { const n = dollars(v); return n != null && n > 0 && n < 100000 ? n : null; };

/** A Sources item → a rent_fmr_areas row, or null when it is not an FMR area this service can show. */
function rowOf(item) {
    const f = (item && item.fields) || {};
    const code = item && typeof item.identity === 'string' ? item.identity.trim() : '';
    const name = item && typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!CODE_RE.test(code) || !name) return null;
    const row = {
        code, item_id: String(item.id), revision: Number(item.revision) || 1, name,
        fmr_0br: okRent(f.fmr_0br), fmr_1br: okRent(f.fmr_1br), fmr_2br: okRent(f.fmr_2br), fmr_3br: okRent(f.fmr_3br), fmr_4br: okRent(f.fmr_4br),
        retrieved_at: (item.provenance && item.provenance.retrieved_at) || new Date(0).toISOString(),
    };
    return SIZES.some(([, col]) => row[col] != null) ? row : null;
}

const view = (r) => ({ code: r.code, name: r.name, rents: Object.fromEntries(SIZES.map(([k, col]) => [k, r[col]])), retrieved_at: r.retrieved_at });

function createFairMarketRents({ config, s, fetchImpl = globalThis.fetch, log = console, source = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    const client = source || (url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'housing' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'rent', now: s.now });
    const stats = { pulls: 0, applied: 0, removed: 0, last_at: null, last_error: null };
    let byCode = new Map();
    let timer = null;
    let first = null;
    let running = false;

    async function apply(item, t) {
        if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'rent_area') return 'hold';
        if (item.removed) {
            await t.query('DELETE FROM rent_fmr_areas WHERE item_id = $1', [String(item.id)]);
            return 'removed';
        }
        const row = rowOf(item);
        if (!row) return 'hold';
        const cols = Object.keys(row);
        // A replayed page (or an older revision arriving late) never takes a row back.
        await t.query(`INSERT INTO rent_fmr_areas (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
            ON CONFLICT (code) DO UPDATE SET ${cols.filter((c) => c !== 'code').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
            WHERE rent_fmr_areas.item_id <> EXCLUDED.item_id OR rent_fmr_areas.revision <= EXCLUDED.revision`, cols.map((c) => row[c]));
        return 'applied';
    }

    /** Every area into memory (the city pages read it synchronously). */
    async function load() {
        const rows = await s.db.many('SELECT * FROM rent_fmr_areas');
        byCode = new Map(rows.map((r) => [r.code, view(r)]));
        return byCode.size;
    }

    /** Follow Sources' change feed to its end, then reload what changed. Never throws: the caller is a timer or a test. */
    async function pull() {
        if (!client || running) return { skipped: true };
        running = true;
        try {
            const out = await ingest.pullChanges({ db: s.db, cursor, source: client, name: CURSOR, apply });
            stats.pulls++;
            stats.applied += out.applied;
            stats.removed += out.removed;
            stats.last_at = s.iso();
            stats.last_error = null;
            if (out.applied || out.removed || !byCode.size) await load();
            if (out.applied || out.removed) log.log(`[FMR] ${out.applied} areas updated, ${out.removed} removed (Sources cursor ${out.after})`);
            return out;
        } catch (err) {
            stats.last_error = String((err && err.message) || err).slice(0, 300);
            log.warn(`[FMR] pull from OpenVibe.Sources failed: ${stats.last_error}`);
            return { error: stats.last_error };
        } finally { running = false; }
    }

    return {
        enabled: Boolean(client),
        stats,
        pull,
        apply,
        load,
        /** The FMR area a city lies in, with HUD's rents by size, or null. */
        forCity(city) {
            const code = city && AREAS.areas[city.id];
            return (code && byCode.get(code)) || null;
        },
        size: () => byCode.size,
        start() {
            if (timer) return false;
            load().catch((err) => log.warn(`[FMR] load failed: ${(err && err.message) || err}`));
            if (!client) return false;
            timer = setInterval(() => { pull().catch(() => {}); }, EVERY_MS);
            timer.unref();
            first = setTimeout(() => { pull().catch(() => {}); }, FIRST_MS);
            first.unref();
            return true;
        },
        stop() { clearInterval(timer); clearTimeout(first); timer = null; first = null; },
    };
}

module.exports = { createFairMarketRents, rowOf, SOURCE_KEY, SIZES, HUD_URL };
