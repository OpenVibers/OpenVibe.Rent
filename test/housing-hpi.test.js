'use strict';
/**
 * "Home prices around here": the FHFA House Price Index ingest, the MSA-then-state lookup, the page card and the
 * API field. The CSV is streamed straight into the ingest (no network), and the HUD/Nominatim upstream is injected
 * through opts.housingFetchImpl exactly as in test/housing.test.js.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const hpi = require('../server/housing/hpi');

const HEADER = 'hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,index_nsa,index_sa,rstderr,note';
const row = (a) => a.join(',');
const streamOf = (text) => (async function* () { yield text; })();

const fullCsv = [
    HEADER,
    // Colorado: the state fallback. Q2 2021 / Q2 2025 / Q2 2026 give a clean year and five-year change.
    row(['traditional', 'all-transactions', 'quarterly', 'State', 'Colorado', 'CO', '2021', '2', '100.0', '100.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'quarterly', 'State', 'Colorado', 'CO', '2025', '2', '110.0', '110.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'quarterly', 'State', 'Colorado', 'CO', '2026', '1', '118.0', '118.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'quarterly', 'State', 'Colorado', 'CO', '2026', '2', '118.8', '118.8', '0.0', '']),
    // Older than the six-year window: must be dropped even though it otherwise matches.
    row(['traditional', 'all-transactions', 'quarterly', 'State', 'Colorado', 'CO', '2015', '2', '90.0', '90.0', '0.0', '']),
    // Denver MSA, with a quoted place_name that contains a comma.
    row(['traditional', 'all-transactions', 'quarterly', 'MSA', '"Denver-Aurora-Centennial, CO"', '19740', '2021', '2', '100.0', '100.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'quarterly', 'MSA', '"Denver-Aurora-Centennial, CO"', '19740', '2025', '2', '120.0', '120.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'quarterly', 'MSA', '"Denver-Aurora-Centennial, CO"', '19740', '2026', '2', '132.0', '132.0', '0.0', '']),
    // A multi-state MSA: the state list must parse to DC,VA,MD,WV.
    row(['traditional', 'all-transactions', 'quarterly', 'MSA', '"Washington-Arlington-Alexandria, DC-VA-MD-WV"', '47900', '2026', '2', '150.0', '150.0', '0.0', '']),
    // Another state that is kept but never matched for Colorado.
    row(['traditional', 'all-transactions', 'quarterly', 'State', 'Texas', 'TX', '2026', '2', '105.0', '105.0', '0.0', '']),
    // Rows that must be ignored: wrong flavor, wrong frequency, wrong levels.
    row(['traditional', 'purchase-only', 'quarterly', 'State', 'Colorado', 'CO', '2026', '2', '200.0', '200.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'monthly', 'State', 'Colorado', 'CO', '2026', '6', '119.0', '119.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'quarterly', 'USA', 'United States', 'USA', '2026', '2', '120.0', '120.0', '0.0', '']),
    row(['traditional', 'all-transactions', 'quarterly', 'Census Division', 'Mountain', 'MTN', '2026', '2', '121.0', '121.0', '0.0', '']),
].join('\n');

const replacementCsv = [
    HEADER,
    row(['traditional', 'all-transactions', 'quarterly', 'State', 'Texas', 'TX', '2026', '2', '999.0', '999.0', '0.0', '']),
].join('\n');

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const denverPlace = [{
    place_id: 1, lat: '39.7392', lon: '-104.9903', display_name: 'Denver, Colorado, United States',
    boundingbox: ['39.61', '39.86', '-105.11', '-104.88'],
    address: { country: 'United States', country_code: 'us', state: 'Colorado', 'ISO3166-2-lvl4': 'US-CO', city: 'Denver' },
}];
const telluridePlace = [{
    place_id: 2, lat: '37.9375', lon: '-107.8123', display_name: 'Telluride, Colorado, United States',
    boundingbox: ['37.92', '37.95', '-107.84', '-107.78'],
    address: { country: 'United States', country_code: 'us', state: 'Colorado', city: 'Telluride' },
}];

const mockFetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/search')) {
        const q = u.searchParams.get('q') || '';
        if (/denver/i.test(q)) return jsonResponse(denverPlace);
        if (/telluride/i.test(q)) return jsonResponse(telluridePlace);
        return jsonResponse([]);
    }
    if (u.pathname.includes('/query')) return jsonResponse({ features: [] });
    return jsonResponse([]);
};

(async () => {
    // ── Unit: percentages and the missing-quarter rule ────────
    await check('changes: the year and five-year percentages, rounded to 0.1%', () => {
        const c = hpi.changes([
            { yr: 2021, quarter: 2, index_nsa: 100 },
            { yr: 2025, quarter: 2, index_nsa: 110 },
            { yr: 2026, quarter: 2, index_nsa: 118.8 },
        ]);
        assert.strictEqual(c.year_change_pct, 8.0);
        assert.strictEqual(c.five_year_change_pct, 18.8);
        assert.strictEqual(c.latest, 'Q2 2026');
    });

    await check('changes: a missing year-ago quarter is null, never invented', () => {
        const c = hpi.changes([
            { yr: 2021, quarter: 2, index_nsa: 100 },
            { yr: 2026, quarter: 2, index_nsa: 130 },
        ]);
        assert.strictEqual(c.year_change_pct, null);
        assert.strictEqual(c.five_year_change_pct, 30.0);
        assert.strictEqual(c.latest, 'Q2 2026');
    });

    await check('csv records keep a quoted comma inside place_name', async () => {
        const rows = [];
        for await (const r of hpi.csvRecords(streamOf(`${HEADER}\n${row(['traditional', 'all-transactions', 'quarterly', 'MSA', '"Denver-Aurora-Centennial, CO"', '19740', '2026', '2', '132.0', '132.0', '0.0', ''])}\n`))) rows.push(r);
        assert.strictEqual(rows[1][4], 'Denver-Aurora-Centennial, CO');
    });

    // ── Integration: boot with HPI on and a stubbed upstream ──
    const t = await boot({ housingFetchImpl: mockFetch, env: { RENT_HPI: 'true' } });
    try {
        await check('no home-price card or API field before any data is ingested', async () => {
            const api = await t.get('/api/v1/housing?q=Denver');
            assert.strictEqual(api.status, 200);
            assert.strictEqual(api.json().area_prices, null);

            const page = await t.get('/housing?q=Denver');
            assert.strictEqual(page.status, 200);
            assert.ok(!page.text.includes('Home prices around'));
        });

        await check('the ingest keeps only the matching rows from the last six years', async () => {
            const out = await hpi.ingestFromStream(t.ctx.s, streamOf(fullCsv), { fetchedAt: '2026-10-12T00:00:00.000Z' });
            assert.strictEqual(out.scanned, 14);
            assert.strictEqual(out.kept, 9);

            const rows = await t.ctx.s.db.many('SELECT level, place_id, place_name, states, yr, quarter, index_nsa FROM area_price_index ORDER BY level, place_id, yr, quarter');
            assert.strictEqual(rows.length, 9);
            assert.ok(rows.every((r) => r.level === 'state' || r.level === 'msa'));
            assert.ok(!rows.some((r) => r.level === 'USA' || r.level === 'Census Division'));
            assert.strictEqual(rows.filter((r) => r.place_id === 'CO').length, 4, 'Colorado keeps its four in-window quarters');
            assert.ok(!rows.some((r) => r.place_id === 'CO' && r.yr === 2015), 'the six-year window drops 2015');
            assert.strictEqual(rows.filter((r) => r.place_id === '19740').length, 3, 'Denver MSA keeps its three quarters');
            const dc = rows.find((r) => r.place_id === '47900');
            assert.strictEqual(dc.states, 'DC,VA,MD,WV');
            assert.ok(rows.some((r) => r.place_id === 'TX'));
        });

        await check('a later ingest replaces the old rows whole', async () => {
            const out = await hpi.ingestFromStream(t.ctx.s, streamOf(replacementCsv), { fetchedAt: '2026-10-12T01:00:00.000Z' });
            assert.strictEqual(out.kept, 1);
            const rows = await t.ctx.s.db.many('SELECT place_id, yr, quarter, index_nsa FROM area_price_index');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].place_id, 'TX');
            assert.strictEqual(Number(rows[0].index_nsa), 999.0);
        });

        await check('a refresh with no usable rows keeps the old rows', async () => {
            const before = (await t.ctx.s.db.many('SELECT place_id FROM area_price_index ORDER BY place_id')).map((r) => r.place_id);
            await assert.rejects(
                () => hpi.ingestFromStream(t.ctx.s, streamOf(`${HEADER}\n${row(['traditional', 'purchase-only', 'quarterly', 'State', 'Colorado', 'CO', '2026', '2', '200.0', '200.0', '0.0', ''])}\n`), { fetchedAt: '2026-10-12T03:00:00.000Z' }),
                /no usable rows/);
            const after = (await t.ctx.s.db.many('SELECT place_id FROM area_price_index ORDER BY place_id')).map((r) => r.place_id);
            assert.deepStrictEqual(after, before);
        });

        await hpi.ingestFromStream(t.ctx.s, streamOf(fullCsv), { fetchedAt: '2026-10-12T02:00:00.000Z' });

        await check('the MSA wins for a city that is in its name list', async () => {
            const api = await t.get('/api/v1/housing?q=Denver');
            assert.strictEqual(api.status, 200);
            const p = api.json().area_prices;
            assert.strictEqual(p.place, 'Denver-Aurora-Centennial, CO');
            assert.strictEqual(p.level, 'msa');
            assert.strictEqual(p.year_change_pct, 10.0);
            assert.strictEqual(p.five_year_change_pct, 32.0);
            assert.strictEqual(p.latest, 'Q2 2026');
            assert.deepStrictEqual(p.source, { name: 'FHFA House Price Index', url: 'https://www.fhfa.gov/data/hpi' });
        });

        await check('a small town falls back to its state', async () => {
            const api = await t.get('/api/v1/housing?q=Telluride');
            assert.strictEqual(api.status, 200);
            const p = api.json().area_prices;
            assert.strictEqual(p.place, 'Colorado');
            assert.strictEqual(p.level, 'state');
            assert.strictEqual(p.year_change_pct, 8.0);
            assert.strictEqual(p.five_year_change_pct, 18.8);
            assert.strictEqual(p.latest, 'Q2 2026');
        });

        await check('the page shows the home-price card above the results, with the repeat-sales note and source', async () => {
            const r = await t.get('/housing?q=Denver');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.ok(r.text.includes('Home prices around Denver-Aurora-Centennial, CO'));
            assert.match(r.text, /\+10\.0 %<\/span><span class="hpi-label">over the past year/);
            assert.match(r.text, /\+32\.0 %<\/span><span class="hpi-label">over five years/);
            assert.ok(r.text.includes('FHFA all-transactions index, Q2 2026.'));
            assert.ok(r.text.includes('This is an index of repeat sales, not a price.'));
            assert.ok(r.text.includes('Source: FHFA House Price Index'));
            assert.ok(r.text.includes('https://www.fhfa.gov/data/hpi'));
        });

        await check('where prices moved: every state and metro with a year-ago quarter, highest first, on the latest quarter only', async () => {
            const m = await hpi.areaMoves(t.ctx.s);
            assert.strictEqual(m.latest, 'Q2 2026');
            assert.deepStrictEqual(m.states.map((x) => [x.place_id, x.year_change_pct]), [['CO', 8.0]], 'Texas has no year-ago quarter, so it is not ranked');
            assert.deepStrictEqual(m.metros.map((x) => [x.place_name, x.year_change_pct]), [['Denver-Aurora-Centennial, CO', 10.0]]);
            assert.strictEqual(m.source.url, 'https://www.fhfa.gov/data/hpi');
        });

        await check('the state fallback card names the state', async () => {
            const r = await t.get('/housing?q=Telluride');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Home prices around Colorado'));
            assert.match(r.text, /\+8\.0 %<\/span><span class="hpi-label">over the past year/);
            assert.match(r.text, /\+18\.8 %<\/span><span class="hpi-label">over five years/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
