/**
 * POST /parlay-entry -- a commissioner's whole-week save from Parlay Legs
 * (it was the Enter Picks page, site audit II #11). The page parses the
 * note and finds every game on ESPN itself; this checks who is asking (a
 * signed-in commissioner, or the PIN) and saves the week straight into the
 * picks table (parlayData.js saveWeek, audit X #26).
 *
 * Body: { pin, picks: {year, week, sacko, final_odds, final_payout,
 * dry_run, mode, rows} } (see parlayData.js saveWeek for the rows' fields;
 * mode "edit" saves each row's Result as sent).
 *
 * GET /parlay-week?year=&week= -- one week's rows from the picks table,
 * for the Edit Week view.
 *
 * Requires:
 *   - Secret:  PARLAY_PIN  (wrangler secret put PARLAY_PIN)
 *   - KV namespace COOLDOWN_KV, for the wrong-PIN lockout
 */
import { saveWeek } from "./parlayData.js";

// Ten wrong PINs locks the route for an hour, so a short PIN can't be
// guessed by trying them all.
const FAIL_KEY = "parlay-entry:fails";
const MAX_FAILS = 10;
const LOCK_SECONDS = 3600;
// A week is about 4,000 characters; anything near this is a mistake.
const MAX_PICKS_CHARS = 60000;

function samePin(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/** null when `pin` is the commissioner's PIN, otherwise the response to
 * send back. Shared with the Commissioner page (auth.js), so both count
 * toward the one lockout. */
export async function checkPin(env, pin) {
  if (!env.PARLAY_PIN) return { status: 503, body: { error: "not_configured" } };
  const fails = Number(await env.COOLDOWN_KV.get(FAIL_KEY)) || 0;
  if (fails >= MAX_FAILS) return { status: 429, body: { error: "locked" } };
  if (!samePin(pin || "", env.PARLAY_PIN)) {
    await env.COOLDOWN_KV.put(FAIL_KEY, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    return { status: 403, body: { error: "wrong_pin", triesLeft: MAX_FAILS - fails - 1 } };
  }
  return null;
}

/** opts.commissioner: index.js saw a signed-in commissioner, so no PIN.
 * opts.guard(picks) may adjust the rows before they are sent; opts.after(picks)
 * runs once the week is saved (both from legs.js, which owns the
 * board's copy of the week). */
export async function enterParlay(request, env, opts = {}) {
  const commissioner = !!opts.commissioner;
  if (!commissioner && !env.PARLAY_PIN) return { status: 503, body: { error: "not_configured" } };
  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }

  // A signed-in commissioner (index.js checked) needs no PIN.
  if (!commissioner) {
    const denied = await checkPin(env, body.pin);
    if (denied) return denied;
  }

  let picks = body.picks;
  if (!picks || !picks.rows || !Number(picks.year) || !Number(picks.week)) {
    return { status: 400, body: { error: "missing_week" } };
  }
  if (opts.guard) picks = await opts.guard(picks).catch((err) => { console.error("Save guard failed:", err); return picks; });
  if (JSON.stringify(picks).length > MAX_PICKS_CHARS) return { status: 413, body: { error: "too_big" } };
  // Straight into the picks table (audit X #26); this used to dispatch
  // enter_parlay.yml, which wrote the sheet a minute or two later.
  const out = await saveWeek(env, picks);
  if (out.status < 300 && !picks.dry_run && opts.after) await opts.after(picks).catch((err) => console.error("Save mirror failed:", err));
  return out;
}

export async function getParlayWeek(env, url) {
  const year = Number(url.searchParams.get("year")), week = Number(url.searchParams.get("week"));
  if (!year || !week) return { status: 400, body: { error: "missing_week" } };
  const { results } = await env.PARLAY_DB.prepare(
    `SELECT player, sacko, sport, bet_type, team, opponent, player_prop, line, side, odds, gametime,
            result, raw_pick, final_odds, final_payout
       FROM picks WHERE year = ?1 AND week = ?2`
  ).bind(year, week).all();
  if (!results.length) return { status: 404, body: { error: "no_week" } };
  const first = results[0];
  return {
    status: 200,
    body: {
      year, week, sacko: first.sacko || "", final_odds: first.final_odds, final_payout: first.final_payout,
      rows: Object.fromEntries(results.map(({ player, sacko, final_odds, final_payout, ...row }) => [player, row])),
    },
  };
}
