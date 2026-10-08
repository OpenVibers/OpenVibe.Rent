'use strict';

/**
 * The expiry sweep. A listing lasts 30 days; a timer (started by server/index.js, the process entry) marks the ones
 * whose time is up expired, and an expired listing leaves search.
 *
 * The timer is deliberately not part of createApp: a test would then race it, and every test that cares about
 * expiry calls store.expireListings(s) itself, on the store's injected clock.
 */
const store = require('./store');

const DEFAULT_EVERY_MS = 5 * 60_000;

/** Returns { timer, tick }: `timer` is cleared by the process's graceful stop, `tick` is one sweep. */
function startExpiryTimer(s, { log = console, everyMs = DEFAULT_EVERY_MS } = {}) {
    let running = false;
    const tick = async () => {
        if (running) return 0;
        running = true;
        try {
            const n = await store.expireListings(s);
            if (n) log.log(`[OpenVibe.Rent] ${n} listing(s) expired`);
            return n;
        } catch (err) {
            log.error('[OpenVibe.Rent] expiry sweep failed:', err && err.message ? err.message : err);
            return 0;
        } finally {
            running = false;
        }
    };
    const timer = setInterval(tick, everyMs);
    // Never hold the process open on the sweep alone.
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { timer, tick };
}

module.exports = { startExpiryTimer, DEFAULT_EVERY_MS };
