'use strict';
/**
 * The AI listing screen (server/listings/screen.js): each listing a person posts or edits is read by OpenVibe.AI's
 * rent.screen_listing (a stand-in here) for the signs of a rental scam, never with the poster or the contact link; a
 * `review` puts it in the staff page's flagged queue with the signs and the quoted words, and nothing else changes for
 * anyone; staff mark it "Looks fine"; the same words are never screened twice, new words are; a failed run is picked
 * up by the sweep; the output is bounded; without OpenVibe.AI nothing is screened.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, post } = require('./helpers/rent');
const store = require('../server/listings/store');
const { createScreen, readOutput } = require('../server/listings/screen');

const SCAM = 'I am abroad for work so I cannot show it. Send the deposit by wire transfer today and I will mail you the keys.';

(async () => {
    const calls = [];
    let failing = false;
    const ai = {
        run: async (key, input, opts) => {
            calls.push({ key, input, opts });
            if (failing) throw new Error('AI unreachable');
            const scam = /wire transfer/.test(input.listing.description);
            return {
                runId: `run_${calls.length}`,
                output: scam
                    ? { action: 'review', signals: ['owner_unavailable', 'payment_before_viewing', 'unusual_payment', 'made_up'], rationale: 'Pay by wire before any viewing; the owner is away.', spans: [{ quote: 'Send the deposit by wire transfer today', signal: 'payment_before_viewing' }] }
                    : { action: 'allow', signals: ['none'], rationale: '', spans: [] },
            };
        },
    };
    const t = await boot({ ai });
    const s = t.ctx.s;
    const kim = t.network.addUser('kim');
    const ada = t.network.addUser('ada', { role: 'admin' });
    let fine;
    let scam;

    try {
        await check('a posted listing is screened once, as a renter reads it: never the poster or the contact link', async () => {
            fine = (await post(t, kim)).json();
            await t.ctx.screen.settle();
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].key, 'rent.screen_listing');
            assert.strictEqual(calls[0].input.listing.title, 'Sunny two-bedroom flat near the park');
            const sent = JSON.stringify(calls[0].input);
            assert.ok(!sent.includes('example.com/rooms') && !sent.includes('usr_'), 'no contact link and no poster go to AI');
            assert.deepStrictEqual(calls[0].opts.target, { service: 'rent', type: 'listing', id: fine.id });
            assert.match(calls[0].opts.idempotencyKey, new RegExp(`^rent-screen-${fine.id}-[0-9a-f]{32}$`));
            const c = await store.getCheck(s, fine.id);
            assert.strictEqual(c.action, 'allow');
            assert.deepStrictEqual(c.signals, []);
            assert.strictEqual(await store.countFlagged(s), 0);
        });

        await check('a listing with scam signs is flagged for staff with the signs and the quoted words; it stays listed', async () => {
            scam = (await post(t, kim, { title: 'Room in the centre', description: SCAM })).json();
            await t.ctx.screen.settle();
            const c = await store.getCheck(s, scam.id);
            assert.strictEqual(c.action, 'review');
            assert.deepStrictEqual(c.signals, ['owner_unavailable', 'payment_before_viewing', 'unusual_payment'], 'an unknown sign is dropped');
            assert.strictEqual(await store.countFlagged(s), 1);
            assert.strictEqual((await t.get(`/api/v1/listings/${scam.id}`)).status, 200, 'still public: a flag only asks staff to look');
            const page = await t.get('/staff?state=flagged', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Room in the centre'));
            assert.ok(page.text.includes('payment before a viewing') && page.text.includes('an owner who cannot show the place'));
            assert.ok(page.text.includes('Send the deposit by wire transfer today'), 'the quoted words');
            assert.ok(page.text.includes(`action="/listings/${scam.id}/check"`), 'Looks fine');
            assert.ok(!page.text.includes('Sunny two-bedroom flat'), 'an allowed listing is not in the flagged queue');
            assert.ok((await t.get('/staff', { as: ada })).text.includes('1 flagged by the AI screen'));
        });

        await check('only staff see the flagged queue or mark a listing reviewed', async () => {
            assert.strictEqual((await t.get('/staff?state=flagged', { as: kim })).status, 403);
            assert.strictEqual((await t.get(`/listings/${scam.id}/check`, { as: kim, method: 'POST', form: {}, headers: SAME })).status, 403);
            assert.strictEqual(await store.countFlagged(s), 1);
        });

        await check('Looks fine takes it out of the queue; the same words are not screened again', async () => {
            const r = await t.get(`/listings/${scam.id}/check`, { as: ada, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(r.status, 303);
            assert.strictEqual(await store.countFlagged(s), 0);
            assert.match((await store.getCheck(s, scam.id)).reviewed_by, /^user:usr_/);
            const before = calls.length;
            await store.update(s, scam.id, { bedrooms: 1 });   // not something the screen reads: same words
            await t.ctx.screen.settle();
            assert.strictEqual(calls.length, before, 'unchanged words: no run');
            assert.strictEqual(await store.countFlagged(s), 0, 'and the review stands');
            assert.deepStrictEqual(await store.unscreenedActive(s, 10), [], 'nor does the sweep pick it up');
        });

        await check('new words are screened again, and a new flag is unreviewed', async () => {
            await store.update(s, scam.id, { description: `${SCAM} Also, no calls please.` });
            await t.ctx.screen.settle();
            assert.strictEqual(calls[calls.length - 1].input.listing.description.endsWith('no calls please.'), true);
            assert.strictEqual(await store.countFlagged(s), 1);
        });

        await check('a failed run leaves no check; the sweep screens the listing once AI answers again', async () => {
            failing = true;
            const late = (await post(t, kim, { title: 'Parking space downtown', kind: 'parking', description: 'Covered space, monthly.' })).json();
            await t.ctx.screen.settle();
            assert.strictEqual(await store.getCheck(s, late.id), null);
            assert.deepStrictEqual(await store.unscreenedActive(s, 10), [late.id]);
            failing = false;
            const out = await t.ctx.screen.sweep();
            assert.deepStrictEqual(out, { screened: 1, seen: 1 });
            assert.strictEqual((await store.getCheck(s, late.id)).action, 'allow');
        });

        await check('the output is bounded: review without a known sign is allow; quotes are trimmed and capped', () => {
            assert.deepStrictEqual(readOutput({ action: 'review', signals: ['none'] }), { action: 'allow', signals: [], spans: [], rationale: '' });
            assert.strictEqual(readOutput(null).action, 'allow');
            const many = readOutput({ action: 'review', signals: ['pressure'], spans: Array.from({ length: 30 }, () => ({ quote: ` ${'x'.repeat(400)} `, signal: 'nope' })) });
            assert.strictEqual(many.spans.length, 10);
            assert.strictEqual(many.spans[0].quote.length, 300);
            assert.strictEqual(many.spans[0].signal, null);
        });

        await check('without OpenVibe.AI nothing is screened and nothing starts', async () => {
            const off = createScreen({ s, ai: null });
            off.touch(fine.id);
            assert.strictEqual(off.enabled, false);
            assert.strictEqual(off.start(), false);
            assert.deepStrictEqual(await off.sweep(), { screened: 0 });
            assert.strictEqual(await off.screenId(fine.id), 'off');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
