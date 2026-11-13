/**
 * The parlay, run by the Worker (site audit X #26). The picks table in
 * PARLAY_DB is the record now, not the "Auto Parlay Tracker" sheet:
 *
 *   a leg saved on Parlay Legs   -> syncLegs(): straight into picks
 *   a commissioner's week / bet  -> saveWeek(): straight into picks
 *   every few minutes on a game  -> tick(): grades finished legs from ESPN
 *                                   (parlayGrade.js), keeps live scores
 *   any change                   -> publish(): the stats blob in KV
 *                                   (parlayStats.js), what /parlay-stats,
 *                                   push.js and Parlay Legs read
 *
 * Before this, every one of those went through a GitHub Action that wrote
 * the sheet, graded in Python, published and copied the sheet back here:
 * about 40 seconds a save, 22 minutes once. The sheet is now a copy,
 * refreshed nightly by copy_parlay_to_sheet.yml (parlay_to_sheet.py) for
 * anyone who still reads it. An edit made in the sheet doesn't come back.
 *
 * Live scores live in the parlay_live table, not KV (KV allows 1,000 writes
 * a day and a Sunday changes the score every minute); /parlay-stats adds
 * them to the blob when it's read (withLive).
 *
 * Tables (worker/migrations/parlay_011_engine.sql): picks gains detail,
 * game_id, review and checked; parlay_meta holds the managers' order;
 * parlay_live holds each pending leg's live state.
 */
import { buildPayload } from "./parlayStats.js";
import { GRADABLE, gradeLeg, liveLeg } from "./parlayGrade.js";
import { newCtx } from "./parlayEspn.js";

const KV_KEY = "parlay_stats_v1";
const PICK_FIELDS = ["sport", "bet_type", "team", "opponent", "player_prop", "line", "side", "odds", "gametime", "raw_pick"];
const GAMETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const RESULTS = new Set(["", "Pending", "Win", "Loss"]);
// Live scores from half an hour before kickoff to eight hours after.
const LEAD_MIN = 30, TAIL_H = 8;
// A leg that can't be graded is tried again every 30 minutes for a week, then left for a commissioner.
const RETRY_MS = 30 * 60 * 1000, GIVE_UP_MS = 7 * 24 * 3600 * 1000;
// Lookups one run may make: a Sunday's legs are on about eight games.
const FETCH_BUDGET = 40;

/** Now in naive US Eastern ("2026-11-15T13:05:00"), the picks' own format. */
export function easternNow(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
const naiveMs = (iso) => Date.parse(String(iso).slice(0, 19) + "Z");

// ---------- Reading ----------
export async function players(env) {
  const row = await env.PARLAY_DB.prepare("SELECT v FROM parlay_meta WHERE k = 'players'").first().catch(() => null);
  if (row) return JSON.parse(row.v);
  const blob = await env.COOLDOWN_KV.get(KV_KEY, "json").catch(() => null);
  return (blob && blob.players) || [];
}
const allPicks = (env) => env.PARLAY_DB.prepare("SELECT * FROM picks").all().then((r) => r.results);

/** Rebuilds the stats blob from picks; writes KV only when something but the time changed (or force). */
export async function publish(env, { force = false } = {}) {
  const [names, rows, old] = await Promise.all([players(env), allPicks(env), env.COOLDOWN_KV.get(KV_KEY, "json").catch(() => null)]);
  const payload = buildPayload(names, rows);
  payload.live = {};
  const strip = (d) => JSON.stringify({ ...d, generated_at: 0 });
  if (!force && old && strip(old) === strip(payload)) return { changed: false, payload: old };
  await env.COOLDOWN_KV.put(KV_KEY, JSON.stringify(payload));
  return { changed: true, payload };
}

/** /parlay-stats: the blob plus the live scores and each pending prop's game. */
export async function withLive(env, blob) {
  if (!blob) return blob;
  const { results } = await env.PARLAY_DB.prepare("SELECT k, v FROM parlay_live").all().catch(() => ({ results: [] }));
  const live = {};
  const matchups = {};
  for (const r of results) {
    const x = JSON.parse(r.v);
    if (x.live) live[r.k] = x.live;
    if (x.matchup) matchups[r.k] = x.matchup;
  }
  for (const w of blob.weeks || []) for (const [p, pick] of Object.entries(w.picks || {})) {
    const m = matchups[`${w.year}:${w.week}:${p}`];
    if (m && pick.result === "Pending") pick.matchup = m;
  }
  blob.live = live;
  return blob;
}

// ---------- The scheduled run ----------
/** Grades every leg whose game has finished, refreshes live scores on the
 * ones being played, backfills Grade Detail for a hand-entered result, and
 * republishes if anything changed. `force` ignores the retry wait. */
export async function tick(env, { nowMs = Date.now(), force = false } = {}) {
  const now = easternNow(nowMs), nowN = naiveMs(now);
  const rows = (await allPicks(env)).filter((r) => r.bet_type && r.gametime);
  const ctx = newCtx();
  const writes = [], liveRows = new Map(), report = { graded: [], review: [], live: 0, details: 0 };
  const due = (r) => force || !r.checked || nowMs - r.checked >= RETRY_MS;
  // A hand result's score: tried every 30 minutes for a week after the game, an older one once.
  const backfillDue = (r) => !r.checked || (force || nowMs - r.checked >= RETRY_MS) && nowN - naiveMs(r.gametime) < GIVE_UP_MS;

  // Finished games first, oldest first: grade them.
  const pending = rows.filter((r) => r.result !== "Win" && r.result !== "Loss").sort((a, b) => (a.gametime < b.gametime ? -1 : 1));
  for (const r of pending) {
    if (r.gametime > now) continue;
    const age = nowN - naiveMs(r.gametime);
    if (age > GIVE_UP_MS && !force) continue;
    if (ctx.fetches >= FETCH_BUDGET) break;
    // Back off on one that needed a human last time; a game just ending is checked every run.
    if (r.review && !due(r)) continue;
    const res = GRADABLE.has(r.bet_type) || r.review == null ? await gradeLeg(ctx, r) : { outcome: null, why: r.review };
    if (res.outcome) {
      writes.push(env.PARLAY_DB.prepare(
        "UPDATE picks SET result = ?1, detail = ?2, review = NULL, checked = ?3 WHERE year = ?4 AND week = ?5 AND player = ?6 AND (result IS NULL OR result NOT IN ('Win', 'Loss'))"
      ).bind(res.outcome, res.detail, nowMs, r.year, r.week, r.player));
      report.graded.push(`${r.year}:${r.week}:${r.player} ${res.outcome} [${res.detail}]`);
    } else {
      // Not final yet is quiet; anything else says why, for the Commissioner page.
      const quiet = /not final yet|not found in the box score/.test(res.why) && age < 6 * 3600 * 1000;
      writes.push(env.PARLAY_DB.prepare("UPDATE picks SET review = ?1, checked = ?2 WHERE year = ?3 AND week = ?4 AND player = ?5")
        .bind(quiet ? null : res.why, nowMs, r.year, r.week, r.player));
      if (!quiet) report.review.push(`${r.year}:${r.week}:${r.player}: ${res.why}`);
    }
  }

  // Games on now (or about to be): live scores, and which game a prop is on.
  for (const r of pending) {
    if (ctx.fetches >= FETCH_BUDGET) break;
    const mins = (nowN - naiveMs(r.gametime)) / 60000;
    if (mins < -LEAD_MIN || mins > TAIL_H * 60) continue;
    if (report.graded.some((x) => x.startsWith(`${r.year}:${r.week}:${r.player} `))) continue;
    const { live, matchup } = await liveLeg(ctx, r);
    if (live || matchup) { liveRows.set(`${r.year}:${r.week}:${r.player}`, { live, matchup }); if (live) report.live++; }
  }

  // A result typed in by hand (or graded before Grade Detail): fill in its detail.
  for (const r of rows) {
    if (ctx.fetches >= FETCH_BUDGET - 4) break;
    if ((r.result !== "Win" && r.result !== "Loss") || r.detail || !GRADABLE.has(r.bet_type) || !backfillDue(r)) continue;
    const res = await gradeLeg(ctx, r);
    writes.push(env.PARLAY_DB.prepare("UPDATE picks SET detail = ?1, checked = ?2 WHERE year = ?3 AND week = ?4 AND player = ?5 AND (detail IS NULL OR detail = '')")
      .bind(res.detail || null, nowMs, r.year, r.week, r.player));
    if (res.detail) report.details++;
  }

  // Live rows: the ones still pending and in their window replace the table.
  const keep = new Set(pending.filter((r) => { const m = (nowN - naiveMs(r.gametime)) / 60000; return m >= -LEAD_MIN && m <= TAIL_H * 60; }).map((r) => `${r.year}:${r.week}:${r.player}`));
  writes.push(env.PARLAY_DB.prepare(`DELETE FROM parlay_live WHERE k NOT IN (${[...keep].map(() => "?").join(",") || "''"})`).bind(...keep));
  for (const [k, v] of liveRows) {
    if (!keep.has(k)) continue;
    writes.push(env.PARLAY_DB.prepare("INSERT INTO parlay_live (k, v, at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at").bind(k, JSON.stringify(v), nowMs));
  }
  if (writes.length) await env.PARLAY_DB.batch(writes);
  const pub = report.graded.length || report.details ? await publish(env) : { changed: false };
  return { ...report, fetches: ctx.fetches, published: pub.changed };
}

/** Whether the cron should run tick() now: a pending leg's game is within
 * its live window or finished but ungraded, or a hand result lacks detail. */
export async function tickDue(env, nowMs = Date.now()) {
  const now = easternNow(nowMs), nowN = naiveMs(now);
  const { results } = await env.PARLAY_DB.prepare(
    "SELECT gametime, result, review, checked, detail, bet_type FROM picks WHERE bet_type IS NOT NULL AND bet_type != '' AND gametime IS NOT NULL AND gametime != ''"
  ).all();
  for (const r of results) {
    const graded = r.result === "Win" || r.result === "Loss";
    const mins = (nowN - naiveMs(r.gametime)) / 60000;
    if (!graded && mins >= -LEAD_MIN && mins <= TAIL_H * 60) return "a game is on";
    if (!graded && mins > 0 && nowMs - (r.checked || 0) >= RETRY_MS && mins * 60000 < GIVE_UP_MS) return "a finished leg to grade";
    if (graded && !r.detail && GRADABLE.has(r.bet_type) && (!r.checked || nowMs - r.checked >= RETRY_MS && mins * 60000 < GIVE_UP_MS)) return "a result without its score";
  }
  return null;
}

// ---------- Writes from the site ----------
const meta = async (env, year, week) =>
  env.PARLAY_DB.prepare("SELECT sacko, final_odds, final_payout FROM picks WHERE year = ?1 AND week = ?2 LIMIT 1").bind(year, week).first();
function upsert(env, year, week, player, m, row, extra = {}) {
  const v = { ...Object.fromEntries(PICK_FIELDS.map((f) => [f, row[f] ?? null])), result: row.result ?? null, detail: null, game_id: row.game_id || null, review: null, checked: null, ...extra };
  return env.PARLAY_DB.prepare(
    `INSERT INTO picks (year, week, player, sacko, sport, bet_type, team, opponent, player_prop, line, side, odds, gametime, result, raw_pick, final_odds, final_payout, detail, game_id, review, checked)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
     ON CONFLICT(year, week, player) DO UPDATE SET sport = excluded.sport, bet_type = excluded.bet_type, team = excluded.team,
       opponent = excluded.opponent, player_prop = excluded.player_prop, line = excluded.line, side = excluded.side, odds = excluded.odds,
       gametime = excluded.gametime, result = excluded.result, raw_pick = excluded.raw_pick, detail = excluded.detail,
       game_id = excluded.game_id, review = excluded.review, checked = excluded.checked`
  ).bind(year, week, player, (m && m.sacko) || null, v.sport || null, v.bet_type || null, v.team || null, v.opponent || null, v.player_prop || null,
    v.line || null, v.side || null, v.odds === "" || v.odds == null ? null : Number(v.odds), v.gametime || null, v.result || null, v.raw_pick || null,
    m ? m.final_odds : null, m ? m.final_payout : null, v.detail, v.game_id, v.review, v.checked);
}

/** Parlay Legs: a leg entered, changed or taken back goes into picks at
 * once (archive/parlay_python/enter_parlay.py's mode "legs"). Only a row whose Raw Pick differs
 * is written (as Pending), so a commissioner's fix that kept the Raw Pick
 * stays; a removed leg's row is cleared only if it still holds that leg. */
export async function syncLegs(env, wk) {
  const [entries, have, m, names] = await Promise.all([
    env.PARLAY_DB.prepare("SELECT * FROM leg_entries WHERE year = ?1 AND week = ?2").bind(wk.year, wk.week).all().then((r) => r.results),
    env.PARLAY_DB.prepare("SELECT player, raw_pick, game_id FROM picks WHERE year = ?1 AND week = ?2").bind(wk.year, wk.week).all().then((r) => r.results),
    meta(env, wk.year, wk.week),
    players(env),
  ]);
  const old = Object.fromEntries(have.map((r) => [r.player, r]));
  const stmts = [];
  for (const e of entries) {
    const cur = old[e.player];
    if (e.removed) {
      if (cur && cur.raw_pick && cur.raw_pick === e.raw_pick) stmts.push(upsert(env, wk.year, wk.week, e.player, m, {}));
      continue;
    }
    if (cur && (cur.raw_pick || "") === e.raw_pick) {
      // Same leg: only learn its game id if the row lacks one.
      if (e.game_id && !cur.game_id) stmts.push(env.PARLAY_DB.prepare("UPDATE picks SET game_id = ?1 WHERE year = ?2 AND week = ?3 AND player = ?4").bind(e.game_id, wk.year, wk.week, e.player));
      continue;
    }
    stmts.push(upsert(env, wk.year, wk.week, e.player, m, { ...e, result: "Pending" }));
  }
  // A week has a row for every manager, as the sheet's 12-row block did.
  const legged = new Set(entries.filter((e) => !e.removed).map((e) => e.player));
  if (stmts.length) for (const p of names) if (!old[p] && !legged.has(p)) stmts.push(upsert(env, wk.year, wk.week, p, m, {}));
  if (stmts.length) await env.PARLAY_DB.batch(stmts);
  await publish(env, { force: stmts.length > 0 });
  return stmts.length;
}

/** A commissioner's week (enter_parlay.py): mode "new" replaces the week
 * keeping a Result where the Raw Pick didn't change, "edit" saves each
 * row's Result as sent, "meta" only the Sacko and the final odds and
 * payout. Returns { status, body } like the routes. */
export async function saveWeek(env, picks) {
  const year = Number(picks.year), week = Number(picks.week);
  if (!year || !week) return { status: 400, body: { error: "missing_week" } };
  const names = await players(env);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const existing = (await env.PARLAY_DB.prepare("SELECT * FROM picks WHERE year = ?1 AND week = ?2").bind(year, week).all()).results;
  const byPlayer = Object.fromEntries(existing.map((r) => [r.player, r]));

  if (picks.mode === "meta") {
    const sacko = String(picks.sacko || "").trim();
    if (sacko && !names.includes(sacko)) return { status: 400, body: { error: "bad_sacko", detail: `${sacko} isn't a player` } };
    if (!existing.length) return { status: 404, body: { error: "no_week", detail: `${year} Week ${week} has no picks yet` } };
    const m = { sacko: sacko || null, final_odds: num(picks.final_odds), final_payout: num(picks.final_payout) };
    if (picks.dry_run) return { status: 200, body: { ok: true, dry_run: true, would: m } };
    await env.PARLAY_DB.prepare("UPDATE picks SET sacko = ?1, final_odds = ?2, final_payout = ?3 WHERE year = ?4 AND week = ?5")
      .bind(m.sacko, m.final_odds, m.final_payout, year, week).run();
    await publish(env, { force: true });
    return { status: 200, body: { ok: true } };
  }

  const edit = picks.mode === "edit";
  const rows = picks.rows || {};
  const unknown = Object.keys(rows).filter((p) => !names.includes(p));
  if (unknown.length) return { status: 400, body: { error: "bad_player", detail: `Not players: ${unknown.join(", ")}` } };
  if (edit && !existing.length) return { status: 404, body: { error: "no_week", detail: `${year} Week ${week} isn't saved, so there's nothing to edit` } };
  const clean = {};
  for (const [p, r] of Object.entries(rows)) {
    const c = Object.fromEntries(PICK_FIELDS.filter((f) => f !== "odds").map((f) => [f, String(r[f] ?? "").trim().slice(0, 200)]));
    if (c.gametime && !GAMETIME_RE.test(c.gametime)) return { status: 400, body: { error: "bad_gametime", detail: `${p}: game time ${c.gametime} isn't YYYY-MM-DDTHH:MM:SS` } };
    c.odds = typeof r.odds === "number" && Number.isFinite(r.odds) ? r.odds : null;
    let result = "Pending";
    if (edit) {
      result = String(r.result || "").trim();
      if (!RESULTS.has(result)) return { status: 400, body: { error: "bad_result", detail: `${p}: ${result} isn't Pending, Win or Loss` } };
      if (!c.bet_type) result = "";
    }
    const was = byPlayer[p];
    // mode new: the same pick keeps its graded Result (and its detail and game).
    if (!edit && was && was.raw_pick && was.raw_pick === c.raw_pick && was.result) result = was.result;
    c.result = c.bet_type ? result : null;
    clean[p] = c;
  }
  if (!Object.keys(clean).length) return { status: 400, body: { error: "no_picks" } };
  const m = { sacko: String(picks.sacko || "").trim() || null, final_odds: num(picks.final_odds), final_payout: num(picks.final_payout) };
  if (picks.dry_run) return { status: 200, body: { ok: true, dry_run: true, would: { ...m, rows: clean } } };
  const stmts = names.map((p) => {
    const c = clean[p];
    const was = byPlayer[p];
    if (!c) return upsert(env, year, week, p, m, {});
    const same = was && was.raw_pick === c.raw_pick && (was.result || "") === (c.result || "");
    // A row that didn't change keeps its detail, game and review notes.
    return upsert(env, year, week, p, m, c, same ? { detail: was.detail, game_id: was.game_id, review: was.review, checked: was.checked } : { game_id: was && was.raw_pick === c.raw_pick ? was.game_id : null });
  });
  stmts.push(env.PARLAY_DB.prepare("UPDATE picks SET sacko = ?1, final_odds = ?2, final_payout = ?3 WHERE year = ?4 AND week = ?5").bind(m.sacko, m.final_odds, m.final_payout, year, week));
  await env.PARLAY_DB.batch(stmts);
  await publish(env, { force: true });
  return { status: 200, body: { ok: true } };
}

/** For the Commissioner page: legs that need a human, and the last run. */
export async function reviewList(env) {
  const { results } = await env.PARLAY_DB.prepare("SELECT year, week, player, bet_type, raw_pick, review, checked FROM picks WHERE review IS NOT NULL AND review != '' AND (result IS NULL OR result NOT IN ('Win', 'Loss')) ORDER BY year DESC, week DESC").all();
  return results;
}
