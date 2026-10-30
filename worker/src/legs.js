/**
 * Parlay Legs: each signed-in manager enters their own leg for the coming
 * week (docs/parlay-legs.html).
 *
 * The window opens Tuesday 12:00 AM Eastern, after Monday Night Football,
 * and locks Thursday 1:00 PM Eastern. The week is the one after the last
 * week saved (parlay weeks are the league's own count, not the NFL's), and
 * once anyone saves a leg in a window, that window keeps that week.
 *
 * A leg can't be one someone already has, or its opposite (the other team
 * on the same spread or money line, the other side of the same total or
 * player bet). Another bet on the same game is allowed. A leg typed in by
 * hand is saved as bet type "Other" with the text in Player Prop, for a
 * commissioner to fit into the sheet on Enter Picks.
 *
 * A saved leg lands in leg_entries (PARLAY_DB) at once, then every save
 * dispatches sync_legs.yml with the whole week's legs, which writes the
 * rows that changed to Auto Parlay Tracker (enter_parlay.py, mode "legs")
 * and publishes. A later dispatch replaces a queued one, and each carries
 * every leg, so the last save always wins.
 *
 * GET  /legs                -> { year, week, open, locksAt, opensAt, players,
 *                                legs, me } (me only with a signed-in key)
 * POST /legs  { leg } | { remove: true }   Authorization: Bearer <key>
 * GET  /legs/games?sport=   -> { events } Hard Rock's lines for the window
 *                              (Thu-Mon); the page matches them to ESPN's
 *                              schedule, which it reads itself
 * GET  /legs/props?sport=&event= -> { odds: {player: price} } for Anytime TD
 * POST /legs/lock { locked } -> a commissioner locks the week's legs for
 *                              everyone else once the bet is live (or unlocks
 *                              them); commissioners can still edit. Locking
 *                              also reprices every leg at Hard Rock's odds
 *                              of that minute (priceAtLock). Unlocking after
 *                              Thursday 1 PM reopens the week to everyone
 *                              until a commissioner locks it again or the
 *                              next window opens (reopenKey)
 *
 * Lines come from Hard Rock Bet through The Odds API (secret ODDS_API_KEY):
 * the Florida book first, then Hard Rock's main book, which also has
 * college football; Florida's doesn't. A game neither lists keeps the
 * DraftKings line ESPN's scoreboard carries. The schedule itself is read
 * by the page: ESPN's site API turns away requests from Cloudflare's
 * servers (see fetchNflScoreboard in espn.js), never a browser's. The free plan is 500 credits a
 * month; a sport's lines cost 3 and are kept 4 hours, a game's touchdown
 * odds cost 1 and are kept 6, and nothing is fetched once fewer than
 * ODDS_RESERVE credits are left.
 */
import { sessionManager } from "./auth.js";
import { cached } from "./cache.js";
import { isCommissioner, logAction } from "./roles.js";

const REPO = "bradbutcher321/RetirementLeague";
const SYNC_WORKFLOW = "sync_legs.yml";
const ODDS_API = "https://api.the-odds-api.com/v4/sports";
const BOOKS = ["hardrockbet_fl", "hardrockbet"];
const ODDS_RESERVE = 30;
const ODDS_LEFT_KEY = "legs:odds-left";
// Who may enter any manager's leg, not just their own, and save a whole week:
// isCommissioner() in roles.js (Brad and Jon, plus whoever they add).

// The sheet's Bet Type dropdown list, plus "Other"
// for a typed-in leg.
export const BET_TYPES = ["Money Line", "Spread", "Alt Spread", "1st Half Spread", "Anytime TD", "Total Points",
  "Total Goals", "Total Rounds", "Receiving Yards", "Passing TD", "Passing Yards", "Receptions", "Total Yards",
  "Home Runs", "Player Points", "Interceptions", "Coin Toss", "Other"];
const TEAM_LINE_VS = ["Spread", "Alt Spread", "1st Half Spread"];
const TOTAL_VS = ["Total Points", "Total Goals", "Total Rounds"];
const PLAYER_ONLY = ["Anytime TD", "Coin Toss"];

// The Odds API's key for each board sport Hard Rock has lines worth the
// credits for. Futbol stays on DraftKings: six leagues would cost 18
// credits a look.
const ODDS_KEYS = {
  NFL: "americanfootball_nfl", NCAAF: "americanfootball_ncaaf", NBA: "basketball_nba",
  NCAAM: "basketball_ncaab", NHL: "icehockey_nhl", MLB: "baseball_mlb",
};

// ---------- Eastern time ----------
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function etParts(date) {
  const p = Object.fromEntries(ET.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), dow: DOW.indexOf(p.weekday) };
}
/** A Date as the sheet's naive Eastern "YYYY-MM-DDTHH:MM:00". */
export function easternIso(date) {
  const p = etParts(date);
  return `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00`;
}
/** Naive Eastern "YYYY-MM-DDTHH:MM:SS" -> epoch ms. */
function etMs(naive) {
  const guess = Date.parse(naive + "Z");
  return guess + (guess - Date.parse(easternIso(new Date(guess)) + "Z"));
}
const addDays = (date, n) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The entry window `now` falls in: tue is its Tuesday, days its Thursday
 * through Monday (YYYYMMDD) -- the games the week's legs are on. */
export function legWindow(now = new Date()) {
  const p = etParts(now);
  const sinceTue = (p.dow + 5) % 7; // Tue 0 ... Mon 6
  const tue = addDays(p.date, -sinceTue);
  const locks = `${addDays(tue, 2)}T13:00:00`;
  return {
    tue,
    open: sinceTue < 2 || (sinceTue === 2 && p.hour < 13),
    locksAt: etMs(locks),
    opensAt: etMs(`${addDays(tue, 7)}T00:00:00`),
    days: [2, 3, 4, 5, 6].map((i) => addDays(tue, i).replace(/-/g, "")),
  };
}

// ---------- The week ----------
const readStats = (env) => env.COOLDOWN_KV.get("parlay_stats_v1", "json");

/** {year, week} the window's legs go to. */
async function targetWeek(env, win, stats) {
  const row = await env.PARLAY_DB.prepare("SELECT year, week FROM leg_entries WHERE win = ?1 LIMIT 1").bind(win.tue).first();
  if (row) return { year: row.year, week: row.week };
  const season = Number(env.ESPN_YEAR);
  const last = (stats?.weeks || []).at(-1);
  if (!last) return { year: season, week: 1 };
  // Already begun: the commissioner entered it, or legs have reached the sheet.
  if (Object.values(last.picks || {}).some((p) => p.gametime && p.gametime >= `${win.tue}T00:00:00`)) return { year: last.year, week: last.week };
  if (last.year < season) return { year: season, week: 1 };
  return { year: last.year, week: last.week + 1 };
}

// ---------- Legs ----------
const fmtOdds = (o) => (o > 0 ? "+" : "") + Math.round(o);
const fold = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^#\d+\s*/, "").replace(/[^a-z0-9]/g, "");

/** The leg the way the note and Parlay Results write it (reconstruct_pick_text). */
export function pickText(l) {
  if (TEAM_LINE_VS.includes(l.bet_type)) return `${l.bet_type}: ${l.team} ${l.line} vs. ${l.opponent}`;
  if (l.bet_type === "Money Line") return `${l.bet_type}: ${l.team} vs. ${l.opponent}`;
  if (TOTAL_VS.includes(l.bet_type)) return `${l.bet_type}: ${l.side} ${l.line} ${l.team} vs. ${l.opponent}`;
  if (PLAYER_ONLY.includes(l.bet_type) || l.bet_type === "Other") return `${l.bet_type === "Other" ? "" : l.bet_type + ": "}${l.player_prop}`;
  return `${l.bet_type}: ${l.side} ${l.line} ${l.player_prop}`;
}

// The same leg (or its other side) is a family match: a spread and an alt
// spread on one team are the same pick at different prices.
const FAMILY = { "Money Line": "ml", Spread: "spread", "Alt Spread": "spread", "Total Points": "total", "Total Goals": "total", "Total Rounds": "total" };
const gameKey = (l) => l.team && l.opponent && l.gametime ? `${l.gametime.slice(0, 10)}|${[fold(l.team), fold(l.opponent)].sort().join("|")}` : "";

/** 'same', 'opposite', 'also' (another bet on the same game) or null. Kept
 * in step with clash() in docs/parlay-legs.html. */
export function clash(a, b) {
  if (a.bet_type === "Other" || b.bet_type === "Other") return null;
  const fa = FAMILY[a.bet_type], fb = FAMILY[b.bet_type];
  if (!fa && a.bet_type === b.bet_type && a.player_prop && fold(a.player_prop) === fold(b.player_prop)) {
    return !a.side || !b.side || a.side === b.side ? "same" : "opposite";
  }
  const sameGame = (a.game_id && a.game_id === b.game_id) || (gameKey(a) && gameKey(a) === gameKey(b));
  if (!sameGame) return null;
  if (fa && fa === fb) return fa === "total" ? (a.side === b.side ? "same" : "opposite") : (fold(a.team) === fold(b.team) ? "same" : "opposite");
  return "also";
}

const LEG_FIELDS = ["sport", "bet_type", "team", "opponent", "player_prop", "line", "side", "odds", "gametime", "raw_pick"];

/** Every leg in for the week: a manager's own entry, or what the sheet has
 * for them (the commissioner entered it, or fixed a typed-in one). An entry
 * the sheet already has under the same Raw Pick reads from the sheet, so a
 * commissioner's fix shows. */
async function weekLegs(env, wk, win) {
  const [entries, sheet, meta] = await env.PARLAY_DB.batch([
    env.PARLAY_DB.prepare("SELECT * FROM leg_entries WHERE year = ?1 AND week = ?2").bind(wk.year, wk.week),
    env.PARLAY_DB.prepare(`SELECT player, ${LEG_FIELDS.join(", ")} FROM picks WHERE year = ?1 AND week = ?2 AND bet_type IS NOT NULL AND bet_type != ''`).bind(wk.year, wk.week),
    env.PARLAY_DB.prepare("SELECT sacko, final_odds, final_payout, gametime FROM picks WHERE year = ?1 AND week = ?2 AND bet_type IS NOT NULL AND bet_type != '' LIMIT 1").bind(wk.year, wk.week),
  ]);
  // A sheet row from before this window's Tuesday isn't this week's leg (the
  // mirror keeps rows the sheet has since dropped).
  const since = `${win.tue}T00:00:00`;
  const fromSheet = Object.fromEntries(sheet.results.filter((r) => !r.gametime || r.gametime >= since).map((r) => [r.player, r]));
  const out = [];
  for (const e of entries.results) {
    const s = fromSheet[e.player];
    delete fromSheet[e.player];
    if (e.removed) continue;
    const base = s && s.raw_pick === e.raw_pick ? s : e;
    out.push({ ...pickFields(base), player: e.player, game_id: e.game_id || "", updated: e.updated });
  }
  for (const s of Object.values(fromSheet)) out.push({ ...pickFields(s), player: s.player, game_id: "", sheet: true });
  // The week's Sacko and final numbers, from the sheet.
  const m = meta.results[0];
  out.meta = m && (!m.gametime || m.gametime >= since)
    ? { sacko: m.sacko || "", final_odds: m.final_odds, final_payout: m.final_payout } : { sacko: "", final_odds: null, final_payout: null };
  return out;
}
const lockKey = (wk) => `legs:locked:${wk.year}:${wk.week}`;
// Set (to the window's Tuesday) when a commissioner unlocks after Thursday 1 PM.
const reopenKey = (wk) => `legs:reopened:${wk.year}:${wk.week}`;
const pickFields = (r) => Object.fromEntries(LEG_FIELDS.map((f) => [f, f === "odds" ? r.odds : r[f] || ""]));

/** A leg from the page, checked, with its Raw Pick -- or {error}. */
function cleanLeg(b) {
  if (!b || typeof b !== "object") return { error: "bad_leg" };
  const s = (v, n = 80) => String(v ?? "").trim().slice(0, n);
  const odds = Number(b.odds);
  if (!Number.isFinite(odds) || Math.abs(odds) < 100 || Math.abs(odds) > 1000000) return { error: "bad_odds" };
  if (b.typed != null) {
    const text = s(b.typed, 160);
    if (!text) return { error: "bad_leg" };
    return { sport: "", bet_type: "Other", team: "", opponent: "", player_prop: text, line: "", side: "", odds, gametime: "", game_id: "", raw_pick: `${text} (${fmtOdds(odds)})` };
  }
  const leg = { sport: s(b.sport, 20), bet_type: s(b.bet_type, 30), team: s(b.team), opponent: s(b.opponent), player_prop: s(b.player_prop),
    line: s(b.line, 10), side: s(b.side, 10), odds, gametime: s(b.gametime, 19), game_id: s(b.game_id, 24) };
  if (!BET_TYPES.includes(leg.bet_type) || leg.bet_type === "Other") return { error: "bad_leg" };
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(leg.gametime)) return { error: "bad_leg" };
  if (leg.side && leg.side !== "Over" && leg.side !== "Under") return { error: "bad_leg" };
  if (leg.line && !/^[+-]?\d+(\.\d+)?$/.test(leg.line)) return { error: "bad_line" };
  const needs = TEAM_LINE_VS.includes(leg.bet_type) ? ["team", "opponent", "line"]
    : leg.bet_type === "Money Line" ? ["team", "opponent"]
    : TOTAL_VS.includes(leg.bet_type) ? ["team", "opponent", "side", "line"]
    : PLAYER_ONLY.includes(leg.bet_type) ? ["player_prop"] : ["player_prop", "side", "line"];
  if (needs.some((f) => !leg[f])) return { error: needs.includes("line") && !leg.line ? "bad_line" : "bad_leg" };
  // Only what the bet type uses, so a stale field can't ride along.
  for (const f of ["team", "opponent", "player_prop", "line", "side"]) if (!needs.includes(f)) leg[f] = "";
  leg.raw_pick = `${pickText(leg)} (${fmtOdds(odds)})`;
  return leg;
}

async function board(env, request) {
  const win = legWindow();
  const stats = await readStats(env);
  const wk = await targetWeek(env, win, stats);
  const me = request ? await sessionManager(request, env) : null;
  const commish = !!me && (await isCommissioner(env, me.manager));
  // A commissioner's Lock legs button shuts the week to everyone else once
  // the bet is live; a commissioner can still edit (open stays true for them).
  const [lockVal, reopenVal] = await Promise.all([env.COOLDOWN_KV.get(lockKey(wk)), env.COOLDOWN_KV.get(reopenKey(wk))]);
  const locked = !!lockVal;
  // Past Thursday 1 PM the window stays shut unless a commissioner reopened it.
  const reopened = !win.open && reopenVal === win.tue;
  const windowOpen = win.open || reopened;
  // A commissioner can enter or fix a leg at any time (canEnter); `open` is
  // the members' window.
  return {
    year: wk.year, week: wk.week, open: windowOpen && (!locked || commish), canEnter: commish || (windowOpen && !locked),
    locked: windowOpen && locked, reopened, locksAt: win.locksAt, opensAt: win.opensAt,
    days: win.days, players: stats?.players || [], legs: await weekLegs(env, wk, win), me: me ? me.manager : null,
    commish, asOf: Date.now(),
    // Hard Rock's odds from the last Lock legs, for commissioners to check the slip against.
    priced: commish && locked ? await env.COOLDOWN_KV.get(pricedKey(wk), "json") : null,
    _wk: wk, _win: win,
  };
}
const publicBoard = ({ _wk, _win, ...rest }) => ({ ...rest, meta: rest.legs.meta });

async function getLegs(request, env) {
  return { status: 200, body: publicBoard(await board(env, request)) };
}

async function saveLeg(request, env) {
  const who = await sessionManager(request, env);
  if (!who) return { status: 401, body: { error: "signed_out" } };
  const commish = await isCommissioner(env, who.manager);
  const body = await request.json().catch(() => null);
  if (!body) return { status: 400, body: { error: "bad_json" } };
  const b = await board(env, request);
  if (!b.canEnter) return { status: 403, body: { error: "locked", ...publicBoard(b), me: who.manager, commish } };
  // A commissioner may save for anyone; everyone else only for themselves.
  const player = typeof body.player === "string" && body.player ? body.player : who.manager;
  if (player !== who.manager && !commish) return { status: 403, body: { error: "not_commissioner" } };
  if (!b.players.includes(player)) return { status: 403, body: { error: "not_a_player" } };
  const now = Date.now();

  if (body.remove) {
    await env.PARLAY_DB.prepare("UPDATE leg_entries SET removed = 1, updated = ?1 WHERE year = ?2 AND week = ?3 AND player = ?4")
      .bind(now, b.year, b.week, player).run();
  } else {
    const leg = cleanLeg(body.leg);
    if (leg.error) return { status: 400, body: { error: leg.error } };
    const hits = b.legs.filter((l) => l.player !== player).map((l) => [l, clash(leg, l)]);
    const stop = hits.find((h) => h[1] === "same") || hits.find((h) => h[1] === "opposite");
    if (stop) return { status: 409, body: { error: stop[1], by: stop[0].player, pick: pickText(stop[0]), ...publicBoard(b), me: who.manager, commish } };
    await env.PARLAY_DB.prepare(
      `INSERT INTO leg_entries (year, week, player, win, sport, bet_type, team, opponent, player_prop, line, side, odds, gametime, raw_pick, game_id, removed, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16)
       ON CONFLICT(year, week, player) DO UPDATE SET win = excluded.win, sport = excluded.sport, bet_type = excluded.bet_type,
         team = excluded.team, opponent = excluded.opponent, player_prop = excluded.player_prop, line = excluded.line,
         side = excluded.side, odds = excluded.odds, gametime = excluded.gametime, raw_pick = excluded.raw_pick,
         game_id = excluded.game_id, removed = 0, updated = excluded.updated`
    ).bind(b.year, b.week, player, b._win.tue, leg.sport, leg.bet_type, leg.team, leg.opponent, leg.player_prop,
      leg.line, leg.side, leg.odds, leg.gametime, leg.raw_pick, leg.game_id, now).run();
  }
  const synced = await dispatchSync(env, b._wk).catch((err) => { console.error("Leg sync dispatch failed:", err); return false; });
  return { status: 200, body: { ok: true, synced, ...publicBoard({ ...b, legs: await weekLegs(env, b._wk, b._win) }), me: who.manager, commish } };
}

/** A commissioner locks (or unlocks) the week's legs for everyone else. */
async function saveLock(request, env) {
  const who = await sessionManager(request, env);
  if (!who) return { status: 401, body: { error: "signed_out" } };
  if (!(await isCommissioner(env, who.manager))) return { status: 403, body: { error: "not_commissioner" } };
  const body = await request.json().catch(() => null);
  if (!body || typeof body.locked !== "boolean") return { status: 400, body: { error: "bad_json" } };
  const b = await board(env, null);
  let note = "";
  if (body.locked) {
    await env.COOLDOWN_KV.put(lockKey(b._wk), "1", { expirationTtl: 14 * 24 * 3600 });
    // Hard Rock's odds right now, for the bet about to be placed.
    const report = await priceAtLock(env, b).catch((err) => { console.error("Lock odds:", err); return null; });
    if (report) {
      await env.COOLDOWN_KV.put(pricedKey(b._wk), JSON.stringify({ at: Date.now(), legs: report }), { expirationTtl: 14 * 24 * 3600 });
      if (await savePrices(env, b, report)) await dispatchSync(env, b._wk).catch((err) => console.error("Lock sync dispatch failed:", err));
      const n = (h) => report.filter((r) => h.includes(r.how)).length;
      note = ` · Hard Rock odds on ${n(["updated", "same"])} of ${report.length}, ${n(["updated"])} changed`;
    }
  } else {
    await env.COOLDOWN_KV.delete(lockKey(b._wk));
    // After Thursday 1 PM, unlocking reopens the week to everyone.
    if (!b._win.open) {
      await env.COOLDOWN_KV.put(reopenKey(b._wk), b._win.tue, { expirationTtl: 14 * 24 * 3600 });
      note = " after the Thursday lock";
    }
  }
  await logAction(env, who.manager, "parlay", `${body.locked ? "Locked" : "Unlocked"} the legs for week ${b._wk.week}${note}`);
  return { status: 200, body: { ok: true, ...publicBoard(await board(env, request)), me: who.manager } };
}

/** A commissioner sets the week's Sacko, final odds and final payout. */
// ---------- A commissioner's whole-week save (POST /parlay-entry) ----------
const blankLeg = () => ({ sport: "", bet_type: "", team: "", opponent: "", player_prop: "", line: "", side: "", odds: null, gametime: "", raw_pick: "" });

/** Before the save is sent to the sheet: a leg a manager entered after the
 * commissioner's page loaded (picks.loaded_at, epoch ms) is newer than the
 * page's copy, so it stays instead of being overwritten by a stale row. */
export async function guardSavedWeek(env, picks) {
  const b = await board(env, null);
  const loaded = Number(picks.loaded_at);
  if (Number(picks.year) !== b._wk.year || Number(picks.week) !== b._wk.week || !loaded) return picks;
  const { results } = await env.PARLAY_DB.prepare("SELECT * FROM leg_entries WHERE year = ?1 AND week = ?2 AND updated > ?3")
    .bind(b.year, b.week, loaded).all();
  for (const e of results) if (picks.rows[e.player]) picks.rows[e.player] = { ...(e.removed ? blankLeg() : pickFields(e)), result: "Pending" };
  return picks;
}

/** After the save is sent: the board's own copy (leg_entries) takes the
 * saved rows, so the board shows them at once and a later leg sync, which
 * writes whatever differs from the sheet, can't put an old leg back. Only
 * for the week the board is on. */
export async function mirrorSavedWeek(env, picks) {
  const b = await board(env, null);
  if (Number(picks.year) !== b._wk.year || Number(picks.week) !== b._wk.week) return;
  const now = Date.now();
  const stmts = [];
  for (const [player, r] of Object.entries(picks.rows || {})) {
    if (!b.players.includes(player)) continue;
    const have = b.legs.find((l) => l.player === player);
    if (!r.bet_type) {
      if (have) stmts.push(env.PARLAY_DB.prepare("UPDATE leg_entries SET removed = 1, updated = ?1 WHERE year = ?2 AND week = ?3 AND player = ?4").bind(now, b.year, b.week, player));
      continue;
    }
    const leg = Object.fromEntries(LEG_FIELDS.map((f) => [f, f === "odds" ? (Number.isFinite(Number(r.odds)) && r.odds !== "" && r.odds != null ? Number(r.odds) : null) : String(r[f] ?? "")]));
    if (have && LEG_FIELDS.every((f) => String(have[f] ?? "") === String(leg[f] ?? ""))) continue;
    stmts.push(env.PARLAY_DB.prepare(
      `INSERT INTO leg_entries (year, week, player, win, sport, bet_type, team, opponent, player_prop, line, side, odds, gametime, raw_pick, game_id, removed, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, '', 0, ?15)
       ON CONFLICT(year, week, player) DO UPDATE SET win = excluded.win, sport = excluded.sport, bet_type = excluded.bet_type,
         team = excluded.team, opponent = excluded.opponent, player_prop = excluded.player_prop, line = excluded.line,
         side = excluded.side, odds = excluded.odds, gametime = excluded.gametime, raw_pick = excluded.raw_pick,
         game_id = CASE WHEN leg_entries.raw_pick = excluded.raw_pick THEN leg_entries.game_id ELSE '' END,
         removed = 0, updated = excluded.updated`
    ).bind(b.year, b.week, player, b._win.tue, leg.sport, leg.bet_type, leg.team, leg.opponent, leg.player_prop, leg.line, leg.side, leg.odds, leg.gametime, leg.raw_pick, now));
  }
  if (stmts.length) await env.PARLAY_DB.batch(stmts);
}

/** Hands the week's legs to sync_legs.yml. false when it couldn't. */
async function dispatchSync(env, wk) {
  if (!env.GITHUB_PAT) return false;
  const { results } = await env.PARLAY_DB.prepare("SELECT * FROM leg_entries WHERE year = ?1 AND week = ?2").bind(wk.year, wk.week).all();
  const rows = Object.fromEntries(results.map((r) => [r.player, r.removed ? { removed: true, raw_pick: r.raw_pick } : pickFields(r)]));
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${SYNC_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.GITHUB_PAT}`, "Accept": "application/vnd.github+json", "User-Agent": "retirement-league-worker", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { picks: JSON.stringify({ year: wk.year, week: wk.week, mode: "legs", rows }) } }),
  });
  if (!res.ok) console.error("Leg sync dispatch:", res.status, await res.text().catch(() => ""));
  return res.ok;
}

// ---------- Hard Rock lines ----------
/** One Odds API call, unless the month's credits are nearly gone. */
async function oddsApi(env, url) {
  const left = await env.COOLDOWN_KV.get(ODDS_LEFT_KEY);
  if (left != null && Number(left) < ODDS_RESERVE) throw new Error("odds_budget");
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}apiKey=${env.ODDS_API_KEY}`);
  const remaining = res.headers.get("x-requests-remaining");
  // Kept a week at most: the plan resets monthly, and a stale low count
  // would otherwise keep Hard Rock off for good.
  if (remaining != null) await env.COOLDOWN_KV.put(ODDS_LEFT_KEY, remaining, { expirationTtl: 7 * 24 * 3600 });
  if (!res.ok) throw new Error(`Odds API ${res.status}`);
  return res.json();
}

const oddsWindow = (win) => {
  const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
  const thu = `${win.days[0].slice(0, 4)}-${win.days[0].slice(4, 6)}-${win.days[0].slice(6)}`;
  return `commenceTimeFrom=${iso(etMs(`${thu}T00:00:00`))}&commenceTimeTo=${iso(etMs(`${addDays(thu, 5)}T06:00:00`))}`;
};

/** Hard Rock's lines for a sport's window: [{id, at, home, away, markets}],
 * Florida's book where it has the game, Hard Rock's main book otherwise. */
function hardRock(env, sport, win) {
  if (!env.ODDS_API_KEY || !ODDS_KEYS[sport]) return Promise.resolve([]);
  return cached(env, linesKey(sport, win), 4 * 3600, () => fetchLines(env, sport, win))
    .catch((err) => { console.error("Hard Rock lines:", String(err)); return []; });
}
const linesKey = (sport, win) => `legs:hr:${sport}:${win.days[0]}`;
async function fetchLines(env, sport, win) {
  const events = await oddsApi(env, `${ODDS_API}/${ODDS_KEYS[sport]}/odds?bookmakers=${BOOKS.join(",")}&markets=h2h,spreads,totals&oddsFormat=american&${oddsWindow(win)}`);
  return events.map((e) => {
    const book = BOOKS.map((k) => e.bookmakers.find((b) => b.key === k)).find(Boolean);
    return { id: e.id, at: Date.parse(e.commence_time), home: e.home_team, away: e.away_team, markets: book ? book.markets : [] };
  }).filter((e) => e.markets.length);
}
/** This minute's lines, never the cache's (a failed call throws instead of
 * falling back to an old copy); the board's cache takes them too. */
async function freshLines(env, sport, win) {
  if (!env.ODDS_API_KEY) throw new Error("no_key");
  const events = await fetchLines(env, sport, win);
  await cached(env, linesKey(sport, win), 0, async () => events);
  return events;
}

async function getGames(request, env) {
  const sport = new URL(request.url).searchParams.get("sport");
  if (!ODDS_KEYS[sport] && sport !== "Futbol") return { status: 400, body: { error: "bad_sport" } };
  return { status: 200, body: { sport, events: await hardRock(env, sport, legWindow()) } };
}

/** Hard Rock's Anytime TD prices for one game: {player: price}. Only for an
 * event in the window's lines, so a made-up id can't spend credits. */
async function getProps(request, env) {
  const url = new URL(request.url);
  const sport = url.searchParams.get("sport"), id = url.searchParams.get("event");
  if (!ODDS_KEYS[sport] || !id) return { status: 400, body: { error: "bad_game" } };
  const e = (await hardRock(env, sport, legWindow())).find((x) => x.id === id);
  if (!e) return { status: 200, body: { odds: {} } };
  const odds = await cached(env, `legs:td:${e.id}`, 6 * 3600, async () => {
    const data = await oddsApi(env, `${ODDS_API}/${ODDS_KEYS[sport]}/events/${e.id}/odds?bookmakers=${BOOKS.join(",")}&markets=player_anytime_td&oddsFormat=american`);
    const book = BOOKS.map((k) => (data.bookmakers || []).find((b) => b.key === k)).find(Boolean);
    const out = {};
    for (const o of book?.markets?.[0]?.outcomes || []) if (o.name === "Yes" && o.description) out[o.description] = o.price;
    return out;
  }).catch(() => ({}));
  return { status: 200, body: { odds } };
}

// ---------- Hard Rock's odds at lock ----------
// Locking the legs pulls Hard Rock's price for every leg right then, so the
// board matches the bet slip the Sacko places next. A price only counts at
// the leg's own line: Hard Rock's main line, else its alternate lines. A leg
// it doesn't list, or whose line it has moved off, keeps the odds entered,
// and the report says why, so a commissioner knows which to check by hand.

// The Odds API's markets for each bet type, tried in order. h2h, spreads and
// totals come with the sport's lines; the rest cost a credit each per game.
const LOCK_MARKETS = {
  "Money Line": ["h2h"], Spread: ["spreads", "alternate_spreads"], "Alt Spread": ["spreads", "alternate_spreads"],
  "1st Half Spread": ["spreads_h1"], "Total Points": ["totals", "alternate_totals"], "Total Goals": ["totals", "alternate_totals"],
  "Anytime TD": ["player_anytime_td"], "Passing TD": ["player_pass_tds", "player_pass_tds_alternate"],
  "Passing Yards": ["player_pass_yds", "player_pass_yds_alternate"], "Receiving Yards": ["player_reception_yds", "player_reception_yds_alternate"],
  Receptions: ["player_receptions", "player_receptions_alternate"], "Total Yards": ["player_rush_reception_yds", "player_rush_reception_yds_alternate"],
  Interceptions: ["player_pass_interceptions"], "Player Points": ["player_points", "player_points_alternate"],
  "Home Runs": ["batter_home_runs", "batter_home_runs_alternate"],
};
const TEAM_BETS = ["Money Line", ...TEAM_LINE_VS];
const GAME_BETS = [...TEAM_BETS, ...TOTAL_VS];
// ESPN's page-data host for one game (cdn.espn.com answers the Worker; see
// fetchNflScoreboard in espn.js).
const ESPN_CORE = { NFL: "nfl", NCAAF: "college-football", NBA: "nba", NCAAM: "mens-college-basketball", NHL: "nhl", MLB: "mlb" };
const pricedKey = (wk) => `legs:priced:${wk.year}:${wk.week}`;
const signed = (n) => (n > 0 ? "+" : "") + n;

/** A book's team name against the board's ("Buffalo Bills" / "Bills", "#5 Georgia"). */
const nameHit = (book, name) => { const b = fold(book), n = fold(name); return !!n && (b === n || b.startsWith(n) || b.endsWith(n)); };
/** A book's team name against ESPN's [displayName, location, name] (sameTeam on the page). */
const sameTeam = (name, [display, location, nick]) => {
  const n = fold(name);
  return n === fold(display) || (!!fold(location) && n.startsWith(fold(location)) && n.endsWith(fold(nick))) || n === fold(location);
};
/** The event team the leg backs: the one its name matches, or the one its opponent's doesn't. */
function legTeam(ev, l) {
  const hit = [ev.home, ev.away].filter((n) => nameHit(n, l.team));
  if (hit.length === 1) return hit[0];
  const opp = [ev.home, ev.away].filter((n) => nameHit(n, l.opponent));
  return opp.length === 1 ? (opp[0] === ev.home ? ev.away : ev.home) : null;
}
/** The leg's game among Hard Rock's events, within 3 hours of kickoff: by
 * ESPN's names for the game when we have them, else the leg's two teams. */
export function findEvent(events, l, game) {
  const at = game ? game.at : etMs(l.gametime);
  const near = events.filter((e) => Math.abs(e.at - at) < 3 * 3600 * 1000);
  if (game) {
    const both = near.find((e) => (sameTeam(e.away, game.away) && sameTeam(e.home, game.home)) || (sameTeam(e.away, game.home) && sameTeam(e.home, game.away)));
    if (both) return both;
    const one = near.filter((e) => [e.away, e.home].some((n) => sameTeam(n, game.away) || sameTeam(n, game.home)));
    return one.length === 1 ? one[0] : null;
  }
  if (!l.team || !l.opponent) return null;
  const has = (e, name) => nameHit(e.home, name) || nameHit(e.away, name);
  const hits = near.filter((e) => has(e, l.team) && has(e, l.opponent));
  return hits.length === 1 ? hits[0] : null;
}

/** ESPN's two teams and kickoff for a game id, or null. */
async function espnGame(sport, id) {
  if (!ESPN_CORE[sport] || !/^\d+$/.test(id || "")) return null;
  const res = await fetch(`https://cdn.espn.com/core/${ESPN_CORE[sport]}/game?xhr=1&gameId=${id}`, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const c = (await res.json())?.gamepackageJSON?.header?.competitions?.[0];
  const side = (k) => { const t = c?.competitors?.find((x) => x.homeAway === k)?.team; return t ? [t.displayName, t.location, t.name] : null; };
  const home = side("home"), away = side("away");
  return home && away && c.date ? { home, away, at: Date.parse(c.date) } : null;
}

/** One game's extra markets from Hard Rock, Florida's book first, market by
 * market. A sport that doesn't have one of the markets fails the whole call,
 * so then each is asked for on its own. */
async function eventMarkets(env, sport, id, keys) {
  const ask = async (list) => {
    const data = await oddsApi(env, `${ODDS_API}/${ODDS_KEYS[sport]}/events/${id}/odds?bookmakers=${BOOKS.join(",")}&markets=${list.join(",")}&oddsFormat=american`);
    return list.map((k) => BOOKS.map((bk) => (data.bookmakers || []).find((b) => b.key === bk)?.markets?.find((m) => m.key === k)).find(Boolean)).filter(Boolean);
  };
  try { return await ask(keys); } catch (err) {
    if (keys.length === 1 || String(err.message) === "odds_budget") throw err;
    return (await Promise.all(keys.map((k) => ask([k]).catch(() => [])))).flat();
  }
}

/** The leg's price in one market: {hit} at its own line, and {near}, the
 * line Hard Rock has for that side now (for the report). */
function priceIn(market, l, team) {
  const line = l.line === "" ? null : Number(l.line);
  const side = l.bet_type === "Anytime TD" ? "Yes" : l.side;
  const mine = (market.outcomes || []).filter((o) => TEAM_BETS.includes(l.bet_type) ? o.name === team
    : GAME_BETS.includes(l.bet_type) ? o.name === side
    : o.name === side && fold(o.description) === fold(l.player_prop));
  return { hit: line == null ? mine[0] : mine.find((o) => Number(o.point) === line), near: mine[0] };
}
function tryPrice(x, markets) {
  for (const k of LOCK_MARKETS[x.l.bet_type]) {
    const m = markets.find((mm) => mm.key === k);
    if (!m) continue;
    const { hit, near } = priceIn(m, x.l, x.team);
    if (hit) {
      Object.assign(x.r, { odds: hit.price, how: hit.price === Number(x.l.odds) ? "same" : "updated", why: "" });
      return true;
    }
    if (near && near.point != null && k === LOCK_MARKETS[x.l.bet_type][0]) x.now = `${TEAM_LINE_VS.includes(x.l.bet_type) ? signed(near.point) : `${x.l.side} ${near.point}`} (${fmtOdds(near.price)})`;
  }
  return false;
}

/** Every leg's price on Hard Rock right now: [{player, pick, was, odds, how, why}],
 * how "updated" | "same" | "moved" (Hard Rock is on another line) | "kept". */
export async function priceAtLock(env, b) {
  const now = Date.now();
  const rows = b.legs.map((l) => ({ l, r: { player: l.player, pick: pickText(l), was: l.odds, odds: l.odds, how: "kept", why: "" } }));
  const todo = [];
  for (const x of rows) {
    const l = x.l;
    if (l.bet_type === "Other") x.r.why = "Typed in";
    else if (!LOCK_MARKETS[l.bet_type] || !ODDS_KEYS[l.sport] || /^\d+x\s/i.test(l.player_prop)) x.r.why = "Hard Rock's line isn't pulled for this bet";
    else if (!l.gametime || etMs(l.gametime) <= now) x.r.why = "The game has started";
    else todo.push(x);
  }

  // Each sport's lines once (3 credits), then each leg's game in them.
  const sports = [...new Set(todo.map((x) => x.l.sport))];
  const lines = Object.fromEntries(await Promise.all(sports.map(async (s) =>
    [s, await freshLines(env, s, b._win).catch((err) => { console.error("Lock lines:", s, String(err)); return String(err.message) === "odds_budget" ? "budget" : null; })])));
  const games = {};
  await Promise.all(todo.map(async (x) => {
    const l = x.l, events = lines[l.sport];
    if (!Array.isArray(events)) { x.r.why = events === "budget" ? "Odds credits are almost out for the month" : "Couldn't reach Hard Rock"; return; }
    let ev = GAME_BETS.includes(l.bet_type) ? findEvent(events, l, null) : null;
    if (!ev && l.game_id) ev = findEvent(events, l, await (games[l.game_id] ??= espnGame(l.sport, l.game_id).catch(() => null)));
    if (!ev) { x.r.why = l.game_id || GAME_BETS.includes(l.bet_type) ? "Hard Rock doesn't list this game" : "No game saved with this leg to look it up"; return; }
    if (TEAM_BETS.includes(l.bet_type) && !(x.team = legTeam(ev, l))) { x.r.why = "Couldn't tell which team it is on Hard Rock"; return; }
    x.ev = ev;
  }));

  // The sport's lines first; what they don't have (an alternate line, a half,
  // a player) from the game's own markets, one call per game.
  const extra = new Map();
  for (const x of todo) {
    if (!x.ev || tryPrice(x, x.ev.markets)) continue;
    const more = LOCK_MARKETS[x.l.bet_type].filter((k) => !x.ev.markets.some((m) => m.key === k));
    if (!more.length) continue;
    const e = extra.get(x.ev.id) || { sport: x.l.sport, keys: new Set() };
    more.forEach((k) => e.keys.add(k));
    extra.set(x.ev.id, e);
    x.more = true;
  }
  const fetched = {};
  await Promise.all([...extra].map(async ([id, e]) => {
    fetched[id] = await eventMarkets(env, e.sport, id, [...e.keys]).catch((err) => { console.error("Lock props:", String(err)); return null; });
  }));
  for (const x of todo) {
    if (!x.ev || x.r.how !== "kept") continue;
    if (x.more && fetched[x.ev.id]) tryPrice(x, fetched[x.ev.id]);
    if (x.r.how !== "kept") continue;
    if (x.more && !fetched[x.ev.id]) x.r.why = "Couldn't reach Hard Rock";
    else if (x.now) Object.assign(x.r, { how: "moved", why: `Hard Rock has ${x.now} now` });
    else x.r.why = GAME_BETS.includes(x.l.bet_type) ? "Hard Rock doesn't offer this line" : "Hard Rock doesn't offer this player bet";
  }
  return rows.map((x) => x.r);
}

/** The new prices into the board's copy (leg_entries), so the sheet sync
 * carries them; true if any leg changed. */
async function savePrices(env, b, report) {
  const now = Date.now();
  const stmts = [];
  for (const r of report.filter((x) => x.how === "updated")) {
    const l = b.legs.find((x) => x.player === r.player);
    if (!l) continue;
    stmts.push(env.PARLAY_DB.prepare(
      `INSERT INTO leg_entries (year, week, player, win, sport, bet_type, team, opponent, player_prop, line, side, odds, gametime, raw_pick, game_id, removed, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16)
       ON CONFLICT(year, week, player) DO UPDATE SET win = excluded.win, sport = excluded.sport, bet_type = excluded.bet_type,
         team = excluded.team, opponent = excluded.opponent, player_prop = excluded.player_prop, line = excluded.line,
         side = excluded.side, odds = excluded.odds, gametime = excluded.gametime, raw_pick = excluded.raw_pick,
         game_id = excluded.game_id, removed = 0, updated = excluded.updated`
    ).bind(b.year, b.week, l.player, b._win.tue, l.sport, l.bet_type, l.team, l.opponent, l.player_prop, l.line, l.side,
      r.odds, l.gametime, `${pickText(l)} (${fmtOdds(r.odds)})`, l.game_id || "", now));
  }
  if (stmts.length) await env.PARLAY_DB.batch(stmts);
  return stmts.length > 0;
}

/** What the Commissioner page shows about the week: who has a leg in, whether
 * the board is open or locked, and the Odds API credits left. */
export async function legsSummary(env) {
  const b = await board(env, null);
  const locked = !!(await env.COOLDOWN_KV.get(lockKey(b._wk)));
  const left = await env.COOLDOWN_KV.get(ODDS_LEFT_KEY);
  const inNow = new Set(b.legs.map((l) => l.player));
  return {
    year: b._wk.year, week: b._wk.week, windowOpen: b._win.open || b.reopened, locked: b.locked, reopened: b.reopened,
    locksAt: b.locksAt, opensAt: b.opensAt, players: b.players,
    legsIn: b.players.filter((p) => inNow.has(p)), missing: b.players.filter((p) => !inNow.has(p)),
    oddsLeft: left == null ? null : Number(left),
    priced: locked ? await env.COOLDOWN_KV.get(pricedKey(b._wk), "json") : null,
  };
}

export const LEG_ROUTES = {
  "/legs": { GET: getLegs, POST: saveLeg },
  "/legs/games": { GET: getGames },
  "/legs/props": { GET: getProps },
  "/legs/lock": { POST: saveLock },
};
