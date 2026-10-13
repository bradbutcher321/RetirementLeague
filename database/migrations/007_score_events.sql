-- Live Dashboard Feed (site audit III #7): every change to a starter's
-- fantasy points, in the order the Worker saw them. Written by
-- worker/src/scoreFeed.js on each live dashboard build (every 15 seconds
-- while someone has the dashboard open, every minute from the cron during
-- games) and read by its /feed route. ESPN keeps no play-by-play of fantasy
-- points, so these rows are the only record; a week before this table
-- existed has none.
--   prev/total/delta: the player's points before and after the change
--   stats/prev_stats: JSON, ESPN stat id -> value, just the ids the Feed
--                     describes a change with (scoreFeed.js FEED_STATS)
--   team/opp/period/clock: his NFL game at the moment it was seen
CREATE TABLE IF NOT EXISTS score_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    manager TEXT NOT NULL,
    player TEXT NOT NULL,
    pos TEXT NOT NULL,
    prev REAL NOT NULL,
    total REAL NOT NULL,
    delta REAL NOT NULL,
    stats TEXT NOT NULL,
    prev_stats TEXT,
    team TEXT,
    opp TEXT,
    period INTEGER,
    clock TEXT
);
CREATE INDEX IF NOT EXISTS idx_score_events_week ON score_events (season, week, id);
CREATE INDEX IF NOT EXISTS idx_score_events_player ON score_events (season, week, player_id, id);
