'use strict';
/**
 * HUD's Fair Market Rents (server/housing/fair-market-rents.js, server/data/city-fmr-areas.json, city-pages.js):
 *   - a Sources item of hud-fair-market-rents becomes one row per FMR area, as HUD states it; anything else is held;
 *   - the pull follows the change feed from the cursor; a removed area is deleted; an older revision never wins;
 *   - a city page shows HUD's rents beside the Census medians with what they are; /fair names the one for that size;
 *     a city whose area is unknown keeps the plain table.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const cities = require('../server/aggregate/cities');
const AREAS = require('../server/data/city-fmr-areas.json');
const { rowOf } = require('../server/housing/fair-market-rents');

const ny = cities.find('ny', 'new-york');
const austin = cities.find('tx', 'austin');
const NY = AREAS.areas[ny.id];
const AUSTIN = AREAS.areas[austin.id];

const item = (seq, code, name, rents, over = {}) => ({
    id: `itm_${seq}`, source_key: 'hud-fair-market-rents', category: 'housing', kind: 'rent_area', identity: code, canonical_url: null,
    title: name, summary: null, fields: { fmr_0br: rents[0], fmr_1br: rents[1], fmr_2br: rents[2], fmr_3br: rents[3], fmr_4br: rents[4] },
    revision: 1, provenance: { retrieved_at: '2026-10-22T10:00:00.000Z' }, removed: null, change_seq: seq, ...over,
});

function feed(items) {
    return {
        items,
        async listItems({ after = 0, limit = 100 }) {
            const rest = items.filter((x) => x.change_seq > after).sort((a, b) => a.change_seq - b.change_seq);
            const page = rest.slice(0, limit);
            return { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: rest.length > limit, sources: {} };
        },
    };
}

(async () => {
    const source = feed([
        item(1, NY, 'New York, NY HUD Metro FMR Area', [2529, 2655, 2910, 3644, 3959]),
        item(2, AUSTIN, 'Austin-Round Rock-San Marcos, TX MSA', [1474, 1562, 1852, 2347, 2760]),
        { ...item(3, 'METRO10180M10180', 'Abilene, TX MSA', [1010, 1020, 1276, 1653, 1987]), kind: 'record' },
        { ...item(4, 'X', 'Bad code', [1, 2, 3, 4, 5]) },
    ]);
    const t = await boot({ fmrSource: source });
    try {
        await check('the data: every city is placed in an FMR area by its Census point; New York and Austin in their metros', () => {
            assert.ok(Object.keys(AREAS.areas).length >= cities.cities.length - 5, `${Object.keys(AREAS.areas).length} of ${cities.cities.length}`);
            assert.strictEqual(NY, 'METRO35620MM5600');
            assert.ok(/^METRO12420/.test(AUSTIN), AUSTIN);
            assert.ok(Object.values(AREAS.areas).every((code) => /^[A-Z0-9]{6,40}$/.test(code)));
        });

        await check('an area becomes one row as HUD states it; a bad code or no rents is not an area', () => {
            const row = rowOf(item(9, NY, 'New York, NY HUD Metro FMR Area', [2529, 2655, 2910, 3644, 3959]));
            assert.deepStrictEqual([row.code, row.fmr_2br, row.fmr_4br], [NY, 2910, 3959]);
            assert.strictEqual(rowOf(item(9, 'not a code!', 'x', [1, 2, 3, 4, 5])), null);
            assert.strictEqual(rowOf(item(9, NY, 'x', [null, '', -4, 'abc', 0])), null);
            assert.strictEqual(rowOf(item(9, NY, 'x', ['1500', null, null, null, null])).fmr_0br, 1500);
        });

        await check('before the first pull a city page keeps the Census table alone', async () => {
            const page = await t.get('/in/ny/new-york');
            assert.strictEqual(page.status, 200);
            assert.ok(!page.text.includes('HUD fair market'));
        });

        await check('the pull follows the change feed and keeps the cursor; the areas are in memory for the pages', async () => {
            const out = await t.ctx.fmr.pull();
            assert.deepStrictEqual([out.applied, out.hold], [2, 2]);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM rent_ingest_cursor WHERE name = 'sources.housing.after'")), 4);
            assert.deepStrictEqual(t.ctx.fmr.forCity(ny).rents, { studio: 2529, b1: 2655, b2: 2910, b3: 3644, b4: 3959 });
            assert.strictEqual(t.ctx.fmr.forCity(cities.find('ca', 'los-angeles')), null);
        });

        await check('a city page shows HUD\'s rents beside the medians and says what they are', async () => {
            const page = await t.get('/in/ny/new-york');
            assert.ok(page.text.includes('HUD FMR'));
            assert.ok(page.text.includes('$2,910'));
            assert.ok(page.text.includes('New York, NY HUD Metro FMR Area'));
            assert.ok(page.text.includes('Housing Choice Vouchers'));
            assert.ok(page.text.includes('40th percentile'), 'the percentile HUD states');
            assert.ok(page.text.includes('read 22 Oct 2026'), 'the year and date the figure carries');
            assert.ok(page.text.includes('never averaged'), 'the two measures are shown side by side');
            const la = await t.get('/in/ca/los-angeles');
            assert.ok(!la.text.includes('HUD FMR'), 'an area Sources has not given keeps the plain table');
        });

        await check('/fair names HUD\'s Fair Market Rent for that size', async () => {
            const page = await t.get('/fair?city=tx/austin&beds=2&rent=1900');
            assert.ok(page.text.includes('HUD&#39;s Fair Market Rent for a 2-bedroom') || page.text.includes('HUD\'s Fair Market Rent for a 2-bedroom'));
            assert.ok(page.text.includes('$1,852'));
            const five = await t.get('/fair?city=tx/austin&beds=5&rent=4000');
            assert.ok(!five.text.includes('Fair Market Rent for'), 'HUD gives no 5-bedroom figure, and none is made up');
        });

        await check('a removed area is deleted; an older revision arriving late changes nothing', async () => {
            source.items.push(item(10, AUSTIN, 'Austin-Round Rock-San Marcos, TX MSA', [1500, 1600, 1900, 2400, 2800], { id: 'itm_2', revision: 3 }));
            source.items.push(item(11, AUSTIN, 'Austin-Round Rock-San Marcos, TX MSA', [1, 1, 1, 1, 1], { id: 'itm_2', revision: 2 }));
            source.items.push({ ...item(12, NY, 'New York, NY HUD Metro FMR Area', [1, 1, 1, 1, 1]), id: 'itm_1', revision: 2, removed: { at: '2026-10-22T11:00:00.000Z', reason: 'licence' } });
            const out = await t.ctx.fmr.pull();
            assert.strictEqual(out.removed, 1);
            assert.strictEqual(t.ctx.fmr.forCity(ny), null);
            assert.strictEqual(t.ctx.fmr.forCity(austin).rents.b2, 1900);
        });
    } finally {
        await t.close();
    }
    done();
})();
