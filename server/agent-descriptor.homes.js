'use strict';
// What openvibe.homes tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// OpenVibe.Homes is served by the OpenVibe.Rent process for its own host. Every field is something this host really
// serves: the home, the place search, the county records, the mortgage calculator, homes by state and city, llms.txt
// and the sitemap. Buying needs no account; there is no API, documentation page, OpenAPI document or MCP endpoint of
// its own, so none is named.
module.exports = {
    id: 'homes',
    name: 'OpenVibe.Homes',
    purpose: 'Buying a home: one search across Zillow, Realtor.com, Redfin, Homes.com, Trulia and Craigslist, with HUD and Fannie Mae homes, foreclosure auctions and county property records, the FHFA price index for the area, a mortgage calculator and homes by state and city.',
    home: 'https://openvibe.homes',
    site: 'openvibe.homes',
    policy: {
        auth: ['none'],
    },
};
