CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  ts INTEGER NOT NULL,
  vid TEXT NOT NULL,
  page TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hits_day ON hits(day);
CREATE TABLE IF NOT EXISTS seen (
  vid TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_ts ON seen(ts);
-- Home Screen app notifications (src/push.js, site audit II #37).
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  me TEXT NOT NULL DEFAULT '',
  prefs TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_sent (
  k TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
-- The Live Dashboard's two-minute cache (src/index.js readCache/writeCache,
-- site audit II #25). One row per key; kv_at is when KV last got a copy.
CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  kv_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
