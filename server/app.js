'use strict';

/**
 * OpenVibe.Rent — Express app factory; server/index.js listens, tests build their own instance with a temp database
 * and a mock Network.
 *
 *   /, /listings, /listings/:id, /post, /mine, /saved, /safety, /staff, /updates   the pages (http/pages.js)
 *   /api/v1/*                                         the API (http/api.js)
 *   /auth/*                                           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics  (loopback only)
 *
 * The product's routes are in http/api.js and its pages in http/pages.js; its budgets are in
 * http/caller-limits.js and its listing rules in listings/. The plumbing here (helmet, SSO, legal pages, static
 * assets, the API mount, the 404 and the error handler) stays.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const { createAiClient } = require('openvibe-publishing/ai');
const { createScreen } = require('./listings/screen');
const cache = require('openvibe-shared/cache-policy');

const { createSearchIndex } = require('./search-index');
const { createIndexNow } = require('openvibe-shared/indexnow');
const configLib = require('./config');
const { openStore } = require('./db');
const { createUpstream } = require('./housing/upstream');
const housingStore = require('./housing/store');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createServiceReadiness } = require('./observability');
const { createCallerLimits } = require('./http/caller-limits');
const accountDataLib = require('./identity/account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, now (clock), fetchImpl (Network), log, limitsNow, callerLimits (false: count nobody,
 * tests only), valkey, accountSend (a stand-in for Network's internal routes; tests only)
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const principal = createPrincipal({ config, keys });
    const ctx = { config, s, keys, sso, principal, log };
    // Listing pages in OpenVibe.Search (./search-index.js): every store write names the listing it touched (s.search),
    // and a sweep runs on its own timer once server/index.js starts it.
    // IndexNow: off without INDEXNOW_KEY; a malformed key warns and stays off rather than stopping the site.
    const indexnow = opts.indexnow || (() => {
        const warn = (...a) => (log.warn || console.warn)(...a);
        try { return createIndexNow({ host: config.baseUrl, key: config.indexnow.key, fetch: fetchImpl, log: warn }); } catch (err) {
            warn(`[Rent] ${err.message} — IndexNow is off until INDEXNOW_KEY is fixed`);
            return createIndexNow({ host: config.baseUrl, key: '', fetch: fetchImpl, log: warn });
        }
    })();
    ctx.indexnow = indexnow;
    ctx.search = opts.search || createSearchIndex({ config, s, log, indexnow });
    s.search = ctx.search;

    // The only outbound client the housing feature has (Nominatim + HUD ArcGIS, paced and cached); the pages and the
    // API get it from here. Its own wall clock, not the store's, so the pace between two calls does not depend on an
    // injected test clock. A test injects a stand-in fetch through opts.housingFetchImpl (it must never reach the
    // real Nominatim or HUD hosts from a sandbox).
    ctx.upstream = createUpstream({ config, s, fetchImpl: opts.housingFetchImpl || fetchImpl, log });
    // Drop expired geocode/area answers now and hourly; an expired row is ignored anyway, this only keeps the table
    // small. The interval is unref'd and kept on ctx so the entry point clears it on shutdown (server/index.js).
    ctx.housingPruneTimer = housingStore.startCachePrune(s, { log });
    // HUD's Fair Market Rents from OpenVibe.Sources (server/housing/fair-market-rents.js), for the city pages; a test
    // passes a stand-in source through opts.fmrSource.
    ctx.fmr = require('./housing/fair-market-rents').createFairMarketRents({ config, s, fetchImpl, log, source: opts.fmrSource || null });

    // Account export and deletion (ADR-033, ./identity/account-data.js): the three tables that hold a person's rows.
    // The sender posts to Network's internal export/deletion routes with this service's own client-credentials token;
    // a test injects a stand-in through opts.accountSend.
    const accountData = accountDataLib.create({ db: s.db, log });
    // Without a client secret the service has no way to push a part or a confirmation: the route still answers
    // (bad signature, a forwarded request, no secret), and an event that really arrives asks Events to retry.
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Rent cannot answer account events'); });
    ctx.accountData = accountData;
    ctx.accountSend = accountSend;

    // The AI listing screen (server/listings/screen.js): with OV_AI_INTERNAL_URL and a client secret, Rent asks
    // OpenVibe.AI's rent.screen_listing about each posted or edited listing with its own service token (Network grants
    // rent ai.run.* on rent.*); the answer is for staff. Off otherwise. A test injects a stand-in through opts.ai.
    const aiTokenClient = config.aiUrl && config.oauth.clientSecret ? contracts.serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', scope: 'ai.run.create ai.run.read', fetchImpl,
    }) : null;
    const ai = opts.ai !== undefined ? opts.ai : (aiTokenClient ? createAiClient({ baseUrl: config.aiUrl, tokenClient: aiTokenClient, fetch: fetchImpl }) : null);
    ctx.screen = createScreen({ s, ai, log });
    s.screen = ctx.screen;

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'rent', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'rent', release: release.release });
    app.locals.metrics = metrics.registry;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each flush, stored in this service's telemetry_samples table; /shared, health, readiness and /metrics make
    // none. server/index.js flushes it on stop and keeps the table to 14 days.
    ctx.telemetry = createHttpTelemetry({ service: 'rent', sink: opts.telemetrySink || createPgTelemetrySink({ db: s.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.limits = createCallerLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: opts.callerLimits !== false, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-rent', version: VERSION }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ s, config, release: release.release, valkey, sso });
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    // /auth/me is the navbar's who-is-signed-in read on every page, so it is not counted with sign-ins: 60 page views in 15 minutes made a signed-in visitor look signed out.
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, skip: (req) => req.path === '/me', standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'rent', service: 'rent', host: 'openvibe.rent', name: 'OpenVibe.Rent', profile: 'ugc' })); }

    // ── OpenVibe.Events → this service (loopback only) ──────
    // network.account.export_requested and network.account.deleted (ADR-033), answered by the SDK's consumer. It
    // reads the raw body itself, so it is mounted before any body parser (there is none above it), and nginx answers
    // 404 for /internal/ so this is reachable only on 127.0.0.1.
    app.use('/internal/events', accountData.consumer({ secrets: config.events.secrets, send: accountSend, log }));

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use('/shared', require('openvibe-shared/serve').handler());
    // GET /<key>.txt — the IndexNow key file, only when a key is configured.
    if (indexnow.enabled) app.use(indexnow.keyFile);
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.RENT_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.RENT_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    // OpenVibe.Homes (server/homes/pages.js): the same process, its own host and pages.
    const homesHost = (() => { try { return new URL(config.homes.url).hostname; } catch { return 'openvibe.homes'; } })();
    const homesRoutes = require('./homes/pages').createHomesRoutes(ctx);
    const pageRoutes = createPageRoutes(ctx);
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and the Markdown twins of the public
    // pages, one descriptor and one page set per host, because this process answers on openvibe.rent and
    // openvibe.homes. Entered only for the manifest exactly (the rest of /.well-known/ belongs to the app) and a
    // twin request — a `.md` path, ?format=markdown or an explicit text/markdown preference — because the layer
    // renders pages signed out and Rent's pages are not one page (posting, a person's listings, saved searches, the
    // staff queue). It comes before each host's routes so `/listings/x.md` is not read as a listing called `x.md`;
    // the pages name their own twins in the head and the Link header (server/render/layout.js).
    {
        const agentLayer = require('openvibe-shared/agent-layer');
        const agentPages = require('./agent-pages');
        const agentRouter = (descriptor, router, site, host) => {
            const layer = express.Router();
            agentLayer.mount(layer, { descriptor, render: agentPages.createAgentPages({ router, site, host }).renderPublicPage });
            return (req, res, next) => {
                if (req.path === '/.well-known/agent.json') return layer(req, res, next);
                const p = String(req.path || '');
                if (p.endsWith('.md') || (req.query && req.query.format === 'markdown')
                    || req.accepts(['html', 'text/markdown']) === 'text/markdown') return layer(req, res, next);
                return next();
            };
        };
        const homesAgent = agentRouter(require('./agent-descriptor.homes'), homesRoutes, 'homes', homesHost);
        const rentAgent = agentRouter(require('./agent-descriptor'), pageRoutes, 'rent', new URL(config.baseUrl).hostname);
        app.use((req, res, next) => (req.hostname === homesHost ? homesAgent(req, res, next) : next()));
        app.use(rentAgent);
    }
    app.use((req, res, next) => (req.hostname === homesHost ? homesRoutes(req, res, next) : next()));
    app.use(pageRoutes);
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try <a href="/">the home page</a> or <a href="/updates">the update log</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies.
        log.error('[OpenVibe.Rent]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
