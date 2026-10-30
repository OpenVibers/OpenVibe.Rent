'use strict';
/**
 * BLS CPI rent (server/housing/rent-cpi.js): the national and metro trend lines from OpenVibe.Sources.
 *   - a bls-cpi-rent item becomes one point per series and month; another series, kind or source is held;
 *   - the 12-month change is the latest index against the same month a year earlier;
 *   - a city maps to its BLS metro by the area name's own cities and states, else the national line is used;
 *   - the city and fair pages show "Rents in <area> rose X% in the last year (BLS CPI, <month>)" with a line
 *     and the BLS credit; a city page with no metro line shows the national one.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const cities = require('../server/aggregate/cities');
const { createRentCpi, rowOf, trendOf, metroFor, phrasing, NOTE } = require('../server/housing/rent-cpi');

const item = (series, year, period, value, over = {}) => ({
    id: `itm_${series}_${year}${period}`, source_key: 'bls-cpi-rent', category: 'housing', kind: 'rent_cpi',
    identity: `${series}-${year}${period}`, canonical_url: null, title: series, summary: null,
    fields: { series_id: series, year: String(year), period, value: String(value) },
    revision: 1, provenance: { retrieved_at: '2026-10-30T06:00:00.000Z' }, removed: null, ...over,
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
    const items = [
        { ...item('CUUR0000SEHA', 2025, 'M09', 400), change_seq: 1 },
        { ...item('CUUR0000SEHA', 2026, 'M09', 420), change_seq: 2 },
        { ...item('CUURS12ASEHA', 2025, 'M09', 500), change_seq: 3 },
        { ...item('CUURS12ASEHA', 2026, 'M09', 520), change_seq: 4 },
        { ...item('CUUR0000SEHA', 2026, 'M08', 419), change_seq: 5 },
        { ...item('CUURS99XSEHA', 2026, 'M09', 999), change_seq: 6 },       // not one of the 19 metro series
        { ...item('CUUR0000SEHA', 2026, 'M07', 418, { kind: 'record' }), change_seq: 7 },
        { ...item('CUUR0000SEHA', 2026, 'M06', 417, { source_key: 'hud-fmr' }), change_seq: 8 },
    ];
    const source = feed(items);
    const t = await boot({ rentCpiSource: source });
    const ny = cities.match('New York, NY');
    const boise = cities.match('Boise City, ID');
    try {
        await check('one point per series and month; the other series and kinds are held', async () => {
            const row = rowOf(item('CUUR0000SEHA', 2026, 'M09', 450.402));
            assert.deepStrictEqual([row.series_id, row.year, row.period, row.value], ['CUUR0000SEHA', 2026, 'M09', 450.402]);
            assert.strictEqual(rowOf(item('CUURS99XSEHA', 2026, 'M09', 999)), null, 'a series Rent does not map');
            assert.strictEqual(rowOf(item('CUUR0000SEHA', 2026, 'M13', 450)), null, 'M13 is the annual average, not a month');
            assert.strictEqual(rowOf(item('CUUR0000SEHA', 2026, 'M09', -1)), null);
            const out = await t.ctx.rentCpi.pull();
            assert.deepStrictEqual([out.applied, out.hold], [5, 3]);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT cursor FROM rent_ingest_cursor WHERE name = 'sources.housing.rentcpi.after'")), 8);
        });

        await check('the 12-month change compares the same month a year earlier', async () => {
            const national = t.ctx.rentCpi.forSeries('CUUR0000SEHA');
            assert.deepStrictEqual([national.latest.label, national.latest.value, national.change_pct], ['September 2026', 420, 5]);
            assert.strictEqual(national.text, 'Rents in US city average rose 5.0% in the last year (BLS CPI, September 2026).');
            const nyTrend = t.ctx.rentCpi.forSeries('CUURS12ASEHA');
            assert.strictEqual(nyTrend.change_pct, 4);
            assert.strictEqual(trendOf([]), null);
            assert.strictEqual(phrasing('Somewhere', { latest: { value: 1, label: 'September 2026' }, change_pct: null }).includes('12-month change'), true);
        });

        await check('a city maps to its BLS metro by the area name; another falls back to the national line', async () => {
            assert.strictEqual(metroFor({ name: 'New York', state: 'NY' }).series, 'CUURS12ASEHA');
            assert.strictEqual(metroFor({ name: 'Jersey City', state: 'NJ' }).series, 'CUURS12ASEHA');
            assert.strictEqual(metroFor({ name: 'Boise City', state: 'ID' }), null);
            assert.strictEqual(metroFor({ name: 'St. Paul', state: 'MN' }).series, 'CUURS24ASEHA');
            const local = t.ctx.rentCpi.trendForCity(ny);
            assert.deepStrictEqual([local.scope, local.area, local.change_pct], ['metro', 'New York-Newark-Jersey City, NY-NJ-PA', 4]);
            const national = t.ctx.rentCpi.trendForCity(boise);
            assert.deepStrictEqual([national.scope, national.area, national.change_pct], ['national', 'US city average', 5]);
        });

        await check('the city page draws both lines with the BLS credit; a city BLS does not publish shows the national one', async () => {
            const page = await t.get(ny.path);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Are rents rising?'));
            assert.ok(page.text.includes('Rents in New York-Newark-Jersey City, NY-NJ-PA rose 4.0% in the last year (BLS CPI, September 2026).'));
            assert.ok(page.text.includes('Rents in US city average rose 5.0% in the last year (BLS CPI, September 2026).'));
            assert.ok(page.text.includes('BLS series CUURS12ASEHA'));
            assert.ok(page.text.includes('<svg class="rent-trend"'), 'a trend line');
            assert.ok(page.text.includes('BLS.gov cannot vouch'));
            const boisePage = await t.get(boise.path);
            assert.ok(boisePage.text.includes('Rents in US city average rose 5.0%'));
            assert.ok(!boisePage.text.includes('CUURS12ASEHA'), 'no metro line where BLS has none');
            const all = await t.get('/in');
            assert.ok(all.text.includes('Are rents rising?') && all.text.includes('BLS series CUUR0000SEHA'), 'the national line is on /in too');
        });

        await check('the fair page names the same 12-month change', async () => {
            const page = await t.get(`/fair?city=${encodeURIComponent(`${ny.state.toLowerCase()}/${ny.slug}`)}&beds=1&rent=2000`);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Rents in New York-Newark-Jersey City, NY-NJ-PA rose 4.0% in the last year (BLS CPI, September 2026).'));
            assert.ok(page.text.includes('BLS series CUURS12ASEHA'));
        });

        await check('the points survive a restart, and a removed item is deleted', async () => {
            const again = createRentCpi({ config: { sources: { internalUrl: '' } }, s: t.ctx.s, log: { log() {}, warn() {} } });
            assert.strictEqual(await again.load(), 2);
            assert.strictEqual(again.forSeries('CUUR0000SEHA').latest.value, 420);
            source.items.push({ ...item('CUURS12ASEHA', 2026, 'M09', 520, { id: 'itm_CUURS12ASEHA_2026M09', removed: { at: '2026-10-30T07:00:00.000Z', reason: 'licence' }, revision: 2 }), change_seq: 9 });
            const out = await t.ctx.rentCpi.pull();
            assert.strictEqual(out.removed, 1);
            assert.strictEqual(t.ctx.rentCpi.forSeries('CUURS12ASEHA').latest.label, 'September 2025', 'only the 2025 point remains');
            assert.ok(NOTE.includes('BLS.gov cannot vouch'));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
