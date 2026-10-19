/**
 * Manually dispatches the "Refresh Parlay Data" GitHub Action so anyone can
 * force a refresh right after editing Auto Parlay Tracker, instead of
 * waiting for the next scheduled run (every 10 minutes while a pick's game
 * is on, see dispatchParlayRefreshIfNeeded). The dispatched
 * workflow re-reads the sheet and pushes the recomputed stats straight to
 * Cloudflare KV (see publish_parlay_stats.py) -- no git commit involved,
 * so the site's own /parlay-stats fetch (via this same Worker) picks it up
 * immediately, no GitHub Pages rebuild needed.
 *
 * Requires:
 *   - Secret:  GITHUB_PAT  (fine-grained, this repo only, Actions: read/write)
 *   - KV namespace bound as COOLDOWN_KV (shared with the dashboard cache)
 */
const REPO = "bradbutcher321/RetirementLeague";
const WORKFLOW_FILE = "refresh_parlay_data.yml";
const COOLDOWN_SECONDS = 60;
const COOLDOWN_KEY = "parlay-refresh:last";

// The scheduled refresh only does anything while a Pending pick's game is
// about to start, live, or just over (the workflow's job is grading those and
// publishing live scores). Gametimes in the stats blob are naive US Eastern.
const LEAD_MINUTES = 30;
const TAIL_HOURS = 8;
// A scheduled run is forced at least this often even with nothing pending, so
// a hand edit to the sheet (a fixed team, a regraded Result) still reaches
// the site and D1 within hours.
const SAFETY_SECONDS = 6 * 3600;
const SAFETY_KEY = "parlay-refresh:last-scheduled";

function easternNowAsUtcMs(nowMs) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
}

/** "kickoff Brad 2026-10-18T16:25:00" for the first Pending pick whose game
 *  is within [-LEAD_MINUTES, +TAIL_HOURS] of now, else null. */
export function pendingGameWindow(stats, nowMs) {
  const now = easternNowAsUtcMs(nowMs);
  for (const w of stats?.weeks || []) {
    for (const [player, pick] of Object.entries(w.picks || {})) {
      if (pick.result !== "Pending" || !pick.gametime) continue;
      const kickoff = Date.parse(pick.gametime + "Z"); // both sides naive Eastern, compared as UTC
      if (Number.isNaN(kickoff)) continue;
      const minutesIn = (now - kickoff) / 60000;
      if (minutesIn >= -LEAD_MINUTES && minutesIn <= TAIL_HOURS * 60) return `${player} ${pick.gametime}`;
    }
  }
  return null;
}

/** The cron's version of dispatchParlayRefresh: skips (status 204) unless a
 *  Pending pick's game is in its window, the stats blob can't be read (fail
 *  open), or the safety interval has passed. */
export async function dispatchParlayRefreshIfNeeded(env, nowMs = Date.now()) {
  const stats = await env.COOLDOWN_KV.get("parlay_stats_v1", "json").catch(() => null);
  let reason = stats ? pendingGameWindow(stats, nowMs) : "stats unreadable";
  if (!reason) {
    const last = Number(await env.COOLDOWN_KV.get(SAFETY_KEY)) || 0;
    if (nowMs - last >= SAFETY_SECONDS * 1000) reason = "safety interval";
  }
  if (!reason) return { status: 204, body: { skipped: "no pending game in window" } };
  const result = await dispatchParlayRefresh(env);
  if (result.status < 400) {
    await env.COOLDOWN_KV.put(SAFETY_KEY, String(nowMs), { expirationTtl: 7 * 86400 });
  }
  console.log(`Scheduled parlay refresh: ${reason} -> ${result.status}`);
  return result;
}

export async function dispatchParlayRefresh(env) {
  const now = Date.now();
  const last = Number(await env.COOLDOWN_KV.get(COOLDOWN_KEY)) || 0;
  const remaining = COOLDOWN_SECONDS - Math.floor((now - last) / 1000);
  if (remaining > 0) {
    return { status: 429, body: { error: "cooldown", retryAfterSeconds: remaining } };
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_PAT}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "retirement-league-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { status: 502, body: { error: "github_dispatch_failed", detail: detail.slice(0, 300) } };
  }

  // Set the cooldown only once GitHub actually accepted the dispatch, so a
  // failed attempt doesn't lock the button for a minute for no reason.
  await env.COOLDOWN_KV.put(COOLDOWN_KEY, String(now), { expirationTtl: COOLDOWN_SECONDS + 10 });
  return { status: 202, body: { ok: true } };
}
