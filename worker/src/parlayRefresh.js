/**
 * Manually dispatches the "Refresh Parlay Data" GitHub Action so anyone can
 * force a refresh right after editing the Parlay Tracker sheet, instead of
 * waiting for the next scheduled run (every 30 minutes). The dispatched
 * workflow re-reads the sheet, regenerates docs/data/parlay.json, and pushes
 * it if it changed -- same as the schedule does -- which GitHub Pages then
 * rebuilds from automatically.
 *
 * Requires:
 *   - Secret:  GITHUB_PAT  (fine-grained, this repo only, Actions: read/write)
 *   - KV namespace bound as COOLDOWN_KV (shared with the dashboard cache)
 */
const REPO = "bradbutcher321/RetirementLeague";
const WORKFLOW_FILE = "refresh_parlay_data.yml";
const COOLDOWN_SECONDS = 60;
const COOLDOWN_KEY = "parlay-refresh:last";

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
