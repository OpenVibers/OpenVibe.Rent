'use strict';
/**
 * The board (server/board/board.js, /board, /api/v1/board): a person keeps listings from any site in one list with
 * their notes and how far they got. Only a signed-in person, only their own items; the same link twice is one item;
 * a bad link or status is refused; the page works without JavaScript, opens prefilled from the bookmarklet's
 * ?url=&title=, never fetches the listing, and is not indexed.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME } = require('./helpers/rent');
const board = require('../server/board/board');

const CL = 'https://saltlakecity.craigslist.org/apa/d/salt-lake-city-sunny-2br/7790000001.html';
const ZL = 'https://www.zillow.com/homedetails/123-Main-St-Salt-Lake-City-UT-84111/1_zpid/';

(async () => {
    await check('validate: an http(s) link is required; prices, periods, currencies and statuses are checked', () => {
        assert.strictEqual(board.validate({}).ok, false);
        assert.strictEqual(board.validate({ url: 'javascript:alert(1)' }).ok, false, 'no javascript: links');
        assert.strictEqual(board.validate({ url: 'ftp://example.com/x' }).ok, false);
        assert.strictEqual(board.validate({ url: 'https://user:pw@example.com/x' }).ok, false, 'no credentials in a link');
        const v = board.validate({ url: CL, price: '$1,450', period: 'month' });
        assert.deepStrictEqual(v.item, { url: CL, site: 'saltlakecity.craigslist.org', title: 'A listing on Craigslist', price: 1450, period: 'month', currency: 'USD' });
        assert.strictEqual(board.validate({ url: CL, price: '-3' }).ok, false);
        assert.strictEqual(board.validate({ url: CL, period: 'fortnight' }).ok, false);
        assert.strictEqual(board.validate({ url: CL, currency: 'XYZ' }).ok, false);
        assert.strictEqual(board.validate({ status: 'moved-in' }, { partial: true }).ok, false);
        assert.deepStrictEqual(board.validate({ status: 'viewing' }, { partial: true }).item, { status: 'viewing' });
        assert.strictEqual(board.siteName('zillow.com'), 'Zillow');
        assert.strictEqual(board.siteName('airbnb.com'), 'Airbnb');
        assert.strictEqual(board.siteName('example.org'), 'example.org');
        assert.strictEqual(board.validate({ url: ZL, title: '9 Elm St | Zillow' }).item.title, '9 Elm St', 'a page title loses the site\'s own name');
        assert.strictEqual(board.validate({ url: ZL, title: 'Bed - Bath' }).item.title, 'Bed - Bath', 'only the site\'s name is taken off');
    });

    const t = await boot();
    try {
        const kim = t.network.addUser('kim');
        const lee = t.network.addUser('lee');

        await check('the API: a person keeps, lists, moves and forgets their own listings; nobody else sees them', async () => {
            assert.strictEqual((await t.get('/api/v1/board')).status, 401);
            const made = await t.get('/api/v1/board', { as: kim, json: { url: CL, title: 'Sunny 2BR', price: 1450, period: 'month', place: 'Downtown', notes: 'Ask about parking' }, headers: SAME });
            assert.strictEqual(made.status, 201, made.text);
            const item = made.json();
            assert.ok(board.isItemId(item.id));
            assert.strictEqual(made.headers.get('location'), `/api/v1/board/${item.id}`);
            assert.deepStrictEqual([item.site, item.site_name, item.status, item.price, item.currency], ['saltlakecity.craigslist.org', 'Craigslist', 'interested', 1450, 'USD']);

            const again = await t.get('/api/v1/board', { as: kim, json: { url: CL, title: 'Sunny 2BR, the one with the yard' }, headers: SAME });
            assert.strictEqual(again.status, 200, 'the same link again updates the item');
            assert.strictEqual(again.json().id, item.id);
            assert.strictEqual(again.json().notes, 'Ask about parking', 'fields left out stay');

            const moved = await t.get(`/api/v1/board/${item.id}`, { as: kim, method: 'PATCH', json: { status: 'viewing' }, headers: SAME });
            assert.strictEqual(moved.status, 200, moved.text);
            assert.strictEqual(moved.json().status, 'viewing');
            assert.strictEqual((await t.get(`/api/v1/board/${item.id}`, { as: kim, method: 'PATCH', json: { status: 'moved-in' }, headers: SAME })).status, 422);

            assert.strictEqual((await t.get(`/api/v1/board/${item.id}`, { as: lee, method: 'PATCH', json: { status: 'rented' }, headers: SAME })).status, 404, 'not someone else\'s');
            assert.strictEqual((await t.get(`/api/v1/board/${item.id}`, { as: lee, method: 'DELETE', headers: SAME })).status, 404);
            assert.deepStrictEqual((await t.get('/api/v1/board', { as: lee })).json().items, []);

            const mine = (await t.get('/api/v1/board', { as: kim })).json();
            assert.deepStrictEqual(mine.items.map((x) => x.id), [item.id]);
            assert.deepStrictEqual(mine.statuses, board.STATUSES);

            const other = await t.get('/api/v1/board', { as: kim, json: { url: ZL }, headers: SAME });
            assert.strictEqual((await t.get(`/api/v1/board/${other.json().id}`, { as: kim, method: 'PATCH', json: { url: CL }, headers: SAME })).status, 409, 'two items cannot share a link');
            assert.strictEqual((await t.get(`/api/v1/board/${other.json().id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204);
            assert.strictEqual((await t.get('/api/v1/board', { as: kim, json: { url: 'javascript:alert(1)' }, headers: SAME })).json().code, 'board.invalid');
        });

        await check('/board: sign-in first, then the listings grouped by status with forms that work without JavaScript', async () => {
            const anon = await t.get('/board?url=' + encodeURIComponent(ZL) + '&title=A+house');
            assert.strictEqual(anon.status, 401);
            assert.ok(anon.text.includes('/auth/login?next=' + encodeURIComponent('/board?url=' + encodeURIComponent(ZL) + '&title=A+house')), 'sign-in comes back to the same listing');

            const r = await t.get('/board', { as: kim });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('noindex'), 'a person\'s board is not indexed');
            assert.ok(r.text.includes('Viewing booked'), 'grouped by status');
            assert.ok(r.text.includes(`href="${CL}" target="_blank" rel="noopener nofollow ugc"`), 'the listing opens on its own site');
            assert.ok(r.text.includes('Ask about parking'));
            assert.ok(r.text.includes('<textarea id="bd-bookmarklet"') && r.text.includes('javascript:(()=&gt;{open('), 'the bookmarklet is text to copy');
            assert.ok(!/href="javascript:/i.test(r.text), 'never a javascript: link');

            const prefilled = await t.get('/board?url=' + encodeURIComponent(ZL) + '&title=A+house+with+a+yard', { as: kim });
            assert.ok(prefilled.text.includes('Keep this listing') && prefilled.text.includes('<b>Zillow</b>'));
            assert.ok(prefilled.text.includes(`value="${ZL}"`) && prefilled.text.includes('value="A house with a yard"'));
        });

        await check('the page forms: keep, move, edit and remove — from this site only', async () => {
            const cross = await t.get('/board', { as: lee, form: { url: ZL }, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403, 'a cross-site form cannot act as the person');

            const kept = await t.get('/board', { as: lee, form: { url: ZL, title: 'A house', price: '2,100', period: 'month', place: '', notes: '' }, headers: SAME });
            assert.strictEqual(kept.status, 303, kept.text.slice(0, 200));
            const id = kept.headers.get('location').split('#')[1];
            assert.ok(board.isItemId(id));

            assert.strictEqual((await t.get(`/board/${id}`, { as: lee, form: { status: 'applied' }, headers: SAME })).status, 303);
            assert.strictEqual((await t.get(`/board/${id}`, { as: lee, form: { url: ZL, title: 'A house, applied Tuesday', price: '', period: 'month', place: 'Sugar House', notes: 'Waiting to hear' }, headers: SAME })).status, 303);
            const row = await board.get(t.ctx.s, id);
            assert.deepStrictEqual([row.status, row.title, row.price, row.place, row.notes], ['applied', 'A house, applied Tuesday', null, 'Sugar House', 'Waiting to hear']);

            const bad = await t.get('/board', { as: lee, form: { url: 'not a link' }, headers: SAME });
            assert.strictEqual(bad.status, 422);
            assert.ok(bad.text.includes('an http or https address'));

            assert.strictEqual((await t.get(`/board/${id}/delete`, { as: kim, method: 'POST', form: { go: '1' }, headers: SAME })).status, 303);
            assert.ok(await board.get(t.ctx.s, id), 'someone else cannot remove it');
            assert.strictEqual((await t.get(`/board/${id}/delete`, { as: lee, method: 'POST', form: { go: '1' }, headers: SAME })).status, 303);
            assert.strictEqual(await board.get(t.ctx.s, id), null);
        });

        await check('a board holds MAX_ITEMS listings, then says so', async () => {
            const s = t.ctx.s;
            const nia = t.network.addUser('nia');
            const subject = `user:${nia.subject}`;
            const values = [];
            for (let i = 0; i < board.MAX_ITEMS; i++) values.push(`('${s.newId('rbi')}', '${subject}', 'https://example.com/${i}', 'example.com', 'x', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`);
            await s.db.exec(`INSERT INTO rent_board_items (id, subject, url, site, title, created_at, updated_at) VALUES ${values.join(', ')}`);
            const full = await t.get('/api/v1/board', { as: nia, json: { url: ZL }, headers: SAME });
            assert.strictEqual(full.status, 409, full.text);
            assert.strictEqual(full.json().code, 'board.full');
        });

        await check('search everywhere points at the board; robots.txt keeps it out', async () => {
            const robots = await t.get('/robots.txt');
            assert.ok(robots.text.includes('Disallow: /board'));
            const home = await t.get('/');
            assert.ok(home.text.includes('href="/board"'), 'the navbar has the board');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
