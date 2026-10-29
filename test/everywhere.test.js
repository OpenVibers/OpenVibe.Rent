'use strict';
/**
 * Search everywhere (server/aggregate/everywhere.js, /everywhere, /api/v1/everywhere): one place and filters open every
 * rental site's own search there, with the URL forms checked in a real browser on 2026-10-15; a site that cannot serve
 * the place is left out; the page and the API answer with the geocoded place; the home is the aggregator the owner
 * asked for and no longer says nothing is scraped.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const everywhere = require('../server/aggregate/everywhere');

const SLC = { city: 'Salt Lake City', state: 'UT', country: 'us', postcode: '84111', lat: 40.7608, lon: -111.891, countryName: 'United States' };
const urls = (links) => Object.fromEntries(links.map((l) => [l.id, l.url]));
const ids = (links) => links.map((l) => l.id);

const nominatimSlc = [{
    lat: '40.7596198', lon: '-111.8867975', display_name: 'Salt Lake City, Salt Lake County, Utah, 84111, United States',
    boundingbox: ['40.6996', '40.8533', '-112.1015', '-111.7393'],
    address: { city: 'Salt Lake City', county: 'Salt Lake County', state: 'Utah', 'ISO3166-2-lvl4': 'US-UT', postcode: '84111', country: 'United States', country_code: 'us' },
}];
const nominatimToronto = [{
    lat: '43.6534817', lon: '-79.3839347', display_name: 'Toronto, Ontario, Canada', boundingbox: ['43.58', '43.86', '-79.64', '-79.11'],
    address: { city: 'Toronto', state: 'Ontario', 'ISO3166-2-lvl4': 'CA-ON', country: 'Canada', country_code: 'ca' },
}];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const housingFetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/search')) return json(/toronto/i.test(u.searchParams.get('q') || '') ? nominatimToronto : nominatimSlc);
    return json({ features: [] });
};

(async () => {
    await check('apartments in a multi-word US city: every site, in order, at the place and with the filters each takes', () => {
        const links = everywhere.linksFor(SLC, { kind: 'apartment', maxPrice: 1500, minBeds: 2 });
        assert.deepStrictEqual(ids(links), ['craigslist', 'facebook', 'zillow', 'apartments', 'zumper', 'rentcom', 'rentcafe', 'apartmentlist', 'padmapper', 'hotpads', 'trulia', 'realtor']);
        const u = urls(links);
        assert.strictEqual(u.craigslist, 'https://www.craigslist.org/search/city/salt-lake-city-ut?cat=apa&max_price=1500&min_bedrooms=2&postal=84111&radius=10');
        assert.strictEqual(u.facebook, 'https://www.facebook.com/marketplace/saltlakecity/propertyrentals');
        assert.strictEqual(u.zillow, 'https://www.zillow.com/salt-lake-city-ut/rentals/');
        assert.strictEqual(u.apartments, 'https://www.apartments.com/salt-lake-city-ut/2-bedrooms-under-1500/');
        assert.strictEqual(u.zumper, 'https://www.zumper.com/apartments-for-rent/salt-lake-city-ut');
        assert.strictEqual(u.rentcom, 'https://www.rent.com/utah/salt-lake-city-apartments');
        assert.strictEqual(u.rentcafe, 'https://www.rentcafe.com/apartments-for-rent/salt-lake-city-ut/');
        assert.strictEqual(u.apartmentlist, 'https://www.apartmentlist.com/ut/salt-lake-city');
        assert.strictEqual(u.padmapper, 'https://www.padmapper.com/apartments/salt-lake-city-ut');
        assert.strictEqual(u.hotpads, 'https://hotpads.com/salt-lake-city-ut/apartments-for-rent');
        assert.strictEqual(u.trulia, 'https://www.trulia.com/for_rent/Salt_Lake_City,UT/');
        assert.strictEqual(u.realtor, 'https://www.realtor.com/apartments/Salt-Lake-City_UT');
        assert.ok(links.every((l) => l.best && l.name), 'every link says what the site is best for');
    });

    await check('each kind opens the sites that carry it', () => {
        const u = (kind) => urls(everywhere.linksFor(SLC, { kind }));
        assert.deepStrictEqual(Object.keys(u('house')), ['craigslist', 'facebook', 'zillow', 'zumper', 'rentcom', 'padmapper', 'hotpads', 'trulia', 'realtor']);
        assert.strictEqual(u('house').zillow, 'https://www.zillow.com/salt-lake-city-ut/rent-houses/');
        assert.strictEqual(u('house').zumper, 'https://www.zumper.com/houses-for-rent/salt-lake-city-ut');
        assert.strictEqual(u('house').rentcom, 'https://www.rent.com/utah/salt-lake-city-houses');
        assert.deepStrictEqual(Object.keys(u('room')), ['craigslist', 'facebook', 'zumper', 'roomies', 'furnishedfinder']);
        assert.match(u('room').craigslist, /\?cat=roo&postal=84111&radius=10$/);
        assert.strictEqual(u('room').roomies, 'https://www.roomies.com/rooms/salt-lake-city-ut');
        assert.deepStrictEqual(Object.keys(u('stay')), ['craigslist', 'furnishedfinder', 'airbnb']);
        assert.match(u('stay').craigslist, /\?cat=sub&/);
        assert.strictEqual(u('stay').airbnb, 'https://www.airbnb.com/s/Salt-Lake-City--UT/homes?monthly_stay=true');
        assert.strictEqual(u('stay').furnishedfinder, 'https://www.furnishedfinder.com/housing/us--ut--salt-lake-city');
        assert.deepStrictEqual(Object.keys(u('commercial')), ['craigslist', 'loopnet']);
        assert.strictEqual(u('commercial').loopnet, 'https://www.loopnet.com/search/commercial-real-estate/salt-lake-city-ut/for-lease/');
        assert.deepStrictEqual(Object.keys(u('parking')), ['craigslist', 'spothero']);
        assert.strictEqual(u('parking').spothero, 'https://spothero.com/search?latitude=40.7608&longitude=-111.8910&kind=monthly');
        assert.deepStrictEqual(Object.keys(u('storage')), ['craigslist', 'sparefoot']);
        assert.strictEqual(u('storage').sparefoot, 'https://www.sparefoot.com/Salt-Lake-City-UT-self-storage.html');
        assert.deepStrictEqual(Object.keys(u('vehicle')), ['turo']);
        assert.strictEqual(u('vehicle').turo, 'https://turo.com/us/en/search?country=US&location=Salt+Lake+City%2C+UT');
    });

    await check('outside the US only the sites that work worldwide; nothing is guessed', () => {
        const toronto = { city: 'Toronto', state: null, country: 'ca', countryName: 'Canada' };
        assert.deepStrictEqual(ids(everywhere.linksFor(toronto, { kind: 'apartment' })), ['facebook']);
        assert.deepStrictEqual(urls(everywhere.linksFor(toronto, { kind: 'stay' })), { airbnb: 'https://www.airbnb.com/s/Toronto--Canada/homes?monthly_stay=true' });
        assert.deepStrictEqual(everywhere.linksFor({ city: null, state: 'UT' }, { kind: 'apartment' }), [], 'no city, no links');
    });

    await check('filters are bounded, an unknown kind is apartments, and every link is https', () => {
        const u = urls(everywhere.linksFor(SLC, { kind: 'boats', maxPrice: 'abc', minBeds: 99 }));
        assert.strictEqual(u.craigslist, 'https://www.craigslist.org/search/city/salt-lake-city-ut?cat=apa&postal=84111&radius=10');
        assert.strictEqual(u.apartments, 'https://www.apartments.com/salt-lake-city-ut/');
        for (const kind of everywhere.KINDS) for (const l of everywhere.linksFor(SLC, { kind })) assert.match(l.url, /^https:\/\/[a-z0-9.-]+\//, l.url);
    });

    const t = await boot({ housingFetchImpl });
    try {
        await check('/everywhere: the place, every site for it, the kinds, and what OpenVibe.Rent has there', async () => {
            const r = await t.get('/everywhere?q=Salt+Lake+City&kind=apartment&max=1500&beds=2');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.ok(r.text.includes('Apartments near Salt Lake City, UT'));
            assert.ok(r.text.includes('href="https://www.craigslist.org/search/city/salt-lake-city-ut?cat=apa&amp;max_price=1500&amp;min_bedrooms=2&amp;postal=84111&amp;radius=10"'));
            assert.ok(r.text.includes('href="https://www.apartments.com/salt-lake-city-ut/2-bedrooms-under-1500/"'));
            assert.ok(r.text.includes('target="_blank" rel="noopener nofollow"'), 'opens in a new tab, no referrer games');
            assert.ok(r.text.includes('href="/everywhere?q=Salt+Lake+City&amp;kind=room&amp;max=1500&amp;beds=2"'), 'the other kinds keep the place and filters');
            assert.ok(r.text.includes('href="/housing?q=Salt+Lake+City"'), 'affordable housing for the same place');
            assert.ok(r.text.includes('/listings?kind=apartment&amp;city=Salt+Lake+City&amp;max=1500'), 'listings posted here');
            assert.ok(r.text.includes('noindex'), 'a search result page is not indexed');
            const blank = await t.get('/everywhere');
            assert.strictEqual(blank.status, 200);
            assert.ok(blank.text.includes('Search every rental site') && !blank.text.includes('noindex'));
        });

        await check('/everywhere outside the US: the worldwide sites, and no HUD link', async () => {
            const r = await t.get('/everywhere?q=Toronto&kind=apartment');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('facebook.com/marketplace/toronto/propertyrentals'));
            assert.ok(!r.text.includes('craigslist.org') && !r.text.includes('href="/housing?q='));
        });

        await check('/api/v1/everywhere answers the place and the sites; bad input is a 422 problem', async () => {
            const r = await t.get('/api/v1/everywhere?q=Salt+Lake+City&kind=room');
            assert.strictEqual(r.status, 200);
            const b = r.json();
            assert.deepStrictEqual([b.place.city, b.place.state, b.place.country, b.kind], ['Salt Lake City', 'UT', 'us', 'room']);
            assert.deepStrictEqual(b.sites.map((x) => x.id), ['craigslist', 'facebook', 'zumper', 'roomies', 'furnishedfinder']);
            assert.strictEqual((await t.get('/api/v1/everywhere?q=x&kind=boats')).status, 422);
            assert.strictEqual((await t.get('/api/v1/everywhere?kind=room')).json().code, 'rent.everywhere.invalid');
        });

        await check('the home is the aggregator: one search over every site, and it no longer says nothing is scraped', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Every rental site.') && r.text.includes('One search.'));
            assert.ok(r.text.includes('action="/everywhere"'), 'the hero search goes everywhere');
            for (const name of ['Craigslist', 'Facebook Marketplace', 'Zillow', 'Apartments.com', 'Zumper', 'Turo']) assert.ok(r.text.includes(name), name);
            // Every site it searches is named on the home, in a fold (read once), with the real count.
            const sites = (/<details class="ovk-fold" id="sites">[\s\S]*?<\/details>/.exec(r.text) || [''])[0];
            assert.ok(sites.includes(`· ${everywhere.SITES.length} sites`) && everywhere.SITES.every((x) => sites.includes(`<b>${x.name.replace(/&/g, '&amp;')}</b>`)), 'every site searched, in its fold');
            assert.ok(!/nothing (here )?is scraped|no scraped listings/i.test(r.text), 'the old "nothing is scraped" framing is gone');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
