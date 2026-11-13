-- The parlay engine moves into the Worker (site audit X #26): the picks
-- table becomes the record, so it keeps what the sheet used to.
--   detail   the score a leg was graded on ("24-17 final"), was Grade Detail
--   game_id  ESPN's event id, copied from leg_entries when the leg came from Parlay Legs
--   review   why the grader left a leg for a commissioner (NULL when it didn't)
--   checked  when the grader last looked at the leg (ms)
ALTER TABLE picks ADD COLUMN detail TEXT;
ALTER TABLE picks ADD COLUMN game_id TEXT;
ALTER TABLE picks ADD COLUMN review TEXT;
ALTER TABLE picks ADD COLUMN checked INTEGER;

-- Small settings: 'players' is the managers' column order (a JSON list).
CREATE TABLE IF NOT EXISTS parlay_meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);

-- Each pending leg's live state ({live, matchup}), keyed "year:week:player".
CREATE TABLE IF NOT EXISTS parlay_live (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    at INTEGER
);
