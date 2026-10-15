-- phase: expand
-- OpenVibe.Rent: the latest AI screen of each listing for the signs of a rental scam (server/listings/screen.js, the
-- `rent.screen_listing` workflow on OpenVibe.AI). Staff only: `review` puts the listing in the staff page's flagged queue
-- with the signs and the quoted words until a member of staff marks it reviewed (or hides or removes it). One row per
-- listing, replaced when what the listing says changes (`content_hash`); it goes with its listing.
CREATE TABLE IF NOT EXISTS rent_listing_checks (
    listing_id   text COLLATE "C" PRIMARY KEY REFERENCES rent_listings (id) ON DELETE CASCADE,
    content_hash text COLLATE "C" NOT NULL,                      -- what a renter reads, hashed (screen.js contentHash)
    action       text COLLATE "C" NOT NULL CHECK (action IN ('allow', 'review')),
    signals      jsonb NOT NULL DEFAULT '[]'::jsonb,             -- the signs named, e.g. ["payment_before_viewing"]
    spans        jsonb NOT NULL DEFAULT '[]'::jsonb,             -- [{ quote, signal }] the words behind each sign
    rationale    text,
    run_id       text COLLATE "C",                               -- the OpenVibe.AI run that answered
    checked_at   text COLLATE "C" NOT NULL,
    reviewed_at  text COLLATE "C",                               -- set when staff mark a flagged listing reviewed
    reviewed_by  text COLLATE "C"                                -- user:usr_… of that member of staff
);
CREATE INDEX IF NOT EXISTS rent_listing_checks_flagged ON rent_listing_checks (checked_at DESC) WHERE action = 'review' AND reviewed_at IS NULL;
