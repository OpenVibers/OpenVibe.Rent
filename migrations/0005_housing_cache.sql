-- phase: expand
-- OpenVibe.Rent: the cache in front of the two upstream services behind "Affordable housing near you"
-- (server/housing/upstream.js): every Nominatim geocode and HUD ArcGIS query answer, with its TTL
-- (RENT_HOUSING_CACHE_TTL_MS, 7 days by default), so a place is geocoded once and an area is asked once,
-- not once per visitor. Nothing here is ever a credential, a key or a token.

CREATE TABLE housing_geo_cache (
    key        text COLLATE "C" PRIMARY KEY,           -- 'nominatim:<query>' | 'arcgis:<service>/<layer>:<sha256 of the query>'
    body       jsonb NOT NULL,                         -- the upstream answer, as it came
    fetched_at text COLLATE "C" NOT NULL,              -- when it was fetched (ISO 8601, UTC)
    expires_at text COLLATE "C" NOT NULL               -- ISO 8601, UTC: past it the row is ignored and replaced
);
CREATE INDEX housing_geo_cache_expires ON housing_geo_cache (expires_at);
