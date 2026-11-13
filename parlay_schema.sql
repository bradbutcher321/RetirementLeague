-- The parlay's own database (retirement-league-parlay). Since site audit
-- X #26 the Worker keeps it (worker/src/parlayData.js): picks is the record,
-- written when a leg or a week is saved and when a leg is graded, and the
-- stats blob in KV is rebuilt from it. The "Auto Parlay Tracker" sheet is a
-- nightly copy (parlay_to_sheet.py). An existing database got the newer
-- columns and tables from worker/migrations/parlay_011_engine.sql.

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
    detail TEXT,          -- the score a leg was graded on ("24-17 final")
    game_id TEXT,         -- ESPN's event id, when the leg came from Parlay Legs
    review TEXT,          -- why the grader left the leg for a commissioner
    checked INTEGER,      -- when the grader last looked at it (ms)
    PRIMARY KEY (year, week, player)
);

CREATE INDEX IF NOT EXISTS idx_picks_player ON picks (player, year, week);

-- Legs the managers enter themselves on Parlay Legs (worker/src/legs.js).
-- Written by the Worker, not the sheet: a leg lands here the moment it's
-- saved, and syncLegs copies the week into picks. win is the
-- entry window's Tuesday (YYYY-MM-DD), so a window keeps the week it began
-- with. A removed leg keeps its row (removed = 1) so the sync knows which
-- picks row to clear. game_id is ESPN's event id ('' for a typed-in leg).
CREATE TABLE IF NOT EXISTS leg_entries (
    year INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player TEXT NOT NULL,
    win TEXT NOT NULL,
    sport TEXT,
    bet_type TEXT,
    team TEXT,
    opponent TEXT,
    player_prop TEXT,
    line TEXT,
    side TEXT,
    odds REAL,
    gametime TEXT,
    raw_pick TEXT NOT NULL,
    game_id TEXT,
    removed INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL,
    PRIMARY KEY (year, week, player)
);
CREATE INDEX IF NOT EXISTS idx_leg_entries_win ON leg_entries (win);

CREATE TABLE IF NOT EXISTS parlay_meta (
    k TEXT PRIMARY KEY,   -- 'players': the managers' order, a JSON list
    v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parlay_live (
    k TEXT PRIMARY KEY,   -- "year:week:player"
    v TEXT NOT NULL,      -- {live, matchup} for a pending leg
    at INTEGER
);
