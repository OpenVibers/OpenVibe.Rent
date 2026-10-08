'use strict';
/**
 * Searching the listings: the filters (q, kind, city, country, min, max, period), newest first, 30 a page with a
 * cursor, the kind and country facets, and what is never listed (hidden, expired, removed). The contact URL is the
 * private part of a listing: it is in the API's answer and on the page for a signed-in person, and in neither for
 * anyone else. A filter we do not know is ignored, never an error — a stale bookmark still shows listings.
 *
 * The rows here are inserted through the store (server/listings/store.js) rather than posted: what is under test is
 * the search, and a person's 5-a-day cap would otherwise have to be worked around to reach 31 of them.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, listing, post } = require('./helpers/rent');
const store = require('../server/listings/store');

const DAY = 86_400_000;

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const KIM = `user:${kim.subject}`;

    /** Insert a listing straight into the store, as a person who posted it earlier would have left it. */
    let n = 0;
    const make = (over = {}) => {
        n += 1;
        const now = Date.now() + n;                    // a later insert is a later listing, for "newest first"
        return store.insert(t.ctx.s, {
            id: t.ctx.s.newId('rnt'), owner: KIM, kind: 'apartment', title: `Listing ${n}`,
            description: 'A place to live.', price: 1000, currency: 'EUR', period: 'month',
            city: 'Lisbon', region: null, country: 'PT', neighbourhood: 'Alfama', bedrooms: null,
            available_from: null, contact_url: 'https://example.com/contact', state: 'active',
            created_at: new Date(now).toISOString(),
            expires_at: new Date(now + 30 * DAY).toISOString(),
            ...over,
        });
    };

    const search = async (qs, o = {}) => (await t.get(`/api/v1/listings?${qs}`, o)).json();

    await check('filters: q, kind, city, country, min, max, period', async () => {
        const a = await make({ kind: 'apartment', city: 'Lisbon', country: 'PT', price: 1200, period: 'month', title: 'Sunny flat with a balcony', neighbourhood: 'Alfama' });
        await make({ kind: 'room', city: 'Lisbon', country: 'PT', price: 450, period: 'month', title: 'Room in a shared house', neighbourhood: 'Graça' });
        await make({ kind: 'house', city: 'Porto', country: 'PT', price: 2200, period: 'month', title: 'House with a garden', neighbourhood: 'Cedofeita' });
        await make({ kind: 'equipment', city: 'Berlin', country: 'DE', price: 40, period: 'day', title: 'Camera and two lenses for hire', neighbourhood: null });
        await make({ kind: 'parking', city: 'Paris', country: 'FR', price: 90, period: 'month', title: 'Garage space near the market', neighbourhood: 'Le Marais' });

        const ids = async (qs) => (await search(qs)).listings.map((x) => x.id);
        assert.deepStrictEqual((await ids('kind=room')).sort(), [(await search('kind=room')).listings[0].id]);
        assert.strictEqual((await search('kind=room')).count, 1);
        assert.strictEqual((await search('city=lisbon')).count, 2, 'the city match is case-insensitive');
        assert.strictEqual((await search('country=DE')).count, 1);
        assert.strictEqual((await search('period=day')).count, 1);
        assert.strictEqual((await search('min=1000&max=1500')).count, 1);
        assert.strictEqual((await search('min=1000&max=2500')).count, 2);
        assert.strictEqual((await search('min=2000')).count, 1);
        assert.strictEqual((await search('max=50')).count, 1);
        assert.strictEqual((await search('q=garage')).count, 1, 'q searches the title');
        assert.strictEqual((await search('q=balcony')).count, 1);
        assert.strictEqual((await search('q=alfama')).count, 1, 'q searches the neighbourhood');
        assert.strictEqual((await search('q=Lisbon')).count, 2, 'q searches the city');
        assert.strictEqual((await search('kind=room&city=Berlin')).count, 0, 'the filters are ANDed');
        assert.strictEqual((await search('min=500&max=100')).count, 1, 'a reversed range is swapped (100–500), and then matches');
        assert.strictEqual((await search('kind=nonsense&country=ZZ&period=fortnight&min=abc')).count, 5, 'a filter we do not know is ignored');
        assert.strictEqual((await search('')).count, 5);
        assert.strictEqual((await search('')).listings[0].id, (await search('')).listings[0].id);
        // Newest first.
        const ordered = (await search('')).listings.map((x) => x.id);
        assert.deepStrictEqual(ordered, [...ordered].sort().reverse(), 'ULID order, newest first');
        assert.ok(ordered.includes(a.id));
    });

    await check('the facets count each dimension without its own filter', async () => {
        const all = await search('');
        assert.deepStrictEqual(all.facets.kind.map((x) => x.value).sort(), ['apartment', 'equipment', 'house', 'parking', 'room']);
        assert.deepStrictEqual(all.facets.country.map((x) => [x.value, x.count]).sort(), [['DE', 1], ['FR', 1], ['PT', 3]]);
        const pt = await search('country=PT');
        assert.deepStrictEqual(pt.facets.kind.map((x) => x.value).sort(), ['apartment', 'house', 'room']);
        assert.strictEqual(pt.facets.country.find((x) => x.value === 'PT').count, 3, 'the country facet counts the others');
        const rooms = await search('kind=room');
        assert.strictEqual(rooms.facets.kind.length, 5, 'the kind facet leaves its own dimension out');
        assert.strictEqual(rooms.facets.country.find((x) => x.value === 'PT').count, 1);
    });

    await check('30 a page, newest first, and the cursor walks back through them', async () => {
        for (let i = 0; i < 40; i++) await make({ title: `Bulk listing ${i}` });
        const first = await search('');
        assert.strictEqual(first.count, 30, 'a page is 30 listings');
        assert.ok(first.next, 'there is a cursor');
        assert.strictEqual(first.listings.length, 30);
        const second = await search(`before=${first.next}`);
        assert.strictEqual(second.count, 15, 'the rest');
        const overlap = second.listings.filter((x) => first.listings.some((y) => y.id === x.id));
        assert.deepStrictEqual(overlap, [], 'no listing is on two pages');
        const ids = [...first.listings, ...second.listings].map((x) => x.id);
        assert.deepStrictEqual(ids, [...ids].sort().reverse(), 'the whole walk is newest first');
        assert.strictEqual(second.next, null, 'the last page has no cursor');
        assert.strictEqual((await search('before=not-an-id')).count, 30, 'a cursor that is not a listing id is ignored');
    });

    await check('a hidden, expired or removed listing is not listed; its owner and staff still see it', async () => {
        const row = await make({ title: 'To be hidden' });
        assert.ok((await search('q=to be hidden')).count === 1);
        await store.setState(t.ctx.s, row.id, 'hidden');
        assert.strictEqual((await search('q=to be hidden')).count, 0, 'hidden leaves search');
        assert.strictEqual((await t.get(`/api/v1/listings/${row.id}`)).status, 404, 'and is 404 for a stranger');
        assert.strictEqual((await t.get(`/api/v1/listings/${row.id}`, { as: kim })).status, 200, 'the owner still reads it');

        const ada = t.network.addUser('ada2', { role: 'admin' });
        assert.strictEqual((await t.get(`/api/v1/listings/${row.id}`, { as: ada })).status, 200, 'staff read it');

        await store.setState(t.ctx.s, row.id, 'active');
        assert.strictEqual((await search('q=to be hidden')).count, 1);
        await store.remove(t.ctx.s, row.id);
        assert.strictEqual((await search('q=to be hidden')).count, 0, 'a deleted listing is gone');
        assert.strictEqual((await t.get(`/api/v1/listings/${row.id}`, { as: kim })).status, 404);

        // The sweep at 30 days: an expired listing leaves search, and the store still has it.
        const old = await make({ title: 'Long expired' });
        await t.ctx.s.db.query('UPDATE rent_listings SET expires_at = $2 WHERE id = $1', [old.id, '2020-01-01T00:00:00.000Z']);
        assert.ok(await store.expireListings(t.ctx.s) >= 1);
        assert.strictEqual(await t.ctx.s.db.value('SELECT state FROM rent_listings WHERE id = $1', [old.id]), 'expired');
        assert.strictEqual((await search('q=long expired')).count, 0);
    });

    await check('contact_url is for a signed-in person only — in the API, both on one listing and in the list', async () => {
        const mine = (await search('', { as: kim })).listings.find((x) => x.contact_url);
        assert.ok(mine, 'the signed-in person sees their own contact link in the list');
        const anon = await search('');
        assert.ok(anon.listings.every((x) => !('contact_url' in x)), 'a signed-out list carries no contact_url at all');
        const anonOne = await t.get(`/api/v1/listings/${mine.id}`);
        assert.strictEqual(anonOne.status, 200);
        assert.ok(!('contact_url' in anonOne.json()), 'and neither does one listing');
        const signedOne = await t.get(`/api/v1/listings/${mine.id}`, { as: kim });
        assert.strictEqual(signedOne.json().contact_url, 'https://example.com/contact');
    });

    await check('the page shows the contact link only to a signed-in viewer, and asks anyone else to sign in', async () => {
        const mine = (await search('', { as: kim })).listings.find((x) => x.contact_url);
        const out = await t.get(`/listings/${mine.id}`);
        assert.strictEqual(out.status, 200);
        assert.ok(!out.text.includes('https://example.com/contact'), 'the signed-out page leaks the contact link');
        assert.match(out.text, /Sign in to see how to contact/i);
        const inPage = await t.get(`/listings/${mine.id}`, { as: kim });
        assert.ok(inPage.text.includes('https://example.com/contact'), 'the signed-in page shows it');
        assert.ok(!inPage.text.includes('Sign in to see how to contact'), 'and no prompt');
    });

    await check('an expired or hidden listing leaves the page too: 404 for a stranger, not for its owner', async () => {
        const row = await post(t, lee, { title: 'Posted then hidden' });
        assert.strictEqual(row.status, 201, row.text);
        await t.get(`/api/v1/listings/${row.json().id}`, { method: 'PATCH', as: lee, json: { state: 'hidden' }, headers: SAME });
        const anon = await t.get(`/listings/${row.json().id}`);
        assert.strictEqual(anon.status, 404);
        const owner = await t.get(`/listings/${row.json().id}`, { as: lee });
        assert.strictEqual(owner.status, 200);
        assert.match(owner.text, /hidden/);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
