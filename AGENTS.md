# AGENTS.md — OpenVibe.Rent

## Project Overview

OpenVibe.Rent is the rental aggregator: every major rental site's own search for one place and filter set
(`/everywhere`), person-posted listings that anyone can search, city rent pages with Census/HUD/BLS/FHFA context,
"Is this rent fair?", an "Affordable housing near you" map-free guide from HUD open data, a personal board of
listings from any site, and a scam screen. The same process also serves **OpenVibe.Homes** (`openvibe.homes`) for
buying, chosen by Host header.

- **Domain:** `openvibe.rent` (+ `openvibe.homes` in-process) · **Port:** 5010 · **Service id:** `rent` ·
  **Env prefix:** `RENT`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey
  optional for shared limits.
- **Read first:** [README.md](README.md), [STATUS.json](STATUS.json), [.env.example](.env.example).

**Network context:** accounts, sign-in and the staff role are OpenVibe.Network (OAuth client `rent`, PKCE S256; Homes
has its own redirect URI on `openvibe.homes`). Account export/deletion arrives from OpenVibe.Events at
`/internal/events`. The listing scam screen calls OpenVibe.AI (`rent.screen_listing`). Public market data is fetched
from OSM Nominatim, HUD ArcGIS, FHFA and BLS — paced, cached and attributed. Rent stores no account, no role, no file
or image, and owns no event delivery.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run dev                    # http://localhost:5010, PGlite under data/
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp PGlite, mock Network/AI/upstreams
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- board              # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step: pages are server-rendered; CSS only under [public/css/](public/css/) (`app`, `board`, `cities`,
`everywhere`, `home`, `homes`, `housing`). Every page works without JavaScript.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, telemetry, the listing-expiry sweep and the HPI timer,
  Events subscriptions and graceful stop. `RENT_DRILL` keeps boot-time work off; the expiry sweep is started **only**
  here, never by a page render.
- **App factory:** [server/app.js](server/app.js) — CSP, SSO with per-host auth routes (Rent and Homes), `/auth`,
  `/internal/events`, `/shared`+static, `/api/v1`, host routing for openvibe.homes, pages, 404/error handler.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/rent.env`.
- **Listings:** [server/listings/](server/listings/) — `listings.js` (rules/validation), `store.js`, `service.js`,
  `screen.js` (AI scam screen), `staff.js`, `expiry.js`.
- **Market data:** [server/housing/](server/housing/) — `places.js`, `upstream.js` (paced/identified), `store.js`,
  `hpi.js` (FHFA), `fair-market-rents.js` (HUD), `safmr.js`, `rent-cpi.js` (BLS); city aggregation
  [server/aggregate/cities.js](server/aggregate/cities.js), [server/aggregate/everywhere.js](server/aggregate/everywhere.js).
- **Homes:** [server/homes/](server/homes/) — `pages.js`, `city-pages.js`, `sites.js`, `mortgage.js`.
- **Board and saved searches:** [server/board/board.js](server/board/board.js).
- **HTTP:** [server/http/api.js](server/http/api.js), [server/http/pages.js](server/http/pages.js),
  [server/http/city-pages.js](server/http/city-pages.js), [server/http/board-pages.js](server/http/board-pages.js),
  [server/http/principal.js](server/http/principal.js), [server/http/discovery.js](server/http/discovery.js),
  [server/http/router.js](server/http/router.js), [server/http/caller-limits.js](server/http/caller-limits.js).
- **Auth/account data:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js),
  [server/identity/account-data.js](server/identity/account-data.js), [server/events-consumer.js](server/events-consumer.js).
- **Frontend/rendering:** [server/render/](server/render/) (`layout.js`, `html.js`, `home-blocks.js`, `short.js`,
  `markdown.js`), agent twins [server/agent-pages.js](server/agent-pages.js),
  [server/agent-descriptor.js](server/agent-descriptor.js), Homes descriptor
  [server/agent-descriptor.homes.js](server/agent-descriptor.homes.js).
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): `rent_listings`, `rent_reports`,
  `rent_listing_checks`, `rent_board_items`, `rent_saved_searches`, `housing_geo_cache`, `area_price_index`,
  `rent_fmr_areas`, `rent_ingest_cursor`, `rent_cpi_points`, `rent_index_revisions`, `event_outbox`,
  `account_data_events`, `telemetry_samples`.
- **Deploy:** [deploy/systemd/openvibe-rent.service](deploy/systemd/openvibe-rent.service) (127.0.0.1:5010,
  `/etc/openvibe/rent.env`, `/opt/openvibe.rent`), [deploy/nginx/openvibe.rent.conf](deploy/nginx/openvibe.rent.conf)
  and [deploy/nginx/openvibe.homes.conf](deploy/nginx/openvibe.homes.conf). `sudo ovhost deploy rent`; database
  `ov_rent`; rollback when `/api/ready` fails.

## Ownership and Boundaries

Rent owns listings, reports, AI screens, the board, saved searches, the market caches (geocode, HPI, FMR, CPI), the
index sequencer and its outbox. It does **not** own accounts/roles (Network), the site frame (Network), event delivery
(Events), files/images (Media), the external market data (OSM/HUD/FHFA/BLS/Census, read-only and attributed), or the
host/database (Host). A listing carries **no image**; `contact_url` is text and is never fetched. The interface says
plainly that Rent takes no payment from either side of a listing.

## Auth and Capabilities

- **No `rent.*` capability exists and none is needed.** Every write is a person acting for themself (or staff by
  Network role); an app/agent/service token cannot post, edit, report or save. `CAPABILITIES` in
  [server/http/principal.js](server/http/principal.js) is empty on purpose — do not add one without Contracts.
- A person is a Network Bearer token or the `rent_at` session; a cookie write must be same-origin. Homes has its own
  OAuth redirect and auth host.
- Outbound: `events.subscription.manage` only (Network/Events endpoints); the AI screen uses a client-credentials token
  for `rent.screen_listing`. No other service capability.
- Listing rules: 10 active listings, 5 posted a day, 30 days each, 3 reports hide one until staff review, 30 per
  search page. **A street address is refused** — listings are area-level; never add an exact-address field.
- AI screen: reads the listing text only — **never the poster or the contact link** — and a `review` flag puts it in
  the staff queue with the signs and quoted words. It changes nothing else for anyone; staff can mark it fine.
- Errors are RFC 9457 problem+json with stable codes.

## API (`/api/v1`)

`GET /ping`, `GET /housing?q=&kind=`, `GET /listings?q=&kind=&city=&country=&min=&max=&period=&limit=&before=`,
`GET /listings/:id` (contact link only for a signed-in person), `POST /listings`, `PATCH|DELETE /listings/:id`,
`POST /listings/:id/renew`, `POST /listings/:id/reports`,
`GET|POST /saved-searches`, `DELETE /saved-searches/:id`, `GET|POST /board`, `PATCH|DELETE /board/:id`,
staff: `GET /staff/reports`, `POST /listings/:id/state`. Machine endpoints `/api/health`, `/api/ready`,
`/release.json`, `/metrics` are loopback only.

Pages: `/`, `/listings`, `/listings/:id`, `/post`, `/mine`, `/saved`, `/safety`, `/board`, `/staff`, `/updates`,
`/in`, `/in/<state>`, `/in/<state>/<city>`, `/fair`, `/everywhere`, the housing pages and the openvibe.homes pages;
discovery (`/llms.txt`, sitemaps, robots, Markdown twins) is generated per host.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter. Async handlers through the router.
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Keep `rent_`/`housing_` prefixes.
- External data is paced (`RENT_HOUSING_MIN_INTERVAL_MS`, one request a second per host), cached and identified with
  `RENT_USER_AGENT` ("OpenVibeRent/…", never a browser's). HUD and FHFA are public domain; OSM is ODbL and credited;
  Census/HUD/BLS lines stay separate and labelled — never averaged into one number.
- Never fetch a user-supplied URL (a listing link, a board link): store it, render it as a link, and leave it alone.
- A contact URL is shown only to a signed-in person; a hostile title/description is escaped everywhere (page, API,
  JSON-LD, Search document).
- CSP: add origins to `helmet` in [server/app.js](server/app.js) per host. No Font Awesome; shared glyphs.
- Phone first: listing, board, city and housing pages fit 390 px; empty states use the shared kit.
- "Calm reduces, only Off removes": a hidden/expired listing is suppressed, not deleted; only the owner's explicit
  delete (or staff `removed`) removes it.
- A fair-rent answer shows the median, its margin of error and the size it applies to; no invented precision.

## Key Pitfalls

- **Expiry** runs only from [server/listings/expiry.js](server/listings/expiry.js), started by
  [server/index.js](server/index.js). Do not move it into a page or an API read (tests would race it).
- **Reports hide at three** (`rent_reports_once` unique per person per listing); staff restore, and the count is never
  shown to the public.
- **Board:** one row per person per link, at most 500; a repeated link updates the same row (200), a different existing
  link is 409 `board.duplicate`, full is 409 `board.full`. Board links come from any site; they are never fetched.
- **Saved searches:** one row per distinct filter set; `new_count` compares against `last_seen_at`.
- **AI screen** is bounded, never includes the poster/contact, caches the content hash so the same words are not
  screened twice, and is off without the AI URL. A failed run is retried by the sweep, not silently ignored.
- **Homes is a second host in this process:** add routes to the Homes router and its own auth/redirect, not to Rent's
  pages; the two hosts must not leak each other's pages or discovery.
- **Drill mode** (`RENT_DRILL`) keeps the expiry sweep, HPI timer, subscriptions and AI sweep off.
- **`event_outbox`** needs its rejected partial index ([migrations/0012_outbox_rejected_index.sql](migrations/0012_outbox_rejected_index.sql)).
- Account deletion removes a person's listings/board/saved searches and anonymizes public rows; redelivery changes
  nothing.

## Testing

`npm test` runs each file in its own process on temp PGlite with mock Network/AI/upstreams: listing rules and caps,
street-address refusal, search/facets/paging, contact-link visibility, reports and staff restore, expiry, owner-only
edits, same-origin, saved searches, board, city pages, fair rent, housing/HUD/FMR/SAFMR/HPI/CPI, markets, AI screen,
homes, error pages, discovery, SSO/JWKS, limits, secret-leak/session/redirect, service kit and budgets.
`npm run test:pg` for PostgreSQL. Run the narrowest file first, then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — what it is, owns/does-not-own, data sources and terms, capabilities, what works, API,
  configuration, acceptance, deploy, account data, security.
- [STATUS.json](STATUS.json) — stage, deployed flag, features and not-yet list.
- [.env.example](.env.example) — variable names only.
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), [tools/](tools/).
