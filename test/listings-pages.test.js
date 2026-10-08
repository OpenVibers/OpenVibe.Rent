'use strict';
/**
 * The pages, as a person without JavaScript uses them: home, /listings, one listing, /post, /mine, /saved and
 * /safety. Every page is server-rendered and every write is a plain form POST that must come from this site. The
 * safety note is on the listing page word for word, a saved search counts what is new since you last looked, and
 * a refused form gives back what was typed, escaped.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, post } = require('./helpers/rent');
const listings = require('../server/listings/listings');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const nia = t.network.addUser('nia');

    await check('the home page: a search box, the latest listings, how it works, and no payments said plainly', async () => {
        const made = await post(t, kim, { title: 'A flat on the home page' });
        assert.strictEqual(made.status, 201, made.text);
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /action="\/listings"/, 'the search box posts to /listings');
        assert.ok(r.text.includes('A flat on the home page'), 'the latest listings are on the home page');
        assert.match(r.text, /How it works/);
        assert.ok(r.text.includes('OpenVibe does not handle payments for listings'), 'the no-payments rule');
        assert.match(r.text, /no scraped listings and no partner feeds/i, 'the sources-to-come statement');
        assert.match(r.text, /href="\/post"/);
        assert.match(r.text, /href="\/safety"/);
    });

    await check('the safety note is on every listing page, word for word', async () => {
        const made = await post(t, kim, { title: 'A flat with a safety note' });
        const id = made.json().id;
        for (const path of [`/listings/${id}`, '/safety']) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 200, path);
            assert.ok(r.text.includes(listings.SAFETY), `${path} is missing the safety note`);
        }
    });

    await check('/listings renders the filters, the facets and the results, and never the contact link when signed out', async () => {
        await post(t, kim, { kind: 'room', city: 'Lisbon', title: 'A room in Lisbon' });
        const r = await t.get('/listings?kind=room&city=Lisbon', { as: kim });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('A room in Lisbon'), 'the match is listed');
        assert.ok(!r.text.includes('A flat on the home page'), 'a filtered listing is not');
        assert.match(r.text, /Kind:/, 'a kind facet');
        assert.match(r.text, /Country:/, 'a country facet');
        assert.match(r.text, /Save this search/i, 'a signed-in-only save form is offered to a signed-in viewer');
        assert.ok(!r.text.includes('https://example.com/rooms/1'), 'no contact link on a signed-out page');
        const empty = await t.get('/listings?q=nothingmatchesthis', { as: kim });
        assert.strictEqual(empty.status, 200);
        assert.match(empty.text, /No listing matches those filters/);
        const bad = await t.get('/listings?kind=nonsense&before=nope');
        assert.strictEqual(bad.status, 200, 'a filter we do not know is not an error');
    });

    await check('/post: sign-in is asked for, and the form is the same rules as the API', async () => {
        const out = await t.get('/post');
        assert.strictEqual(out.status, 401);
        assert.match(out.text, /\/auth\/login\?next=%2Fpost/);

        const page = await t.get('/post', { as: kim });
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /action="\/post"/);
        assert.match(page.text, /name="currency"/);

        const crossSite = await t.get('/post', { as: kim, form: { kind: 'apartment', title: 'x' } });
        assert.strictEqual(crossSite.status, 403, 'a form from another site cannot post as the person');

        const refused = await t.get('/post', {
            as: kim, headers: SAME,
            form: { kind: 'apartment', title: 'A flat at 12 Rue de la Paix', description: 'Nice.', price: '900', currency: 'EUR', period: 'month', city: 'Paris', country: 'FR' },
        });
        assert.strictEqual(refused.status, 422);
        assert.match(refused.text, /street address/);
        assert.ok(refused.text.includes('A flat at 12 Rue de la Paix'), 'the refused text comes back, escaped');

        const made = await t.get('/post', {
            as: kim, headers: SAME,
            form: { kind: 'equipment', title: 'A camera for the weekend', description: 'Two lenses, a bag and a charger.', price: '35', currency: 'GBP', period: 'day', city: 'London', country: 'GB', neighbourhood: 'Shoreditch', contact_url: 'mailto:kim@example.com' },
        });
        assert.strictEqual(made.status, 303, made.text.slice(0, 200));
        const where = made.headers.get('location');
        assert.match(where, /^\/listings\/rnt_/);
        const shown = await t.get(where, { as: kim });
        assert.ok(shown.text.includes('A camera for the weekend'));
        assert.ok(shown.text.includes('mailto:kim@example.com'));
        const anon = await t.get(where);
        assert.ok(!anon.text.includes('mailto:kim@example.com'), 'the contact address is not on a signed-out page');
    });

    await check('/mine lists your own listings with their actions, and only yours', async () => {
        assert.strictEqual((await t.get('/mine')).status, 401);
        const mine = await t.get('/mine', { as: kim });
        assert.strictEqual(mine.status, 200);
        assert.ok(mine.text.includes('A flat on the home page'));
        assert.ok(!mine.text.includes('Nothing here yet'), 'the table is not the empty state');
        const theirs = await t.get('/mine', { as: lee });
        assert.ok(!theirs.text.includes('A flat on the home page'), "somebody else's listing is not on your page");
        assert.match(theirs.text, /You have not posted anything yet/);
    });

    await check('the owner edits, renews, hides and deletes through the pages; a stranger cannot', async () => {
        const made = await post(t, kim, { title: 'Mine to change' });
        const id = made.json().id;

        const form = await t.get(`/listings/${id}/edit`, { as: kim });
        assert.strictEqual(form.status, 200);
        assert.ok(form.text.includes('Mine to change'));
        assert.strictEqual((await t.get(`/listings/${id}/edit`, { as: lee })).status, 403);
        assert.strictEqual((await t.get(`/listings/${id}/edit`)).status, 401);

        const edited = await t.get(`/listings/${id}/edit`, {
            as: kim, headers: SAME,
            form: { kind: 'apartment', title: 'Renamed through the form', description: 'Still nice.', price: '1300', currency: 'EUR', period: 'month', city: 'Lisbon', country: 'PT' },
        });
        assert.strictEqual(edited.status, 303);
        assert.strictEqual((await t.get(`/api/v1/listings/${id}`, { as: kim })).json().title, 'Renamed through the form');

        const renewed = await t.get(`/listings/${id}/renew`, { as: kim, method: 'POST', headers: SAME });
        assert.strictEqual(renewed.status, 303);
        assert.ok(Date.parse((await t.get(`/api/v1/listings/${id}`, { as: kim })).json().expires_at) > Date.now());

        const hidden = await t.get(`/listings/${id}/visibility`, { as: kim, form: { state: 'hidden' }, headers: SAME });
        assert.strictEqual(hidden.status, 303);
        assert.strictEqual((await t.get(`/api/v1/listings/${id}`, { as: kim })).json().state, 'hidden');
        assert.strictEqual((await t.get(`/api/v1/listings/${id}`)).status, 404, 'hidden leaves the public');

        assert.strictEqual((await t.get(`/listings/${id}/visibility`, { as: lee, form: { state: 'active' }, headers: SAME })).status, 403);
        assert.strictEqual((await t.get(`/listings/${id}/delete`, { as: lee, method: 'POST', headers: SAME })).status, 403);

        const deleted = await t.get(`/listings/${id}/delete`, { as: kim, method: 'POST', headers: SAME });
        assert.strictEqual(deleted.status, 303);
        assert.strictEqual((await t.get(`/api/v1/listings/${id}`, { as: kim })).status, 404);
    });

    await check('saved searches: save the filters, see what is new since you last looked', async () => {
        assert.strictEqual((await t.get('/saved')).status, 401);
        assert.strictEqual((await t.get('/saved', { as: kim })).status, 200);

        const saved = await t.get('/saved', { as: kim, form: { kind: 'room', city: 'Lisbon' }, headers: SAME });
        assert.strictEqual(saved.status, 303);
        const list = (await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches;
        assert.strictEqual(list.length, 1);
        assert.deepStrictEqual(list[0].filters, { q: null, kind: 'room', city: 'Lisbon', country: null, period: null, min: null, max: null });
        // Nothing has appeared since it was saved: everything that matches was already there.
        assert.strictEqual(list[0].new_count, 0);
        assert.strictEqual((await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches[0].new_count, 0);

        // The same filters again: one saved search, not two.
        await t.get('/saved', { as: kim, form: { kind: 'room', city: 'Lisbon' }, headers: SAME });
        assert.strictEqual((await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches.length, 1);

        // A matching listing appears, and a non-matching one does not count.
        assert.strictEqual((await post(t, lee, { kind: 'room', city: 'Lisbon', title: 'A new room in Lisbon' })).status, 201);
        assert.strictEqual((await post(t, lee, { kind: 'apartment', city: 'Porto', title: 'A flat in Porto' })).status, 201);
        const after = (await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches[0];
        assert.strictEqual(after.new_count, 1, 'only the listing that matches the filters is new');

        const page = await t.get('/saved', { as: kim });
        assert.match(page.text, /1 new/);
        assert.match(page.text, /Room in Lisbon/i, 'the filters are shown as a sentence');
        assert.match(page.text, /OpenVibe\.Watch/, 'the alert story names OpenVibe.Watch');
        const again = await t.get('/saved', { as: kim });
        assert.match(again.text, /nothing new/, 'looking at the page is looking at the searches');
        assert.ok(!again.text.includes('1 new'));

        const id = after.id;
        const gone = await t.get(`/api/v1/saved-searches/${id}`, { method: 'DELETE', as: kim, headers: SAME });
        assert.strictEqual(gone.status, 204);
        assert.strictEqual((await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches.length, 0);
    });

    await check('a signed-out list is not a saved search: the API refuses an app and anonymous', async () => {
        assert.strictEqual((await t.get('/api/v1/saved-searches')).status, 401);
        assert.strictEqual((await t.get('/api/v1/saved-searches', { json: { kind: 'room' }, headers: SAME })).status, 401);
        const { signJwt } = require('./helpers/mocks');
        const now = Math.floor(Date.now() / 1000);
        const app = signJwt({
            iss: t.network.url, sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.rent'],
            cap: ['rent.saved.create'], project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0', env: 'production',
            iat: now, exp: now + 300, jti: 'tok_test_app',
        }, t.network.privatePem);
        assert.strictEqual((await t.get('/api/v1/saved-searches', { bearer: app, json: { kind: 'room' }, headers: SAME })).status, 403);
        assert.strictEqual((await t.get('/api/v1/saved-searches/something-else', { method: 'DELETE', as: kim, headers: SAME })).status, 404);
    });

    await check('a listing page carries an Offer with its price and currency, and none where no type is clear', async () => {
        const flat = await post(t, lee, { kind: 'apartment', title: 'A flat with JSON-LD', price: 1450, currency: 'EUR' });
        assert.strictEqual(flat.status, 201, flat.text);
        const blocks = async (id) => {
            const r = await t.get(`/listings/${id}`);
            return [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        };
        const ofFlat = await blocks(flat.json().id);
        const offer = ofFlat.find((b) => b['@type'] === 'Offer');
        assert.ok(offer, `no Offer node: ${ofFlat.map((b) => b['@type'])}`);
        assert.strictEqual(offer.price, 1450);
        assert.strictEqual(offer.priceCurrency, 'EUR');
        assert.strictEqual(offer.itemOffered['@type'], 'Apartment');
        assert.ok(ofFlat.some((b) => b['@type'] === 'BreadcrumbList'));

        const other = await post(t, lee, { kind: 'other', title: 'Something else entirely' });
        assert.strictEqual(other.status, 201, other.text);
        const ofOther = await blocks(other.json().id);
        assert.strictEqual(ofOther.some((b) => b['@type'] === 'Offer'), false, 'no Offer when the type is not clear');
        assert.ok(ofOther.some((b) => b['@type'] === 'BreadcrumbList'), 'the breadcrumbs stay');
    });

    await check('discovery: robots keeps the private pages out, and the sitemap carries the active listings', async () => {
        const robots = await t.get('/robots.txt');
        for (const d of ['/post', '/mine', '/saved', '/staff']) assert.ok(robots.text.includes(`Disallow: ${d}`), `no Disallow: ${d}`);
        assert.ok(!robots.text.includes('Disallow: /listings'), '/listings stays crawlable');

        const hidden = await post(t, nia, { title: 'A listing nobody should crawl' });
        assert.strictEqual(hidden.status, 201, hidden.text);
        assert.strictEqual((await t.get(`/api/v1/listings/${hidden.json().id}`, { method: 'PATCH', as: nia, json: { state: 'hidden' }, headers: SAME })).status, 200);
        const active = await post(t, nia, { title: 'A listing a crawler should read' });
        assert.strictEqual(active.status, 201, active.text);

        const sitemap = await t.get('/sitemap.xml');
        assert.strictEqual(sitemap.status, 200);
        assert.ok(sitemap.text.includes(`<loc>https://openvibe.rent/listings/${active.json().id}</loc>`), 'the active listing is in the sitemap');
        assert.ok(!sitemap.text.includes(hidden.json().id), 'the hidden one is not');
        assert.ok(sitemap.text.includes('<loc>https://openvibe.rent/listings</loc>'));

        const llms = await t.get('/llms.txt');
        assert.match(llms.text, /no scraped listings and no partner feeds/i);
        assert.match(llms.text, /no payments, no deposits and no messaging/i);
        assert.ok(llms.text.includes('https://openvibe.rent/sitemap.xml'));

        const full = await t.get('/llms-full.txt');
        assert.ok(full.text.includes(`https://openvibe.rent/listings/${active.json().id}`), 'llms-full lists the same pages as the sitemap');
        assert.ok(!full.text.includes(hidden.json().id));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
