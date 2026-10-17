'use strict';

/**
 * Crawl artifacts for openvibe.rent, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; sign-in, the
 * API, posting, a person's own listings, their saved searches and the staff queue are not.
 *
 * The sitemap and llms-full.txt are two renderings of one list (publicPages), so a page can never be in one and
 * missing from the other. Search results are not pages here: /listings canonicalises to itself (the layout drops the
 * query), and the listings that matter to a crawler are the individual /listings/:id pages, up to LISTINGS_MAX of
 * them, newest first.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const store = require('../listings/store');
const cities = require('../aggregate/cities');
const listings = require('../listings/listings');

const SITE_NAME = 'OpenVibe.Rent';
const DESCRIPTION = 'OpenVibe.Rent — every rental site, one search: apartments, houses, rooms, furnished stays, commercial space, parking, storage and cars across Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper and more, with typical rents for 885 US cities, one board for listings from anywhere, and listings people post here.';
// /everywhere?… and /housing?… are live searches that ask other rental sites on each visit: crawlers get the landing
// pages and the city pages (/in/…), not every query. GPTBot crawled 1,500 such queries on 2026-10-16 and was
// refused by the per-address limit for about 1,000 of them.
const DISALLOW = ['/auth/', '/api/', '/post', '/mine', '/saved', '/board', '/staff', '/everywhere?', '/housing?'];
// A sitemap floor and a ceiling that keeps llms-full.txt inside its own byte budget, so the two stay in step.
const LISTINGS_MAX = 1000;

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION, searchUrl: `${site}/listings?q={q}` }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'openvibe rent, rental search, apartments for rent, rooms for rent, commercial rentals, parking, equipment rental' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/** One line of text for a listing, in the words of the person who posted it (no contact details, ever). */
const listingText = (row) => `${listings.KIND_TEXT[row.kind] || row.kind} in ${[row.city, row.country].filter(Boolean).join(', ')} — ${listings.priceText(row)}. ${row.description}`;

/** Every public page: the site's own pages, then the active listings a crawler should read. */
async function publicPages(s) {
    const static_ = [
        { path: '/', changefreq: 'daily', priority: 1.0, title: 'OpenVibe.Rent home', text: 'One place to find and offer things to rent: apartments, rooms, houses, commercial space, parking and storage, and equipment. Listings are posted by people; OpenVibe handles no payments and no deposits.' },
        { path: '/everywhere', changefreq: 'weekly', priority: 0.9, title: 'Search every rental site', text: 'One search across Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper, Rent.com and more: apartments, houses, rooms, furnished stays, commercial space, parking, storage and cars.' },
        { path: '/housing', changefreq: 'daily', priority: 0.8, title: 'Affordable housing near you', text: 'Public housing, tax-credit (LIHTC) and HUD-assisted properties, and the authorities and counselling agencies to apply through, near a place — from U.S. Department of Housing and Urban Development open data (public domain).' },
        { path: '/listings', changefreq: 'hourly', priority: 0.9, title: 'Listings for rent', text: 'Search every active listing by kind, city, country, price and period, newest first.' },
        { path: '/in', changefreq: 'monthly', priority: 0.8, title: 'Rent by city', text: `What rent usually costs in ${cities.cities.length} US cities, by number of bedrooms (Census Bureau ACS), with every rental site's search for each city.` },
        { path: '/fair', changefreq: 'monthly', priority: 0.7, title: 'Is this rent fair?', text: 'Check a monthly rent from any site against the middle rent for that size in the city, from the Census Bureau.' },
        { path: '/safety', changefreq: 'monthly', priority: 0.6, title: 'Renting safely', text: 'Never pay or send a deposit before you have seen the place and signed an agreement. OpenVibe does not handle payments for listings.' },
        // /post is a form behind sign-in and robots.txt disallows it, so it is deliberately not a sitemap page.
        { path: '/updates', changefreq: 'daily', priority: 0.5, title: `What shipped on ${SITE_NAME}`, text: 'This site\'s update log, from the network changelog feed.' },
    ];
    // Rent by city: a page per state and per city (server/http/city-pages.js).
    for (const st of cities.states()) static_.push({ path: `/in/${st.slug}`, changefreq: 'monthly', priority: 0.6, title: `Renting in ${st.name}`, text: `Typical rents in ${st.count} ${st.name} ${st.count === 1 ? 'city' : 'cities'}, by number of bedrooms.` });
    for (const c of cities.cities) {
        const two = cities.rentText(c.rent.b2);
        static_.push({ path: c.path, changefreq: 'monthly', priority: 0.6, title: `Renting in ${c.name}, ${c.state}`, text: `${two ? `Typical 2-bedroom rent ${two}. ` : ''}Every rental site's search for ${c.name}.` });
    }
    if (!s) return static_;
    const out = await store.search(s, listings.normalizeFilters({}), { limit: LISTINGS_MAX });
    return [...static_, ...out.rows.map((row) => ({
        path: `/listings/${row.id}`, changefreq: 'daily', priority: 0.7,
        title: row.title, text: listingText(row),
    }))];
}

function createDiscoveryRoutes(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.rent: the public pages are for search and AI crawlers; sign-in, the API, posting, your listings, your saved searches and the staff queue are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: DESCRIPTION,
            details: 'OpenVibe.Rent is a rental aggregator. Search everywhere takes one place and set of filters and opens the matching search on every major rental site (Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper, Rent.com, RentCafe, Apartment List, PadMapper, HotPads, Trulia, Realtor.com, and for rooms, stays, commercial space, parking, storage and cars the sites that cover them); the listings open on those sites, in the person\'s own browser. Rent by city has a page for 885 US cities with the typical (median gross) rent by number of bedrooms from the Census Bureau\'s American Community Survey, and /fair checks any quoted rent against it. The board keeps listings from any site in one list, saved searches send alerts through OpenVibe.Watch, and people post listings here too (a city and a neighbourhood, never a street address). Affordable housing comes from U.S. HUD open data (public domain). There are no payments, no deposits and no messaging on OpenVibe.Rent: never pay before you have seen the place and signed an agreement. Every page is server-rendered and readable without JavaScript.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Rent', url: abs('/'), note: 'find something to rent, or offer your own' },
                    { title: 'Search every rental site', url: abs('/everywhere'), note: 'one place and filters open Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper and more at once' },
                    { title: 'Rent by city', url: abs('/in'), note: 'typical rents by size in 885 US cities (Census ACS), with every rental site\'s search for each city' },
                    { title: 'Is this rent fair?', url: abs('/fair'), note: 'a quoted monthly rent against the city\'s median for that size' },
                    { title: 'Affordable housing', url: abs('/housing'), note: 'public housing, LIHTC and HUD-assisted properties, and where to apply, near you' },
                    { title: 'Listings', url: abs('/listings'), note: 'search by kind, city, country, price and period' },
                    { title: 'Renting safely', url: abs('/safety'), note: 'the rules, including the one about deposits' },
                    { title: `What shipped on ${SITE_NAME}`, url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Listings (JSON)', url: abs('/api/v1/listings'), note: 'active listings, newest first, with facets' },
                    { title: 'Search every rental site (JSON)', url: abs('/api/v1/everywhere?q=salt+lake+city&kind=apartment'), note: 'the geocoded place and the search link on every rental site' },
                    { title: 'Affordable housing (JSON)', url: abs('/api/v1/housing?q=washington'), note: 'the geocoded place and normalised HUD housing results near it' },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, apps and grants' },
                    { title: 'OpenVibe.Watch', url: 'https://openvibe.watch', note: 'where alerts for a saved search will come from later' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and capability grants' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', async (_req, res) => {
        const pages = await publicPages(s);
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Rent, one line each: the site\'s own pages and the active listings.',
            base: site,
            // Big enough for every entry the sitemap can carry, so the two lists never disagree.
            maxBytes: 512 * 1024,
            sections: [{ title: 'Pages', pages: pages.map((p) => ({ url: p.path, title: p.title, text: p.text })) }],
        }));
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const lastmod = siteUpdated();
        const pages = await publicPages(s);
        const urls = pages.map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
