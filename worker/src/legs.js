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

const REPO = "bradbutcher321/RetirementLeague";
const SYNC_WORKFLOW = "sync_legs.yml";
const ODDS_API = "https://api.the-odds-api.com/v4/sports";
const BOOKS = ["hardrockbet_fl", "hardrockbet"];
const ODDS_RESERVE = 30;
const ODDS_LEFT_KEY = "legs:odds-left";

// The sheet's Bet Type list (tools/add_parlay_validation.py), plus "Other"
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
  const [entries, sheet] = await env.PARLAY_DB.batch([
    env.PARLAY_DB.prepare("SELECT * FROM leg_entries WHERE year = ?1 AND week = ?2").bind(wk.year, wk.week),
    env.PARLAY_DB.prepare(`SELECT player, ${LEG_FIELDS.join(", ")} FROM picks WHERE year = ?1 AND week = ?2 AND bet_type IS NOT NULL AND bet_type != ''`).bind(wk.year, wk.week),
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
  return out;
}
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
  return {
    year: wk.year, week: wk.week, open: win.open, locksAt: win.locksAt, opensAt: win.opensAt,
    days: win.days, players: stats?.players || [], legs: await weekLegs(env, wk, win), me: me ? me.manager : null,
    _wk: wk, _win: win,
  };
}
const publicBoard = ({ _wk, _win, ...rest }) => rest;

async function getLegs(request, env) {
  return { status: 200, body: publicBoard(await board(env, request)) };
}

async function saveLeg(request, env) {
  const who = await sessionManager(request, env);
  if (!who) return { status: 401, body: { error: "signed_out" } };
  const body = await request.json().catch(() => null);
  if (!body) return { status: 400, body: { error: "bad_json" } };
  const b = await board(env, null);
  if (!b.open) return { status: 403, body: { error: "locked", ...publicBoard(b), me: who.manager } };
  if (!b.players.includes(who.manager)) return { status: 403, body: { error: "not_a_player" } };
  const now = Date.now();

  if (body.remove) {
    await env.PARLAY_DB.prepare("UPDATE leg_entries SET removed = 1, updated = ?1 WHERE year = ?2 AND week = ?3 AND player = ?4")
      .bind(now, b.year, b.week, who.manager).run();
  } else {
    const leg = cleanLeg(body.leg);
    if (leg.error) return { status: 400, body: { error: leg.error } };
    const hits = b.legs.filter((l) => l.player !== who.manager).map((l) => [l, clash(leg, l)]);
    const stop = hits.find((h) => h[1] === "same") || hits.find((h) => h[1] === "opposite");
    if (stop) return { status: 409, body: { error: stop[1], by: stop[0].player, pick: pickText(stop[0]), ...publicBoard(b), me: who.manager } };
    await env.PARLAY_DB.prepare(
      `INSERT INTO leg_entries (year, week, player, win, sport, bet_type, team, opponent, player_prop, line, side, odds, gametime, raw_pick, game_id, removed, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16)
       ON CONFLICT(year, week, player) DO UPDATE SET win = excluded.win, sport = excluded.sport, bet_type = excluded.bet_type,
         team = excluded.team, opponent = excluded.opponent, player_prop = excluded.player_prop, line = excluded.line,
         side = excluded.side, odds = excluded.odds, gametime = excluded.gametime, raw_pick = excluded.raw_pick,
         game_id = excluded.game_id, removed = 0, updated = excluded.updated`
    ).bind(b.year, b.week, who.manager, b._win.tue, leg.sport, leg.bet_type, leg.team, leg.opponent, leg.player_prop,
      leg.line, leg.side, leg.odds, leg.gametime, leg.raw_pick, leg.game_id, now).run();
  }
  const synced = await dispatchSync(env, b._wk).catch((err) => { console.error("Leg sync dispatch failed:", err); return false; });
  return { status: 200, body: { ok: true, synced, ...publicBoard({ ...b, legs: await weekLegs(env, b._wk, b._win) }), me: who.manager } };
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
  const key = ODDS_KEYS[sport];
  if (!env.ODDS_API_KEY || !key) return Promise.resolve([]);
  return cached(env, `legs:hr:${sport}:${win.days[0]}`, 4 * 3600, async () => {
    const events = await oddsApi(env, `${ODDS_API}/${key}/odds?bookmakers=${BOOKS.join(",")}&markets=h2h,spreads,totals&oddsFormat=american&${oddsWindow(win)}`);
    return events.map((e) => {
      const book = BOOKS.map((k) => e.bookmakers.find((b) => b.key === k)).find(Boolean);
      return { id: e.id, at: Date.parse(e.commence_time), home: e.home_team, away: e.away_team, markets: book ? book.markets : [] };
    }).filter((e) => e.markets.length);
  }).catch((err) => { console.error("Hard Rock lines:", String(err)); return []; });
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

export const LEG_ROUTES = {
  "/legs": { GET: getLegs, POST: saveLeg },
  "/legs/games": { GET: getGames },
  "/legs/props": { GET: getProps },
};
