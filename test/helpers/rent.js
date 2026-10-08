'use strict';
/**
 * What the listing tests share: the same-origin header every signed-in write needs (a session-cookie write is only
 * accepted from openvibe.rent itself) and a valid listing body to override field by field.
 */
const SAME = { 'sec-fetch-site': 'same-origin' };

const listing = (over = {}) => ({
    kind: 'apartment',
    title: 'Sunny two-bedroom flat near the park',
    description: 'Quiet street, plenty of light, available from the end of the month.',
    price: 1200,
    currency: 'EUR',
    period: 'month',
    city: 'Lisbon',
    region: '',
    country: 'PT',
    neighbourhood: 'Alfama',
    bedrooms: 2,
    contact_url: 'https://example.com/rooms/1',
    ...over,
});

/** POST /api/v1/listings as somebody, same-origin by default. */
const post = (t, as, over = {}, o = {}) => t.get('/api/v1/listings', { as, json: listing(over), headers: { ...SAME, ...(o.headers || {}) } });

module.exports = { SAME, listing, post };
