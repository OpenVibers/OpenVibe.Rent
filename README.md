# OpenVibe.Rent

> Find a place, or rent yours out.

**Status:** v1 works end to end: people post listings, anyone searches them, three reports hide one until staff look.
**Domain:** `openvibe.rent` · **Port:** 5010 · **Service id:** `rent` · **Env prefix:** `RENT`
**License:** AGPL-3.0 (same as every OpenVibe service).

## What it is

One place to find and offer things to rent: apartments, rooms, houses, commercial space, parking and storage, and
equipment. In this first version the listings are **posted by people on this site** — there are no scraped listings
and no partner feeds. Other sources come later, and only when their terms are verified; each listing will then carry
its provenance (the source, a link back to it, and when it was read). Until then every listing here was written by
the person who posted it, and the page says so.

Three rules shape the product:

- **No payments, no deposits, no messaging.** A listing is a description, a price with a currency and a period, and a
  way to make contact. OpenVibe handles no money for listings, and there is no inbox here.
- **Never a street address.** A listing names a city, and a neighbourhood if the poster gave one. A house number
  together with a street is refused when the listing is posted or edited, in the form and in the API alike, with a
  message that says what to write instead.
- **The safety note is on every listing page**, word for word: *Never pay or send a deposit before you have seen the
  place and signed an agreement. OpenVibe does not handle payments for listings.*

## Owns

Rent's own data is its PostgreSQL database ([server/db.js](server/db.js)); the `NNNN_*.sql` files in
[migrations/](migrations/) are applied at boot. It is the authority for:

- **`rent_listings`** — the listings people post: kind, title, description, price with currency and period, city and
  country with the optional region, neighbourhood, bedrooms and available-from, the contact URL, the state
  (`active`, `hidden`, `expired`, `removed`), the report count and `expires_at`. `rnt_<ULID>` ids
  ([migrations/0002_rent.sql](migrations/0002_rent.sql)).
- **`rent_reports`** — one report per person per listing (unique index `rent_reports_once`), what hides a listing at
  three. `rpt_<ULID>` ids.
- **`rent_saved_searches`** — a person's saved filter sets, one per distinct set, with `last_seen_at` for the "new
  since you last looked" count. `ssv_<ULID>` ids.
- **`account_data_events`** — the receipt of each ADR-033 account export or deletion delivery Rent has applied, so a
  redelivery changes nothing ([migrations/0003_account_data.sql](migrations/0003_account_data.sql)).

`migrations/0001_initial.sql` creates no tables (the skeleton). Every row keys a person as `user:usr_…`, and the
namespace is `rent.*`.

## Does not own

- **Accounts, sign-in and roles** — a person's account and the `role` claim that decides staff are
  OpenVibe.Network's. Rent holds no password, profile or role row: it reads the Network session
  ([server/auth/sso.js](server/auth/sso.js)) and reads the role claim ([server/listings/staff.js](server/listings/staff.js)).
- **The shared site frame** — the navbar, footer and boost shell are OpenVibe.Network's; Rent renders the page body
  ([server/render/layout.js](server/render/layout.js)).
- **Event delivery and subscriptions** — the queue, retries and subscription records are OpenVibe.Events'; Rent only
  consumes two topics ([server/events-consumer.js](server/events-consumer.js)).
- **Files and media** — uploaded files and images are OpenVibe.Media's. Rent stores no upload, serves no user file,
  and a listing carries no image; its contact URL is stored as text and never fetched.

## Depends on

- **OpenVibe.Network** — OAuth 2 authorization code with PKCE (`/oauth/authorize`, `/oauth/token`, `/oauth/revoke`)
  and its JWKS (the signing key). Env: `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL` (default `http://127.0.0.1:4000`),
  `OV_NETWORK_ISSUER`, `OV_OAUTH_CLIENT_ID` (`rent`), `OV_OAUTH_CLIENT_SECRET`, `OV_OAUTH_REDIRECT_URI`,
  `RENT_AUDIENCE`, `OV_SESSION_AUDIENCE` ([server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js)).
- **OpenVibe.Events** — the two ADR-033 subscriptions and their delivery. Env: `RENT_EVENTS_URL` (or `EVENTS_URL`),
  `RENT_EVENTS_SECRET`, `RENT_EVENTS_ENDPOINT`, `RENT_EVENTS_SUBSCRIBE` ([server/events-consumer.js](server/events-consumer.js)).
- **PostgreSQL** — the store, through `openvibe-sdk/db`. Env: `DATABASE_URL` (serving, through PgBouncer) and
  `DATABASE_DIRECT_URL` (migrations, owner role); `RENT_PGLITE_DIR` in development ([server/db.js](server/db.js)).
- **Valkey** — shared per-caller limit counters (optional). Env: `VALKEY_URL`, `VALKEY_PREFIX`
  ([server/http/caller-limits.js](server/http/caller-limits.js)).
- **Packages** — `openvibe-contracts` (ids, error envelope, capability check) and `openvibe-sdk` (`db`, `auth`,
  `service`, `limits`, `account-data`, `events`, `valkey`), plus `openvibe-shared` (`release`, `metrics`, `ready`,
  `legal`, `cache-policy`, `serve`, `frame`, `shell`, `seo`, `app-icon`).

It fetches from no listing source and no third party: the only outbound calls are the Network and Events above.

## Capabilities

- **Declared:** none. The service manifest lists an empty `capabilities` array, and the service's own list is empty
  ([server/http/principal.js](server/http/principal.js)) — no route names a `rent.*` capability.
- **Called on another service:** none. Rent uses OpenVibe.Network's OAuth endpoints and OpenVibe.Events' subscription
  API directly with its own service token (scope `events.subscription.manage`), not a capability-guarded route.
- **Namespace owned:** `rent.*`.
- **Events:** produces none; consumes `network.account.export_requested` and `network.account.deleted`.

## What works

| Piece | Where | What it does |
|---|---|---|
| Posting rules | [server/listings/listings.js](server/listings/listings.js), [service.js](server/listings/service.js) | A signed-in **person** posts (never an app, agent or service): at most 10 active listings and 5 new ones a day. Kind, title ≤120, plain-text description ≤4000, price with an ISO 4217 currency from a short list, period, city, ISO 3166-1 alpha-2 country, optional region/neighbourhood/bedrooms/available-from, and an optional https:// or mailto: contact link. |
| Expiry | [server/listings/expiry.js](server/listings/expiry.js), [store.js](server/listings/store.js) | A listing lasts 30 days. A timer (started by [server/index.js](server/index.js), never by a request) marks the ones that are up expired; an expired listing leaves search and its owner can renew it for 30 more days from now. |
| Search | [server/listings/store.js](server/listings/store.js), [server/http/pages.js](server/http/pages.js) | `/listings?q=&kind=&city=&country=&min=&max=&period=`, newest first, 30 a page with a cursor, and facets for kind and country (each counted without its own filter). A filter we do not know is ignored, never an error. |
| One listing | `/listings/:id` | The listing, its safety note, and a contact link **only for a signed-in viewer** — everyone else is asked to sign in. JSON-LD is published as an `Offer` (price, currency, `priceValidUntil`) only when the kind has a clear schema.org type; `other` gets none. |
| Reports | [server/listings/store.js](server/listings/store.js), `/staff` | Anyone signed in reports a listing once (reason + note ≤500). **3 distinct reports hide it** from search until staff look; staff restore, hide or remove it, and a listing staff restored is not hidden again by the same reports. |
| Staff | [server/listings/staff.js](server/listings/staff.js) | Who is staff is the Network **role claim** (`admin`, `global_mod`), decided in one place, exactly as at OpenVibe.Help. The pages and the API cannot drift apart. |
| Saving a search | `/saved` | Save the current filters (signed in) and see, each time you open the page, how many listings have appeared since you last looked. Alerts by notification come later through OpenVibe.Watch. |
| Pages | [server/http/pages.js](server/http/pages.js) | Home, `/listings`, `/listings/:id`, `/listings/:id/edit`, `/post`, `/mine`, `/saved`, `/safety`, `/staff`, `/updates` — all server-rendered, all complete without JavaScript, forms are plain POSTs. |
| Discovery | [server/http/discovery.js](server/http/discovery.js) | `robots.txt` (disallows `/auth/`, `/api/`, `/post`, `/mine`, `/saved`, `/staff`), `sitemap.xml` (every active `/listings/:id`, up to 1000), `llms.txt`, `llms-full.txt`. |
| Sign-in | [server/auth/sso.js](server/auth/sso.js) | OAuth 2 authorization code with PKCE (S256) against OpenVibe.Network; httpOnly `rent_at` / `rent_rt` cookies; `/auth/me` for the shared navbar. |
| Limits | [server/http/caller-limits.js](server/http/caller-limits.js) | Per-caller budgets for posting, reporting, renewing and saving a search. The page form and the API route take the same budget, so the form is not a way round a limit. |
| Store | [server/db.js](server/db.js), [migrations/](migrations/) | PostgreSQL through `openvibe-sdk/db`, `NNNN_*.sql` applied at boot, PGlite in development and in tests. |

## API

Everything under `/api/v1`. A **person** is a Network token as a Bearer, or this site's session cookie; a write made
with the cookie must come from `openvibe.rent` itself (same-origin). An app, agent or service token cannot post,
edit, report or save anything here — a listing is somebody's own — so no route names a capability
(`CAPABILITIES` in [server/http/principal.js](server/http/principal.js) is empty on purpose). Errors are RFC 9457
`application/problem+json` with a stable `code`.

| Route | Who | |
|---|---|---|
| `GET /ping` | anyone | liveness |
| `GET /listings` | anyone | search: `q`, `kind`, `city`, `country`, `min`, `max`, `period`, `limit`, `before`; answers `listings`, `next`, `facets` |
| `GET /listings/:id` | anyone | one listing; `contact_url` only when the caller is a signed-in person |
| `POST /listings` | person | post one (201 + `Location`); 422 on a bad field, 429 on a cap |
| `PATCH /listings/:id` | owner | edit it, or `{ "state": "hidden" \| "active" }` |
| `DELETE /listings/:id` | owner | delete it (204) |
| `POST /listings/:id/renew` | owner | 30 more days from now |
| `POST /listings/:id/reports` | person | report it (`reason`, `note`); 409 if you already have |
| `GET /saved-searches` | person | yours, each with `new_count` |
| `POST /saved-searches` | person | save the filters in the body |
| `DELETE /saved-searches/:id` | person | forget one (204) |
| `GET /staff/reports` | staff | the queue, `?state=hidden\|active\|removed\|all` |
| `POST /listings/:id/state` | staff | `{ "state": "active" \| "hidden" \| "removed" }` |

## Data sources and their terms

**This version has none.** Every listing is text a person typed here, under the rules above; nothing is scraped,
imported or fetched from anywhere. There is no outbound fetch for a listing at all — a contact URL is stored as
text and shown as a link, and this service never opens it (a URL a caller sent must never decide what this service
requests).

The only external service this process talks to is **OpenVibe.Network** (its own OAuth token endpoint and its JWKS),
with its terms as the network's own service. When listing sources are added they will be named here with their
terms, and each listing will carry its provenance (source name, a link back, and `fetched_at`) both in the API and
on the page.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET` (the `rent` OAuth client on the
Network), `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`. The database is the only required readiness check;
the Network signing key, the OAuth client and Valkey are optional (the service says so, per check, on
`/api/ready`).

The product adds no environment variables of its own beyond the OpenVibe.Events ones below: its numbers (10 active
listings, 5 a day, 30 days, 3 reports, 30 a page, the per-caller budgets) are constants next to the rules they belong
to, not deployment settings.

## Development and tests

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js, on temp PGlite databases with a mock Network
fnm exec --using=22 npm run dev     # http://localhost:5010
```

The suite covers the posting rules (sign-in, the caps, the street-address refusal, currency and country validation),
search and paging and facets, the contact link being hidden from signed-out viewers (page and API), a report
hiding a listing at 3 and staff restoring it, expiry, owner-only edits, same-origin writes, saved searches with
their new counts, and hostile text staying text everywhere it is shown. `npm run test:pg` runs the same suite
through PostgreSQL and PgBouncer (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Acceptance

`npm test` (`node test/run.js`) runs every `test/*.test.js` against a temporary PGlite database and a mock Network;
`npm run test:pg` runs the same suite through PostgreSQL and PgBouncer. The main files and what they prove:

- [test/listings.test.js](test/listings.test.js) — posting through the API: a person only (never an app), same-origin
  session writes, the field rules (kind, price, currency, country, period, contact URL), the street-address refusal in
  title, description, city, region and neighbourhood, the 10-active and 5-a-day caps, 30-day expiry, owner-only
  edit/renew/hide/delete, and hostile text staying text.
- [test/listings-search.test.js](test/listings-search.test.js) — the search filters, newest-first cursor paging, the
  kind and country facets, the contact URL for a signed-in person only, hidden/expired/removed never listed, and an
  unknown filter ignored.
- [test/listings-reports.test.js](test/listings-reports.test.js) — one report per person, never your own, three
  distinct reports hide a listing, the staff queue and role claim, restore/hide/remove, and a restored listing not
  hidden again.
- [test/listings-pages.test.js](test/listings-pages.test.js) — the server-rendered pages and plain form POSTs, the
  safety note word for word, saved-search new counts, and a refused form re-rendering what was typed, escaped.
- [test/account-data.test.js](test/account-data.test.js) — ADR-033 export and deletion through `/internal/events`
  with a stand-in Network: only the person's rows, a redelivery changes nothing, and a bad signature or forwarded
  request is refused.
- [test/caller-limits.test.js](test/caller-limits.test.js) — a caller past a limit gets 429 `rate_limited` with
  `Retry-After` before the route works, per person and per address, with the window reopening; health, ready,
  release.json and metrics are never limited.
- [test/security-session.test.js](test/security-session.test.js) — the `rent_at` cookie must hold a Network session
  token; a FedCM assertion or an app/service token is not a session.
- [test/security-secrets.test.js](test/security-secrets.test.js) — the OAuth client secret never leaves in a response,
  an event, a log line or the database.
- [test/auth-ops.test.js](test/auth-ops.test.js) — sign-in with PKCE S256, the session cookies, truthful readiness,
  `/release.json`, loopback-only `/metrics`.
- [test/auth-jwks.test.js](test/auth-jwks.test.js) — the Network key is fetched and verified, cached keys survive an
  outage, a rotation is honoured, and readiness shows the cache state.
- [test/discovery.test.js](test/discovery.test.js) — `robots.txt`, `sitemap.xml`, `llms.txt` and `llms-full.txt`
  serve the public pages only.
- [test/open-redirect.test.js](test/open-redirect.test.js) — the sign-in `next` never leaves the site.
- [test/no-internal-key.test.js](test/no-internal-key.test.js) — no `X-Internal-Key` anywhere, and the running service
  never sends one.
- [test/service-kit.test.js](test/service-kit.test.js) — the graceful stop runs its close steps in order and exits 0.
- [test/layout.test.js](test/layout.test.js), [test/asset-cache.test.js](test/asset-cache.test.js),
  [test/nginx-auth-limit.test.js](test/nginx-auth-limit.test.js), [test/perf-budget.test.js](test/perf-budget.test.js)
  — the shared boost marker and navbar, the asset cache headers, the nginx `/auth/me` zone, and the home-page size
  budget.

## Deploy (for the lead)

- **Deploy:** `sudo ovhost deploy rent` on the host (git checkout at `/opt/openvibe.rent`, unit
  `openvibe-rent.service` on 127.0.0.1:5010, env `/etc/openvibe/rent.env`, database `ov_rent` on the data role).
- **nginx:** [deploy/nginx/openvibe.rent.conf](deploy/nginx/openvibe.rent.conf), installed with `ov-vhost-install`.
- **Rollback:** ovhost puts the previous sha back by itself when `/api/ready` does not answer after the restart.
- Register the service and its capabilities in **OpenVibe.Contracts** (`contracts-service: rent` in CI) and with
  **OpenVibe.Services** before the first deploy.

## Account export and deletion

A person's account at OpenVibe.Network can be exported and deleted, and every service holding their rows answers its
part (ADR-033). Rent receives `network.account.export_requested` and `network.account.deleted` at `POST /internal/events`
(loopback only) — the three tables are mapped in [server/identity/account-data.js](server/identity/account-data.js), and
the boot-time subscriptions are created by [server/events-consumer.js](server/events-consumer.js):

- **Exported:** the listings a person posted (`listings.json`), the reports they filed (`reports.json`) and the searches
  they saved (`saved_searches.json`), pushed to `POST /internal/account-exports/:id/parts` with this service's own
  token. Nothing here is a secret — Rent stores no token, key or credential.
- **Erased:** all three tables hold the person's own rows, so they are deleted whole and nothing is kept. Rent then
  confirms with `POST /internal/account-deletions/:id/confirmations` and the counts.
- **Anonymized:** nothing. Rent keeps no row by this person that another person's page must still read — the reports
  other people left on a deleted listing cascade away with it.

Environment: `RENT_EVENTS_SECRET` (comma-separated for rotation, 32+ characters each; unset makes the route answer
503), `RENT_EVENTS_URL` (or `EVENTS_URL`) is where the two subscriptions are created at boot (off when unset), and
`RENT_EVENTS_ENDPOINT` overrides the loopback endpoint; `RENT_EVENTS_SUBSCRIBE=0` turns the boot-time subscription off.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- Secrets live only in the env file; only environment variable names appear in code and docs, and no secret is logged.
- Request bodies are never logged.
- Nothing in a request may decide a URL this service fetches: a caller's URL goes to OpenVibe.Tools, whose own guard
  decides what may be fetched. A listing's contact URL is never fetched here at all.
- A listing is public text: it is escaped by the `html` template everywhere it is rendered, and a street address is
  refused at the door.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.126.0
- openvibe-sdk: v0.36.0
- openvibe-shared: v2.20.3
<!-- versions:end -->
