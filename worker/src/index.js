/**
 * Live Dashboard data endpoint.
 *
 * Replaces the old "proxy that dispatches a GitHub Action to update a
 * Google Sheet" design. This Worker now talks to ESPN directly and caches
 * the result in KV, so the site reads straight from here — no Sheets, no
 * GitHub Actions, no CSV parsing, and no multi-minute lag between a visit
 * and fresh data (Workers cold-start in single-digit milliseconds; the
 * only real latency left is the ESPN call itself and, when the cooldown is
 * active, none at all since it's served straight from KV).
 *
 * GET /            -> cached data if fetched within the last 2 minutes,
 *                      otherwise fetches fresh from ESPN, caches it, and
 *                      returns it. Falls back to serving stale cache (with
 *                      an `error` field) if a fresh ESPN fetch fails.
 * GET /?force=1    -> bypasses the cooldown (manual testing).
 *
 * Required setup:
 *   - Secrets:     ESPN_SWID, ESPN_S2   (wrangler secret put ...)
 *   - Plain vars:  ESPN_LEAGUE_ID, ESPN_YEAR, ALLOWED_ORIGIN
 *   - KV namespace bound as: COOLDOWN_KV (already existed for the old design)
 */
import { buildDashboard } from "./dashboard.js";

const COOLDOWN_SECONDS = 120;
const CACHE_KEY = "dashboard:latest";
const LAST_FETCH_KEY = "dashboard:last-fetch-epoch";

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
    const headers = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, headers, 405);
    }

    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";

    const lastFetchRaw = await env.COOLDOWN_KV.get(LAST_FETCH_KEY);
    const lastFetch = lastFetchRaw ? parseInt(lastFetchRaw, 10) : 0;
    const elapsed = now - lastFetch;

    if (!force && elapsed < COOLDOWN_SECONDS) {
      const cached = await env.COOLDOWN_KV.get(CACHE_KEY, "json");
      if (cached) {
        return jsonResponse({ ...cached, cacheHit: true }, headers);
      }
      // No cache yet at all (very first request ever) — fall through.
    }

    try {
      const dashboard = await buildDashboard(env);
      await env.COOLDOWN_KV.put(CACHE_KEY, JSON.stringify(dashboard));
      await env.COOLDOWN_KV.put(LAST_FETCH_KEY, String(now));
      return jsonResponse({ ...dashboard, cacheHit: false }, headers);
    } catch (err) {
      // ESPN hiccup or bad credentials — better to serve stale data than
      // nothing, if we have it.
      const cached = await env.COOLDOWN_KV.get(CACHE_KEY, "json");
      if (cached) {
        return jsonResponse({ ...cached, cacheHit: true, error: String(err) }, headers);
      }
      return jsonResponse({ error: String(err) }, headers, 502);
    }
  },
};
