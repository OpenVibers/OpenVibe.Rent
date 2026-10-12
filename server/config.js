'use strict';

/**
 * OpenVibe.Rent configuration. Every value comes from the environment (production: /etc/openvibe/rent.env, see
 * .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5010);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.rent' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'rent',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-caller limits (server/http/caller-limits.js): the requests one caller (an app, a person, else an
        // address) may make per minute and per hour. The product's own routes add tighter budgets there.
        limits: {
            minute: Math.max(1, int(env.RENT_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.RENT_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (RENT_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.RENT_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:rent:' },

        // The two upstream services "Affordable housing near you" stands on (server/housing/places.js): Nominatim (a
        // place name → coordinates and a bounding box) and HUD's ArcGIS FeatureServer (the five housing layers). Both
        // are open data with published usage policies — Nominatim at most one request a second, HUD small bounded area
        // queries — and server/housing/upstream.js paces every call to one host at a time and caches every answer.
        housing: {
            nominatimUrl: trim(env.RENT_NOMINATIM_URL || 'https://nominatim.openstreetmap.org'),
            hudArcGisUrl: trim(env.RENT_HUD_ARCGIS_URL || 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services'),
            // Identify to Nominatim and HUD with a contact URL, as their policies require; never a browser User-Agent.
            userAgent: env.RENT_USER_AGENT || `OpenVibeRent/0.1 (+${baseUrl})`,
            minIntervalMs: Math.max(0, int(env.RENT_HOUSING_MIN_INTERVAL_MS, 1000)),
            timeoutMs: Math.max(1000, int(env.RENT_HOUSING_TIMEOUT_MS, 25_000)),
            cacheTtlMs: Math.max(60_000, int(env.RENT_HOUSING_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000)),
            maxBoxKm: 50,
            maxResults: 500,
        },

        // FHFA House Price Index, behind "Home prices around here" on the affordable-housing page
        // (server/housing/hpi.js). The ingest respects a 7-day gate, so RENT_HPI_REFRESH_TTL_MS is a floor, not a
        // cadence. Off in tests and wherever RENT_HPI is unset; on in production by default.
        hpi: {
            enabled: env.RENT_HPI != null ? (env.RENT_HPI === 'true' || env.RENT_HPI === '1') : isProduction,
            url: trim(env.RENT_HPI_URL || 'https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv'),
            timeoutMs: Math.max(1000, int(env.RENT_HPI_TIMEOUT_MS, 60_000)),
            refreshTtlMs: Math.max(60_000, int(env.RENT_HPI_REFRESH_TTL_MS, 7 * 24 * 60 * 60 * 1000)),
        },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The audience this service's app, agent and service tokens carry.
        audience: env.RENT_AUDIENCE || 'openvibe.rent',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'rent',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service (server/events-consumer.js). The secret signs a delivery (comma-separated
        // for rotation, 32+ characters each); unset turns POST /internal/events off (503). The url is where the
        // network.account.export_requested and network.account.deleted subscriptions are created at boot, off when
        // unset. Both topics are ADR-033: account export and deletion (server/identity/account-data.js).
        events: {
            secrets: String(env.RENT_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.RENT_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.RENT_EVENTS_ENDPOINT || '',
        },
    };
}

module.exports = { load };
