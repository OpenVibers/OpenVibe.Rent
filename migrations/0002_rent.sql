-- phase: expand
-- OpenVibe.Rent: listings people post themselves, the reports against them and the searches people save.
-- Applied at boot by openvibe-sdk/db (one file per phase, NNNN_name.sql, in order). Nothing written here is ever a
-- credential, a key or a token.
--
-- v1 is listing-posting only: no scraped or partner sources yet (those come when their terms are verified), no
-- payments, no deposits and no messaging — a listing carries a contact URL and nothing more.

CREATE TABLE rent_listings (
    id             text COLLATE "C" PRIMARY KEY,                 -- rnt_<ULID>
    owner          text COLLATE "C" NOT NULL,                    -- user:usr_… (a listing is posted by a person)
    kind           text COLLATE "C" NOT NULL,                    -- apartment | room | house | commercial | parking | equipment | other
    title          text NOT NULL,
    description    text NOT NULL,
    price          numeric(14, 2) NOT NULL,
    currency       text COLLATE "C" NOT NULL,                    -- ISO 4217, from a short list
    period         text COLLATE "C" NOT NULL,                    -- month | week | day | hour | once
    city           text NOT NULL,
    region         text,
    country        text COLLATE "C" NOT NULL,                    -- ISO 3166-1 alpha-2
    neighbourhood  text,                                         -- never a street address (see the refused-address rule)
    bedrooms       integer,
    available_from text COLLATE "C",                             -- YYYY-MM-DD
    contact_url    text,                                         -- https:// or mailto:, shown only to signed-in viewers
    state          text COLLATE "C" NOT NULL,                    -- active | hidden | expired | removed
    report_count   integer NOT NULL DEFAULT 0,
    created_at     text COLLATE "C" NOT NULL,
    updated_at     text COLLATE "C" NOT NULL,
    expires_at     text COLLATE "C" NOT NULL                     -- 30 days after posting; the owner may renew
);

-- Search is "newest first" over active listings, paged by cursor (the ULID's own order).
CREATE INDEX rent_listings_active ON rent_listings (id DESC) WHERE state = 'active';
CREATE INDEX rent_listings_owner ON rent_listings (owner, id DESC);
CREATE INDEX rent_listings_expiry ON rent_listings (expires_at) WHERE state = 'active';
CREATE INDEX rent_listings_kind ON rent_listings (kind) WHERE state = 'active';
CREATE INDEX rent_listings_country ON rent_listings (country) WHERE state = 'active';

CREATE TABLE rent_reports (
    id         text COLLATE "C" PRIMARY KEY,                     -- rpt_<ULID>
    listing_id text COLLATE "C" NOT NULL REFERENCES rent_listings (id) ON DELETE CASCADE,
    reporter   text COLLATE "C" NOT NULL,                        -- user:usr_…
    reason     text COLLATE "C" NOT NULL,                        -- scam | wrong | offensive | other
    note       text,                                             -- ≤500 characters
    created_at text COLLATE "C" NOT NULL
);

-- One report per reporter per listing: 3 distinct reports hide the listing until staff look at it.
CREATE UNIQUE INDEX rent_reports_once ON rent_reports (listing_id, reporter);
CREATE INDEX rent_reports_recent ON rent_reports (created_at DESC);

CREATE TABLE rent_saved_searches (
    id           text COLLATE "C" PRIMARY KEY,                   -- ssv_<ULID>
    subject      text COLLATE "C" NOT NULL,                      -- user:usr_…
    filters      jsonb NOT NULL,                                 -- q, kind, city, country, min, max, period
    filters_key  text COLLATE "C" NOT NULL,                      -- canonical filters, so the same search is saved once
    created_at   text COLLATE "C" NOT NULL,
    last_seen_at text COLLATE "C" NOT NULL                       -- what "new since you last looked" is measured from
);

CREATE UNIQUE INDEX rent_saved_searches_once ON rent_saved_searches (subject, filters_key);
CREATE INDEX rent_saved_searches_by_subject ON rent_saved_searches (subject, id DESC);
