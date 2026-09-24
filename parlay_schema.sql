-- Parlay pick data, synced from the "Auto Parlay Tracker" Google Sheet tab
-- (see PARLAY_DATA_MIGRATION.md) into its own Cloudflare D1 database --
-- durable, queryable storage for the raw picks themselves, separate from
-- the precomputed stats blob publish_parlay_stats.py pushes to KV (that
-- blob is what the site actually reads; this table exists for durability
-- and future queryability, the same reason league history lives in its
-- own D1 database -- see database/schema.sql).
--
-- The sheet remains the human-editable source of truth (via parlay_gui.py
-- and the auto-grader); this table is a read-only mirror kept current by
-- sync_parlay_to_d1.py. Every write is INSERT OR REPLACE keyed on
-- (year, week, player), so a re-sync always reflects the sheet's current
-- state exactly, including edits/corrections made after the fact.

CREATE TABLE IF NOT EXISTS picks (
    year INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player TEXT NOT NULL,
    sacko TEXT,          -- that week's Sacko -- repeated on every row for the week, matching the sheet's own layout
    sport TEXT,
    bet_type TEXT,
    team TEXT,
    opponent TEXT,
    player_prop TEXT,
    line TEXT,
    side TEXT,
    odds REAL,
    gametime TEXT,        -- ISO string (America/New_York), matches Auto Parlay Tracker's own format exactly
    result TEXT,          -- 'Win', 'Loss', 'Pending', or '' if this player hasn't picked yet this week
    raw_pick TEXT,        -- the original entered text (audit trail only -- see generate_parlay_data.py's
                           -- reconstruct_pick_text() for why stats computation doesn't parse this directly)
    final_odds REAL,      -- combined 12-leg parlay odds for the week -- repeated on every row, matching the sheet
    final_payout REAL,    -- combined 12-leg parlay payout for the week -- repeated on every row
    PRIMARY KEY (year, week, player)
);

CREATE INDEX IF NOT EXISTS idx_picks_player ON picks (player, year, week);
