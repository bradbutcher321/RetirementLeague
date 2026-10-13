/**
 * Live Dashboard data endpoint.
 *
 * Replaces the old "proxy that dispatches a GitHub Action to update a
 * Google Sheet" design. This Worker now talks to ESPN directly and caches
 * the result (see readCache/writeCache), so the site reads straight from here — no Sheets, no
 * GitHub Actions, no CSV parsing, and no multi-minute lag between a visit
 * and fresh data (Workers cold-start in single-digit milliseconds; the
 * only real latency left is the ESPN call itself and, when the cooldown is
 * active, none at all since it's served straight from the cache).
 *
 * GET /            -> cached data if fetched within the last 15 seconds,
 *                      otherwise fetches fresh from ESPN, caches it, and
 *                      returns it. Falls back to serving stale cache (with
 *                      an `error` field) if a fresh ESPN fetch fails.
 * GET /?force=1    -> bypasses the cooldown (manual testing).
 * GET /?week=N     -> a finished week, rebuilt the same way (the dashboard's
 *                      week stepper); cached for three hours. N at or past
 *                      the live week is just the live dashboard.
 * GET /player?id=&week=&last= -> one player's game log (see playerLog.js).
 * POST /hit, GET /stats -> site analytics (see analytics.js).
 * POST /refresh-parlay -> dispatches the Parlay data refresh Action on
 *                      demand (see parlayRefresh.js); used by the "Refresh
 *                      Data" button on the Parlay Results page.
 * POST /parlay-entry -> the Enter Picks page's save: checks the PIN and
 *                      dispatches the Action that writes the week to the
 *                      sheet (see parlayEntry.js).
 * GET /parlay-week?year=&week= -> one week's raw rows, for Edit Week.
 * GET /median-history -> the week's projected median over time, for Median
 *                      Watch's chart (see medianHistory.js; the rows are
 *                      written by scheduled() below).
 * GET /parlay-stats  -> the parlay stats payload, read straight from KV
 *                      (see publish_parlay_stats.py, which computes and
 *                      pushes it there -- same "no git commit needed" idea
 *                      as this whole file, just for parlay data instead
 *                      of the live dashboard).
 * POST /push/subscribe, /push/unsubscribe -> Home Screen app
 *                      notifications (see push.js, site audit II #37).
 *
 * Required setup:
 *   - Secrets:     ESPN_SWID, ESPN_S2, GITHUB_PAT, PARLAY_PIN   (wrangler secret put ...)
 *   - Plain vars:  ESPN_LEAGUE_ID, ESPN_YEAR, ALLOWED_ORIGIN
 *   - KV namespace bound as: COOLDOWN_KV (already existed for the old design)
 *   - D1 table `cache` in DB (schema.sql)
 */
import { buildDashboard } from "./dashboard.js";
import { getStats, recordHit } from "./analytics.js";
import { dispatchParlayRefresh } from "./parlayRefresh.js";
import { enterParlay, getParlayWeek } from "./parlayEntry.js";
import { getMedianHistory, recordMedianSnapshot } from "./medianHistory.js";
import { checkPushEvents, subscribe, unsubscribe } from "./push.js";
import { getPlayerLog } from "./playerLog.js";
import { cached } from "./cache.js";

const PUSH_ROUTES = { "/push/subscribe": subscribe, "/push/unsubscribe": unsubscribe };

const COOLDOWN_SECONDS = 15;
// A finished week only changes with ESPN's stat corrections.
const PAST_WEEK_SECONDS = 3 * 60 * 60;
const CACHE_KEY = "dashboard:v2";
// The 15-second cache is a row in D1, whose free tier allows 100k row
// writes a day (a rebuild every 15s all day is under 6k). KV allows only
// 1k, which rebuilds that often would use up within hours, so KV just gets a copy
// every ten minutes, read only if D1 fails. (The Cache API would be the
// other free option, but it does nothing on a *.workers.dev hostname.)
const KV_COPY_SECONDS = 600;

/** { fetchedAt, kvAt, data } for the last dashboard build, or null. */
async function readCache(env) {
  try {
    const row = await env.DB.prepare("SELECT fetched_at, kv_at, data FROM cache WHERE k = ?1").bind(CACHE_KEY).first();
    if (row) return { fetchedAt: row.fetched_at, kvAt: row.kv_at, data: JSON.parse(row.data) };
  } catch (err) {
    console.error("D1 cache read failed:", err);
  }
  const entry = await env.COOLDOWN_KV.get(CACHE_KEY, "json");
  return entry && { ...entry, kvAt: entry.fetchedAt };
}

async function writeCache(env, now, data, previous) {
  const json = JSON.stringify(data);
  let kvDue = !previous?.kvAt || now - previous.kvAt >= KV_COPY_SECONDS;
  const kvAt = kvDue ? now : previous.kvAt;
  try {
    await env.DB.prepare(
      `INSERT INTO cache (k, fetched_at, kv_at, data) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(k) DO UPDATE SET fetched_at = excluded.fetched_at, kv_at = excluded.kv_at, data = excluded.data`
    ).bind(CACHE_KEY, now, kvAt, json).run();
  } catch (err) {
    console.error("D1 cache write failed:", err);
    kvDue = true; // KV is the only cache left, so keep it current
  }
  if (kvDue) await env.COOLDOWN_KV.put(CACHE_KEY, JSON.stringify({ fetchedAt: now, data }));
}

// Reflects the request's own Origin back when it's the production site or a
// local dev server (any localhost/127.0.0.1 port -- covers whatever port a
// static file server happens to pick for local staging), otherwise falls
// back to the configured production origin. A static single-origin header
// would reject every local testing setup outright.
function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (origin === env.ALLOWED_ORIGIN) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(env, request) {
  const origin = request && request.headers.get("Origin");
  const allowOrigin = isAllowedOrigin(origin, env) ? origin : (env.ALLOWED_ORIGIN || "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function jsonResponse(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    const path = new URL(request.url).pathname;
    if (path === "/hit") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const ok = await recordHit(request, env).catch(() => false);
      return new Response(null, { status: ok ? 204 : 400, headers });
    }
    if (path === "/stats") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      return jsonResponse(await getStats(env).catch((err) => ({ error: String(err) })), headers);
    }
    if (path === "/refresh-parlay") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const result = await dispatchParlayRefresh(env).catch((err) => ({ status: 502, body: { error: String(err) } }));
      return jsonResponse(result.body, headers, result.status);
    }
    if (path === "/parlay-entry") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const result = await enterParlay(request, env).catch((err) => ({ status: 502, body: { error: String(err) } }));
      return jsonResponse(result.body, headers, result.status);
    }
    if (path === "/parlay-week") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const result = await getParlayWeek(env, new URL(request.url)).catch((err) => ({ status: 502, body: { error: String(err) } }));
      return jsonResponse(result.body, headers, result.status);
    }
    if (path === "/median-history") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const url = new URL(request.url);
      return jsonResponse(await getMedianHistory(env, url).catch((err) => ({ error: String(err), points: [] })), headers);
    }
    if (path === "/player") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const result = await getPlayerLog(env, new URL(request.url)).catch((err) => ({ status: 502, body: { error: String(err) } }));
      return jsonResponse(result.body, headers, result.status);
    }
    if (PUSH_ROUTES[path]) {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const result = await PUSH_ROUTES[path](request, env).catch((err) => ({ status: 500, body: { error: String(err) } }));
      return jsonResponse(result.body, headers, result.status);
    }
    if (path === "/parlay-stats") {
      // Precomputed elsewhere (publish_parlay_stats.py, run on a schedule
      // or via /refresh-parlay) and pushed straight into this same KV
      // namespace -- this route is just a plain read, no live computation
      // here, since reproducing the Python stats logic in JS would be a
      // large duplicate-maintenance risk for no real benefit at this
      // site's traffic level.
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, headers, 405);
      const data = await env.COOLDOWN_KV.get("parlay_stats_v1", "json");
      if (!data) return jsonResponse({ error: "No parlay stats published yet" }, headers, 404);
      return jsonResponse(data, headers);
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, headers, 405);
    }

    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";

    const entry = await readCache(env);

    // gameStates and averages are for the next build, not for the page.
    const publicView = ({ gameStates, averages, ...rest }) => rest;

    // The live cache knows which week is live; a week before it is history.
    const week = parseInt(url.searchParams.get("week"), 10);
    const liveWeek = entry?.data?.liveWeek || entry?.data?.week;
    if (week >= 1 && liveWeek && week < liveWeek) {
      try {
        const past = await cached(env, `dashboard:week:${env.ESPN_YEAR}:${week}`, PAST_WEEK_SECONDS, () => buildDashboard(env, null, { week }));
        return jsonResponse(publicView(past), headers);
      } catch (err) {
        return jsonResponse({ error: String(err) }, headers, 502);
      }
    }

    if (!force && entry && now - entry.fetchedAt < COOLDOWN_SECONDS) {
      return jsonResponse({ ...publicView(entry.data), cacheHit: true }, headers);
    }

    try {
      const dashboard = await buildDashboard(env, entry?.data);
      await writeCache(env, now, dashboard, entry);
      return jsonResponse({ ...publicView(dashboard), cacheHit: false }, headers);
    } catch (err) {
      // ESPN hiccup or bad credentials — better to serve stale data than
      // nothing, if we have it.
      if (entry) {
        return jsonResponse({ ...publicView(entry.data), cacheHit: true, error: String(err) }, headers);
      }
      return jsonResponse({ error: String(err) }, headers, 502);
    }
  },

  // Cloudflare Cron Trigger (see wrangler.toml [triggers]) -- fires
  // refresh_parlay_data.yml on a real schedule, since GitHub's own
  // `schedule:` trigger is best-effort and was observed firing every
  // 2.5-5.5 hours instead of the configured cadence. The cadence itself
  // varies by day/time (off midweek, hourly on a game day, every 10 min
  // during an actual game window) -- see the crons list in wrangler.toml
  // for the full schedule. Reuses the same dispatch the manual "Refresh
  // Data" button calls, cooldown and all.
  //
  // The same run also saves a projected-median snapshot (medianHistory.js),
  // which is what gives that chart its 10-minutes-in-a-game, hourly-
  // otherwise cadence. It reuses the cached dashboard when a visitor just
  // refreshed it and otherwise builds its own and caches it, so the next
  // visitor gets it for free. The same build is what the notifications are
  // checked against (push.js).
  async scheduled(event, env, ctx) {
    const [parlay, median] = await Promise.allSettled([
      dispatchParlayRefresh(env),
      (async () => {
        const entry = await readCache(env);
        const now = Math.floor(Date.now() / 1000);
        let dashboard = entry?.data;
        if (!entry || now - entry.fetchedAt >= COOLDOWN_SECONDS) {
          dashboard = await buildDashboard(env, entry?.data);
          await writeCache(env, now, dashboard, entry);
        }
        const [snap, push] = await Promise.allSettled([recordMedianSnapshot(env, dashboard), checkPushEvents(env, dashboard)]);
        if (push.status === "rejected") console.error("Push check failed:", push.reason);
        if (snap.status === "rejected") throw snap.reason;
      })(),
    ]);
    if (parlay.status === "rejected" || parlay.value.status >= 400) {
      console.error("Scheduled parlay refresh dispatch failed:", parlay.reason || parlay.value);
    }
    if (median.status === "rejected") console.error("Median snapshot failed:", median.reason);
  },
};
