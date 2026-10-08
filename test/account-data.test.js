'use strict';
/**
 * ADR-033: Rent's part of an account export (listings, reports and saved searches) and of an account deletion,
 * applied through the service's own /internal/events route with a stand-in Network. Real rows are made through the
 * service's provider (server/listings/service.js) and store (server/listings/store.js), the signed delivery is
 * answered by openvibe-sdk/account-data, and the part only ever carries person A's rows. A redelivery erases nothing
 * twice, and the route refuses a bad signature and a forwarded request.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const rentStore = require('../server/listings/store');
const rentService = require('../server/listings/service');
const listings = require('../server/listings/listings');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const OLD = 'usr_01JZ0000000000000000000MRG';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
// Fixture secrets, built so they never look like a real key to a scanner.
const SECRET = `whsec_${'fixture'.repeat(6)}`;
const WRONG = `whsec_${'mismatch'.repeat(5)}`;

const exportEvent = { event_id: 'evt_01JZ0000000000000000000E01', event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: 'evt_01JZ0000000000000000000D01', event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [OLD] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

/** A stand-in for Network's internal routes: the token endpoint, the export part and the deletion confirmation. */
async function startNetworkStub({ partStatus = 201, confirmStatus = 201 } = {}) {
    const calls = [];
    const statusOf = (v) => (typeof v === 'function' ? v() : v);
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_rent', token_type: 'Bearer', expires_in: 300, scope: 'openvibe.network' });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(req.url.includes('/parts') ? statusOf(partStatus) : statusOf(confirmStatus), {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/** A listing's fields, as the form and the API validate them (server/listings/listings.js validate). */
const fields = (title) => ({
    kind: 'apartment', title, description: `A quiet place: ${title}`,
    price: 1200, currency: 'USD', period: 'month',
    city: 'Shoreditch', region: null, country: 'GB', neighbourhood: null,
    bedrooms: 2, availableFrom: null, contactUrl: null,
});

/** Post a listing for one person, through the service the API writes with (server/listings/service.js). */
async function makeListing(t, subject, title) {
    const r = await rentService.create(t.ctx.s, `user:${subject}`, fields(title));
    assert.ok(r.ok, `listing for ${subject}: ${r.error || r.code || ''}`);
    return r.row;
}

/** Save one search for a person, through the store the API writes with (server/listings/store.js). */
function makeSearch(t, subject, city) {
    const s = t.ctx.s;
    const filters = listings.normalizeFilters({ city });
    return rentStore.saveSearch(s, { id: s.newId('ssv'), subject: `user:${subject}`, filters, key: listings.filtersKey(filters), createdAt: s.iso() });
}

/** File one report, through the store the API writes with (server/listings/store.js). */
async function makeReport(t, listingId, subject, note) {
    const s = t.ctx.s;
    const r = await rentStore.addReport(s, listingId, { id: s.newId('rpt'), reporter: `user:${subject}`, reason: 'scam', note, createdAt: s.iso() });
    assert.ok(r.report, `report by ${subject}: ${r.error || ''}`);
    return r.report;
}

/**
 * A listing, a saved search and a report each for A and B. The reports cross: A's is on B's listing and B's is on
 * A's — so A's part must carry A's report and not B's, and deleting A takes B's report on A's listing with it
 * (rent_reports.listing_id REFERENCES rent_listings(id) ON DELETE CASCADE), which is the documented cascade.
 */
async function seed(t) {
    const a = await makeListing(t, A, 'person-a');
    const b = await makeListing(t, B, 'person-b');
    await makeSearch(t, A, 'Aton');
    await makeSearch(t, B, 'Bville');
    await makeReport(t, b.id, A, 'a-report-note');
    await makeReport(t, a.id, B, 'b-report-note');
    return { a, b };
}

(async () => {
    await check('an export part carries only the person\'s listings, reports and saved searches, and no secret', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'rent', clientSecret: 'rent-secret' });
        const t = await boot({ env: { RENT_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            await seed(t);

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'exported');

            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_rent', 'with this service\'s own token');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['listings.json', 'reports.json', 'saved_searches.json']);
            const body = JSON.stringify(part.body);
            assert.ok(body.includes('person-a'), 'person A\'s listing');
            assert.ok(body.includes('a-report-note'), 'person A\'s report');
            assert.ok(body.includes('Aton'), 'person A\'s saved search');
            assert.ok(!body.includes('person-b'), 'nobody else\'s listing');
            assert.ok(!body.includes('b-report-note'), 'nobody else\'s report');
            assert.ok(!body.includes('Bville'), 'nobody else\'s saved search');
            assert.ok(!/token|secret|password/i.test(body), 'no secret is exported');
        } finally { await t.close(); await stub.close(); }
    });

    await check('a deletion erases the person and their aliases once, keeps someone else, and confirms with counts', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'rent', clientSecret: 'rent-secret' });
        const t = await boot({ env: { RENT_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const { a } = await seed(t);
            const count = async (sql, subject) => Number(await t.ctx.s.db.value(sql, [`user:${subject}`]));
            const listingsFor = (subject) => count('SELECT count(*)::int FROM rent_listings WHERE owner = $1', subject);

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(await listingsFor(A), 0, 'the person\'s listing is gone');
            assert.strictEqual(await count('SELECT count(*)::int FROM rent_reports WHERE reporter = $1', A), 0, 'the person\'s report is gone');
            assert.strictEqual(await count('SELECT count(*)::int FROM rent_saved_searches WHERE subject = $1', A), 0, 'the person\'s saved search is gone');
            assert.strictEqual(await listingsFor(B), 1, 'someone else\'s listing stays');
            assert.strictEqual(await count('SELECT count(*)::int FROM rent_saved_searches WHERE subject = $1', B), 1, 'someone else\'s saved search stays');
            // The report B left on A's listing cascades away with the listing it named.
            assert.strictEqual(await t.ctx.s.db.value("SELECT count(*)::int FROM rent_reports WHERE listing_id = $1", [a.id]), 0);

            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.deepStrictEqual(confirmation.body.erased, { rent_listings: 1, rent_reports: 1, rent_saved_searches: 1 });
            assert.deepStrictEqual(confirmation.body.retained, {});
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));

            // A redelivery must not erase again: rows written after the deletion stay.
            await makeListing(t, A, 'written-later');
            const again = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json().outcome, 'unchanged');
            assert.strictEqual(await listingsFor(A), 1, 'nothing was erased twice');
        } finally { await t.close(); await stub.close(); }
    });

    await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'rent', clientSecret: 'rent-secret' });
        const t = await boot({ env: { RENT_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);

            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        } finally { await t.close(); await stub.close(); }
    });

    done();
})();
