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
-- Manager sign-in (src/auth.js, site audit III #24). A manager's link and
-- app code are worked out from AUTH_SECRET, their name and gen, so a reset
-- (gen + 1) replaces both. A session is one signed-in browser or app; only
-- the hash of its key is kept.
CREATE TABLE IF NOT EXISTS auth_managers (
  manager TEXT PRIMARY KEY,
  gen INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  manager TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'web',
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_manager ON auth_sessions(manager);
-- The Live Dashboard's two-minute cache (src/index.js readCache/writeCache,
-- site audit II #25). One row per key; kv_at is when KV last got a copy.
CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  kv_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
-- Commissioner page (src/roles.js, src/admin.js). Brad and Jon are
-- commissioners without a row here; auth_roles holds the ones they add.
-- site_settings keeps one JSON value per key (the Live page's announcement
-- and draft date, the recap playlists); admin_log is the Activity Log.
CREATE TABLE IF NOT EXISTS auth_roles (
  manager TEXT PRIMARY KEY,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  who TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
