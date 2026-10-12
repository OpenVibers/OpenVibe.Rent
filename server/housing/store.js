'use strict';

/**
 * What the "Affordable housing near you" feature keeps in Rent's own database (migrations/0005_housing_cache.sql):
 * the cache in front of the two upstream services — Nominatim (a place name → coordinates) and HUD's ArcGIS
 * FeatureServer (the five housing layers). Every function takes the store (server/db.js createStore) first; nothing
 * here is a secret, and the cache body is only ever an upstream answer, never a person's data.
 */

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

// ── housing_geo_cache ────────────────────────────────────────
/** A cached upstream answer that has not expired, or null. */
async function cacheGet(s, key) {
    const row = await s.db.maybe('SELECT body, fetched_at, expires_at FROM housing_geo_cache WHERE key = $1', [key]);
    if (!row || row.expires_at <= s.iso()) return null;
    return { body: parse(row.body), fetched_at: row.fetched_at, expires_at: row.expires_at };
}
async function cachePut(s, key, body, ttlMs) {
    const fetchedAt = s.iso();
    const expiresAt = new Date(s.now() + ttlMs).toISOString();
    await s.db.query(
        `INSERT INTO housing_geo_cache (key, body, fetched_at, expires_at) VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(body), fetchedAt, expiresAt]);
    return { fetched_at: fetchedAt, expires_at: expiresAt };
}
/** Drop expired rows (called at boot; the table stays small because every answer is bounded). */
const cachePrune = (s) => s.db.exec('DELETE FROM housing_geo_cache WHERE expires_at <= $1', [s.iso()]);

/**
 * Prune the geo cache now, then hourly: an expired row is ignored anyway, this only keeps the table small. The
 * interval is unref'd so it never holds the process open; the returned timer is what the entry point clears on
 * shutdown (server/index.js).
 */
function startCachePrune(s, { intervalMs = 60 * 60 * 1000, log = console } = {}) {
    const tick = () => Promise.resolve(cachePrune(s)).catch((err) => log.warn('[OpenVibe.Rent] housing cache prune:', err && err.message));
    tick();
    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

module.exports = { cacheGet, cachePut, cachePrune, startCachePrune };
