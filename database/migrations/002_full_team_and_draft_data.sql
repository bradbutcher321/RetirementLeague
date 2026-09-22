-- Extends the existing `teams` table (already populated) with the rest of
-- ESPN's per-team season fields, and adds draft_picks / league_settings.
-- Run once against the live D1 database; schema.sql already has the full
-- final shape for anyone building a fresh database from scratch.

ALTER TABLE teams ADD COLUMN division_id INTEGER;
ALTER TABLE teams ADD COLUMN division_name TEXT;
ALTER TABLE teams ADD COLUMN playoff_pct REAL;
ALTER TABLE teams ADD COLUMN streak_length INTEGER;
ALTER TABLE teams ADD COLUMN streak_type TEXT;
ALTER TABLE teams ADD COLUMN waiver_rank INTEGER;
ALTER TABLE teams ADD COLUMN draft_projected_rank INTEGER;
ALTER TABLE teams ADD COLUMN acquisitions INTEGER;
ALTER TABLE teams ADD COLUMN acquisition_budget_spent INTEGER;
ALTER TABLE teams ADD COLUMN drops INTEGER;
ALTER TABLE teams ADD COLUMN trades INTEGER;
ALTER TABLE teams ADD COLUMN move_to_ir INTEGER;
ALTER TABLE teams ADD COLUMN logo_url TEXT;

CREATE TABLE IF NOT EXISTS draft_picks (
    year INTEGER NOT NULL,
    round_num INTEGER NOT NULL,
    round_pick INTEGER NOT NULL,
    team_id INTEGER,
    nominating_team_id INTEGER,
    player_id INTEGER,
    player_name TEXT,
    bid_amount INTEGER,
    keeper_status INTEGER,
    PRIMARY KEY (year, round_num, round_pick)
);

CREATE TABLE IF NOT EXISTS league_settings (
    year INTEGER PRIMARY KEY,
    name TEXT,
    team_count INTEGER,
    reg_season_count INTEGER,
    playoff_team_count INTEGER,
    playoff_seed_tie_rule TEXT,
    scoring_type TEXT,
    median_scoring INTEGER,
    settings_json TEXT
);
