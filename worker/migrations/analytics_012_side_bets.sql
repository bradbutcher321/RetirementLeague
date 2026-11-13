-- Side bets (src/bets.js, site audit XI #20): two managers and a stake, settled
-- from the final score (or by hand for an "other" bet). The site keeps score
-- only. status: offered | accepted | declined | cancelled | expired | settled.
CREATE TABLE IF NOT EXISTS side_bets (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  stake TEXT NOT NULL,
  subject TEXT,
  line REAL,
  side TEXT,
  note TEXT,
  status TEXT NOT NULL,
  winner TEXT,
  detail TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_side_bets_a ON side_bets(a, created);
CREATE INDEX IF NOT EXISTS idx_side_bets_b ON side_bets(b, created);
CREATE INDEX IF NOT EXISTS idx_side_bets_status ON side_bets(status, year, week);
