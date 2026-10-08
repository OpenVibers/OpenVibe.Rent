'use strict';

/**
 * OpenVibe.Rent — process entry. `node server/index.js`
 * Listens on PORT (5010) behind nginx (deploy/).
 *
 * The expiry sweep (server/listings/expiry.js) is started here and nowhere else: a listing's 30 days are marked
 * expired by a timer, not by a page render, so a request never does that work and a test never races it.
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startExpiryTimer } = require('./listings/expiry');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the timers clear, the Events subscriptions stop,
 * the JWKS refresher stops and the store closes. Exported so a test can inject `exit` and `signals: false`. `extra` is
 * what the product adds (the Events subscriptions); a test that passes none keeps the skeleton's order.
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Rent', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [() => { for (const t of timers) clearInterval(t); }, () => ctx.keys.client.stop(), () => ctx.s.close(), ...extra],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Rent] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.keys.client.start();

    // One sweep at boot (a restart must not leave a stale listing up a moment longer than it should), then a timer.
    const expiry = startExpiryTimer(ctx.s);
    await expiry.tick();

    // Subscribe to the two ADR-033 topics at OpenVibe.Events (idempotent; off without RENT_EVENTS_URL and
    // RENT_EVENTS_SECRET). The consumer itself is mounted in server/app.js.
    const subscriptions = require('./events-consumer').startSubscriptions({ config, port: config.port, secret: config.events.secrets[0] || '' });
    const extra = [() => { if (subscriptions) subscriptions.stop(); }];
    createLifecycle({ server, ctx, timers: [expiry.timer], extra });
    return { server, ctx, expiry };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Rent] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
