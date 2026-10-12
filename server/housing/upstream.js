'use strict';

/**
 * The only two hosts OpenVibe.Rent fetches from for "Affordable housing near you": Nominatim (a place name →
 * coordinates and a bounding box) and HUD's ArcGIS FeatureServer (the five housing layers). Both are open data with
 * published usage policies, and this module is what keeps us inside them:
 *
 *   - identify   every request carries RENT_USER_AGENT (an OpenVibe.Rent contact URL), never a browser's
 *   - pace       one request a second to a host, at most: calls to the same host queue behind each other, so the
 *                service as a whole cannot burst at Nominatim however many visitors arrive at once
 *   - cache      every answer is kept in housing_geo_cache for RENT_HOUSING_CACHE_TTL_MS (7 days): a place is
 *                geocoded once, an area is queried once, not once per visitor
 *   - bound      area queries are one envelope of at most about 50 km across, with only the fields we use
 *
 * Only a URL built from the configured base is ever fetched; nothing a caller sends becomes a URL. There are no
 * other outbound calls in this service.
 */

const crypto = require('crypto');
const geo = require('./store');

// An ArcGIS answer for one layer is at most 500 features; keep the byte ceiling above any honest answer but far
// below anything that would let a misbehaving upstream exhaust the process.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

class UpstreamError extends Error {
    constructor(code, detail, { status = 502 } = {}) { super(detail); this.code = code; this.status = status; }
}

/** Serialises calls to one host and keeps at least `minIntervalMs` between the moments they start. */
function createPacer({ minIntervalMs, now = () => Date.now() }) {
    let chain = Promise.resolve();
    let last = -Infinity;
    return {
        run(fn) {
            const p = chain.then(async () => {
                const wait = last + minIntervalMs - now();
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                last = now();
                return fn();
            });
            chain = p.then(() => undefined, () => undefined);
            return p;
        },
    };
}

const keyOf = (q) => String(q).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The query URL for one HUD ArcGIS layer, built only from the configured base and fixed field names (never from
 * caller input): an envelope in WGS84, the fields we use, up to 500 records, geometry returned so a missing LAT/LON
 * attribute still gives a point. Exported so a test can assert the exact shape.
 */
function buildArcGisUrl(baseUrl, service, layer, envelope, outFields) {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${service}/FeatureServer/${layer}/query`;
    url.search = new URLSearchParams({
        where: '1=1',
        geometry: JSON.stringify({
            xmin: envelope.xmin, ymin: envelope.ymin, xmax: envelope.xmax, ymax: envelope.ymax,
            spatialReference: { wkid: 4326 },
        }),
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: outFields.join(','),
        outSR: '4326',
        returnGeometry: 'true',
        resultRecordCount: '500',
        f: 'json',
    }).toString();
    return url;
}

function createUpstream({ config, s, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const housing = config.housing;
    const pacers = new Map();
    const pacerFor = (rawUrl) => {
        const host = new URL(rawUrl).host;
        if (!pacers.has(host)) pacers.set(host, createPacer({ minIntervalMs: housing.minIntervalMs, now }));
        return pacers.get(host);
    };

    /**
     * Fetch a URL built from the configured base (never from caller input), with our User-Agent, a hard timeout and a
     * hard byte ceiling. `label` is what the failure message names: Nominatim for a geocode, HUD for a layer query.
     */
    async function fetchJson(url, init = {}, label = 'the data service') {
        let res;
        try {
            res = await fetchImpl(url.toString(), {
                ...init,
                headers: { 'User-Agent': housing.userAgent, Accept: 'application/json', ...(init.headers || {}) },
                signal: AbortSignal.timeout(housing.timeoutMs),
            });
        } catch (err) {
            throw new UpstreamError('housing.place.upstream', `could not reach ${label} right now (${err && err.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
        }
        if (!res.ok) throw new UpstreamError('housing.place.upstream', `could not reach ${label} right now (${label} answered ${res.status})`);
        let buf;
        try { buf = await res.arrayBuffer(); } catch { throw new UpstreamError('housing.place.upstream', `could not reach ${label} right now (the answer could not be read)`); }
        if (buf.byteLength > MAX_RESPONSE_BYTES) throw new UpstreamError('housing.place.upstream', `could not reach ${label} right now (the answer was too large)`);
        let body;
        try { body = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { throw new UpstreamError('housing.place.upstream', `could not reach ${label} right now (${label} answered something that is not JSON)`); }
        return body;
    }

    async function cached(key, fn) {
        const hit = await geo.cacheGet(s, key);
        if (hit) return { body: hit.body, cached: true, fetched_at: hit.fetched_at };
        const body = await fn();
        const written = await geo.cachePut(s, key, body, housing.cacheTtlMs);
        return { body, cached: false, fetched_at: written.fetched_at };
    }

    /** A place name → up to `limit` matches (Nominatim search), cached for the TTL. */
    function geocode(q, { limit = 1 } = {}) {
        const query = String(q || '').trim().slice(0, 200);
        if (!query) return Promise.reject(new UpstreamError('housing.place.invalid', 'q: a place to search for', { status: 422 }));
        const url = new URL(housing.nominatimUrl);
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
        url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: String(Math.min(Math.max(limit, 1), 5)), addressdetails: '1' }).toString();
        return cached(`nominatim:${keyOf(query)}:${limit}`, () => pacerFor(housing.nominatimUrl).run(() => fetchJson(url, {}, 'the place service')));
    }

    /** One bounded HUD ArcGIS layer query → its features. Cached by the request, so the same area is asked once. */
    function arcGis(service, layer, envelope, outFields) {
        const url = buildArcGisUrl(housing.hudArcGisUrl, service, layer, envelope, outFields);
        const key = `arcgis:${service}/${layer}:${crypto.createHash('sha256').update(url.search).digest('hex')}`;
        return cached(key, () => pacerFor(housing.hudArcGisUrl).run(async () => {
            const body = await fetchJson(url, {}, 'HUD');
            if (body && body.error) {
                const message = body.error && body.error.message ? body.error.message : 'the service refused the query';
                throw new UpstreamError('housing.place.upstream', `could not reach HUD right now (${message})`);
            }
            return body;
        }));
    }

    return { geocode, arcGis, fetchJson, buildArcGisUrl, UpstreamError };
}

module.exports = { createUpstream, createPacer, UpstreamError, buildArcGisUrl, MAX_RESPONSE_BYTES };
