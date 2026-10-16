'use strict';

/**
 * Rent's listing pages in OpenVibe.Search (openvibe-publishing/search-feed): one search.index-document@1 per active
 * listing page (/listings/<id>), sent as rent.index_document.upserted|deleted through this service's events outbox. A
 * listing that is hidden (reports or staff), removed, expired or deleted becomes a tombstone, as its page stops being
 * indexable. The document carries what the public page shows: title, description, kind, price and period, city,
 * region, country, neighbourhood, bedrooms and availability. Never the contact link (signed-in viewers only) and never
 * the poster.
 *
 * Every store write names the listing it touched (store.js calls s.search.touch(id)); touched listings are synced a
 * moment later, each in its own transaction. A sweep after every expiry tick that expired something, once a minute
 * after boot and every ten minutes brings Search level with the table whatever happened in between: it re-sends only
 * what changed (rent_index_revisions is the sequencer) and tombstones listings whose row is gone (an account deletion).
 *
 *   const search = createSearchIndex({ config, s, log });   // outbox relay off until the events URL and the OAuth
 *   search.touch(id); search.sweep(); search.start(); search.stop();   // client secret are set; rows wait meanwhile
 */
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createSearchFeed } = require('openvibe-publishing/search-feed');
const listings = require('./listings/listings');
const cities = require('./aggregate/cities');

const EVENT_TYPES = ['rent.index_document.upserted', 'rent.index_document.deleted'];
const FLUSH_MS = 250;
const START_DELAY_MS = 60_000;
const INTERVAL_MS = 10 * 60_000;

/** One listing row → what its public page shows, as search-feed's document description. */
function describe(row, nowMs) {
    const kind = listings.KIND_TEXT[row.kind] || row.kind;
    const place = [row.neighbourhood, row.city, row.region, row.country].filter(Boolean).join(', ');
    const price = listings.priceText(row);
    const facts = [kind, price, place, row.bedrooms == null ? '' : `${row.bedrooms} bedroom${Number(row.bedrooms) === 1 ? '' : 's'}`,
        row.available_from ? `available from ${row.available_from}` : ''].filter(Boolean);
    return {
        listed: row.state === 'active' && Date.parse(row.expires_at) > nowMs,
        title: row.title,
        summary: facts.join(' · '),
        body: [row.title, facts.join(' · '), row.description].filter(Boolean).join('\n'),
        facets: {
            kind: row.kind, country: row.country, city: row.city, currency: row.currency, period: row.period,
            bedrooms: row.bedrooms == null ? null : Number(row.bedrooms),
        },
        authorship: { mode: 'human' },
        publishedAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Rent by city's pages (server/http/city-pages.js) as Search documents (type city, contracts 0.197.0): the typical
 * rents by size, so a network search for "rent in Austin" finds the city page. The rows are the committed city data,
 * in id order (<state>-<slug>); the sweep sends what changed and tombstones a city that left the data.
 */
const CITY_ROWS = cities.cities.map((c) => ({ ...c, id: `${c.state.toLowerCase()}-${c.slug}` })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const CITY_IDS = new Set(CITY_ROWS.map((c) => c.id));
function describeCity(c) {
    const sizes = cities.SIZES.map((z) => (c.rent[z.key] != null ? `${z.text} ${cities.rentText(c.rent[z.key])}` : null)).filter(Boolean);
    const where = `${c.name}, ${c.state}`;
    return {
        listed: true,
        title: `Renting in ${where}`,
        summary: `Typical rent in ${where}: ${sizes.slice(0, 4).join(' · ')}. Every rental site's search for ${c.name} in one place.`,
        body: [`Renting in ${where}, ${c.stateName}.`, `Median gross rent by size (Census ACS ${cities.SOURCE.years}): ${sizes.join(', ')}.`,
            `Every rental site's search for ${c.name}: Craigslist, Facebook Marketplace, Zillow, Apartments.com, Zumper and more. Affordable housing, homes for sale and a fair-rent check.`].join('\n'),
        facets: { state: c.state, population: c.population, rent_2br: c.rent.b2 },
        authorship: { mode: 'human' },
        publishedAt: cities.SOURCE.built ? `${cities.SOURCE.built}T00:00:00.000Z` : null,
        updatedAt: cities.SOURCE.built ? `${cities.SOURCE.built}T00:00:00.000Z` : null,
    };
}

/** An OpenVibe.Homes city page (server/homes/city-pages.js) as a Search document (type homes_city, contracts 0.198.0). */
function describeHomesCity(c) {
    const where = `${c.name}, ${c.state}`;
    const value = cities.valueText(c.value);
    const two = cities.rentText(c.rent.b2);
    return {
        listed: true,
        title: `Buying a home in ${where}`,
        summary: `${value ? `Median home value in ${where}: ${value}. ` : ''}Every for-sale site's search for ${c.name} in one place${two ? `; renting a typical 2-bedroom costs ${two} a month` : ''}.`,
        body: [`Buying a home in ${where}, ${c.stateName}.`, value ? `Median value of owner-occupied homes (Census ACS ${cities.SOURCE.years}): ${value}.` : '',
            `Every for-sale site's search for ${c.name}: Zillow, Realtor.com, Homes.com, Trulia and more, government and bank homes, county records and the mortgage on a typical home.`].filter(Boolean).join('\n'),
        facets: { state: c.state, population: c.population, home_value: c.value },
        authorship: { mode: 'human' },
        publishedAt: cities.SOURCE.built ? `${cities.SOURCE.built}T00:00:00.000Z` : null,
        updatedAt: cities.SOURCE.built ? `${cities.SOURCE.built}T00:00:00.000Z` : null,
    };
}

function createSearchIndex({ config, s, log = console, outbox = null, indexnow = null }) {
    const out = outbox || createServiceOutbox({
        db: s.db, source: 'rent', eventsUrl: config.events.url || null, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, log, eventTypes: EVENT_TYPES,
    });
    const feed = createSearchFeed({
        owner: 'rent', db: s.db, outbox: out, baseUrl: config.baseUrl, now: s.now, log, indexnow,
        types: {
            listing: {
                page: (row) => `/listings/${row.id}`,
                document: (row) => describe(row, s.now()),
                rows: (after, limit) => s.db.many('SELECT * FROM rent_listings WHERE id > $1 ORDER BY id LIMIT $2', [after, limit]),
                exists: async (ids) => (await s.db.many('SELECT id FROM rent_listings WHERE id = ANY($1)', [ids])).map((r) => r.id),
            },

        },
    });
    // Rent by city's pages change only when the city data is rebuilt: their own feed, swept at start and once a day, so
    // the listing sweeps (every expiry tick) stay small.
    const cityFeed = createSearchFeed({
        owner: 'rent', db: s.db, outbox: out, baseUrl: config.baseUrl, now: s.now, log, indexnow,
        types: {
            city: {
                page: (c) => c.path,
                document: (c) => describeCity(c),
                rows: async (after, limit) => CITY_ROWS.filter((c) => c.id > after).slice(0, limit),
                exists: async (ids) => ids.filter((id) => CITY_IDS.has(String(id))),
            },
        },
    });
    // OpenVibe.Homes' city pages live on its own host: another feed with that origin, the same owner, outbox and
    // revision table (their type, homes_city, keeps them apart).
    const homesFeed = config.homes && config.homes.url ? createSearchFeed({
        owner: 'rent', db: s.db, outbox: out, baseUrl: config.homes.url, now: s.now, log,
        types: {
            homes_city: {
                page: (c) => c.path,
                document: (c) => describeHomesCity(c),
                rows: async (after, limit) => CITY_ROWS.filter((c) => c.id > after).slice(0, limit),
                exists: async (ids) => ids.filter((id) => CITY_IDS.has(String(id))),
            },
        },
    }) : null;
    const pending = new Set();
    const timers = [];
    let flushTimer = null;
    let flushing = null;

    /** Sync one listing now: its document, or a tombstone when the row is gone. */
    async function syncId(id) {
        return await s.db.tx(async (t) => {
            const row = await t.maybe('SELECT * FROM rent_listings WHERE id = $1', [id]);
            return row ? await feed.sync(t, 'listing', row) : await feed.remove(t, 'listing', id);
        });
    }

    async function flush() {
        flushTimer = null;
        if (flushing) { await flushing; }
        const ids = [...pending];
        pending.clear();
        flushing = (async () => {
            for (const id of ids) {
                try { await syncId(id); } catch (err) { log.warn(`[Search] listing ${id}: ${(err && err.message) || err}`); }
            }
            if (ids.length && out.kick) out.kick().catch(() => {});
        })();
        try { await flushing; } finally { flushing = null; }
    }

    /** A store write changed this listing: sync it shortly (never awaited by the request, never fatal). */
    function touch(id) {
        if (!id) return;
        pending.add(String(id));
        if (!flushTimer) {
            flushTimer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_MS);
            if (flushTimer.unref) flushTimer.unref();
        }
    }

    async function sweep() {
        const res = await feed.sweep();
        const l = res.listing;
        if (l.sent || l.removed || l.failed) log.log(`[Search] listings: ${l.sent} sent, ${l.removed} removed, ${l.failed} failed of ${l.seen}`);

        if (out.kick) out.kick().catch(() => {});
        return res;
    }
    /** The city pages of Rent and Homes (cityFeed, homesFeed): at start and once a day. */
    async function sweepCities() {
        const res = { city: (await cityFeed.sweep()).city };
        if (homesFeed) res.homes_city = (await homesFeed.sweep()).homes_city;
        const parts = Object.entries(res).filter(([, v]) => v && (v.sent || v.removed || v.failed)).map(([k, v]) => `${k} ${v.sent} sent, ${v.removed} removed, ${v.failed} failed of ${v.seen}`);
        if (parts.length) log.log(`[Search] ${parts.join('; ')}`);
        if (out.kick) out.kick().catch(() => {});
        return res;
    }
    const citiesQuietly = () => { sweepCities().catch((err) => log.warn(`[Search] city sweep failed: ${(err && err.message) || err}`)); };
    const quietly = () => { sweep().catch((err) => log.warn(`[Search] sweep failed: ${(err && err.message) || err}`)); };

    function start() {
        if (timers.length) return false;
        out.start();
        const kick = setTimeout(quietly, START_DELAY_MS);
        if (kick.unref) kick.unref();
        const tick = setInterval(quietly, INTERVAL_MS);
        if (tick.unref) tick.unref();
        const cityKick = setTimeout(citiesQuietly, START_DELAY_MS + 30_000);
        if (cityKick.unref) cityKick.unref();
        const cityTick = setInterval(citiesQuietly, 24 * 3_600_000);
        if (cityTick.unref) cityTick.unref();
        timers.push(kick, tick, cityKick, cityTick);
        return true;
    }

    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        out.stop();
    }

    /** Wait for touched listings to be synced (tests, and a graceful stop). */
    async function settle() {
        if (flushTimer) { clearTimeout(flushTimer); await flush(); }
        if (flushing) await flushing;
    }

    return { feed, outbox: out, describe, touch, syncId, sweep, sweepCities, afterExpiry: quietly, settle, start, stop, status: () => out.status() };
}

module.exports = { createSearchIndex, describe, EVENT_TYPES };
