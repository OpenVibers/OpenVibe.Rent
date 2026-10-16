'use strict';
/**
 * Rent by city (server/data/cities.json from the Census ACS, server/aggregate/cities.js, server/http/city-pages.js): every US
 * place of 50,000 people or more and each state's largest has a page with its typical rents by size and every rental
 * site's search for it; state pages and /in list them; /fair judges a quoted rent against the median and its margin;
 * a listing posted here in a listed US city shows the same line; every page is in the sitemap and nothing is invented
 * (a median the Census does not publish says so, and the $3,500 top code is never a number).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { post } = require('./helpers/rent');
const cities = require('../server/aggregate/cities');

(async () => {
    await check('the data: 50 states, DC and Puerto Rico; Austin as the Census states it; slugs unique; nothing below 50,000 but a state\'s largest', () => {
        assert.strictEqual(cities.states().length, 52);
        assert.ok(cities.cities.length >= 850, String(cities.cities.length));
        const a = cities.find('tx', 'austin');
        assert.deepStrictEqual([a.name, a.state, a.path, a.rent.b2], ['Austin', 'TX', '/in/tx/austin', 1845]);
        assert.strictEqual(new Set(cities.cities.map((c) => c.path)).size, cities.cities.length, 'one page per city');
        const small = cities.cities.filter((c) => c.population < cities.MIN_POPULATION);
        assert.ok(small.every((c) => cities.inState(c.state)[0] === c), 'a small place is only there as its state\'s largest');
        assert.ok(cities.find('vt', 'burlington') && cities.find('wv', 'charleston'));
        assert.strictEqual(cities.find('tn', 'nashville').name, 'Nashville', 'the Census\' "Nashville-Davidson metropolitan government (balance)" reads as people say it');
        assert.strictEqual(cities.find('pr', 'mayaguez').name, 'Mayagüez');
    });

    await check('matching what people type: "City, ST", "city st", the state spelled out, a lone name (the largest)', () => {
        assert.strictEqual(cities.match('Salt Lake City, Utah').path, '/in/ut/salt-lake-city');
        assert.strictEqual(cities.match('austin tx').path, '/in/tx/austin');
        assert.strictEqual(cities.match('Arlington, VA').path, '/in/va/arlington');
        assert.strictEqual(cities.match('Columbus').path, '/in/oh/columbus');
        assert.strictEqual(cities.match('Nowhereville, ZZ'), null);
    });

    await check('the fair check: within the margin is typical, far below warns of scams, the top code is a range, junk is refused', () => {
        const a = cities.find('tx', 'austin');
        assert.strictEqual(cities.fair({ city: a, beds: 2, rent: 1800 }).verdict, 'typical');
        const low = cities.fair({ city: a, beds: 2, rent: 1200 });
        assert.deepStrictEqual([low.verdict, low.pct], ['very-low', -35]);
        assert.match(low.text, /can be a scam/);
        assert.strictEqual(cities.fair({ city: a, beds: 1, rent: 1700 }).verdict, 'high');
        assert.strictEqual(cities.fair({ city: a, beds: 9, rent: 3000 }).size.key, 'b5', 'more than five bedrooms is "5 or more"');
        const top = cities.cities.find((c) => c.top && c.top.includes('b4'));
        const f = cities.fair({ city: top, beds: 4, rent: 5000 });
        assert.strictEqual(f.verdict, 'high-end');
        assert.match(f.text, /\$3,500 or more/);
        assert.ok(!/\$3,501/.test(f.text), 'the top code is never shown as a price');
        assert.strictEqual(cities.fair({ city: a, beds: 2, rent: 'abc' }), null);
        assert.strictEqual(cities.fair({ city: a, beds: 2, rent: -5 }), null);
    });

    await check('reading a listing: rent, bedrooms and city from Craigslist, Zillow and Apartments.com addresses and titles; nothing invented', () => {
        const cl = cities.readListing({ url: 'https://austin.craigslist.org/apa/d/austin-sunny/7712345.html', title: '$1,850 / 2br - 900ft2 - Sunny two bed near Zilker' });
        assert.deepStrictEqual([cl.rent, cl.beds, cl.city.path, cl.read], [1850, 2, '/in/tx/austin', ['rent', 'beds', 'city']]);
        assert.strictEqual(cities.readListing({ url: 'https://www.zillow.com/homedetails/123-Main-St-Salt-Lake-City-UT-84111/1_zpid/' }).city.path, '/in/ut/salt-lake-city');
        assert.strictEqual(cities.readListing({ url: 'https://www.apartments.com/the-bowie-austin-tx/7gd3w0p/' }).city.path, '/in/tx/austin');
        const studio = cities.readListing({ title: 'Studio for $1,200 in Denver, CO' });
        assert.deepStrictEqual([studio.rent, studio.beds, studio.city.path], [1200, 0, '/in/co/denver']);
        assert.deepStrictEqual(cities.readListing({ url: 'https://example.com/', title: 'Call for price, 12345 sq ft' }).read, [], 'no amount, size or city: nothing');
        assert.strictEqual(cities.readListing({ title: '$45 deposit' }).rent, null, 'under $100 is not a monthly rent');
    });

    const t = await boot();
    const kim = t.network.addUser('kim');

    await check('with nothing posted yet, the home shows the largest cities\' rents instead of an empty list', async () => {
        const home = await t.get('/');
        assert.ok(home.text.includes('What rent costs in the largest cities') && home.text.includes('href="/in/ny/new-york"'));
        assert.ok(!home.text.includes('Nobody has posted here yet'));
    });

    await check('a city page: typical rents with margins and the source, the fair form, every site at the city, what is here, nearby', async () => {
        const r = await t.get('/in/tx/austin');
        assert.strictEqual(r.status, 200);
        const h = r.text;
        assert.match(h, /<h1>Renting in Austin, TX<\/h1>/);
        assert.ok(h.includes('$1,845') && h.includes('±$20'), 'the 2-bedroom median and its margin');
        assert.ok(h.includes('American Community Survey'), 'the source, named');
        assert.ok(h.includes('<form class="search-form fair-form" method="get" action="/fair">') && h.includes('name="city" value="tx/austin"'));
        assert.ok(h.includes('https://www.craigslist.org/search/city/austin-tx?cat=apa') && h.includes('https://www.zillow.com/austin-tx/rentals/'), 'every site at Austin');
        assert.ok(h.includes('/everywhere?q=Austin%2C+TX&amp;kind=room') || h.includes('/everywhere?q=Austin%2C+TX&kind=room'), 'other kinds through search everywhere');
        assert.ok(h.includes('/housing?q=Austin%2C+TX') && h.includes('https://openvibe.homes/in/tx/austin') && h.includes('median value $555,300'));
        assert.ok(h.includes('href="/in/tx/round-rock"'), 'nearby cities');
        assert.match(h, /<meta name="robots" content="index, follow">/);
        assert.ok(h.includes('"@type":"BreadcrumbList"'));
        assert.strictEqual((await t.get('/in/tx/nowhere')).status, 404);
        assert.strictEqual((await t.get('/in/zz')).status, 404);
    });

    await check('a state page and /in: every city, largest first; every state', async () => {
        const st = await t.get('/in/tx');
        assert.strictEqual(st.status, 200);
        assert.ok(st.text.indexOf('>Houston<') < st.text.indexOf('>Austin<'), 'largest first');
        const all = await t.get('/in');
        assert.ok(all.text.includes('href="/in/wy"') && all.text.includes('href="/in/pr"') && all.text.includes('href="/in/dc"'));
    });

    await check('/fair: a verdict with the bar, a city typed as text, an unknown city and a size without a median say so', async () => {
        const r = await t.get('/fair?city=tx/austin&beds=2&rent=1200');
        assert.ok(r.text.includes('Well below typical') && r.text.includes('class="fair-bar"'));
        assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/, 'a checked price is not a page for search');
        const typed = await t.get('/fair?where=Austin%2C+TX&beds=2&rent=1850');
        assert.ok(typed.text.includes('About typical'));
        const unknown = await t.get('/fair?where=Nowhereville&beds=1&rent=900');
        assert.ok(unknown.text.includes('No city of 50,000 people or more called'));
        const fromCl = await t.get(`/fair?${new URLSearchParams({ url: 'https://austin.craigslist.org/apa/d/x/1.html', title: '$1,200 / 2br - Sunny two bed' })}`);
        assert.ok(fromCl.text.includes('Read from the listing: the rent ($1,200), 2 bedrooms, the city (Austin, TX)') && fromCl.text.includes('Well below typical'), 'judged from the listing, saying what was read');
        assert.match(fromCl.text, /<meta name="robots" content="noindex, nofollow">/);
        const partial = await t.get(`/fair?${new URLSearchParams({ url: 'https://www.zillow.com/homedetails/1-Main-St-Austin-TX-78701/1_zpid/', title: 'A home' })}`);
        assert.ok(partial.text.includes('Read from the listing: the city (Austin, TX). Check them below and fill in the rest.') && !partial.text.includes('fair-result'));
        const nothing = await t.get(`/fair?${new URLSearchParams({ url: 'https://example.com/', title: 'Hello' })}`);
        assert.ok(nothing.text.includes('did not say its rent, size and city plainly'));
        const blank = await t.get('/fair');
        assert.match(blank.text, /<meta name="robots" content="index, follow">/);
        assert.ok(!blank.text.includes('fair-result'));
    });

    await check('a listing posted here in a listed US city shows where its rent sits; elsewhere nothing is said', async () => {
        const us = await post(t, kim, { title: 'Two-bed near the lake', city: 'Austin', region: 'Texas', country: 'US', currency: 'USD', price: 1850, bedrooms: 2, neighbourhood: 'Zilker' });
        assert.strictEqual(us.status, 201, us.text);
        const page = await t.get(`/listings/${us.json().id}`);
        assert.ok(page.text.includes('class="fair-line verdict-typical"') && page.text.includes('href="/in/tx/austin"'), 'the fair line and the city page');
        const lisbon = await post(t, kim, {});
        assert.ok(!(await t.get(`/listings/${lisbon.json().id}`)).text.includes('fair-line'), 'a listing outside the US gets no line');
    });

    await check('every state and city page is in the sitemap; the home and the nav link Rent by city', async () => {
        const xml = (await t.get('/sitemap.xml')).text;
        assert.ok(xml.includes('/in/tx/austin</loc>') && xml.includes('/in/vt</loc>') && xml.includes('/fair</loc>'));
        assert.ok((xml.match(/<loc>[^<]*\/in\//g) || []).length >= cities.cities.length + 52);
        const home = await t.get('/');
        assert.ok(home.text.includes('href="/in"'));
    });

    done();
})();
