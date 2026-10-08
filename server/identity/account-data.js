'use strict';

/**
 * Account export and deletion → Rent (ADR-033; openvibe-sdk/account-data). Rent holds three things a person made:
 * a listing they posted, the reports they filed against listings, and the searches they saved. All three key the
 * person as `user:usr_…` — server/http/principal.js builds the principal's requester that way and server/http/api.js
 * writes it straight into the store (server/listings/store.js).
 *
 *   network.account.export_requested  the person's listings (listings.json), reports (reports.json) and saved
 *                                     searches (saved_searches.json), newest first, pushed to Network
 *                                     (POST /internal/account-exports/:id/parts) with this service's token.
 *   network.account.deleted           the person's listings, reports and saved searches go, and Rent confirms with
 *                                     the counts.
 *
 * Nothing is anonymized: Rent keeps no row by this person that another person's page must still read. A listing is
 * the poster's own; the reports other people left on it cascade away with it (rent_reports.listing_id REFERENCES
 * rent_listings(id) ON DELETE CASCADE in migrations/0002_rent.sql), which is right — a report about a listing that no
 * longer exists has nothing left to say. Nothing here is a secret: no token, key or credential is stored, so every
 * column of the three tables may be exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

/**
 * The tables that hold a person's rows, with the value the subject column really stores. Listings key on `owner`,
 * reports on `reporter` and saved searches on `subject`; all three store `user:usr_…` (server/listings/store.js takes
 * the value straight from the principal's requester).
 */
const TABLES = [
    { table: 'rent_listings', subject: 'owner', value: (usr) => `user:${usr}`, file: 'listings.json' },
    { table: 'rent_reports', subject: 'reporter', value: (usr) => `user:${usr}`, file: 'reports.json' },
    { table: 'rent_saved_searches', subject: 'subject', value: (usr) => `user:${usr}`, file: 'saved_searches.json' },
];

/** The account-data handle for Rent's store (server/db.js createStore). */
function create({ db, note = 'A listing names a place by its city, never a street address; a saved search is a filter set.', log = console } = {}) {
    return createAccountData({ db, service: 'rent', tables: TABLES, note, log });
}

module.exports = { create, TABLES, TOPICS };
