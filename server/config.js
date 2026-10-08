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
