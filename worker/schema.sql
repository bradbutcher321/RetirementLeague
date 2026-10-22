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
-- What each alert said, for You > Notifications > Recent (src/push.js, audit IV #11):
-- the last seven days. to_mgr is NULL for an alert that goes to everyone.
CREATE TABLE IF NOT EXISTS push_log (
  k TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  to_mgr TEXT,
  pref TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  repl TEXT,
  about TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_log_ts ON push_log(ts);
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
-- Which manager a visitor id belongs to, learned when a signed-in browser
-- sends its visit (src/analytics.js), so the Commissioner page's Activity can
-- name who visited. A browser that never signs in stays a guest.
CREATE TABLE IF NOT EXISTS visitor_names (
  vid TEXT PRIMARY KEY,
  manager TEXT NOT NULL,
  ts INTEGER NOT NULL
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
-- Feedback (src/feedback.js): what signed-in managers send from their You
-- sheet, read and answered on the Commissioner page. status: new | planned
-- | done | no.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  manager TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  page TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  reply TEXT,
  updated INTEGER,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS feedback_manager ON feedback (manager, ts);
