/**
 * Idiot of the Week (site audit XI #19). Once a week's last game is over the
 * site posts its own vote: up to four of the week's worst lineup calls, found
 * in the data, voted on by the league (signed in, and never for yourself).
 * It closes Wednesday at 9 PM Eastern; the winner (everyone tied at the top)
 * wears an IDIOT tag on Standings until the next one closes.
 *
 * What counts as a bad call, from the finished week's dashboard (the
 * starters' projections and points, and each side's best possible lineup,
 * awayBest/homeBest):
 *   a starter projected 0 who scored nothing (on bye or ruled out)     3 each
 *   lost the matchup with a lineup on the roster that would have won      2
 *   else lost to the median with a lineup that would have beaten it       1
 *   points left on the bench                                         1 per 10
 * A week needs two managers with something to show for a vote.
 *
 * Kept in site_settings (roles.js) as "idiot":
 *   { id, year, week, cands: [{ m, why }], opened, closes, closed, votes: { voter: m }, winners }
 * and the last few closed ones in "idiot_past".
 *
 * GET  /idiot       the open vote or the last result, the counts, who voted,
 *                   your own vote when signed in, and who wears the tag
 * POST /idiot/vote  { id, m } signed in
 * checkIdiot(env, dashboard, loadWeek) from the cron: opens the week's vote
 * once its games are over and closes it on time, with one push each
 * (the "idiot" notification switch, on by default).
 */
import { sessionManager } from "./auth.js";
import { getSetting, setSetting } from "./roles.js";
import { notifyPref } from "./push.js";

const f2 = (n) => (Number(n) || 0).toFixed(2);
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" });
const etParts = (ms) => Object.fromEntries(ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));

/** The first Wednesday 9 PM Eastern after `ms`. */
export function closesAfter(ms) {
  for (let i = 0; i < 8; i++) {
    const p = etParts(ms + i * 86400000);
    if (p.weekday !== "Wed") continue;
    const off = Number((p.timeZoneName || "GMT-5").replace("GMT", "")) || -5;
    const at = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 21 - off, 0);
    if (at > ms) return at;
  }
  return ms + 2 * 86400000;
}

/** Up to four managers with the week's worst lineup calls: [{ m, why }]. */
export function candidates(week) {
  const med = Number(week && week.currentMedian);
  const rows = [];
  const last = (p) => String(p.name || "");
  const list = (ps) => { const n = ps.map(last); return n.length < 3 ? n.join(" and ") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`; };
  for (const m of (week && week.matchups) || []) {
    for (const [s, o] of [["away", "home"], ["home", "away"]]) {
      const me = m[s + "Manager"], opp = m[o + "Manager"];
      if (!me) continue;
      const score = Number(m[s + "Score"]) || 0, theirs = Number(m[o + "Score"]) || 0, best = Number(m[s + "Best"]);
      const holes = (m[s + "Players"] || []).filter((p) => (Number(p.projectedPoints) || 0) === 0 && !(Number(p.livePoints) > 0));
      const bench = Number.isFinite(best) ? Math.max(0, best - score) : 0;
      const lostWin = !!opp && score < theirs && Number.isFinite(best) && best > theirs;
      const lostMedian = !lostWin && med > 0 && score < med && Number.isFinite(best) && best > med;
      if (!holes.length && !lostWin && !lostMedian && bench < 10) continue;
      const why = [];
      if (holes.length) why.push(`Started ${list(holes)} (0.00, projected 0).`);
      if (lostWin) why.push(`Best possible lineup: ${f2(best)}, enough to beat ${opp} (${f2(theirs)}).`);
      else if (lostMedian) why.push(`Best possible lineup: ${f2(best)}, enough to beat the median (${f2(med)}).`);
      if (bench >= 10) why.push(`Left ${f2(bench)} on the bench${!lostWin && score < theirs && opp ? ` in a ${f2(theirs - score)}-point loss to ${opp}` : ""}.`);
      rows.push({ m: me, why: why.join(" "), pts: holes.length * 3 + (lostWin ? 2 : 0) + (lostMedian ? 1 : 0) + bench / 10 });
    }
  }
  return rows.sort((a, b) => b.pts - a.pts).slice(0, 4).map(({ m, why }) => ({ m, why }));
}

const tally = (v) => {
  const counts = {};
  (v.cands || []).forEach((c) => { counts[c.m] = 0; });
  Object.values(v.votes || {}).forEach((m) => { if (counts[m] !== undefined) counts[m]++; });
  return counts;
};
const winnersOf = (v) => {
  const c = tally(v), top = Math.max(0, ...Object.values(c));
  return top ? Object.keys(c).filter((m) => c[m] === top) : [];
};
const out = (v, me) => v && {
  id: v.id, year: v.year, week: v.week, cands: v.cands, closes: v.closes, closed: !!v.closed,
  counts: tally(v), voters: Object.keys(v.votes || {}).sort(), mine: me && v.votes ? v.votes[me] || null : null,
  winners: v.closed ? v.winners || winnersOf(v) : null,
};

/** Who wears the tag: the last closed vote's winners. */
async function wearing(env, cur) {
  const last = cur && cur.closed ? cur : (await getSetting(env, "idiot_past", []))[0];
  return last && last.winners && last.winners.length ? { year: last.year, week: last.week, managers: last.winners } : null;
}

// Each push once, even if two cron runs overlap (push_sent holds the key).
async function once(env, key) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO push_sent (k, ts) VALUES (?1, ?2)").bind(key, Date.now()).run();
  return !!(r && r.meta && r.meta.changes);
}

async function closeIfDue(env, v) {
  if (!v || v.closed || Date.now() < v.closes) return v;
  v.closed = true;
  v.winners = winnersOf(v);
  await setSetting(env, "idiot", v);
  const past = await getSetting(env, "idiot_past", []);
  await setSetting(env, "idiot_past", [v, ...past.filter((x) => x.id !== v.id)].slice(0, 8));
  if (v.winners.length && await once(env, `idiot-close:${v.id}`)) {
    const c = tally(v), n = c[v.winners[0]];
    await notifyPref(env, "idiot", {
      title: `Idiot of Week ${v.week}`,
      body: `${v.winners.join(" and ")}, with ${n} vote${n === 1 ? "" : "s"}. The tag is on Standings until next week's is in.`,
      url: "standings.html",
      tag: `idiot-${v.week}`,
    }).catch(() => {});
  }
  return v;
}

/** The week whose games are all over, and its data: { year, week, data } or null. */
async function finishedWeek(env, dashboard, loadWeek) {
  if (!dashboard || !dashboard.week || !dashboard.teams) return null;
  const year = Number(env.ESPN_YEAR);
  const done = (t) => !(t.remaining || 0) && !(t.inPlay || 0);
  const scored = dashboard.teams.some((t) => (t.current || 0) > 0);
  if (dashboard.medianStatusKnown && scored && dashboard.teams.every(done)) return { year, week: dashboard.week, data: dashboard };
  // After ESPN turns the week over (Tuesday), the week before, until Wednesday night.
  const day = etParts(Date.now()).weekday;
  if (dashboard.week > 1 && (day === "Tue" || day === "Wed") && loadWeek) {
    const data = await loadWeek(dashboard.week - 1).catch(() => null);
    if (data && data.matchups && data.matchups.length) return { year, week: dashboard.week - 1, data };
  }
  return null;
}

/** Opens this week's vote once its games are over; closes the open one on time. */
export async function checkIdiot(env, dashboard, loadWeek) {
  let v = await closeIfDue(env, await getSetting(env, "idiot"));
  const fin = await finishedWeek(env, dashboard, loadWeek);
  if (!fin) return v;
  const id = `${fin.year}-${fin.week}`;
  if (v && v.id === id) return v;
  const past = await getSetting(env, "idiot_past", []);
  if (past.some((x) => x.id === id)) return v;
  const cands = candidates(fin.data);
  if (cands.length < 2) return v;
  // A vote still open from an earlier week closes first.
  if (v && !v.closed) { v.closes = Date.now(); v = await closeIfDue(env, v); }
  const now = Date.now();
  v = { id, year: fin.year, week: fin.week, cands, opened: now, closes: closesAfter(now), closed: false, votes: {} };
  await setSetting(env, "idiot", v);
  if (await once(env, `idiot-open:${id}`)) {
    await notifyPref(env, "idiot", {
      title: `Idiot of Week ${fin.week}: vote`,
      body: `${cands.map((c) => c.m).join(", ")}. Vote on Live before Wednesday at 9 PM.`,
      url: "index.html",
      tag: `idiot-${fin.week}`,
    }).catch(() => {});
  }
  return v;
}

/** GET /idiot */
export async function idiotGet(request, env, ctx2 = {}) {
  const who = await sessionManager(request, env).catch(() => null);
  let v = await getSetting(env, "idiot");
  // Opened here too, so a vote doesn't wait for the next cron run.
  if (ctx2.dashboard) v = await checkIdiot(env, ctx2.dashboard, ctx2.loadWeek).catch(() => v);
  else v = await closeIfDue(env, v);
  return { status: 200, body: { vote: out(v, who && who.manager), wearing: await wearing(env, v) } };
}

/** POST /idiot/vote { id, m } */
export async function idiotVote(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  if (!who) return { status: 401, body: { error: "signed_out" } };
  const body = await request.json().catch(() => ({}));
  const v = await closeIfDue(env, await getSetting(env, "idiot"));
  if (!v || v.id !== body.id) return { status: 404, body: { error: "no_vote" } };
  if (v.closed) return { status: 409, body: { error: "closed" } };
  if (!v.cands.some((c) => c.m === body.m)) return { status: 400, body: { error: "bad_choice" } };
  if (body.m === who.manager) return { status: 400, body: { error: "self" } };
  v.votes = v.votes || {};
  v.votes[who.manager] = body.m;
  await setSetting(env, "idiot", v);
  return { status: 200, body: { vote: out(v, who.manager) } };
}

/** What /site-info adds: an open vote, and who wears the tag. */
export async function idiotExtras(env) {
  const v = await getSetting(env, "idiot");
  return { idiot: v && !v.closed && Date.now() < v.closes ? { id: v.id, week: v.week } : null, idiotTag: await wearing(env, v) };
}
