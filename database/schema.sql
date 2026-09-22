-- League history database, covering the league's full life (2015-present).
-- The goal is to archive everything ESPN's API exposes for this league --
-- not just what today's site needs -- so the data survives even if ESPN
-- later changes or removes it. Two fidelity tiers:
--   - teams + matchups + draft_picks + league_settings: populated for
--     every season, 2015 on.
--   - roster_entries: player-level weekly box scores (starters + bench,
--     every ESPN stat category) -- only populated from 2019 on, since
--     ESPN's API does not retain per-week bench rosters or per-week player
--     stat lines for 2015-2018 (confirmed by direct API inspection). That
--     gap is permanent, not a fetch-method problem.
-- This is meant to eventually replace the league's Google Sheet as the
-- site's data source (see generate_franchise_data.py for the sheet-driven
-- version); some data (real-money dues/earnings, the Parlay side-game's
-- weekly "Sacko") has no ESPN equivalent at all and will always need the
-- sheet regardless.

CREATE TABLE IF NOT EXISTS managers (
    espn_id TEXT PRIMARY KEY,
    display_name TEXT,
    first_name TEXT,
    last_name TEXT
);

-- Every field ESPN's Team object exposes for a season, not just what the
-- franchise page happens to need today -- the point is to hold a complete
-- archive of what ESPN reports, so this outlives ESPN changing or removing
-- any of it later.
CREATE TABLE IF NOT EXISTS teams (
    year INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    team_name TEXT,
    team_abbrev TEXT,
    owner_espn_id TEXT,
    division_id INTEGER,
    division_name TEXT,
    wins INTEGER,
    losses INTEGER,
    ties INTEGER,
    points_for REAL,
    points_against REAL,
    regular_season_standing INTEGER,
    final_standing INTEGER,
    playoff_pct REAL,
    streak_length INTEGER,
    streak_type TEXT,
    waiver_rank INTEGER,
    draft_projected_rank INTEGER,
    acquisitions INTEGER,
    acquisition_budget_spent INTEGER,
    drops INTEGER,
    trades INTEGER,
    move_to_ir INTEGER,
    logo_url TEXT,
    PRIMARY KEY (year, team_id)
);

-- One row per draft pick, every year the league has drafted.
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

-- One row per season's league settings/rules -- scoring format, roster/
-- playoff structure, etc. -- since those change over the years and affect
-- how every other table's numbers should be interpreted. settings_json holds
-- the full detail (scoring format list, division map, position slot counts,
-- waiver/trade rules); the plain columns are just the most-queried subset.
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

-- Records which team was that season's "Sacko" (worst team of the year).
-- Not reliably derivable from bracket_type/final_standing -- the league's
-- actual rule has varied over the years (historically some other bracket
-- game entirely, not necessarily the true last-place game; the exact old
-- rule isn't remembered) -- so this is the plain fact of who lost that
-- year's designated Sacko game, recorded directly rather than computed.
CREATE TABLE IF NOT EXISTS season_sackos (
    year INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL,
    week INTEGER,
    opponent_team_id INTEGER,
    source TEXT NOT NULL DEFAULT 'sheet'  -- 'sheet' (imported from the Game
                                            -- Tracker's "Sacko"-typed game) or
                                            -- 'computed' (derived going
                                            -- forward from the two worst
                                            -- regular-season teams meeting in
                                            -- the championship week)
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
    is_playoff INTEGER NOT NULL,  -- true only for ESPN's real championship bracket (WINNERS_BRACKET) -- see bracket_type
    outcome TEXT,  -- 'W', 'L', 'T', or NULL for an undecided/future game
    bracket_type TEXT NOT NULL,  -- ESPN's raw playoffTierType: NONE, WINNERS_BRACKET,
                                  -- WINNERS_CONSOLATION_LADDER, or LOSERS_CONSOLATION_LADDER.
                                  -- Only WINNERS_BRACKET means "made the real playoffs" --
                                  -- the consolation ladders are placement games for teams
                                  -- that didn't, and is_playoff deliberately excludes them.
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
