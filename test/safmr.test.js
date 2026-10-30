'use strict';
/**
 * HUD's Small Area Fair Market Rents (server/housing/safmr.js), from a recorded item of the Sources item (no live call
 * here): the figures a ZIP carries, shown as a dated reference, and only where a ZIP is known.
 */
const assert = require('assert');
const { createSafmr, rowOf } = require('../server/housing/safmr');
const { check, done } = require('./helpers/boot');
const { testDb } = require('./helpers/db');

// A recorded item of the Sources `hud-safmr` feed: the shape the api adapter stores (a HUD row, Indianapolis-Carmel).
const item = (over = {}) => ({
    id: 'itm_1', source_key: 'hud-safmr', category: 'housing', kind: 'safmr', identity: '1',
    title: 'Indianapolis-Carmel, IN HUD Metro FMR Area', summary: null, authors: [], published_at: null,
    fields: { zip: 47435, hud_code: 'METRO26900M26900', metro_name: 'Indianapolis-Carmel, IN HUD Metro FMR Area', fiscal_year: 2024, safmr_0br: 850, safmr_1br: 990, safmr_2br: 1170, safmr_3br: 1430, safmr_4br: 1690 },
    provenance: { retrieved_at: '2026-10-30T06:00:00.000Z' }, removed: null, ...over,
});

(async () => {
    const fresh = await testDb();
    const s = { db: fresh.db, now: () => Date.parse('2026-10-30T08:00:00Z'), iso: () => '2026-10-30T08:00:00.000Z' };
    const safmr = createSafmr({ config: { sources: { internalUrl: '' } }, s, log: { log() {}, warn() {} } });
    try {
        await check('a HUD row becomes the reference for its ZIP, with the fiscal year it carries', async () => {
            await safmr.apply(item());
            const ref = safmr.reference('47435', 2);
            assert.strictEqual(ref.text, 'HUD fair market rent for a 2-bedroom here: $1,170 (FY2024)');
            assert.strictEqual(ref.amount, 1170);
            assert.strictEqual(ref.year, 2024);
            assert.strictEqual(safmr.reference('47435', 0).text, 'HUD fair market rent for a studio here: $850 (FY2024)');
        });

        await check('the reference appears only where a ZIP is known', async () => {
            assert.strictEqual(safmr.reference('99999', 2), null, 'a ZIP HUD does not know has no figure');
            assert.strictEqual(safmr.reference(null, 2), null, 'no ZIP, no figure');
            assert.strictEqual(safmr.reference('', 2), null);
        });

        await check('the newest fiscal year for a ZIP is the one shown, and a second metro row changes nothing', async () => {
            await safmr.apply(item({ id: 'itm_2', identity: '2', fields: { ...item().fields, fiscal_year: 2018, safmr_2br: 900 } }));
            assert.strictEqual(safmr.reference('47435', 2).amount, 1170, 'the older year does not win');
            await safmr.apply(item({ id: 'itm_3', identity: '3', fields: { ...item().fields, hud_code: 'METRO26900MM8960' } }));
            assert.strictEqual(safmr.size(), 1, 'a ZIP is shown once');
        });

        await check('a row that is not a HUD figure is not kept', () => {
            assert.strictEqual(rowOf(item({ fields: { ...item().fields, zip: 'not a zip' } })), null);
            assert.strictEqual(rowOf(item({ fields: { ...item().fields, fiscal_year: null } })), null);
            assert.strictEqual(rowOf(item({ fields: { ...item().fields, safmr_0br: null, safmr_1br: null, safmr_2br: null, safmr_3br: null, safmr_4br: null } })), null);
        });
    } finally { await fresh.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
