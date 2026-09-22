-- League history database, covering the league's full life (2015-present)
-- at two fidelity tiers:
--   - teams + matchups: populated for every season, 2015 on.
--   - roster_entries: player-level weekly box scores (starters + bench,
--     every ESPN stat category) -- only populated from 2019 on, since
--     ESPN's API does not retain per-week bench rosters or per-week player
--     stat lines for 2015-2018 (confirmed by direct API inspection). That
--     gap is permanent, not a fetch-method problem.
-- This is meant to eventually replace the league's Google Sheet as the
-- site's data source (see generate_franchise_data.py for the sheet-driven
-- version), though that migration hasn't started yet.

CREATE TABLE IF NOT EXISTS managers (
    espn_id TEXT PRIMARY KEY,
    display_name TEXT,
    first_name TEXT,
    last_name TEXT
);

CREATE TABLE IF NOT EXISTS teams (
    year INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    team_name TEXT,
    team_abbrev TEXT,
    owner_espn_id TEXT,
    wins INTEGER,
    losses INTEGER,
    ties INTEGER,
    points_for REAL,
    points_against REAL,
    regular_season_standing INTEGER,
    final_standing INTEGER,
    PRIMARY KEY (year, team_id)
);

-- One row per side of a matchup (so a bye shows up as a row with no
-- opponent), keyed by the fantasy "week" (ESPN's matchup period id -- the
-- same numbering the league's Game Tracker sheet already uses), not the raw
-- NFL week number (which can map many-to-one onto a matchup period in the
-- playoffs).
CREATE TABLE IF NOT EXISTS matchups (
    year INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    opponent_team_id INTEGER,
    team_score REAL,
    opponent_score REAL,
    is_playoff INTEGER NOT NULL,
    outcome TEXT,  -- 'W', 'L', 'T', or NULL for an undecided/future game
    PRIMARY KEY (year, week, team_id)
);

-- One row per player per team per fantasy week: who was rostered, whether
-- they started or sat, and their full stat line for that week. stats_json
-- holds every raw stat category ESPN reports (PLAYER_STATS_MAP in
-- espn_api/football/constant.py) so nothing is lost to a fixed column list.
CREATE TABLE IF NOT EXISTS roster_entries (
    year INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    player_name TEXT,
    pro_team TEXT,
    position TEXT,
    lineup_slot TEXT NOT NULL,
    is_starter INTEGER NOT NULL,
    points REAL,
    projected_points REAL,
    stats_json TEXT,
    PRIMARY KEY (year, week, team_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_roster_entries_player ON roster_entries (player_id, year, week);
CREATE INDEX IF NOT EXISTS idx_matchups_team ON matchups (team_id, year, week);
