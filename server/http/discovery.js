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
const listings = require('../listings/listings');

const SITE_NAME = 'OpenVibe.Rent';
const DESCRIPTION = 'OpenVibe.Rent — one place to find and offer things to rent: apartments, rooms, houses, commercial space, parking and storage, and equipment. Listings are posted by people; no payments are handled here.';
const DISALLOW = ['/auth/', '/api/', '/post', '/mine', '/saved', '/staff'];
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
        { path: '/listings', changefreq: 'hourly', priority: 0.9, title: 'Listings for rent', text: 'Search every active listing by kind, city, country, price and period, newest first.' },
        { path: '/safety', changefreq: 'monthly', priority: 0.6, title: 'Renting safely', text: 'Never pay or send a deposit before you have seen the place and signed an agreement. OpenVibe does not handle payments for listings.' },
        // /post is a form behind sign-in and robots.txt disallows it, so it is deliberately not a sitemap page.
        { path: '/updates', changefreq: 'daily', priority: 0.5, title: `What shipped on ${SITE_NAME}`, text: 'This site\'s update log, from the network changelog feed.' },
    ];
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
            details: 'Every page is server-rendered and readable without JavaScript. In this first version the listings are posted by people on this site: there are no scraped listings and no partner feeds — other sources arrive only when their terms are verified. There are no payments, no deposits and no messaging; a listing carries a way to make contact and nothing more. A listing names a city and a neighbourhood, never a street address. OpenVibe does not handle payments for listings, and the safety rule is on every listing page: never pay or send a deposit before you have seen the place and signed an agreement.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Rent', url: abs('/'), note: 'find something to rent, or offer your own' },
                    { title: 'Listings', url: abs('/listings'), note: 'search by kind, city, country, price and period' },
                    { title: 'Renting safely', url: abs('/safety'), note: 'the rules, including the one about deposits' },
                    { title: `What shipped on ${SITE_NAME}`, url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Listings (JSON)', url: abs('/api/v1/listings'), note: 'active listings, newest first, with facets' },
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
