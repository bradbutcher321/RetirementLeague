/**
 * Privacy-light site analytics on D1. No cookies and no IPs: the browser
 * sends a random id it keeps in localStorage, plus which page was opened.
 *
 *   POST /hit    body (text/plain JSON) { vid, page, kind }  kind: "view" | "ping"
 *   GET  /stats  today's unique visitors / page views, active now, last 7 days, top pages
 *
 * "Days" are Eastern-time days, since that is when the league is playing.
 */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const STATS_CACHE_MS = 30 * 1000;
const RETENTION_DAYS = 120;

const etDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));

let statsCache = { at: 0, body: null };

export async function recordHit(request, env) {
  if (!env.DB) return false;
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return false;
  }
  const vid = String(body.vid || "");
  const page = String(body.page || "").toLowerCase();
  const kind = body.kind === "ping" ? "ping" : "view";
  if (!/^[a-z0-9-]{8,64}$/i.test(vid)) return false;
  if (!/^[a-z0-9_\-/.]{1,60}$/.test(page)) return false;

  const now = Date.now();
  const statements = [
    env.DB.prepare("INSERT INTO seen (vid, ts) VALUES (?1, ?2) ON CONFLICT(vid) DO UPDATE SET ts = ?2").bind(vid, now),
  ];
  if (kind === "view") {
    statements.push(env.DB.prepare("INSERT INTO hits (day, ts, vid, page) VALUES (?1, ?2, ?3, ?4)").bind(etDay(now), now, vid, page));
  }
  // Housekeeping now and then so the tables stay small.
  if (Math.random() < 0.01) {
    const cutoff = etDay(now - RETENTION_DAYS * 86400000);
    statements.push(env.DB.prepare("DELETE FROM hits WHERE day < ?1").bind(cutoff));
    statements.push(env.DB.prepare("DELETE FROM seen WHERE ts < ?1").bind(now - 86400000));
  }
  await env.DB.batch(statements);
  return true;
}

export async function getStats(env) {
  if (!env.DB) return { error: "Analytics not configured" };
  const now = Date.now();
  if (statsCache.body && now - statsCache.at < STATS_CACHE_MS) return statsCache.body;

  const today = etDay(now);
  const weekAgo = etDay(now - 6 * 86400000);
  const [todayRow, activeRow, days, pages] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors FROM hits WHERE day = ?1").bind(today),
    env.DB.prepare("SELECT COUNT(*) AS active FROM seen WHERE ts > ?1").bind(now - ACTIVE_WINDOW_MS),
    env.DB.prepare("SELECT day, COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors FROM hits WHERE day >= ?1 GROUP BY day ORDER BY day DESC").bind(weekAgo),
    env.DB.prepare("SELECT page, COUNT(*) AS views FROM hits WHERE day = ?1 GROUP BY page ORDER BY views DESC LIMIT 6").bind(today),
  ]);

  const body = {
    today,
    visitorsToday: todayRow.results[0]?.visitors || 0,
    viewsToday: todayRow.results[0]?.views || 0,
    activeNow: activeRow.results[0]?.active || 0,
    days: days.results,
    topPages: pages.results,
  };
  statsCache = { at: now, body };
  return body;
}
