'use strict';
/**
 * Listing pages in OpenVibe.Search (server/search-index.js): a posted listing is one rent.index_document.upserted in
 * the outbox, exactly the contract, with what the public page shows and never the contact link or the poster; an edit
 * is the next revision; hiding, removing, expiring or deleting it is a tombstone (once); renewing an expired listing
 * brings it back; a sweep re-sends nothing that did not change.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { post } = require('./helpers/rent');
const store = require('../server/listings/store');

const DAY = 86_400_000;

(async () => {
    const clock = { t: Date.now() };   // real time: the test's sign-in tokens are issued now
    const t = await boot({ now: () => clock.t });
    const { s, search } = t.ctx;
    const kim = t.network.addUser('kim');
    const outbox = async () => (await s.db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope);
    const valid = (env) => {
        const e = contracts.validate('events.event-envelope@1', env);
        assert.ok(e.valid, `envelope: ${JSON.stringify(e.errors)}`);
        const p = contracts.validate(env.event_type, env.payload);
        assert.ok(p.valid, `${env.event_type}: ${JSON.stringify(p.errors)}`);
        if (env.event_type.endsWith('.upserted')) assert.ok(contracts.validate('search.index-document@1', env.payload).valid);
        assert.strictEqual(env.source, 'rent');
        assert.strictEqual(env.visibility, 'internal');
        return env;
    };
    const last = async () => valid((await outbox()).pop());
    let id;

    try {
        await check('a posted listing is one document with what its public page shows, and never the contact link', async () => {
            const made = await post(t, kim, { title: 'Bright room near the river', kind: 'room', price: 650, currency: 'EUR', city: 'Porto', country: 'PT', neighbourhood: 'Ribeira', bedrooms: 1 });
            assert.strictEqual(made.status, 201, made.text);
            id = made.json().id;
            await search.settle();
            const envs = await outbox();
            assert.strictEqual(envs.length, 1);
            const doc = valid(envs[0]).payload;
            assert.strictEqual(envs[0].event_type, 'rent.index_document.upserted');
            assert.strictEqual(doc.id, id);
            assert.strictEqual(doc.canonical_url, `https://openvibe.rent/listings/${id}`);
            assert.strictEqual(doc.title, 'Bright room near the river');
            assert.match(doc.summary, /^Room · 650 EUR a month · Ribeira, Porto, PT · 1 bedroom/);
            assert.deepStrictEqual(doc.facets, { kind: 'room', country: 'PT', city: 'Porto', currency: 'EUR', period: 'month', bedrooms: 1 });
            assert.deepStrictEqual(doc.indexability, { decision: 'index', reasons: [] });
            const text = JSON.stringify(envs[0]);
            assert.ok(!text.includes('example.com/rooms'), 'the contact link stays off Search');
            assert.ok(!text.includes('usr_'), 'the poster is not in the document');
        });

        await check('an edit is the next revision; a sweep then sends nothing', async () => {
            await store.update(s, id, { title: 'Bright room near the river, bills included' });
            await search.settle();
            const env = await last();
            assert.strictEqual(env.payload.revision, 2);
            assert.match(env.payload.title, /bills included/);
            const before = (await outbox()).length;
            const res = await search.sweep();
            assert.strictEqual(res.listing.sent, 0);
            assert.strictEqual((await outbox()).length, before);
        });

        await check('hidden by staff is a tombstone, restored is a document again', async () => {
            await store.setState(s, id, 'hidden');
            await search.settle();
            let env = await last();
            assert.strictEqual(env.event_type, 'rent.index_document.deleted');
            assert.deepStrictEqual(env.payload, { type: 'listing', id, revision: 3 });
            await store.setState(s, id, 'active');
            await search.settle();
            env = await last();
            assert.strictEqual(env.event_type, 'rent.index_document.upserted');
            assert.strictEqual(env.payload.revision, 4);
        });

        await check('an expired listing leaves Search through the expiry sweep, and renewing brings it back', async () => {
            clock.t += 31 * DAY;
            assert.strictEqual(await store.expireListings(s), 1);
            for (let i = 0; i < 100 && (await last()).event_type !== 'rent.index_document.deleted'; i += 1) await new Promise((r) => setTimeout(r, 50));
            assert.strictEqual((await last()).event_type, 'rent.index_document.deleted', 'the expiry tick swept');
            await store.renew(s, id);
            await search.settle();
            assert.strictEqual((await last()).event_type, 'rent.index_document.upserted');
        });

        await check('a deleted listing is a tombstone, sent once', async () => {
            await store.remove(s, id);
            await search.settle();
            const env = await last();
            assert.strictEqual(env.event_type, 'rent.index_document.deleted');
            assert.strictEqual(env.payload.id, id);
            const before = (await outbox()).length;
            assert.strictEqual((await search.sweep()).listing.removed, 0, 'already a tombstone');
            assert.strictEqual((await outbox()).length, before);
        });

        await check('the relay stays off without the events URL and the client secret; rows wait', async () => {
            const st = await search.status();
            assert.strictEqual(st.enabled, false);
            assert.ok(st.pending > 0);
        });
    } finally {
        await done(t);
    }
})();
