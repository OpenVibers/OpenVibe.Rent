'use strict';

/**
 * The listing screen (the plan's Rent composition: Sources + Search + Watch + AI): every active listing a person posts
 * or edits is read by OpenVibe.AI's `rent.screen_listing` workflow for the signs of a rental scam — payment before a
 * viewing, wire or gift-card payment, an owner who cannot show the place, pressure, identity documents up front, a
 * conversation pushed off the site. The answer is for staff only: `review` puts the listing in the staff page's
 * "flagged" queue with the signs and the quoted words; nothing is hidden, refused or shown to anyone else, and a person
 * can always post. Staff decide (Looks fine, Hide, Remove) exactly as for a report.
 *
 * Every store write names the listing it touched (store.js calls s.screen.touch(id)); touched listings are screened a
 * moment later, never inside the request. A listing is screened again only when what it says changed (a hash of the
 * words and the price a renter reads), so a renewal or a report never costs a run. A run that fails is logged and
 * retried by the sweep, which also covers listings posted while OpenVibe.AI was unreachable.
 *
 * Off without OV_AI_INTERNAL_URL and a client secret (server/app.js passes no `ai`): then touch() does nothing.
 */
const crypto = require('crypto');
const store = require('./store');

const FLUSH_MS = 2_000;
const START_DELAY_MS = 90_000;
const INTERVAL_MS = 30 * 60_000;
const SWEEP_LIMIT = 25;
const SIGNALS = ['payment_before_viewing', 'unusual_payment', 'owner_unavailable', 'pressure', 'personal_data_request', 'off_platform_only'];

/** What a renter reads, hashed: the screen runs again only when this changes. */
function contentHash(row) {
    const parts = [row.kind, row.title, row.description, row.price, row.currency, row.period, row.city, row.region, row.country, row.neighbourhood];
    return crypto.createHash('sha256').update(JSON.stringify(parts.map((v) => (v == null ? null : String(v))))).digest('hex').slice(0, 32);
}

/** The workflow's input: the listing as a renter sees it (never the poster, never the contact link). */
function screenInput(row) {
    return {
        listing: {
            title: String(row.title || '').slice(0, 200),
            kind: String(row.kind || '').slice(0, 40),
            price: row.price == null ? undefined : Number(row.price),
            currency: row.currency ? String(row.currency).slice(0, 8) : undefined,
            period: row.period ? String(row.period).slice(0, 20) : undefined,
            city: row.city ? String(row.city).slice(0, 120) : undefined,
            country: row.country ? String(row.country).slice(0, 8) : undefined,
            description: String(row.description || '').slice(0, 5000),
        },
    };
}

const norm = (t) => String(t == null ? '' : t).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

/**
 * Bound, validate and ground the workflow's output in the listing it read. A quote counts only when its words really
 * are in the listing's title or description (a model may paraphrase or invent one), and a sign counts only when a
 * grounded quote is labelled with it: staff never read a sign the text does not show. (On its first production run
 * the local model named all six signs for a text that showed three.) With no grounded sign the answer is allow.
 */
function readOutput(output, row = null) {
    const o = output && typeof output === 'object' ? output : {};
    const text = row ? norm(`${row.title || ''}\n${row.description || ''}`) : null;
    const spans = (Array.isArray(o.spans) ? o.spans : [])
        .filter((x) => x && typeof x.quote === 'string' && norm(x.quote))
        .filter((x) => !text || text.includes(norm(x.quote)))
        .slice(0, 10)
        .map((x) => ({ quote: x.quote.trim().slice(0, 300), signal: SIGNALS.includes(x.signal) ? x.signal : null }));
    const backed = new Set(spans.map((x) => x.signal).filter(Boolean));
    const signals = SIGNALS.filter((x) => backed.has(x));
    const action = o.action === 'review' && signals.length ? 'review' : 'allow';
    const rationale = typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 1000) : '';
    return { action, signals: action === 'review' ? signals : [], spans: action === 'review' ? spans : [], rationale };
}

function createScreen({ s, ai = null, log = console }) {
    const pending = new Set();
    const timers = [];
    let flushTimer = null;
    let flushing = null;

    /** Screen one listing now. Returns 'off' | 'gone' | 'inactive' | 'unchanged' | 'allow' | 'review' | 'failed'. */
    async function screenId(id) {
        if (!ai) return 'off';
        const row = await store.get(s, id);
        if (!row) return 'gone';
        if (row.state !== 'active') return 'inactive';
        const hash = contentHash(row);
        const prev = await store.getCheck(s, id);
        if (prev && prev.content_hash === hash) {
            if (prev.checked_at < row.updated_at) await store.recheckUnchanged(s, id);
            return 'unchanged';
        }
        let run;
        try {
            run = await ai.run('rent.screen_listing', screenInput(row), {
                target: { service: 'rent', type: 'listing', id: row.id },
                idempotencyKey: `rent-screen-${row.id}-${hash}`,
            });
        } catch (err) {
            log.warn(`[Screen] listing ${id}: ${(err && err.message) || err}`);
            return 'failed';
        }
        const out = readOutput(run && run.output, row);
        await store.putCheck(s, { listingId: row.id, contentHash: hash, ...out, runId: (run && run.runId) || null });
        if (out.action === 'review') log.log(`[Screen] listing ${row.id} flagged for staff: ${out.signals.join(', ')}`);
        return out.action;
    }

    async function flush() {
        flushTimer = null;
        if (flushing) await flushing;
        const ids = [...pending];
        pending.clear();
        flushing = (async () => {
            for (const id of ids) {
                try { await screenId(id); } catch (err) { log.warn(`[Screen] listing ${id}: ${(err && err.message) || err}`); }
            }
        })();
        try { await flushing; } finally { flushing = null; }
    }

    /** A store write changed this listing: screen it shortly (never awaited by the request, never fatal). */
    function touch(id) {
        if (!ai || !id) return;
        pending.add(String(id));
        if (!flushTimer) {
            flushTimer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_MS);
            if (flushTimer.unref) flushTimer.unref();
        }
    }

    /** Active listings never screened, or changed since (a run failed, or AI was unreachable): a few at a time. */
    async function sweep() {
        if (!ai) return { screened: 0 };
        const ids = await store.unscreenedActive(s, SWEEP_LIMIT);
        let screened = 0;
        for (const id of ids) {
            const r = await screenId(id).catch(() => 'failed');
            if (r === 'allow' || r === 'review') screened++;
        }
        return { screened, seen: ids.length };
    }
    const quietly = () => { sweep().catch((err) => log.warn(`[Screen] sweep failed: ${(err && err.message) || err}`)); };

    function start() {
        if (!ai || timers.length) return false;
        const kick = setTimeout(quietly, START_DELAY_MS);
        const tick = setInterval(quietly, INTERVAL_MS);
        for (const t of [kick, tick]) if (t.unref) t.unref();
        timers.push(kick, tick);
        return true;
    }

    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    }

    /** Wait for touched listings to be screened (tests, and a graceful stop). */
    async function settle() {
        if (flushTimer) { clearTimeout(flushTimer); await flush(); }
        if (flushing) await flushing;
    }

    return { enabled: !!ai, touch, screenId, sweep, settle, start, stop };
}

module.exports = { createScreen, contentHash, screenInput, readOutput, SIGNALS };
