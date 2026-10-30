-- phase: expand
-- OpenVibe.Rent: BLS CPI rent of primary residence (source bls-cpi-rent, category housing), the national series and the
-- 19 largest metro series (server/housing/rent-cpi.js). Sources reads BLS's own flat file under its robots and terms
-- checks; Rent follows Sources' change feed from its rent_ingest_cursor and keeps one point per series and month, so a
-- city page can draw a dated trend line beside HUD's reference. BLS data are public domain; nothing here belongs to a
-- person.

CREATE TABLE rent_cpi_points (
    series_id     text COLLATE "C" NOT NULL,     -- BLS series id (CUUR0000SEHA, CUURS12ASEHA, …)
    year          integer NOT NULL,
    period        text COLLATE "C" NOT NULL,     -- M01..M12, as BLS writes it
    value         double precision NOT NULL,     -- the index value, as BLS states it
    item_id       text COLLATE "C" NOT NULL UNIQUE,
    revision      integer NOT NULL,
    retrieved_at  text COLLATE "C" NOT NULL,     -- when Sources last read it, ISO 8601 UTC
    PRIMARY KEY (series_id, year, period)
);

CREATE INDEX rent_cpi_points_series ON rent_cpi_points (series_id, year, period);
