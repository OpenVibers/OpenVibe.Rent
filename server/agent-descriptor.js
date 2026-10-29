'use strict';
// What openvibe.rent tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public pages (the home, everywhere, housing, the listings
// search and one listing, the safety note and the update log), the JSON API under /api/v1, llms.txt and the sitemap.
// Reading is public; posting, a person's own listings and saved searches need a Network sign-in. No OpenAPI document,
// documentation page or MCP endpoint is published here, so none is named.
module.exports = {
    id: 'rent',
    name: 'OpenVibe.Rent',
    purpose: 'Find a place, or rent yours out: apartments, rooms, houses, commercial space, parking and storage, and equipment, posted by people on this site, with filters and facets, a plain safety note, saved searches and a 30-day expiry an owner can renew.',
    home: 'https://openvibe.rent',
    site: 'openvibe.rent',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
