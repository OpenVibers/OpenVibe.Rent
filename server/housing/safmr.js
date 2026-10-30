'use strict';

/**
 * HUD's Small Area Fair Market Rents, read from OpenVibe.Sources (source hud-safmr, category housing), never from HUD:
 * Sources reads HUD's own SAFMR layer under its robots and terms checks, and Rent follows Sources' change feed
 * (openvibe-publishing/ingest) into memory — no table of its own, because the figure is shown next to the housing a
 * reader is looking at, not stored as a listing.
 *
 * A Small Area Fair Market Rent is HUD's estimate of what a modest rental costs in a ZIP code (and, where HUD has
 * several, in each HUD metro area inside it), from a studio to four bedrooms. HUD sets them each October, so every
 * figure is shown with the fiscal year it carries: the layer holds the years 2018 and 2024 today.
 *
 * A ZIP can appear under two HUD metro codes (the same figures twice) and under more than one fiscal year: the newest
 * year for a ZIP is the one shown, and a ZIP is shown once.
 *
 * Off without OV_SOURCES_INTERNAL_URL and the OAuth client secret (a test passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');

const SOURCE_KEY = 'hud-safmr';
const CURSOR = 'sources.housing.safmr.after';
const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 30 * 1000;
const HUD_URL = 'https://www.huduser.gov/portal/datasets/fmr.html';

// The sizes HUD states, in the words a reader sees: a studio, then one to four bedrooms.
const SIZES = [['studio', 'safmr_0br'], ['b1', 'safmr_1br'], ['b2', 'safmr_2br'], ['b3', 'safmr_3br'], ['b4', 'safmr_4br']];

const amount = (v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : NaN);
    return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
};
const zipOf = (v) => {
    const s = String(v == null ? '' : v).trim();
    return /^\d{5}$/.test(s) ? s : null;
};
const yearOf = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1990 && n <= 2100 ? n : null;
};

/** A Sources item → the SAFMR figures Rent keeps in memory, or null when the item is not one of them. */
function rowOf(item) {
    const f = (item && item.fields) || {};
    const zip = zipOf(f.zip);
    const year = yearOf(f.fiscal_year);
    if (!zip || !year) return null;
    const row = { zip, year, metro: typeof f.metro_name === 'string' ? f.metro_name.replace(/\s+/g, ' ').trim().slice(0, 200) : null };
    let any = false;
    for (const [, col] of SIZES) { row[col] = amount(f[col]); if (row[col] != null) any = true; }
    if (!any) return null;
    return row;
}

function createSafmr({ config, s, fetchImpl = globalThis.fetch, log = console, source = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    const client = source || (url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'housing' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'rent', now: s.now });
    const stats = { pulls: 0, applied: 0, removed: 0, last_at: null, last_error: null };
    let byZip = new Map();
    let timer = null;
    let first = null;
    let running = false;

    async function apply(item, t) {
        if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'safmr') return 'hold';
        const row = rowOf(item);
        if (!row) return 'hold';
        const old = byZip.get(row.zip);
        // A ZIP is shown once, with the newest fiscal year HUD gives it; the same figures under a second HUD metro
        // code change nothing.
        if (!old || row.year > old.year) byZip.set(row.zip, row);
        return 'applied';
    }

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
            if (out.applied || out.removed) log.log(`[SAFMR] ${out.applied} ZIP figures updated from OpenVibe.Sources`);
            return out;
        } catch (err) {
            stats.last_error = String((err && err.message) || err).slice(0, 300);
            log.warn(`[SAFMR] pull from OpenVibe.Sources failed: ${stats.last_error}`);
            return { error: stats.last_error };
        } finally { running = false; }
    }

    return {
        enabled: Boolean(client),
        stats,
        pull,
        apply,
        size: () => byZip.size,
        /** HUD's figures for a ZIP, by size, with the fiscal year they carry; null when the ZIP is not known. */
        forZip(zip) {
            const key = zipOf(zip);
            const row = key ? byZip.get(key) : null;
            if (!row) return null;
            return { zip: row.zip, year: row.year, metro: row.metro, rents: Object.fromEntries(SIZES.map(([k, col]) => [k, row[col]])) };
        },
        /** The one-line reference shown next to a place in a known ZIP: never a listing, always dated. */
        reference(zip, beds = 2) {
            const row = this.forZip(zip);
            if (!row) return null;
            const col = SIZES.find(([k]) => k === (beds === 0 ? 'studio' : `b${beds}`));
            const value = col ? row.rents[col[0]] : null;
            if (value == null) return null;
            const size = col[0] === 'studio' ? 'studio' : `${beds}-bedroom`;
            return { amount: value, year: row.year, metro: row.metro, size, text: `HUD fair market rent for a ${size} here: $${value.toLocaleString('en-US')} (FY${row.year})` };
        },
        start() {
            if (timer) return false;
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

module.exports = { createSafmr, rowOf, SOURCE_KEY, SIZES, HUD_URL };
