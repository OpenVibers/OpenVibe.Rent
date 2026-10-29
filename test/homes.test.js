'use strict';
/**
 * OpenVibe.Homes (server/homes): the buying side of Rent, served by this process for the openvibe.homes host.
 *   - one place opens every for-sale site's search, the government and bank homes, and the state's records directory;
 *   - Redfin only with a ZIP (its city pages need its own ids); a place outside the US gets nothing guessed;
 *   - the mortgage arithmetic is the standard amortisation, and bad input is refused;
 *   - the Homes host gets Homes' pages and name, Rent's host is untouched, and the records and calculator work.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const sites = require('../server/homes/sites');
const { monthly } = require('../server/homes/mortgage');

const SLC = { city: 'Salt Lake City', state: 'UT', country: 'us', postcode: '84111' };
const urls = (links) => Object.fromEntries(links.map((l) => [l.id, l.url]));
const nominatimSlc = [{
    lat: '40.7596198', lon: '-111.8867975', display_name: 'Salt Lake City, Salt Lake County, Utah, 84111, United States',
    boundingbox: ['40.6996', '40.8533', '-112.1015', '-111.7393'],
    address: { city: 'Salt Lake City', county: 'Salt Lake County', state: 'Utah', 'ISO3166-2-lvl4': 'US-UT', postcode: '84111', country: 'United States', country_code: 'us' },
}];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const housingFetchImpl = async (url) => (new URL(String(url)).pathname.endsWith('/search') ? json(nominatimSlc) : json({ features: [] }));

(async () => {
    await check('homes for sale: every site at the place, with the filters each takes; Redfin by ZIP only', () => {
        const u = urls(sites.linksFor(SLC, { kind: 'home', maxPrice: 500000, minBeds: 3 }));
        assert.deepStrictEqual(Object.keys(u), ['zillow', 'realtor', 'redfin', 'homes', 'trulia', 'craigslist']);
        assert.strictEqual(u.zillow, 'https://www.zillow.com/salt-lake-city-ut/');
        assert.strictEqual(u.realtor, 'https://www.realtor.com/realestateandhomes-search/Salt-Lake-City_UT/beds-3/price-na-500000');
        assert.strictEqual(u.redfin, 'https://www.redfin.com/zipcode/84111');
        assert.strictEqual(u.homes, 'https://www.homes.com/salt-lake-city-ut/');
        assert.strictEqual(u.trulia, 'https://www.trulia.com/UT/Salt_Lake_City/');
        assert.strictEqual(u.craigslist, 'https://www.craigslist.org/search/city/salt-lake-city-ut?cat=rea&max_price=500000&min_bedrooms=3');
        assert.ok(!('redfin' in urls(sites.linksFor({ ...SLC, postcode: null }, { kind: 'home' }))), 'no ZIP, no Redfin');
        assert.deepStrictEqual(sites.linksFor({ city: 'Toronto', state: 'ON', country: 'ca' }, { kind: 'home' }), [], 'outside the US: nothing guessed');
    });

    await check('foreclosures, land and commercial; the records directory per state', () => {
        assert.deepStrictEqual(urls(sites.linksFor(SLC, { kind: 'foreclosure' })), {
            hud: 'https://www.hudhomestore.gov/searchresult?citystate=UT',
            homepath: 'https://homepath.fanniemae.com/property-finder?location=Salt+Lake+City%2C+UT',
            auction: 'https://www.auction.com/residential/ut',
        });
        assert.deepStrictEqual(Object.keys(urls(sites.linksFor(SLC, { kind: 'land' }))), ['craigslist', 'landwatch']);
        assert.strictEqual(urls(sites.linksFor(SLC, { kind: 'land' })).landwatch, 'https://www.landwatch.com/utah-land-for-sale/salt-lake-city');
        assert.strictEqual(urls(sites.linksFor(SLC, { kind: 'commercial' })).loopnet, 'https://www.loopnet.com/search/commercial-real-estate/salt-lake-city-ut/for-sale/');
        assert.strictEqual(sites.recordsUrl('UT'), 'https://publicrecords.netronline.com/state/UT');
        assert.strictEqual(sites.recordsUrl('ZZ'), null);
    });

    await check('the mortgage: standard amortisation, the extras per month, bad input refused', () => {
        const m = monthly({ price: '400,000', downPercent: 20, ratePercent: 6, years: 30, taxPerYear: 3600, insurancePerYear: 1200, hoaPerMonth: 50 });
        assert.strictEqual(m.loan, 320000);
        assert.strictEqual(m.principalAndInterest, 1918.56);
        assert.strictEqual(m.total, 1918.56 + 300 + 100 + 50);
        assert.strictEqual(m.payments, 360);
        assert.strictEqual(monthly({ price: 120000, downPercent: 0, ratePercent: 0, years: 10 }).principalAndInterest, 1000, 'no interest: the loan over the months');
        assert.ok(monthly({ price: 0, downPercent: 20, ratePercent: 6, years: 30 }).error);
        assert.ok(monthly({ price: 300000, downPercent: 20, ratePercent: 6, years: 17 }).error, 'only real terms');
    });

    const t = await boot({ housingFetchImpl, env: { RENT_HOMES_URL: 'https://openvibe.homes' } });
    // fetch() drops a Host header; the Homes host needs a plain http request.
    const homes = (path) => new Promise((resolve, reject) => {
        const u = new URL(t.base + path);
        require('http').get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Host: 'openvibe.homes' } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
    });
    try {
        await check('the Homes host: its own home page and name; Rent\'s host is untouched', async () => {
            const r = await homes('/');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Buying a home?') && r.text.includes('OpenVibe.Homes'));
            const up = await homes('/updates');
            assert.strictEqual(up.status, 200, 'the update log, as on every OpenVibe site');
            assert.ok(up.text.includes('What shipped on OpenVibe.Homes') && up.text.includes('data-ov-shipped'));
            assert.ok(/<script type="application\/ld\+json">[^<]*"@type":"WebSite"[^<]*"name":"OpenVibe.Homes"/.test(r.text), 'the home says what the site is (JSON-LD)');
            assert.ok(r.text.includes('<link rel="canonical" href="https://openvibe.homes/">'), 'its own canonical');
            assert.ok(r.text.includes('What homes are worth in the largest cities') && r.text.includes('href="/in/ny/new-york"'), 'the largest cities\' home values, each opening its city page');
            assert.ok(r.text.includes('Where homes cost least and most') && r.text.includes('Homes by state'), 'the cheapest and dearest big cities, and every state');
            // The same front-page shape as Rent's: the search first, the cities as a rail of cards with All N, the parts
            // read once folded, the site's places as a launcher.
            assert.ok(r.text.includes('<form class="ovk-find" method="get" action="/search" role="search">'), 'the search is the kit\'s pill');
            assert.ok(/<section class="ovk-rail[^"]*" id="cities"/.test(r.text) && /<a class="ovk-rail-more" href="\/in">All \d+ cities/.test(r.text), 'the cities are a rail with All N');
            assert.ok(/<details class="ovk-fold" id="range">/.test(r.text) && /<details class="ovk-fold" id="states">/.test(r.text) && /<details class="ovk-fold" id="sites">/.test(r.text), 'the ranks, the states and the sites are folds');
            assert.ok(/<section class="sc-sec sc-apps-sec" id="places"/.test(r.text) && r.text.includes('href="/records"') && r.text.includes('href="/mortgage"'), 'the places as a launcher');
            assert.ok(r.text.includes('Questions people ask') && /"@type":"FAQPage"/.test(r.text) && /"@type":"ItemList"/.test(r.text), 'the questions shown are the FAQPage; the cities are an ItemList');
            assert.ok(!r.text.includes('Where home prices moved'), 'no price-trend block without FHFA rows');
            const rent = await t.get('/');
            assert.ok(!rent.text.includes('Buying a home?'), 'Rent still serves Rent');
            assert.strictEqual((await homes('/listings')).status, 404, 'Rent\'s pages are not on the Homes host');
        });

        await check('a search: every site, the area\'s records and a link back to renting', async () => {
            const r = await homes('/search?q=Salt+Lake+City&kind=home&max=500000&beds=3');
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.ok(r.text.includes('Homes for sale near Salt Lake City, UT'));
            assert.ok(r.text.includes('href="https://www.zillow.com/salt-lake-city-ut/" target="_blank" rel="noopener nofollow"'));
            assert.ok(r.text.includes('href="https://www.redfin.com/zipcode/84111"'));
            assert.ok(r.text.includes('https://publicrecords.netronline.com/state/UT'));
            assert.ok(r.text.includes('https://openvibe.rent/everywhere?q=Salt+Lake+City'));
            assert.ok(r.text.includes('noindex'), 'a result page is not indexed');
        });

        await check('records and the calculator pages; crawl files for the host', async () => {
            const rec = await homes('/records');
            assert.ok(rec.text.includes('href="https://publicrecords.netronline.com/state/UT"') && rec.text.includes('Utah'));
            const calc = await homes('/mortgage?price=400000&down=20&rate=6&years=30&tax=3600&ins=1200&hoa=50');
            assert.ok(calc.text.includes('About $2,368.56 a month'), calc.text.slice(0, 400));
            assert.match((await homes('/robots.txt')).text, /Sitemap: https:\/\/openvibe\.homes\/sitemap\.xml/);
            assert.ok((await homes('/sitemap.xml')).text.includes('<loc>https://openvibe.homes/mortgage</loc>'));
        });

        await check('homes by city: the median value (the top code as a range), the mortgage on it, renting there, every site, nearby; in the sitemap', async () => {
            const a = await homes('/in/tx/austin');
            assert.strictEqual(a.status, 200);
            assert.ok(a.text.includes('<h1>Buying a home in Austin, TX</h1>') && a.text.includes('$555,300') && a.text.includes('±$8,017'));
            assert.ok(a.text.includes('href="/mortgage?price=555300&amp;down=20"') || a.text.includes('href="/mortgage?price=555300&down=20"'), 'the calculator with the median price, the rate left to the person');
            assert.ok(a.text.includes('rents for $1,845 a month') && a.text.includes('/in/tx/austin">Rents and every rental site in Austin'), 'its Rent twin');
            assert.ok(a.text.includes('https://www.zillow.com/austin-tx/') && a.text.includes('href="https://publicrecords.netronline.com/state/TX"'));
            assert.match(a.text, /<meta name="robots" content="index, follow">/);
            const pa = await homes('/in/ca/palo-alto');
            assert.ok(pa.text.includes('$2,000,000 or more') && !pa.text.includes('$2,000,001'), 'the top code is a range, never a price');
            assert.ok(pa.text.includes('href="/mortgage"'), 'no median price to carry into the calculator');
            assert.strictEqual((await homes('/in/tx/nowhere')).status, 404);
            assert.ok((await homes('/in/tx')).text.includes('Buying a home in Texas'));
            assert.ok((await homes('/in')).text.includes('href="/in/vt"'));
            const map = (await homes('/sitemap.xml')).text;
            assert.ok(map.includes('<loc>https://openvibe.homes/in/tx/austin</loc>') && map.includes('<loc>https://openvibe.homes/in</loc>'));
        });
    } finally { await t.close(); }
    done();
})();
