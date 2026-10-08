'use strict';
/**
 * Reporting a listing and what staff do about it: a signed-in person reports once per listing (never their own,
 * never an app), three distinct reports hide it from search until a member of OpenVibe staff looks, staff read the
 * queue and restore, hide or remove it, and a listing a member of staff restored is not hidden again by the same
 * reports. Reasons and notes are text: they are escaped wherever the queue shows them.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, post } = require('./helpers/rent');
const store = require('../server/listings/store');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const jo = t.network.addUser('jo');
    const ada = t.network.addUser('ada', { role: 'admin' });
    const gil = t.network.addUser('gil', { role: 'global_mod' });
    const pat = t.network.addUser('pat', { role: 'streamer' });
    const nia = t.network.addUser('nia');

    const made = await post(t, kim, { title: 'A flat that is not what it seems', contact_url: '' });
    assert.strictEqual(made.status, 201, made.text);
    const ID = made.json().id;

    const report = (body, o = {}) => t.get(`/api/v1/listings/${ID}/reports`, { as: o.as || sam, json: body || { reason: 'scam' }, headers: { ...SAME, ...(o.headers || {}) } });
    const inSearch = async (id = ID) => (await t.get('/api/v1/listings?limit=60')).json().listings.some((x) => x.id === id);

    await check('a signed-in person reports a listing; the report carries the reason and the note', async () => {
        const r = await report({ reason: 'scam', note: 'They asked for a deposit over the phone.' });
        assert.strictEqual(r.status, 201, r.text);
        const body = r.json();
        assert.match(body.report.id, /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(body.report.reason, 'scam');
        assert.strictEqual(body.report.note, 'They asked for a deposit over the phone.');
        assert.strictEqual(body.report.reporter.type, 'user');
        assert.strictEqual(body.hidden, false, 'one report does not hide anything');
        assert.strictEqual(body.listing.report_count, 1);
        assert.ok(inSearch(), 'still listed');
    });

    await check('one report per reporter per listing; your own listing is not yours to report', async () => {
        const again = await report({ reason: 'wrong' });
        assert.strictEqual(again.status, 409, again.text);
        assert.strictEqual(again.json().code, 'report.duplicate');
        const mine = await report({ reason: 'wrong' }, { as: kim });
        assert.strictEqual(mine.status, 403);
        assert.strictEqual(mine.json().code, 'listing.own');
        assert.strictEqual((await report({ reason: 'nonsense' }, { as: jo })).status, 422, 'the reason is from the list');
        assert.strictEqual((await report({ reason: 'other', note: 'x'.repeat(501) }, { as: jo })).status, 422, 'the note is capped');
    });

    await check('anonymous is refused; an app token cannot report as a person', async () => {
        assert.strictEqual((await t.get(`/api/v1/listings/${ID}/reports`, { json: { reason: 'scam' }, headers: SAME })).status, 401);
        const { signJwt } = require('./helpers/mocks');
        const now = Math.floor(Date.now() / 1000);
        const app = signJwt({
            iss: t.network.url, sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.rent'],
            cap: ['rent.listing.report'], project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0', env: 'production',
            iat: now, exp: now + 300, jti: 'tok_test_app',
        }, t.network.privatePem);
        const byApp = await t.get(`/api/v1/listings/${ID}/reports`, { bearer: app, json: { reason: 'scam' }, headers: SAME });
        assert.strictEqual(byApp.status, 403, byApp.text);
        assert.strictEqual(byApp.json().code, 'rent.person_required');
    });

    await check('the third distinct report hides the listing until staff look', async () => {
        assert.strictEqual((await report({ reason: 'wrong' }, { as: jo })).status, 201);
        const third = await report({ reason: 'offensive', note: 'Says something about the neighbours.' }, { as: pat });
        assert.strictEqual(third.status, 201, third.text);
        assert.strictEqual(third.json().hidden, true);
        assert.strictEqual(third.json().listing.state, 'hidden');
        assert.strictEqual(third.json().listing.report_count, 3);
        assert.strictEqual(await inSearch(), false, 'hidden leaves search');
        assert.strictEqual((await t.get(`/api/v1/listings/${ID}`)).status, 404, '404 for a stranger');
        assert.strictEqual((await t.get(`/api/v1/listings/${ID}`, { as: kim })).status, 200, 'the owner still reads it');
        assert.strictEqual((await report({ reason: 'other' }, { as: nia })).status, 404, 'a hidden listing is not reportable');
        assert.strictEqual((await report({ reason: 'other' })).status, 404, 'even by someone who has not reported it');
    });

    await check('the queue is for staff: a signed-in person who is not staff gets 403, anonymous 401', async () => {
        assert.strictEqual((await t.get('/api/v1/staff/reports')).status, 401);
        assert.strictEqual((await t.get('/api/v1/staff/reports', { as: kim })).status, 403);
        assert.strictEqual((await t.get('/api/v1/staff/reports', { as: kim })).json().code, 'staff.forbidden');
        for (const staff of [ada, gil]) {
            const q = await t.get('/api/v1/staff/reports', { as: staff });
            assert.strictEqual(q.status, 200, q.text);
            const body = q.json();
            assert.strictEqual(body.filter.state, 'hidden');
            assert.strictEqual(body.counts.hidden, 1);
            const item = body.queue.find((x) => x.listing.id === ID);
            assert.ok(item, 'the listing is in the queue');
            assert.strictEqual(item.reports.length, 3);
            assert.deepStrictEqual([...new Set(item.reports.map((x) => x.reason))].sort(), ['offensive', 'scam', 'wrong']);
            assert.ok(item.reports.some((x) => x.note === 'They asked for a deposit over the phone.'));
        }
        assert.strictEqual((await t.get('/api/v1/listings/' + ID + '/state', { as: pat, json: { state: 'active' }, headers: SAME })).status, 403, 'a non-staff role is not staff');
    });

    await check('staff restore it: it is back in search, and the same reports do not hide it again', async () => {
        const restored = await t.get(`/api/v1/listings/${ID}/state`, { as: gil, json: { state: 'active' }, headers: SAME });
        assert.strictEqual(restored.status, 200, restored.text);
        assert.strictEqual(restored.json().state, 'active');
        assert.strictEqual(await inSearch(), true, 'back in search');
        assert.strictEqual((await t.get('/api/v1/staff/reports', { as: gil })).json().counts.hidden, 0);

        const fourth = await report({ reason: 'scam' }, { as: nia });
        assert.strictEqual(fourth.status, 201, 'a listing a member of staff restored can be reported again');
        assert.strictEqual(fourth.json().hidden, false, 'the threshold is crossed once, not on every report past it');
        assert.strictEqual(fourth.json().listing.report_count, 4, 'it is recorded, and staff still see it');
        assert.strictEqual(await inSearch(), true);
        const active = await t.get('/api/v1/staff/reports?state=active', { as: gil });
        assert.strictEqual(active.json().queue.some((x) => x.listing.id === ID), true, 'and it stays in the queue for staff');
    });

    await check('staff remove it: gone from search, not renewable and not editable', async () => {
        const removed = await t.get(`/api/v1/listings/${ID}/state`, { as: ada, json: { state: 'removed' }, headers: SAME });
        assert.strictEqual(removed.status, 200);
        assert.strictEqual(removed.json().state, 'removed');
        assert.strictEqual(await inSearch(), false);
        assert.strictEqual((await t.get(`/api/v1/listings/${ID}`, { as: kim })).status, 200, 'the owner can still see why');
        assert.strictEqual((await t.get(`/api/v1/listings/${ID}/renew`, { as: kim, json: {}, headers: SAME })).status, 409);
        assert.strictEqual((await t.get(`/api/v1/listings/${ID}`, { method: 'PATCH', as: kim, json: { title: 'new' }, headers: SAME })).status, 409);
        assert.strictEqual((await t.get(`/api/v1/listings/${ID}/state`, { as: ada, json: { state: 'sold' }, headers: SAME })).status, 422, 'only the three states');
    });

    await check('the staff page shows the queue, with what people wrote escaped', async () => {
        const other = await post(t, kim, { title: 'Another one <b>bold</b>', contact_url: '' });
        assert.strictEqual(other.status, 201, other.text);
        const oid = other.json().id;
        const r = await t.get(`/api/v1/listings/${oid}/reports`, { as: sam, json: { reason: 'wrong', note: '<script>alert(1)</script> and "quotes"' }, headers: SAME });
        assert.strictEqual(r.status, 201, r.text);

        const page = await t.get('/staff?state=active', { as: gil });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.ok(page.text.includes(`/listings/${oid}`), 'the reported listing is linked');
        assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the note is escaped');
        assert.ok(!page.text.includes('<script>alert(1)</script>'), 'the raw note is not on the page');

        assert.strictEqual((await t.get('/staff', { as: kim })).status, 403);
        assert.strictEqual((await t.get('/staff')).status, 401);
        // And the same act through the page's form.
        const viaForm = await t.get(`/listings/${oid}/state`, { as: ada, form: { state: 'removed' }, headers: SAME });
        assert.strictEqual(viaForm.status, 303);
        assert.strictEqual((await t.get(`/api/v1/listings/${oid}`, { as: ada })).json().state, 'removed');
    });

    await check('reporting is limited per caller, on the same budget as the form', async () => {
        const limits = await boot({ callerLimits: true });
        try {
            const u = limits.network.addUser('heavy');
            const rows = [];
            for (let i = 0; i < 12; i++) {
                rows.push(await store.insert(limits.ctx.s, {
                    id: limits.ctx.s.newId('rnt'), owner: 'user:usr_01JABCDEFGHJKMNPQRSTVWXYZ0', kind: 'room',
                    title: `Listing ${i}`, description: 'x', price: 10, currency: 'EUR', period: 'month',
                    city: 'Lisbon', region: null, country: 'PT', neighbourhood: null, bedrooms: null,
                    available_from: null, contact_url: null, state: 'active',
                    created_at: limits.ctx.s.iso(), expires_at: limits.ctx.s.iso(),
                }));
            }
            let refused = null;
            for (const row of rows) {
                const r = await limits.get(`/api/v1/listings/${row.id}/reports`, { as: u, json: { reason: 'wrong' }, headers: SAME });
                if (r.status === 429) { refused = r; break; }
                assert.strictEqual(r.status, 201, r.text);
            }
            assert.ok(refused, 'the 11th report in a minute is refused');
            assert.strictEqual(refused.json().code, 'rate_limited');
            assert.ok(Number(refused.headers.get('retry-after')) > 0);
        } finally {
            await limits.close();
        }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
