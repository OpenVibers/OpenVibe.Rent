-- phase: expand
-- OpenVibe.Rent: the board (server/board/board.js). A person keeps the listings they found on any site in one
-- OpenVibe list: the link to the listing on its own site, what they want to remember (title, price, place, notes)
-- and how far they got (interested → contacted → viewing → applied → declined or rented). Rent never fetches the
-- listing's page: the person gives the details, or their own browser does (the OpenVibe Companion extension, a
-- bookmarklet). One row per person per link; it is the person's own, exported and erased with their account.
CREATE TABLE IF NOT EXISTS rent_board_items (
    id          text COLLATE "C" PRIMARY KEY,                    -- rbi_<ULID>
    subject     text COLLATE "C" NOT NULL,                       -- user:usr_… (the person whose board it is)
    url         text NOT NULL,                                   -- the listing on its own site (http or https)
    site        text COLLATE "C" NOT NULL,                       -- that site's host, e.g. craigslist.org
    title       text NOT NULL,
    price       numeric(12, 2),
    currency    text COLLATE "C",
    period      text COLLATE "C",
    place       text,
    notes       text,
    status      text COLLATE "C" NOT NULL DEFAULT 'interested'
                CHECK (status IN ('interested', 'contacted', 'viewing', 'applied', 'declined', 'rented')),
    created_at  text COLLATE "C" NOT NULL,
    updated_at  text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS rent_board_items_subject ON rent_board_items (subject, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rent_board_items_once ON rent_board_items (subject, url);
