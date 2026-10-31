'use strict';
/**
 * The market rebuild's outcomes (research-2026-10-30/market/outcomes/rent.md):
 *   1. HUD's Fair Market Rent beside the asking rent, labelled with its year, percentile and source;
 *   2. asking rent, the Census median and HUD's FMR as separate labelled lines, never averaged;
 *   3. month on month and year on year as two fields on the city page's BLS trend;
 *   4. the scam check with its date, and the words behind a flag in a reader's words;
 *   5. a one-tap report to the staff queue, and the line that we take no payment from either side.
 * Outcome 6 (days-on-market and concessions) needs a fetch we do not have: nothing here claims it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, post } = require('./helpers/rent');
const store = require('../server/listings/store');
const cities = require('../server/aggregate/cities');
const AREAS = require('../server/data/city-fmr-areas.json');

const SCAM = 'I am abroad for work so I cannot show it. Send the deposit by wire transfer today and I will mail you the keys.';
const sd = cities.match('San Diego, CA');

const fmrItem = (seq, code, name, rents) => ({
    id: `itm_${seq}`, source_key: 'hud-fair-market-rents', category: 'housing', kind: 'rent_area', identity: code,
    canonical_url: null, title: name, summary: null,
    fields: { fmr_0br: rents[0], fmr_1br: rents[1], fmr_2br: rents[2], fmr_3br: rents[3], fmr_4br: rents[4] },
    revision: 1, provenance: { retrieved_at: '2026-10-22T10:00:00.000Z' }, removed: null, change_seq: seq,
});
const cpiItem = (seq, year, period, value) => ({
    id: `cpi_${seq}`, source_key: 'bls-cpi-rent', category: 'housing', kind: 'rent_cpi', identity: `CUUR0000SEHA-${year}${period}`,
    canonical_url: null, title: 'CUUR0000SEHA', summary: null,
    fields: { series_id: 'CUUR0000SEHA', year: String(year), period, value: String(value) },
    revision: 1, provenance: { retrieved_at: '2026-10-30T06:00:00.000Z' }, removed: null, change_seq: seq,
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
    const ai = {
        run: async (key, input) => ({
            runId: 'run_market',
            output: /wire transfer/.test(input.listing.description)
                ? {
                    action: 'review', rationale: 'Payment by wire before a viewing.',
                    signals: ['payment_before_viewing', 'unusual_payment', 'owner_unavailable', 'made_up'],
                    spans: [
                        { quote: 'Send the deposit by wire transfer today', signal: 'payment_before_viewing' },
                        { quote: 'by wire transfer', signal: 'unusual_payment' },
                        { quote: 'I am abroad for work so I cannot show it.', signal: 'owner_unavailable' },
                        { quote: 'Pay in bitcoin within the hour', signal: 'payment_before_viewing' },
                    ],
                }
                : { action: 'allow', signals: [], spans: [], rationale: '' },
        }),
    };
    const t = await boot({
        ai,
        fmrSource: feed([fmrItem(1, AREAS.areas[sd.id], 'San Diego-Chula Vista-Carlsbad, CA MSA', [2288, 2459, 3001, 3998, 4845])]),
        rentCpiSource: feed([cpiItem(1, 2025, 'M09', 400), cpiItem(2, 2026, 'M08', 419), cpiItem(3, 2026, 'M09', 420)]),
    });
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    let clean;
    let scam;

    try {
        await t.ctx.fmr.pull();
        await t.ctx.rentCpi.pull();

        await check('a US listing shows the asking rent, the Census median and HUD\'s FMR as separate labelled lines', async () => {
            clean = (await post(t, kim, { title: 'Two-bed near Balboa Park', city: 'San Diego', region: 'California', country: 'US', currency: 'USD', price: 2400, bedrooms: 2, neighbourhood: 'North Park' })).json();
            const page = await t.get(`/listings/${clean.id}`, { as: lee });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('<span class="listing-asking-label">Asking rent</span>'), 'the asking rent is labelled');
            assert.strictEqual((page.text.match(/class="rent-line"/g) || []).length, 2, 'the two official lines, each its own row');
            assert.ok(page.text.includes('Census median gross rent') && page.text.includes('$2,442') && page.text.includes('ACS 2020–2024'), 'the Census median with its metric and years');
            assert.ok(page.text.includes('HUD Fair Market Rent') && page.text.includes('$3,001'), 'HUD\'s figure for the 2-bedroom');
            assert.ok(page.text.includes('40th percentile') && page.text.includes('gross rent'), 'the percentile and what it measures');
            assert.ok(page.text.includes('read 2026') && page.text.includes('read 22 Oct 2026'), 'the year and the date the figure carries');
            assert.ok(page.text.includes('https://www.huduser.gov/portal/datasets/fmr.html'), 'the HUD source link');
            assert.ok(page.text.includes('never averaged'), 'the page says the measures are not mixed');
            assert.ok(!page.text.includes('2,721'), 'nothing is the average of the median and the FMR');
        });

        await check('listing cards carry HUD\'s benchmark and the dated check; the home rail too', async () => {
            await t.ctx.screen.settle();
            const checkDate = (await store.getCheck(t.ctx.s, clean.id)).checked_at;
            const r = await t.get('/listings?city=San%20Diego', { as: lee });
            assert.ok(r.text.includes('HUD FMR $3,001'), 'the card carries the benchmark');
            assert.match(r.text, new RegExp(`Checked ${new Date(checkDate).getUTCDate()} `), 'the card carries the check date');
            assert.ok(r.text.includes(`<form class="listing-report-mini" method="post" action="/listings/${clean.id}/reports">`), 'every card can be reported in one tap');
            const home = await t.get('/');
            const rail = (/<section class="ovk-rail[^"]*" id="latest"[\s\S]*?<\/section>/.exec(home.text) || [''])[0];
            assert.ok(rail.includes('HUD FMR $3,001'), 'the home card carries the benchmark');
        });

        await check('the city page labels HUD\'s figure with percentile, year and source, beside the Census median', async () => {
            const page = await t.get(sd.path);
            assert.ok(page.text.includes('Census median') && page.text.includes('HUD FMR'), 'the two columns are named');
            assert.ok(page.text.includes('40th percentile') && page.text.includes('read 22 Oct 2026'), 'percentile and the year/date');
            assert.ok(page.text.includes('https://www.huduser.gov/portal/datasets/fmr.html'), 'the source link');
            assert.ok(page.text.includes('never averaged'), 'the page says they are separate measures');
        });

        await check('month on month and year on year are two fields, each with the months it compares', async () => {
            const page = await t.get(sd.path);
            assert.strictEqual((page.text.match(/class="rent-move"/g) || []).length, 2, 'two fields, not one combined number');
            assert.ok(page.text.includes('Month on month') && page.text.includes('Year on year'));
            assert.ok(page.text.includes('Month on month</span><strong class="rent-move-up">+0.2%'), 'the month-on-month change');
            assert.ok(page.text.includes('Year on year</span><strong class="rent-move-up">+5.0%'), 'the year-on-year change');
            assert.ok(page.text.includes('September 2026 vs August 2026') && page.text.includes('September 2026 vs September 2025'), 'the months each compares');
            assert.ok(!page.text.includes('days on market') && !page.text.includes('concession'), 'outcome 6 is not claimed: we do not fetch it');
        });

        await check('a flagged listing says what the check saw, in quoted words and a reader\'s words, with its date', async () => {
            scam = (await post(t, kim, { title: 'Room in the centre', description: SCAM, city: 'San Diego', region: 'California', country: 'US', currency: 'USD', price: 1500, bedrooms: 2 })).json();
            await t.ctx.screen.settle();
            await t.ctx.screen.settle();
            const c = await store.getCheck(t.ctx.s, scam.id);
            assert.strictEqual(c.action, 'review');
            const page = await t.get(`/listings/${scam.id}`, { as: lee });
            const date = new Date(c.checked_at);
            const stamp = `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${date.getUTCFullYear()}`;
            assert.ok(page.text.includes('Our listing check') && page.text.includes(stamp), 'the check and its date');
            assert.ok(page.text.includes('payment before a viewing'), 'the sign in a reader\'s words');
            assert.ok(page.text.includes('Send the deposit by wire transfer today'), 'the quoted words behind the sign');
            assert.ok(!page.text.includes('payment_before_viewing') && !page.text.includes('made_up'), 'never a raw signal name');
            assert.ok(page.text.includes('not a verdict'), 'a flag is not a verdict');
            const cleanPage = await t.get(`/listings/${clean.id}`, { as: lee });
            assert.ok(cleanPage.text.includes('no scam signs found'), 'a clean check says so');
        });

        await check('one tap reports to the staff queue, and the page says we take no payment from either side', async () => {
            const page = await t.get(`/listings/${scam.id}`, { as: lee });
            assert.ok(page.text.includes(`<form method="post" action="/listings/${scam.id}/reports"><input type="hidden" name="reason" value="scam"><button class="sc-btn sc-primary" type="submit">Report this listing</button></form>`), 'one button, one hidden reason');
            assert.ok(page.text.includes('OpenVibe staff&#39;s report queue') || page.text.includes('OpenVibe staff\'s report queue'), 'the named escalation path');
            assert.ok(page.text.includes('We take no payment from renter or landlord'), 'the no-payment line');
            assert.ok(page.text.includes('3 different reports hide the listing'), 'the escalation count comes from the listing rules');
            const out = await t.get(`/listings/${scam.id}/reports`, { as: lee, method: 'POST', form: { reason: 'scam' }, headers: SAME });
            assert.strictEqual(out.status, 303);
            assert.strictEqual(Number((await store.get(t.ctx.s, scam.id)).report_count), 1);
            const signedOut = await t.get(`/listings/${scam.id}`);
            assert.ok(signedOut.text.includes('We take no payment from renter or landlord'), 'the line is on a signed-out page too');
        });

        await check('a listing outside the US gets no HUD block, and no figure is made up for it', async () => {
            const lisbon = (await post(t, kim, { title: 'A room in Lisbon' })).json();
            const page = await t.get(`/listings/${lisbon.id}`, { as: lee });
            assert.ok(!page.text.includes('HUD Fair Market Rent'), 'no HUD figure for a non-US listing');
            assert.ok(!page.text.includes('Census median gross rent'), 'no Census figure either');
            assert.ok(page.text.includes('Asking rent'), 'the asking rent still shows');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
