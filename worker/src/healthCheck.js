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
const SNAPSHOT_KEY = "health:snapshot";
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

/** Each check returns rows: { id, name, ok, detail, text?, at? }. `text` is
 * the sentence the daily push uses for a failing row; `at` (epoch ms) is the
 * newest finished run of a workflow. The Commissioner page's Site Health and
 * Data Refresh screens show the rows as they are. */
async function checkEspn(env) {
  try {
    await pingEspn(env);
    return [{ id: "espn", name: "ESPN login", ok: true, detail: "Answering" }];
  } catch (err) {
    const m = /\((\d+)\)/.exec(String(err && err.message));
    const status = m && m[1];
    const cookie = status === "401" || status === "403";
    return [{
      id: "espn", name: "ESPN login", ok: false,
      detail: cookie ? "ESPN rejected the saved login" : `ESPN isn't answering${status ? ` (${status})` : ""}`,
      text: cookie ? "ESPN rejected the saved login cookies (ESPN_SWID / ESPN_S2 expired?)" : `ESPN isn't answering${status ? ` (${status})` : ""}`,
    }];
  }
}

const agoText = (hours) => (hours >= 48 ? `${Math.round(hours / 24)} days` : hours >= 1.5 ? `${Math.round(hours)} hours` : `${Math.max(1, Math.round(hours * 60))} minutes`);

async function checkWorkflow(env, wf) {
  const base = { id: `wf:${wf.file}`, name: wf.name, file: wf.file };
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${wf.file}/runs?status=completed&per_page=1`,
    { headers: { Authorization: `Bearer ${env.GITHUB_PAT}`, Accept: "application/vnd.github+json", "User-Agent": "retirement-league-worker" }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${wf.file}`);
  const run = (await res.json()).workflow_runs?.[0];
  if (!run) {
    return [wf.maxAge
      ? { ...base, ok: false, detail: "Has never run", text: `${wf.name} has never run` }
      : { ...base, ok: true, detail: "Runs on demand · never run" }];
  }
  const at = Date.parse(run.updated_at);
  const hours = (Date.now() - at) / HOUR;
  if (BAD.has(run.conclusion)) return [{ ...base, at, ok: false, detail: `Failed ${agoText(hours)} ago`, text: `${wf.name} failed on its last run` }];
  if (wf.maxAge && hours > wf.maxAge) {
    return [{ ...base, at, ok: false, detail: `Hasn't run in ${agoText(hours)}`, text: `${wf.name} hasn't run in ${agoText(hours)}` }];
  }
  return [{ ...base, at, ok: true, detail: wf.maxAge ? `Ran ${agoText(hours)} ago` : `On demand · last ${agoText(hours)} ago` }];
}

async function checkWorkflows(env) {
  if (!env.GITHUB_PAT) return [{ id: "github", name: "GitHub", ok: false, detail: "GITHUB_PAT isn't set", text: "GITHUB_PAT isn't set, so the workflows can't be checked" }];
  const out = await Promise.all(
    WORKFLOWS.map((wf) => checkWorkflow(env, wf).catch((err) => {
      const why = String(err && err.message).slice(0, 80);
      return [{ id: `wf:${wf.file}`, name: wf.name, file: wf.file, ok: false, detail: "Couldn't check", text: `Couldn't check ${wf.name}: ${why}` }];
    }))
  );
  return out.flat();
}

async function checkParlayStats(env) {
  const stats = await env.COOLDOWN_KV.get("parlay_stats_v1", "json").catch(() => null);
  return [stats
    ? { id: "parlay-kv", name: "Parlay stats published", ok: true, detail: "In the Worker's storage" }
    : { id: "parlay-kv", name: "Parlay stats published", ok: false, detail: "Missing from the Worker's storage", text: "The parlay stats aren't in the Worker's storage" }];
}

/** Every check, passing or not, in the order the page lists them. */
export async function collectChecks(env) {
  const parts = await Promise.all([checkEspn(env), checkWorkflows(env), checkParlayStats(env)]);
  return parts.flat();
}

/** Every problem found right now: [{ id, text }]. */
export async function collectProblems(env) {
  return (await collectChecks(env)).filter((c) => !c.ok).map((c) => ({ id: c.id, text: c.text }));
}

/** The last full set of checks, kept so the Commissioner page can show
 * something before it has run a fresh one. */
export async function saveSnapshot(env, checks) {
  await env.COOLDOWN_KV.put(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), checks }), { expirationTtl: 3 * 24 * 3600 });
}
export const readSnapshot = (env) => env.COOLDOWN_KV.get(SNAPSHOT_KEY, "json").catch(() => null);

export async function runHealthCheck(env) {
  const checks = await collectChecks(env);
  await saveSnapshot(env, checks).catch(() => {});
  const problems = checks.filter((c) => !c.ok).map((c) => ({ id: c.id, text: c.text }));
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
