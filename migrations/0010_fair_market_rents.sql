-- phase: expand
-- OpenVibe.Rent: HUD's Fair Market Rents (server/housing/fair-market-rents.js), as OpenVibe.Sources reads them from HUD
-- every week (source hud-fair-market-rents, category housing). Rent never calls HUD for them: it follows Sources'
-- change feed from its cursor here (openvibe-publishing/ingest, prefix rent) and keeps one row per FMR area. A city
-- page finds its area through server/data/city-fmr-areas.json. Public domain data; nothing here belongs to a person.

-- The DDL is openvibe-publishing lib/ingest.js schema('rent').
CREATE TABLE IF NOT EXISTS rent_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

CREATE TABLE rent_fmr_areas (
    code         text COLLATE "C" PRIMARY KEY,     -- HUD's FMR_CODE (METRO35620MM5600), Sources' identity
    item_id      text COLLATE "C" NOT NULL UNIQUE, -- the Sources item
    revision     integer NOT NULL,                 -- the Sources item's revision this row holds
    name         text NOT NULL,                    -- FMR_AREANAME, as HUD names it
    fmr_0br      integer,                          -- dollars a month, rent plus essential utilities
    fmr_1br      integer,
    fmr_2br      integer,
    fmr_3br      integer,
    fmr_4br      integer,
    retrieved_at text COLLATE "C" NOT NULL         -- when Sources last read it, ISO 8601 UTC
);
