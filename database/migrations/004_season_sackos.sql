-- Records which team was that season's "Sacko" (worst team of the year).
-- This is NOT reliably derivable from bracket_type/final_standing -- the
-- league's actual rule has varied over the years and at times had nothing
-- to do with ESPN's own consolation-bracket seeding (a specific matchup is
-- manually arranged between the two worst regular-season teams in the
-- championship week; historically it was some other bracket game entirely,
-- and nobody remembers the exact old rule). So this is just the plain fact
-- of who lost that year's designated Sacko game, recorded directly rather
-- than computed.
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
