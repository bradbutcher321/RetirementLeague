/**
 * The Commissioner page's other tools (docs/commissioner.html). Sign-ins and
 * roles live in auth.js; this is everything else.
 *
 * POST /admin { action, pin?, ... }   Authorization: Bearer <key> (a signed-in
 * commissioner needs no PIN; anyone else sends the PIN)
 *   overview { names }     one call for the hub: sign-in counts, the week's legs,
 *                          notification devices, the announcement, draft date,
 *                          latest log line, the last health snapshot, today's visits
 *   health                 runs every site check now and keeps the result
 *   workflow_run { which } starts league | franchise | history | scores | parlay
 *   push_info              who has notifications on, and what was sent lately
 *   push_send { title, body, to }   a push to everyone, or one manager's devices
 *   announce_set { text, until }  /  announce_clear
 *   season_set { draft }   the draft's date and time ("YYYY-MM-DDTHH:MM", Eastern), "" clears it
 *   videos_get / videos_set { season, playlist } / videos_remove { season }
 *   videos_list { season } / videos_hide { id, hidden }
 *   activity               visits, and when each manager was last here
 *   log                    the latest hundred things a commissioner did
 *
 * GET /site-info (public) -> { announcement, draft }, what the Live page shows.
 */
import { commissionerGate, ensureManagers } from "./auth.js";
import { commissioners, getSetting, logAction, setSetting } from "./roles.js";
import { legsSummary } from "./legs.js";
import { getStats, getWho } from "./analytics.js";
import { collectChecks, readSnapshot, saveSnapshot } from "./healthCheck.js";
import { broadcast, subscriberSummary } from "./push.js";
import { dispatchParlayRefresh } from "./parlayRefresh.js";
import { cached } from "./cache.js";
import { fetchPlaylist, hiddenVideos, playlistId, playlists } from "./videos.js";

const REPO = "bradbutcher321/RetirementLeague";
const WORKFLOWS = {
  league: ["refresh_league_data.yml", "League data refresh"],
  franchise: ["refresh_franchise_data.yml", "Franchise data refresh"],
  history: ["update_history_d1.yml", "League history update"],
  scores: ["sync_scores_to_sheet.yml", "Scores to sheet"],
};
const RUN_COOLDOWN_SECONDS = 60;
const etDay = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));

const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

/** What the Live page shows: a current announcement and the draft's date. */
export async function siteInfo(env) {
  const [ann, draft] = await Promise.all([getSetting(env, "announcement"), getSetting(env, "draft")]);
  const live = ann && ann.text && (!ann.until || ann.until >= etDay());
  return { announcement: live ? { text: ann.text, until: ann.until || null } : null, draft: draft && draft.at ? { at: draft.at } : null };
}

async function overview(env, body) {
  const names = await ensureManagers(env, body.names);
  const [mgr, sess, subs, ann, draft, last, snap, stats, parlay, lists, hidden, comms] = await Promise.all([
    env.DB.prepare("SELECT manager FROM auth_managers").all(),
    env.DB.prepare("SELECT DISTINCT manager FROM auth_sessions").all(),
    subscriberSummary(env).catch(() => []),
    getSetting(env, "announcement"),
    getSetting(env, "draft"),
    env.DB.prepare("SELECT ts, who, text FROM admin_log ORDER BY id DESC LIMIT 1").first().catch(() => null),
    readSnapshot(env),
    getStats(env).catch(() => null),
    legsSummary(env).catch((err) => { console.error("legsSummary failed:", err); return null; }),
    playlists(env),
    hiddenVideos(env),
    commissioners(env),
  ]);
  const all = mgr.results.map((r) => r.manager).filter((m) => !names.length || names.includes(m));
  const signed = new Set(sess.results.map((r) => r.manager));
  return {
    status: 200,
    body: {
      managers: all.length,
      commissioners: comms.length,
      signedIn: all.filter((m) => signed.has(m)).length,
      unsigned: all.filter((m) => !signed.has(m)).sort((a, b) => a.localeCompare(b)),
      parlay,
      push: { people: subs.filter((s) => s.me).length, devices: subs.reduce((n, s) => n + s.devices, 0) },
      announcement: ann && ann.text ? ann : null,
      draft: draft && draft.at ? draft : null,
      last: last || null,
      health: snap ? { at: snap.at, checks: snap.checks } : null,
      visits: stats && !stats.error ? { visitors: stats.visitorsToday, views: stats.viewsToday, activeNow: stats.activeNow } : null,
      playlists: Object.keys(lists).map(Number).sort((a, b) => a - b),
      hiddenVideos: hidden.size,
    },
  };
}

async function health(env, who) {
  const checks = await collectChecks(env);
  await saveSnapshot(env, checks).catch(() => {});
  return { status: 200, body: { at: Date.now(), checks } };
}

async function dispatchWorkflow(env, file) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${file}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_PAT}`, Accept: "application/vnd.github+json", "User-Agent": "retirement-league-worker", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
}

async function workflowRun(env, body, who) {
  const which = text(body.which, 20);
  if (which === "parlay") {
    const r = await dispatchParlayRefresh(env);
    if (r.status < 300) await logAction(env, who, "refresh", "Started a parlay data refresh");
    return r;
  }
  const wf = WORKFLOWS[which];
  if (!wf) return fail(400, "bad_workflow");
  const key = `admin:run:${which}`;
  const left = RUN_COOLDOWN_SECONDS - Math.floor((Date.now() - (Number(await env.COOLDOWN_KV.get(key)) || 0)) / 1000);
  if (left > 0) return fail(429, "cooldown", { retryAfterSeconds: left });
  try {
    await dispatchWorkflow(env, wf[0]);
  } catch (err) {
    return fail(502, "github_dispatch_failed", { detail: String(err && err.message) });
  }
  await env.COOLDOWN_KV.put(key, String(Date.now()), { expirationTtl: RUN_COOLDOWN_SECONDS + 10 });
  await logAction(env, who, "refresh", `Started the ${wf[1].toLowerCase()}`);
  return { status: 202, body: { ok: true } };
}

async function pushInfo(env) {
  const [subs, recent] = await Promise.all([
    subscriberSummary(env),
    env.DB.prepare("SELECT ts, who, text FROM admin_log WHERE kind = 'push' ORDER BY id DESC LIMIT 8").all().catch(() => ({ results: [] })),
  ]);
  return { status: 200, body: { subs, recent: recent.results } };
}

async function pushSend(env, body, who) {
  const title = text(body.title, 60), message = text(body.body, 180);
  if (!title) return fail(400, "no_title");
  const to = body.to && body.to !== "all" ? text(body.to, 40) : null;
  const out = await broadcast(env, { title, body: message }, to);
  if (out.error) return fail(503, out.error);
  if (!out.devices) return fail(404, "no_devices");
  await logAction(env, who, "push", `Sent "${title}" to ${to || "everyone"} (${out.sent} of ${out.devices} devices)`);
  return { status: 200, body: out };
}

async function announce(env, body, who) {
  if (body.action === "announce_clear") {
    await setSetting(env, "announcement", null);
    await logAction(env, who, "announce", "Took down the announcement");
    return { status: 200, body: { ok: true } };
  }
  const msg = text(body.text, 200);
  if (!msg) return fail(400, "no_text");
  const until = text(body.until, 10);
  if (until && !/^\d{4}-\d\d-\d\d$/.test(until)) return fail(400, "bad_date");
  await setSetting(env, "announcement", { text: msg, until: until || null, by: who || "PIN", at: Date.now() });
  await logAction(env, who, "announce", `Posted an announcement: ${msg}`);
  return { status: 200, body: { ok: true } };
}

async function season(env, body, who) {
  const at = text(body.draft, 16);
  if (at && !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(at)) return fail(400, "bad_date");
  await setSetting(env, "draft", at ? { at } : null);
  await logAction(env, who, "season", at ? `Set the draft for ${at.replace("T", " ")}` : "Cleared the draft date");
  return { status: 200, body: { ok: true } };
}

async function videos(env, body, who) {
  const mine = await getSetting(env, "video_playlists", {});
  const all = await playlists(env);
  const season = text(body.season, 4);
  switch (body.action) {
    case "videos_get":
      return { status: 200, body: { playlists: Object.keys(all).sort().map((y) => ({ season: Number(y), saved: !!mine[y] })) } };
    case "videos_set": {
      const id = playlistId(body.playlist);
      if (!/^\d{4}$/.test(season) || !id) return fail(400, "bad_playlist");
      let list;
      try {
        list = await fetchPlaylist(id);
      } catch {
        return fail(422, "unreadable_playlist");
      }
      await setSetting(env, "video_playlists", { ...mine, [season]: id });
      await logAction(env, who, "videos", `Set the ${season} recap playlist (${list.length} videos)`);
      return { status: 200, body: { ok: true, count: list.length } };
    }
    case "videos_remove": {
      if (!mine[season]) return fail(404, "not_saved");
      const { [season]: gone, ...rest } = mine;
      await setSetting(env, "video_playlists", Object.keys(rest).length ? rest : null);
      await logAction(env, who, "videos", `Removed the saved ${season} recap playlist`);
      return { status: 200, body: { ok: true } };
    }
    case "videos_list": {
      if (!all[season]) return fail(404, "no_playlist");
      const [list, hidden] = await Promise.all([cached(env, `videos:${season}:${all[season]}`, 30 * 60, () => fetchPlaylist(all[season])), hiddenVideos(env)]);
      return { status: 200, body: { season: Number(season), videos: list.map((v) => ({ ...v, hidden: hidden.has(v.id) })) } };
    }
    case "videos_hide": {
      const id = text(body.id, 11);
      if (!/^[A-Za-z0-9_-]{11}$/.test(id) || typeof body.hidden !== "boolean") return fail(400, "bad_video");
      const hidden = await hiddenVideos(env);
      if (body.hidden) hidden.add(id); else hidden.delete(id);
      await setSetting(env, "video_hidden", hidden.size ? [...hidden] : null);
      await logAction(env, who, "videos", `${body.hidden ? "Hid" : "Showed"} a recap video${body.title ? `: ${text(body.title, 60)}` : ""}`);
      return { status: 200, body: { ok: true } };
    }
  }
  return fail(400, "bad_action");
}

async function activity(env) {
  const [stats, who, seen, subs] = await Promise.all([
    getStats(env).catch(() => null),
    getWho(env).catch((err) => { console.error("getWho failed:", err); return null; }),
    env.DB.prepare("SELECT manager, MAX(seen) AS seen, SUM(kind = 'app') AS apps, COUNT(*) AS devices FROM auth_sessions GROUP BY manager").all(),
    subscriberSummary(env).catch(() => []),
  ]);
  return { status: 200, body: { stats, who, managers: seen.results, push: subs } };
}

async function log(env) {
  const { results } = await env.DB.prepare("SELECT ts, who, kind, text FROM admin_log ORDER BY id DESC LIMIT 100").all();
  return { status: 200, body: { entries: results } };
}

async function adminRoute(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, "bad_json");
  const gate = await commissionerGate(request, env, body);
  if (gate.denied) return gate.denied;
  const who = gate.who;
  const a = String(body.action || "");
  switch (a) {
    case "overview": return overview(env, body);
    case "health": return health(env, who);
    case "workflow_run": return workflowRun(env, body, who);
    case "push_info": return pushInfo(env);
    case "push_send": return pushSend(env, body, who);
    case "announce_set":
    case "announce_clear": return announce(env, body, who);
    case "season_set": return season(env, body, who);
    case "activity": return activity(env);
    case "log": return log(env);
  }
  if (a.startsWith("videos_")) return videos(env, body, who);
  return fail(400, "bad_action");
}

export const ADMIN_ROUTES = {
  "/admin": ["POST", adminRoute],
};
