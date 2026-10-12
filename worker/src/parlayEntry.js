/**
 * POST /parlay-entry -- the site's Enter Picks page (site audit II #11).
 * The page parses the note and finds every game on ESPN itself; this only
 * checks the PIN and hands the finished week to enter_parlay.yml, which
 * writes it to Auto Parlay Tracker and then grades, publishes and syncs.
 *
 * Body: { pin, picks: {year, week, sacko, final_odds, final_payout,
 * dry_run, mode, rows} } (see enter_parlay.py for the rows' fields;
 * mode "edit" saves each row's Result as sent).
 *
 * GET /parlay-week?year=&week= -- one week's rows as the sheet has them,
 * from the D1 mirror sync_parlay_to_d1.py keeps, for the Edit Week view.
 *
 * Requires:
 *   - Secret:  PARLAY_PIN  (wrangler secret put PARLAY_PIN)
 *   - Secret:  GITHUB_PAT  (the same one /refresh-parlay dispatches with)
 *   - KV namespace COOLDOWN_KV, for the wrong-PIN lockout and the cooldown
 */
const REPO = "bradbutcher321/RetirementLeague";
const WORKFLOW_FILE = "enter_parlay.yml";
const COOLDOWN_SECONDS = 60;
const COOLDOWN_KEY = "parlay-entry:last";
// Ten wrong PINs locks the route for an hour, so a short PIN can't be
// guessed by trying them all.
const FAIL_KEY = "parlay-entry:fails";
const MAX_FAILS = 10;
const LOCK_SECONDS = 3600;
// A workflow_dispatch input holds 65,535 characters; a week is about 4,000.
const MAX_PICKS_CHARS = 60000;

function samePin(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function enterParlay(request, env) {
  if (!env.PARLAY_PIN) return { status: 503, body: { error: "not_configured" } };
  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }

  const fails = Number(await env.COOLDOWN_KV.get(FAIL_KEY)) || 0;
  if (fails >= MAX_FAILS) return { status: 429, body: { error: "locked" } };
  if (!samePin(body.pin || "", env.PARLAY_PIN)) {
    await env.COOLDOWN_KV.put(FAIL_KEY, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    return { status: 403, body: { error: "wrong_pin", triesLeft: MAX_FAILS - fails - 1 } };
  }

  const picks = body.picks;
  if (!picks || !picks.rows || !Number(picks.year) || !Number(picks.week)) {
    return { status: 400, body: { error: "missing_week" } };
  }
  const json = JSON.stringify(picks);
  if (json.length > MAX_PICKS_CHARS) return { status: 413, body: { error: "too_big" } };

  const now = Date.now();
  const last = Number(await env.COOLDOWN_KV.get(COOLDOWN_KEY)) || 0;
  const remaining = COOLDOWN_SECONDS - Math.floor((now - last) / 1000);
  if (remaining > 0) return { status: 429, body: { error: "cooldown", retryAfterSeconds: remaining } };

  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_PAT}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "retirement-league-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { picks: json } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { status: 502, body: { error: "github_dispatch_failed", detail: detail.slice(0, 300) } };
  }
  await env.COOLDOWN_KV.put(COOLDOWN_KEY, String(now), { expirationTtl: COOLDOWN_SECONDS + 10 });
  return { status: 202, body: { ok: true } };
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
