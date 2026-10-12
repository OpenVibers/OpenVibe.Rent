-- phase: expand
-- OpenVibe.Rent: the FHFA House Price Index behind "Home prices around here" on the affordable-housing page
-- (server/housing/hpi.js). One row per place per quarter, only the matching rows the ingest keeps (traditional,
-- all-transactions, quarterly, State or MSA), replaced whole on each refresh. `index_nsa` is the index value, not
-- a price; `states` is a comma-separated list of the two-letter state codes the place covers. Nothing here is a
-- credential, key or token.

CREATE TABLE area_price_index (
    level       text COLLATE "C" NOT NULL,          -- 'state' | 'msa'
    place_id    text COLLATE "C" NOT NULL,          -- state: the two-letter code; msa: FHFA's CBSA code
    place_name  text NOT NULL,                      -- state: 'Colorado'; msa: 'Denver-Aurora-Centennial, CO'
    states      text NOT NULL,                      -- comma-separated two-letter codes, e.g. 'CO' or 'DC,VA,MD,WV'
    yr          integer NOT NULL,                   -- the calendar year of the quarter
    quarter     integer NOT NULL,                   -- 1..4
    index_nsa   numeric NOT NULL,                   -- FHFA all-transactions index, not seasonally adjusted
    fetched_at  text COLLATE "C" NOT NULL,          -- when this refresh was fetched (ISO 8601, UTC)
    PRIMARY KEY (level, place_id, yr, quarter)
);
CREATE INDEX area_price_index_lookup ON area_price_index (level, place_id);
