-- Live Dashboard: the projected median over the course of a week, so Median
-- Watch can chart how it moved from Thursday to Monday. Written by the
-- Worker's scheduled run (worker/src/medianHistory.js) -- every 10 minutes
-- during game windows, hourly otherwise -- and read by its /median-history
-- route. ESPN keeps no history of projections, so these rows are the only
-- record; a week that ran before this table existed has none.
--   teams: JSON object, manager name -> that team's projected total
--   live:  starters in play across the league at that moment (0 = no games on)
CREATE TABLE IF NOT EXISTS median_snapshots (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    projected_median REAL NOT NULL,
    current_median REAL NOT NULL,
    live INTEGER NOT NULL,
    teams TEXT NOT NULL,
    PRIMARY KEY (season, week, ts)
);
