/**
 * Daily health check (site audit III #26).
 *
 * The site depends on ESPN's login cookies, the GitHub Actions workflows
 * (which also read the Google Sheet), and the Worker's own crons. Any of
 * them can quietly stop -- an expired ESPN cookie is the usual one -- and
 * nobody notices until Sunday's games. scheduled() (index.js) calls
 * runHealthCheck() once a day, at 13:00 UTC (9am Eastern in EDT) on the
 * days a cron fires then (Mon, Thu, Fri, Sat, Sun; the blackout window has
 * none). It checks:
 *   - ESPN still answers the saved cookies (the same API the dashboard uses)
 *   - each workflow's newest finished run didn't fail and isn't overdue
 *     (refresh_parlay_data and sync_legs are the ones that read the sheet)
 *   - the parlay stats blob the workflows publish to KV is there
 * and sends a push to subscribers with the "health" notification on (off by
 * default; the commissioner turns it on in the You sheet). It sends when a
 * problem exists, and once more when everything is back to normal; a quiet
 * day sends nothing. A dead Worker cron can't report itself, so that case
 * shows up only as the 9am message not arriving.
 */
import { pingEspn } from "./espn.js";
import { notifyPref } from "./push.js";

const REPO = "bradbutcher321/RetirementLeague";
const HOUR = 3600 * 1000;
const STATE_KEY = "health:last";
// maxAge: hours since the newest finished run; null = only run on demand.
const WORKFLOWS = [
  { file: "refresh_league_data.yml", name: "League data refresh", maxAge: 12 },
  { file: "update_history_d1.yml", name: "League history update", maxAge: 36 },
  { file: "refresh_franchise_data.yml", name: "Franchise data refresh", maxAge: 96 },
  { file: "sync_scores_to_sheet.yml", name: "Scores to sheet", maxAge: 9 * 24 },
  { file: "refresh_parlay_data.yml", name: "Parlay data refresh", maxAge: 72 },
  { file: "enter_parlay.yml", name: "Parlay pick entry", maxAge: null },
  { file: "sync_legs.yml", name: "Parlay leg sync", maxAge: null },
];
const BAD = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

async function checkEspn(env) {
  try {
    await pingEspn(env);
    return [];
  } catch (err) {
    const m = /\((\d+)\)/.exec(String(err && err.message));
    const status = m && m[1];
    const cookie = status === "401" || status === "403";
    return [{ id: "espn", text: cookie ? "ESPN rejected the saved login cookies (ESPN_SWID / ESPN_S2 expired?)" : `ESPN isn't answering${status ? ` (${status})` : ""}` }];
  }
}

async function checkWorkflow(env, wf) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${wf.file}/runs?status=completed&per_page=1`,
    { headers: { Authorization: `Bearer ${env.GITHUB_PAT}`, Accept: "application/vnd.github+json", "User-Agent": "retirement-league-worker" }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${wf.file}`);
  const run = (await res.json()).workflow_runs?.[0];
  if (!run) return wf.maxAge ? [{ id: `wf:${wf.file}`, text: `${wf.name} has never run` }] : [];
  if (BAD.has(run.conclusion)) return [{ id: `wf:${wf.file}`, text: `${wf.name} failed on its last run` }];
  const hours = (Date.now() - Date.parse(run.updated_at)) / HOUR;
  if (wf.maxAge && hours > wf.maxAge) {
    const ago = hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`;
    return [{ id: `wf:${wf.file}`, text: `${wf.name} hasn't run in ${ago}` }];
  }
  return [];
}

async function checkWorkflows(env) {
  if (!env.GITHUB_PAT) return [{ id: "github", text: "GITHUB_PAT isn't set, so the workflows can't be checked" }];
  const out = await Promise.all(
    WORKFLOWS.map((wf) => checkWorkflow(env, wf).catch((err) => [{ id: `wf:${wf.file}`, text: `Couldn't check ${wf.name}: ${String(err && err.message).slice(0, 80)}` }]))
  );
  return out.flat();
}

async function checkParlayStats(env) {
  const stats = await env.COOLDOWN_KV.get("parlay_stats_v1", "json").catch(() => null);
  return stats ? [] : [{ id: "parlay-kv", text: "The parlay stats aren't in the Worker's storage" }];
}

/** Every problem found right now: [{ id, text }]. */
export async function collectProblems(env) {
  const parts = await Promise.all([checkEspn(env), checkWorkflows(env), checkParlayStats(env)]);
  return parts.flat();
}

export async function runHealthCheck(env) {
  const problems = await collectProblems(env);
  const hadProblems = (await env.COOLDOWN_KV.get(STATE_KEY)) === "bad";
  if (problems.length) {
    await notifyPref(env, "health", {
      title: problems.length === 1 ? "Site health: 1 problem" : `Site health: ${problems.length} problems`,
      body: problems.map((p) => p.text).join(" · "),
      tag: "health",
    });
    await env.COOLDOWN_KV.put(STATE_KEY, "bad");
  } else if (hadProblems) {
    await notifyPref(env, "health", { title: "Site health: all clear", body: "Everything the daily check covers is answering again.", tag: "health" });
    await env.COOLDOWN_KV.put(STATE_KEY, "ok");
  }
  return problems;
}
