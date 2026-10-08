'use strict';
/**
 * Posting a listing, through the API: it takes a signed-in person (never an app), a session write must come from
 * openvibe.rent itself, the field rules are enforced (kind, price, currency, country, period, contact URL) and a
 * house number with a street is refused everywhere it could hide — title, description, city, region, neighbourhood.
 * A person may have 10 active listings and post 5 a day, each listing lasts 30 days, its owner may edit, renew,
 * hide or delete it and nobody else may, and a hostile title stays text everywhere it is shown.
 *
 * The caps and the expiry are exercised against the store's own functions rather than the clock: a token is
 * verified against the real clock, so a test that jumped the store's clock a day ahead would be testing an expired
 * session, not a daily cap.
 */
const assert = require('assert');
const { signJwt } = require('./helpers/mocks');
const { boot, check, done } = require('./helpers/boot');
const { SAME, listing, post } = require('./helpers/rent');

const RNT = /^rnt_[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = 86_400_000;
const LONG_AGO = '2020-01-01T00:00:00.000Z';

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    // The caps get a person of their own, so how many listings another check left behind cannot change them.
    const pat = t.network.addUser('pat');

    /** Send every row this person posted back in time, so a new UTC day begins for them. */
    const newDay = (user) => t.ctx.s.db.query('UPDATE rent_listings SET created_at = $2 WHERE owner = $1', [`user:${user.subject}`, LONG_AGO]);

    await check('posting needs a signed-in person: anonymous is 401, an app token is 403', async () => {
        const anon = await t.get('/api/v1/listings', { json: listing(), headers: SAME });
        assert.strictEqual(anon.status, 401, anon.text);
        assert.strictEqual(anon.json().code, 'token.required');

        const now = Math.floor(Date.now() / 1000);
        const app = signJwt({
            iss: t.network.url, sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.rent'],
            cap: ['rent.listing.create'], project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0', env: 'production',
            iat: now, exp: now + 300, jti: 'tok_test_app',
        }, t.network.privatePem);
        const byApp = await t.get('/api/v1/listings', { bearer: app, json: listing(), headers: SAME });
        assert.strictEqual(byApp.status, 403, byApp.text);
        assert.strictEqual(byApp.json().code, 'rent.person_required');
    });

    await check('a session write must come from this site; a Bearer write need not', async () => {
        const cross = await post(t, kim, {}, { headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 403);
        assert.strictEqual(cross.json().code, 'request.cross_site');
        const bare = await t.get('/api/v1/listings', { as: kim, json: listing() });
        assert.strictEqual(bare.status, 403, 'no fetch metadata and no Origin: refused');
        const bearer = await t.get('/api/v1/listings', { bearer: t.network.userToken(kim), json: listing() });
        assert.strictEqual(bearer.status, 201, bearer.text);
        await t.get(`/api/v1/listings/${bearer.json().id}`, { method: 'DELETE', as: kim, headers: SAME });
    });

    let id = null;
    await check('a listing is posted: rnt_ id, active, a 30-day expiry, and its own words back', async () => {
        const r = await post(t, kim);
        assert.strictEqual(r.status, 201, r.text);
        const made = r.json();
        assert.match(made.id, RNT);
        id = made.id;
        assert.strictEqual(r.headers.get('location'), `/api/v1/listings/${id}`);
        assert.strictEqual(made.state, 'active');
        assert.strictEqual(made.kind, 'apartment');
        assert.strictEqual(made.price, 1200);
        assert.strictEqual(made.currency, 'EUR');
        assert.strictEqual(made.country, 'PT');
        assert.strictEqual(made.neighbourhood, 'Alfama');
        assert.strictEqual(made.contact_url, 'https://example.com/rooms/1', 'the owner sees their own contact link');
        assert.strictEqual(Date.parse(made.expires_at) - Date.parse(made.created_at), 30 * DAY);
        assert.strictEqual(made.report_count, 0);
    });

    await check('the fields are checked: kind, title, price, currency, country, period, contact URL', async () => {
        const bad = async (over, expect) => {
            const r = await post(t, kim, over);
            assert.strictEqual(r.status, 422, `${JSON.stringify(over)} → ${r.status} ${r.text.slice(0, 140)}`);
            assert.match(r.json().detail, expect, JSON.stringify(over));
        };
        await bad({ kind: 'castle' }, /kind/);
        await bad({ title: '   ' }, /title/);
        await bad({ title: 'x'.repeat(121) }, /title/);
        await bad({ description: '' }, /description/);
        await bad({ description: 'x'.repeat(4001) }, /description/);
        await bad({ price: 0 }, /price/);
        await bad({ price: -5 }, /price/);
        await bad({ price: 'lots' }, /price/);
        await bad({ price: 2e9 }, /price/);
        await bad({ currency: 'USDX' }, /currency/);
        await bad({ currency: 'BTC' }, /currency/);
        await bad({ country: 'ZZ' }, /country/);
        await bad({ country: 'Portugal' }, /country/);
        await bad({ period: 'fortnight' }, /period/);
        await bad({ contact_url: 'http://example.com/x' }, /contact_url/);
        await bad({ contact_url: 'javascript:alert(1)' }, /contact_url/);
        await bad({ contact_url: 'mailto:not-an-address' }, /contact_url/);
        await bad({ available_from: '31-12-2026' }, /available_from/);
        await bad({ bedrooms: 'four' }, /bedrooms/);
        await bad({ bedrooms: '51' }, /bedrooms/);
    });

    await check('lower-case currency and country are accepted and normalised', async () => {
        const r = await post(t, kim, { currency: 'usd', country: 'us', period: 'Month', kind: 'Room' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().currency, 'USD');
        assert.strictEqual(r.json().country, 'US');
        assert.strictEqual(r.json().period, 'month');
        assert.strictEqual(r.json().kind, 'room');
        assert.strictEqual((await t.get(`/api/v1/listings/${r.json().id}`, { method: 'DELETE', as: kim, headers: SAME })).status, 204);
    });

    await check('a street address is refused, in every place field, with a message that says what to write', async () => {
        for (const [field, value] of [
            ['neighbourhood', '12 Rue de la Paix'],
            ['neighbourhood', '221B Baker Street'],
            ['neighbourhood', 'Flat 3, 12 High Street'],
            ['neighbourhood', 'Hauptstraße 12'],
            ['neighbourhood', '#4 Cherry Lane'],
            ['neighbourhood', 'Unit 5 / 22 Main Rd'],
            ['city', '12 High Street'],
            ['region', 'Rue de la Paix 12'],
            ['title', 'Flat at 12 Rue de la Paix'],
            ['description', 'Come to 221B Baker Street, second floor.'],
        ]) {
            const r = await post(t, kim, { [field]: value });
            assert.strictEqual(r.status, 422, `${field}: ${value} → ${r.status} ${r.text.slice(0, 120)}`);
            assert.strictEqual(r.json().code, 'listing.address_refused', `${field}: ${value}`);
            assert.match(r.json().detail, /street address/);
            assert.match(r.json().detail, new RegExp(`^${field}:`), `${field}: names the field`);
        }
        // And the areas a person really writes are accepted.
        for (const area of ['Shoreditch', 'Le Marais', 'Kreuzberg', 'Greenwich Village', 'Northern Quarter', 'Old Town']) {
            const r = await post(t, kim, { neighbourhood: area });
            assert.strictEqual(r.status, 201, `${area} → ${r.status} ${r.text.slice(0, 120)}`);
            await t.get(`/api/v1/listings/${r.json().id}`, { method: 'DELETE', as: kim, headers: SAME });
        }
    });

    await check('the cap: 5 new listings a day, then 10 active ones, then no more', async () => {
        const store_ = require('../server/listings/store');
        const activeCount = (user) => store_.countActiveByOwner(t.ctx.s, `user:${user.subject}`);
        for (let i = 1; i <= 5; i++) {
            const r = await post(t, pat, { title: `Day one listing ${i}` });
            assert.strictEqual(r.status, 201, `listing ${i}: ${r.text.slice(0, 140)}`);
        }
        const sixth = await post(t, pat, { title: 'One too many today' });
        assert.strictEqual(sixth.status, 429, sixth.text);
        assert.strictEqual(sixth.json().code, 'listing.limit_daily');
        assert.match(sixth.json().detail, /5 listings today/);

        await newDay(pat);
        for (let i = 1; i <= 5; i++) {
            const r = await post(t, pat, { title: `A later day, listing ${i}` });
            assert.strictEqual(r.status, 201, `later listing ${i}: ${r.text.slice(0, 140)}`);
        }
        assert.strictEqual(await activeCount(pat), 10, 'ten active');
        const eleventh = await post(t, pat, { title: 'The eleventh active listing' });
        assert.strictEqual(eleventh.status, 429, eleventh.text);
        assert.strictEqual(eleventh.json().code, 'listing.limit_active');
        assert.match(eleventh.json().detail, /10 active listings/);

        // Deleting one makes room at once, and the daily cap still applies first.
        const doomed = await t.ctx.s.db.value("SELECT id FROM rent_listings WHERE owner = $1 AND state = 'active' ORDER BY id DESC LIMIT 1", [`user:${pat.subject}`]);
        assert.strictEqual((await t.get(`/api/v1/listings/${doomed}`, { method: 'DELETE', as: pat, headers: SAME })).status, 204);
        assert.strictEqual((await t.get(`/api/v1/listings/${doomed}`, { as: pat })).status, 404);
        await newDay(pat);
        assert.strictEqual((await post(t, pat, { title: 'Room again after a delete' })).status, 201);
    });

    await check('owner-only: another person cannot edit, renew, hide or delete it; the owner can', async () => {
        const mine = await t.ctx.s.db.maybe('SELECT * FROM rent_listings WHERE owner = $1 ORDER BY id DESC LIMIT 1', [`user:${kim.subject}`]);
        const patch = (target, body, as) => t.get(`/api/v1/listings/${target.id}`, { method: 'PATCH', as, json: body, headers: SAME });
        const taken = await patch(mine, { title: 'Taken over' }, lee);
        assert.strictEqual(taken.status, 403, taken.text);
        assert.strictEqual(taken.json().code, 'listing.forbidden');
        assert.strictEqual((await t.get(`/api/v1/listings/${mine.id}`, { method: 'DELETE', as: lee, headers: SAME })).status, 403);
        assert.strictEqual((await t.get(`/api/v1/listings/${mine.id}/renew`, { as: lee, json: {}, headers: SAME })).status, 403);
        assert.strictEqual(await t.ctx.s.db.value('SELECT count(*) FROM rent_listings WHERE owner = $1', [`user:${lee.subject}`]).then(Number), 0, 'lee has none of their own');

        const edited = await patch(mine, { title: 'Renamed by its owner', price: 950.5, period: 'week' }, kim);
        assert.strictEqual(edited.status, 200, edited.text);
        assert.strictEqual(edited.json().title, 'Renamed by its owner');
        assert.strictEqual(edited.json().price, 950.5);
        assert.strictEqual(edited.json().period, 'week');
        assert.strictEqual(edited.json().kind, mine.kind, 'a patch leaves what it does not name alone');
        assert.strictEqual(edited.json().city, mine.city);

        const hidden = await patch(mine, { state: 'hidden' }, kim);
        assert.strictEqual(hidden.json().state, 'hidden');
        assert.strictEqual((await t.get('/api/v1/listings?limit=60')).json().listings.some((x) => x.id === mine.id), false, 'hidden leaves search');
        assert.strictEqual((await patch(mine, { state: 'active' }, kim)).json().state, 'active');
        assert.strictEqual((await patch(mine, { state: 'removed' }, kim)).status, 422, 'only staff remove a listing');
        assert.strictEqual((await patch(mine, { title: '12 High Street' }, kim)).status, 422, 'the rules apply to an edit too');
    });

    await check('renewing adds 30 days, and brings an expired listing back', async () => {
        const mine = await t.ctx.s.db.maybe('SELECT * FROM rent_listings WHERE owner = $1 ORDER BY id DESC LIMIT 1', [`user:${kim.subject}`]);
        const before = Date.parse(mine.expires_at);
        const renewed = await t.get(`/api/v1/listings/${mine.id}/renew`, { as: kim, json: {}, headers: SAME });
        assert.strictEqual(renewed.status, 200, renewed.text);
        // Renewing is 30 days from now, never a top-up that could run far past it, and never a shortening.
        assert.ok(Math.abs(Date.parse(renewed.json().expires_at) - (Date.now() + 30 * DAY)) < 60_000, renewed.json().expires_at);
        assert.ok(Date.parse(renewed.json().expires_at) >= before, 'a renew never takes time away');

        // Its time is up: the sweep (what the timer calls in production) marks it, and search drops it.
        await t.ctx.s.db.query('UPDATE rent_listings SET expires_at = $2 WHERE id = $1', [mine.id, LONG_AGO]);
        const store = require('../server/listings/store');
        assert.ok(await store.expireListings(t.ctx.s) >= 1, 'the sweep marked them expired');
        assert.strictEqual((await t.get(`/api/v1/listings/${mine.id}`, { as: kim })).json().state, 'expired');
        assert.strictEqual((await t.get('/api/v1/listings?limit=60')).json().listings.some((x) => x.id === mine.id), false, 'expired leaves search');
        const back = await t.get(`/api/v1/listings/${mine.id}/renew`, { as: kim, json: {}, headers: SAME });
        assert.strictEqual(back.json().state, 'active');
        assert.ok(Date.parse(back.json().expires_at) > Date.now(), 'the new expiry is in the future');
        assert.strictEqual((await t.get('/api/v1/listings?limit=60')).json().listings.some((x) => x.id === mine.id), true, 'and it is back in search');
    });

    await check('a hostile title and description stay text: nothing a page shows is live markup', async () => {
        const nasty = '<script>alert(1)</script> & "quotes" \'apostrophes\'';
        const r = await post(t, lee, { title: `Nasty ${nasty}`, description: `Description ${nasty}` });
        assert.strictEqual(r.status, 201, r.text);
        const made = r.json();
        const html = (await t.get(`/listings/${made.id}`)).text;
        assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw tag is on the page');
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the escaped text is');
        assert.ok(html.includes('&amp;'), 'the ampersand is escaped');
        assert.ok(html.includes('&#39;'), 'the apostrophe is escaped');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
