/**
 * Side bets (site audit XI #20). Two managers and a stake: one offers, the
 * other takes it or passes, and the site settles it from the final score.
 * It keeps score only; it never moves money. Rows in the analytics D1
 * database (schema.sql: side_bets).
 *
 * Kinds, all for the live week:
 *   matchup  the two of you play each other: the higher score wins
 *   points   any two managers: whoever scores more this week
 *   ou       one of your two scores against a line; `side` is the offerer's
 *            (over or under), the other takes the opposite
 *   other    anything, in words (`note`); either of you settles it by hand
 * Status: offered -> accepted | declined | cancelled (by the offerer) |
 * expired (the week ended first) -> settled (winner: a name, or "push").
 *
 * GET  /bets           signed in: your bets, the week, your opponent, the managers
 * POST /bets           { kind, to, stake, subject?, line?, side?, note? }
 * POST /bets/answer    { id, accept }   the one it was offered to
 * POST /bets/cancel    { id }           the offerer, while it's still offered
 * POST /bets/settle    { id, winner }   an "other" bet, either side
 * settleBets(env, dashboard, loadWeek) from the cron: settles accepted bets
 * once the scores they need are final, and expires offers from past weeks.
 * Each step pushes the other side (the "bets" switch, on by default).
 */
import { sessionManager } from "./auth.js";
import { notifyManager } from "./push.js";

const KINDS = new Set(["matchup", "points", "ou", "other"]);
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const f2 = (n) => (Number(n) || 0).toFixed(2);
const fail = (status, error) => ({ status, body: { error } });
// "$20" reads as an amount; anything else after a colon ("owes you: a beer").
const owe = (stake) => (/^\s*\$\s*\d/.test(stake) ? ` ${stake}` : `: ${stake}`);

/** A manager's line in a week's dashboard: { score, done, opp } or null. */
function sideOf(d, mgr) {
  for (const m of (d && d.matchups) || []) {
    for (const [s, o] of [["away", "home"], ["home", "away"]]) {
      if (m[s + "Manager"] !== mgr) continue;
      const done = !(Number(m[s + "Remaining"]) || 0) && !(Number(m[s + "InPlay"]) || 0);
      return { score: Number(m[s + "Score"]) || 0, done, opp: m[o + "Manager"] || null };
    }
  }
  return null;
}

/** The bet in words, from `me`'s side. */
export function describe(b, me) {
  const other = me === b.a ? b.b : b.a;
  if (b.kind === "matchup") return `${b.stake} on your matchup with ${other}`;
  if (b.kind === "points") return `${b.stake} on who scores more this week, you or ${other}`;
  if (b.kind === "ou") {
    const side = me === b.a ? b.side : b.side === "over" ? "under" : "over";
    return `${b.stake}: ${b.subject === me ? "your score" : `${b.subject}'s score`} ${side} ${f2(b.line)}`;
  }
  return `${b.stake}: ${b.note}`;
}

const row = (b) => ({ ...b, line: b.line == null ? null : Number(b.line) });

async function dashboardOf(env) {
  const r = await env.DB.prepare("SELECT data FROM cache WHERE k = ?1").bind("dashboard:v2").first().catch(() => null);
  return r ? JSON.parse(r.data) : null;
}

/** GET /bets */
export async function betsGet(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  if (!who) return fail(401, "signed_out");
  const me = who.manager;
  const d = await dashboardOf(env);
  const { results } = await env.DB.prepare("SELECT * FROM side_bets WHERE a = ?1 OR b = ?1 ORDER BY created DESC LIMIT 80").bind(me).all();
  const mine = d && sideOf(d, me);
  return {
    status: 200,
    body: {
      me, year: Number(env.ESPN_YEAR), week: d ? d.week : null, opponent: mine ? mine.opp : null,
      managers: d ? (d.teams || []).map((t) => t.manager).filter(Boolean).sort() : [],
      bets: results.map(row),
    },
  };
}

/** POST /bets */
export async function betsOffer(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  if (!who) return fail(401, "signed_out");
  const a = who.manager;
  const body = await request.json().catch(() => ({}));
  const d = await dashboardOf(env);
  if (!d || !d.week) return fail(503, "no_week");
  const managers = new Set((d.teams || []).map((t) => t.manager).filter(Boolean));
  const kind = text(body.kind, 10), b = text(body.to, 40), stake = text(body.stake, 40);
  if (!KINDS.has(kind)) return fail(400, "bad_kind");
  if (!managers.has(b) || b === a) return fail(400, "bad_manager");
  if (!stake) return fail(400, "no_stake");
  const sa = sideOf(d, a), sb = sideOf(d, b);
  const bet = { kind, a, b, stake, subject: null, line: null, side: null, note: null };
  if (kind === "matchup") {
    if (!sa || sa.opp !== b) return fail(400, "not_your_opponent");
    if (sa.done && sb && sb.done) return fail(409, "already_over");
  } else if (kind === "points") {
    if (!sa || !sb) return fail(400, "no_game");
    if (sa.done && sb.done) return fail(409, "already_over");
  } else if (kind === "ou") {
    const subject = text(body.subject, 40), line = Math.round(Number(body.line) * 100) / 100, side = body.side === "under" ? "under" : body.side === "over" ? "over" : null;
    if (subject !== a && subject !== b) return fail(400, "bad_subject");
    if (!(line > 0 && line < 400) || !side) return fail(400, "bad_line");
    const s = sideOf(d, subject);
    if (!s) return fail(400, "no_game");
    if (s.done) return fail(409, "already_over");
    Object.assign(bet, { subject, line, side });
  } else {
    const note = text(body.note, 120);
    if (note.length < 3) return fail(400, "no_note");
    bet.note = note;
  }
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM side_bets WHERE a = ?1 AND year = ?2 AND week = ?3 AND status IN ('offered', 'accepted')")
    .bind(a, Number(env.ESPN_YEAR), d.week).first();
  if (open && open.n >= 6) return fail(429, "too_many");
  const now = Date.now();
  const id = now.toString(36) + Math.random().toString(36).slice(2, 6);
  await env.DB.prepare(`INSERT INTO side_bets (id, year, week, kind, a, b, stake, subject, line, side, note, status, winner, detail, created, updated)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'offered', NULL, NULL, ?12, ?12)`)
    .bind(id, Number(env.ESPN_YEAR), d.week, kind, a, b, stake, bet.subject, bet.line, bet.side, bet.note, now).run();
  const saved = { ...bet, id, year: Number(env.ESPN_YEAR), week: d.week, status: "offered" };
  await notifyManager(env, b, "bets", { title: `${a} wants a side bet`, body: `${describe(saved, b)}. Open Live to take it or pass.`, url: "index.html", tag: `bet-${id}` }).catch(() => {});
  return { status: 200, body: { bet: saved } };
}

async function oneBet(env, id) {
  return env.DB.prepare("SELECT * FROM side_bets WHERE id = ?1").bind(text(id, 40)).first();
}

/** POST /bets/answer { id, accept } */
export async function betsAnswer(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  if (!who) return fail(401, "signed_out");
  const body = await request.json().catch(() => ({}));
  const b = await oneBet(env, body.id);
  if (!b || b.b !== who.manager) return fail(404, "not_found");
  if (b.status !== "offered") return fail(409, "not_open");
  const status = body.accept ? "accepted" : "declined";
  await env.DB.prepare("UPDATE side_bets SET status = ?1, updated = ?2 WHERE id = ?3 AND status = 'offered'").bind(status, Date.now(), b.id).run();
  await notifyManager(env, b.a, "bets", {
    title: body.accept ? `${b.b} took your bet` : `${b.b} passed on your bet`,
    body: `${describe(b, b.a)}.${body.accept ? (b.kind === "other" ? " Settle it on Live when you know." : " It settles from the final score.") : ""}`, url: "index.html", tag: `bet-${b.id}`,
  }).catch(() => {});
  return { status: 200, body: { bet: row({ ...b, status }) } };
}

/** POST /bets/cancel { id } */
export async function betsCancel(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  if (!who) return fail(401, "signed_out");
  const body = await request.json().catch(() => ({}));
  const b = await oneBet(env, body.id);
  if (!b || b.a !== who.manager) return fail(404, "not_found");
  if (b.status !== "offered") return fail(409, "not_open");
  await env.DB.prepare("UPDATE side_bets SET status = 'cancelled', updated = ?1 WHERE id = ?2").bind(Date.now(), b.id).run();
  return { status: 200, body: { bet: row({ ...b, status: "cancelled" }) } };
}

async function settle(env, b, winner, detail) {
  const r = await env.DB.prepare("UPDATE side_bets SET status = 'settled', winner = ?1, detail = ?2, updated = ?3 WHERE id = ?4 AND status = 'accepted'")
    .bind(winner, detail, Date.now(), b.id).run();
  if (!(r && r.meta && r.meta.changes)) return;
  for (const me of [b.a, b.b]) {
    const other = me === b.a ? b.b : b.a;
    const message = winner === "push"
      ? { title: "Side bet: a push", body: `${describe(b, me)}. ${detail}. Nobody owes anything.` }
      : winner === me
        ? { title: "Side bet won", body: `${other} owes you${owe(b.stake)}. ${detail}.` }
        : { title: "Side bet lost", body: `You owe ${other}${owe(b.stake)}. ${detail}.` };
    await notifyManager(env, me, "bets", { ...message, url: "franchise.html", tag: `bet-${b.id}` }).catch(() => {});
  }
}

/** POST /bets/settle { id, winner } for an "other" bet */
export async function betsSettle(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  if (!who) return fail(401, "signed_out");
  const body = await request.json().catch(() => ({}));
  const b = await oneBet(env, body.id);
  if (!b || (b.a !== who.manager && b.b !== who.manager)) return fail(404, "not_found");
  if (b.kind !== "other" || b.status !== "accepted") return fail(409, "not_open");
  const winner = body.winner === "push" ? "push" : body.winner === b.a || body.winner === b.b ? body.winner : null;
  if (!winner) return fail(400, "bad_winner");
  await settle(env, b, winner, `Settled by ${who.manager}`);
  return { status: 200, body: { ok: true } };
}

/** The result once the scores it needs are final: [winner, detail] or null. */
function result(b, d) {
  if (b.kind === "ou") {
    const s = sideOf(d, b.subject);
    if (!s || !s.done) return null;
    const over = s.score > b.line, under = s.score < b.line;
    const aWins = b.side === "over" ? over : under;
    const detail = `${b.subject} scored ${f2(s.score)}, the line was ${f2(b.line)}`;
    return !over && !under ? ["push", detail] : [aWins ? b.a : b.b, detail];
  }
  const sa = sideOf(d, b.a), sb = sideOf(d, b.b);
  if (!sa || !sb || !sa.done || !sb.done) return null;
  const detail = `${b.a} ${f2(sa.score)}, ${b.b} ${f2(sb.score)}`;
  return sa.score === sb.score ? ["push", detail] : [sa.score > sb.score ? b.a : b.b, detail];
}

/** From the cron: settle what the final scores decide; expire old offers. */
export async function settleBets(env, dashboard, loadWeek) {
  if (!dashboard || !dashboard.week) return;
  const year = Number(env.ESPN_YEAR);
  await env.DB.prepare("UPDATE side_bets SET status = 'expired', updated = ?1 WHERE status = 'offered' AND (year < ?2 OR (year = ?2 AND week < ?3))")
    .bind(Date.now(), year, dashboard.week).run();
  const { results } = await env.DB.prepare("SELECT * FROM side_bets WHERE status = 'accepted' AND kind != 'other'").all();
  if (!results.length) return;
  const weeks = new Map();
  for (const b of results.map(row)) {
    let d = null;
    if (b.year === year && b.week === dashboard.week) d = dashboard;
    else if (b.year === year && b.week < dashboard.week && loadWeek) {
      if (!weeks.has(b.week)) weeks.set(b.week, await loadWeek(b.week).catch(() => null));
      d = weeks.get(b.week);
    }
    if (!d) continue;
    const r = result(b, d);
    if (r) await settle(env, b, r[0], r[1]);
    // A past week with no game for someone (a playoff bye) can't be decided.
    else if (d !== dashboard) await settle(env, b, "push", "No game to settle it");
  }
}

export const BET_ROUTES = {
  "/bets": { GET: betsGet, POST: betsOffer },
  "/bets/answer": { POST: betsAnswer },
  "/bets/cancel": { POST: betsCancel },
  "/bets/settle": { POST: betsSettle },
};
