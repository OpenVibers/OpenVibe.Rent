'use strict';

/**
 * Posting rules that need the database, shared by the API (http/api.js) and the form (http/pages.js) so the two
 * doors enforce the same numbers:
 *
 *   a person, never an app or a service   (the guard lives in http/api.js and http/pages.js)
 *   at most 10 active listings per person
 *   at most 5 new listings a day (UTC)
 *   30 days until expiry, renewable by the owner
 *
 * The refusal is { ok: false, code, detail } — an API problem+json, or the sentence the form re-renders with.
 */
const listings = require('./listings');
const store = require('./store');

/** Post a listing for a person, or say why not. */
async function create(s, owner, fields) {
    const active = await store.countActiveByOwner(s, owner);
    if (active >= listings.MAX_ACTIVE) {
        return { ok: false, code: 'listing.limit_active', detail: `You already have ${listings.MAX_ACTIVE} active listings (the most one person can have). Hide or delete one first — /mine lists them.` };
    }
    const today = await store.countCreatedToday(s, owner);
    if (today >= listings.MAX_PER_DAY) {
        return { ok: false, code: 'listing.limit_daily', detail: `You have posted ${listings.MAX_PER_DAY} listings today (the most one person can post in a day). Try again tomorrow.` };
    }
    const now = s.now();
    const row = await store.insert(s, {
        id: s.newId('rnt'),
        owner,
        kind: fields.kind, title: fields.title, description: fields.description,
        price: fields.price, currency: fields.currency, period: fields.period,
        city: fields.city, region: fields.region, country: fields.country, neighbourhood: fields.neighbourhood,
        bedrooms: fields.bedrooms, available_from: fields.availableFrom, contact_url: fields.contactUrl,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + listings.EXPIRY_DAYS * store.DAY_MS).toISOString(),
    });
    return { ok: true, row };
}

/** Who may change a listing: the person who posted it. Staff act through POST /listings/:id/state, not as its owner. */
const isOwner = (requester, row) => Boolean(row) && row.owner === requester;

module.exports = { create, isOwner };
