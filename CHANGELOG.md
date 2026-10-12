# Changelog

What changed in OpenVibe.Rent, newest first. Each site also publishes its patch notes at /updates.

## 0.3.0 — 2026-10-12

"Home prices around here" beside the affordable-housing results.

- **FHFA House Price Index context.** `/housing` shows a small card above the results: the change in the FHFA
  all-transactions index over the past year and five years, for the MSA that matches the place (or the state), rounded
  to 0.1 %, with the latest quarter. The index is a repeat-sales index, not a price, and the card links back to FHFA.
- **Ingest.** The FHFA master CSV is streamed line by line (never held whole), keeps only the traditional,
  all-transactions, quarterly State and MSA rows from the last six years, and replaces them in one transaction — a
  failed refresh keeps the previous rows. It runs from the background timer behind `RENT_HPI` (on in production) and
  fetches at most once every 7 days.
- **API.** `GET /api/v1/housing` answers `area_prices` (`{ place, level, year_change_pct, five_year_change_pct,
  latest, source }`), or `null` when there is no data.

## 0.2.0 — 2026-10-08

The product: people post listings, anyone searches them, and reports bring a listing to staff.

- **Listings, posted by people.** A signed-in person posts apartment, room, house, commercial, parking, equipment or
  other: a title, a plain-text description, a price with an ISO 4217 currency from a short list and a period, a city
  and an ISO 3166-1 alpha-2 country, and optionally a region, a neighbourhood, bedrooms, an available-from date and
  an https or mailto contact link. At most 10 active listings and 5 new ones a day; each lasts 30 days and the owner
  can renew it for 30 more.
- **Never a street address.** A house number with a street is refused in the title, the description, the city, the
  region and the neighbourhood — in the form and the API alike, with a message that says what to write instead.
- **Search.** `/listings` and `GET /api/v1/listings`: q, kind, city, country, min, max and period, newest first,
  30 a page with a cursor, and facets for kind and country. A filter we do not recognise is ignored, not an error.
- **A listing page** with the safety note word for word, the contact link for signed-in viewers only (anyone else is
  asked to sign in), and JSON-LD as an `Offer` only where the schema.org type is clear.
- **Reports and staff.** One report per person per listing; three distinct reports hide it from search until staff
  look. Staff (a Network role of `admin` or `global_mod`) read the queue at `/staff` and restore, hide or remove a
  listing. A listing staff restored is not hidden again by the same reports.
- **Saved searches.** Save the current filters and see, each time you open `/saved`, how many listings have appeared
  since you last looked. Alerts that come to you arrive later through OpenVibe.Watch.
- **No payments, no deposits, no messaging** in this version, and no scraped or partner sources: every listing is
  text a person typed here, and the site says so. Sources arrive only when their terms are verified.
- Pages added: `/listings`, `/listings/:id`, `/listings/:id/edit`, `/post`, `/mine`, `/saved`, `/safety`, `/staff`;
  the home page is the product's own. Discovery carries every active listing in the sitemap, and robots.txt keeps
  `/post`, `/mine`, `/saved` and `/staff` to people.
- The per-caller budgets are declared (`rent.listing.create`, `rent.listing.report`, `rent.listing.renew`,
  `rent.saved.create`), and the page forms take the same budget as the API so a form is not a way round a limit.
- The home page's size budget moved from 24.9/6.2 KB to 28.4/6.5 KB (raw/Brotli) because it is a real home page now;
  the budget was raised to 31.5/7.2 with the same ~10% headroom.

## 0.1.0 — 2026-10-08

- **First release:** the service starts from the OpenVibe skeleton — sign-in with OpenVibe.Network (OAuth 2 + PKCE), server-rendered pages through the OpenVibe Frame, the `/api/v1` mount with per-caller limits, crawl artifacts, PostgreSQL migrations, the deploy files and the test suite.
