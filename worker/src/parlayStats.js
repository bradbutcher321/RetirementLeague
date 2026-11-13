/**
 * The parlay stats payload the site reads (GET /parlay-stats), built from
 * the picks table (PARLAY_DB) -- a line-for-line port of
 * archive/parlay_python/generate_parlay_data.py's load_tracker() / compute_stats() /
 * build_payload() (site audit X #26), checked against the Python's output
 * on every week before the switch. Pure: no I/O, so it runs in Node too.
 *
 * buildPayload(players, rows, now) -> { generated_at, players, weeks, years, stats }
 *   players: the 12 managers in the sheet's order (the old U2:U13 list)
 *   rows: picks rows ({ year, week, player, sacko, sport, bet_type, team,
 *         opponent, player_prop, line, side, odds, gametime, result,
 *         final_odds, final_payout, detail })
 */
const TEAM_LINE_VS = new Set(["Spread", "Alt Spread", "1st Half Spread"]);
const VS_ONLY = new Set(["Money Line"]);
const TOTAL_VS = new Set(["Total Points", "Total Goals", "Total Rounds"]);
const PLAYER_OU = new Set(["Receiving Yards", "Passing TD", "Home Runs", "Player Points", "Interceptions", "Total Yards", "Receptions", "Passing Yards"]);
const PLAYER_ONLY = new Set(["Anytime TD", "Coin Toss"]);
export const SACKO_COST = 20;
const GRADED = new Set(["Win", "Loss"]);

/** Python's round(x, n): the double's exact decimal value rounded to n
 * places, an exact tie to the even digit. (toFixed isn't exact in V8:
 * 2.675 gave 2.68 where Python gives 2.67.) */
export function pyRound(x, n = 0) {
  if (x == null || !Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const neg = x < 0, a = Math.abs(x);
  // Exact digits: toPrecision(100) is exact for a double in V8.
  let str = a.toPrecision(100);
  if (str.includes("e")) {
    const [mant, e] = str.split("e"); const exp = Number(e);
    const digits = mant.replace(".", "");
    str = exp < 0 ? "0." + "0".repeat(-exp - 1) + digits : digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  }
  let [int, frac = ""] = str.split(".");
  frac = frac.padEnd(n + 1, "0");
  const keep = frac.slice(0, n), next = frac[n], rest = frac.slice(n + 1);
  let up = next > "5" || (next === "5" && /[1-9]/.test(rest));
  if (next === "5" && !/[1-9]/.test(rest)) {
    const last = n ? keep[n - 1] : int[int.length - 1];
    up = Number(last) % 2 === 1;
  }
  let scaled = BigInt(int + keep);
  if (up) scaled += 1n;
  const v = Number(scaled) / 10 ** n;
  return neg ? -v : v;
}
const toFloat = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const t = String(v).trim().replace(/[,$+]/g, "");
  const f = Number(t);
  return t === "" || Number.isNaN(f) ? null : f;
};
const s = (v) => (v == null ? "" : String(v).trim());
export const americanToProb = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
const probToAmerican = (p) => (p > 0.5 ? -p / (1 - p) * 100 : 100 / p - 100);

/** generate_parlay_data.reconstruct_pick_text */
export function reconstructPickText(bet, team, opp, prop, line, side) {
  if (!bet) return "";
  const t = (x) => x.trim();
  if (TEAM_LINE_VS.has(bet)) return t(`${bet}: ${team} ${line} vs. ${opp}`);
  if (VS_ONLY.has(bet)) return t(`${bet}: ${team} vs. ${opp}`);
  if (TOTAL_VS.has(bet)) return t(`${bet}: ${side} ${line} ${team} vs. ${opp}`);
  if (PLAYER_OU.has(bet)) return t(`${bet}: ${side} ${line} ${prop}`);
  if (PLAYER_ONLY.has(bet)) return t(`${bet}: ${prop}`);
  return t(`${bet}: ${team}${opp}${prop}`);
}
const capitalize = (x) => (x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x);

/** load_tracker(): the weeks, in the sheet's row order (players order inside a week). */
export function loadWeeks(players, rows) {
  const order = new Map(players.map((p, i) => [p, i]));
  const sorted = rows.slice().sort((a, b) => a.year - b.year || a.week - b.week || (order.get(a.player) ?? 99) - (order.get(b.player) ?? 99));
  const byKey = new Map();
  for (const r of sorted) {
    if (r.year == null || r.week == null || !s(r.player)) continue;
    const key = `${r.year}:${r.week}`;
    if (!byKey.has(key)) {
      const payout = toFloat(r.final_payout);
      byKey.set(key, {
        year: Number(r.year), week: Number(r.week), sacko: s(r.sacko) || null, picks: {},
        final: { odds: toFloat(r.final_odds), payout, split: payout != null && players.length ? pyRound(payout / players.length, 2) : null },
      });
    }
    const bet = s(r.bet_type);
    if (!bet) continue;
    const result = capitalize(s(r.result));
    byKey.get(key).picks[s(r.player)] = {
      pick: reconstructPickText(bet, s(r.team), s(r.opponent), s(r.player_prop), s(r.line), s(r.side)),
      sport: s(r.sport) || null,
      odds: toFloat(r.odds),
      gametime: s(r.gametime) || null,
      result: GRADED.has(result) ? result : "Pending",
      detail: s(r.detail) || null,
    };
  }
  return [...byKey.values()].filter((w) => Object.keys(w.picks).length).sort((a, b) => a.year - b.year || a.week - b.week);
}

export function weekState(week, players) {
  const picks = Object.values(week.picks);
  const graded = picks.filter((p) => GRADED.has(p.result)).length;
  const wins = picks.filter((p) => p.result === "Win").length;
  const losses = graded - wins;
  const complete = picks.length === players.length && graded === players.length;
  return { graded, wins, losses, complete, result: losses ? "Loss" : complete ? "Win" : "Pending" };
}

function killInfo(week) {
  const entries = Object.entries(week.picks);
  const lossTimes = entries.filter(([, p]) => p.result === "Loss" && p.gametime).map(([, p]) => p.gametime);
  const earliest = lossTimes.length ? lossTimes.reduce((a, b) => (b < a ? b : a)) : null;
  const killers = entries.filter(([, p]) => earliest && p.result === "Loss" && p.gametime === earliest).map(([n]) => n);
  const chances = entries.filter(([, p]) => GRADED.has(p.result) && p.gametime && (earliest == null || p.gametime <= earliest)).map(([n]) => n);
  return [killers, chances];
}
function betPositions(week) {
  const times = Object.values(week.picks).filter((p) => p.gametime).map((p) => p.gametime);
  const out = {};
  for (const [n, p] of Object.entries(week.picks)) if (p.gametime) out[n] = 1 + times.filter((t) => t < p.gametime).length;
  return out;
}
function sortedLegs(week, players) {
  const ordered = players.filter((n) => n in week.picks).map((n) => [n, week.picks[n]]);
  return ordered.sort((a, b) => ((a[1].gametime || "9999") < (b[1].gametime || "9999") ? -1 : (a[1].gametime || "9999") > (b[1].gametime || "9999") ? 1 : 0));
}

const winPct = (w, l) => (w + l ? pyRound(w / (w + l) * 100, 1) : null);
function wlRows(counter, keyName) {
  const rows = [...counter.entries()].map(([k, [w, l]]) => ({ [keyName]: k, w, l, win_pct: winPct(w, l) }));
  return rows.sort((a, b) => (a.win_pct == null) - (b.win_pct == null) || -(a.win_pct || 0) - -(b.win_pct || 0));
}
const fixedRows = (counter, keyName) => [...counter.entries()].map(([k, [w, l]]) => ({ [keyName]: k, w, l, win_pct: winPct(w, l) }));
function overUnderSide(pick) {
  const m = pick.toLowerCase().match(/\b(over|under)\b|(?<![a-z])([ou])(?=\d)/);
  if (!m) return null;
  return ["over", "o"].includes(m[1] || m[2]) ? "Over" : "Under";
}
const oddsBucket = (o) => (o <= -250 ? "Heavy Favorite" : o <= -150 ? "Favorite" : o < 125 ? "Toss-Up" : o < 200 ? "Underdog" : "Longshot");
function dayBucket(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // Sun 0
  return { 4: "Thursday", 5: "Friday", 6: "Saturday", 0: "Sunday" }[day] || "Mon-Wed";
}
// Python's sorted(key=...) is stable; so is Array.prototype.sort. cmp builds a comparator from a key tuple.
const cmpKeys = (key) => (a, b) => {
  const x = key(a), y = key(b);
  for (let i = 0; i < x.length; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; }
  return 0;
};

export function computeStats(players, weeks) {
  const overUnder = new Map([["Over", [0, 0]], ["Under", [0, 0]]]);
  const oddsRange = new Map(["Heavy Favorite", "Favorite", "Toss-Up", "Underdog", "Longshot"].map((k) => [k, [0, 0]]));
  const dayOfWeek = new Map(["Thursday", "Friday", "Saturday", "Sunday", "Mon-Wed"].map((k) => [k, [0, 0]]));
  const misses = [], closeCalls = [];
  const leg = new Map(players.map((p) => [p, [0, 0]]));
  const sports = new Map(), betTypes = new Map();
  const oddsType = new Map([["Favorite", [0, 0]], ["Underdog", [0, 0]]]);
  const oddsLists = Object.fromEntries(players.map((p) => [p, []]));
  const kills = Object.fromEntries(players.map((p) => [p, 0])), chances = { ...kills };
  const positions = Object.fromEntries(players.map((p) => [p, []]));
  const winnings = Object.fromEntries(players.map((p) => [p, 0])), lossesAmt = { ...winnings };
  const sackos = { ...kills }, served = { ...kills };
  const biggestHit = {}, safestLoss = {};
  const flat = Object.fromEntries(players.map((p) => [p, { profit: 0, bets: 0 }]));
  const streak = Object.fromEntries(players.map((p) => [p, { current: 0, longest_win: 0, longest_loss: 0 }]));
  const perParlay = new Map(), beforeLoss = new Map();
  for (let n = 0; n <= players.length; n++) { perParlay.set(n, 0); beforeLoss.set(n, 0); }
  const bump = (obj, k, d = 1) => { if (k in obj) obj[k] += d; };

  for (const week of weeks) {
    const payout = week.final.payout || 0;
    if (week.sacko in sackos) {
      sackos[week.sacko]++;
      if (Object.values(week.picks).some((p) => GRADED.has(p.result))) served[week.sacko]++;
    }
    const [killers, chanceNames] = killInfo(week);
    killers.forEach((k) => bump(kills, k));
    chanceNames.forEach((n) => bump(chances, n));
    for (const [n, pos] of Object.entries(betPositions(week))) if (positions[n]) positions[n].push(pos);

    for (const [name, p] of Object.entries(week.picks)) {
      if (p.odds && GRADED.has(p.result) && oddsLists[name]) oddsLists[name].push(p.odds);
      let sport = null, btype = null;
      if (p.sport) { if (!sports.has(p.sport)) sports.set(p.sport, [0, 0]); sport = sports.get(p.sport); }
      if (p.pick.includes(":")) { const k = p.pick.split(":")[0].trim(); if (!betTypes.has(k)) betTypes.set(k, [0, 0]); btype = betTypes.get(k); }
      if (!GRADED.has(p.result)) continue;
      const idx = p.result === "Win" ? 0 : 1;
      if (leg.has(name)) leg.get(name)[idx]++;
      if (idx === 0 && p.odds && (!(name in biggestHit) || americanToProb(p.odds) < americanToProb(biggestHit[name].odds))) {
        biggestHit[name] = { player: name, odds: p.odds, pick: p.pick, sport: p.sport, year: week.year, week: week.week };
      }
      if (p.odds && flat[name]) {
        flat[name].bets++;
        flat[name].profit += idx === 0 ? (p.odds > 0 ? p.odds : 10000 / -p.odds) : -100;
        if (idx === 1 && (!(name in safestLoss) || americanToProb(p.odds) > americanToProb(safestLoss[name].odds))) {
          safestLoss[name] = { player: name, odds: p.odds, pick: p.pick, sport: p.sport, year: week.year, week: week.week };
        }
      }
      const run = streak[name];
      if (run) {
        if (idx === 0) { run.current = run.current > 0 ? run.current + 1 : 1; run.longest_win = Math.max(run.longest_win, run.current); }
        else { run.current = run.current < 0 ? run.current - 1 : -1; run.longest_loss = Math.max(run.longest_loss, -run.current); }
      }
      if (sport) sport[idx]++;
      if (btype) btype[idx]++;
      if (p.odds) { oddsType.get(p.odds < 0 ? "Favorite" : "Underdog")[idx]++; oddsRange.get(oddsBucket(p.odds))[idx]++; }
      const side = overUnderSide(p.pick);
      if (side) overUnder.get(side)[idx]++;
      if (p.gametime) dayOfWeek.get(dayBucket(p.gametime))[idx]++;
      if (idx === 0) bump(winnings, name, payout); else bump(lossesAmt, name, payout);
    }

    const st = weekState(week, players);
    week.killed_by = killers;
    const entry = { year: week.year, week: week.week, payout, legs_hit: st.wins, killed_by: killers };
    if (st.losses) misses.push(entry);
    if (st.complete && st.losses) closeCalls.push({ ...entry, lost_by: Object.entries(week.picks).filter(([, p]) => p.result === "Loss").map(([n]) => n) });
    if (st.complete) {
      perParlay.set(st.wins, (perParlay.get(st.wins) || 0) + 1);
      let before = 0;
      for (const [, p] of sortedLegs(week, players)) { if (p.result === "Loss") break; before++; }
      beforeLoss.set(before, (beforeLoss.get(before) || 0) + 1);
    }
  }

  const byDesc = (rows, key) => rows.slice().sort(cmpKeys((r) => [-pyRound(r[key], 6)]));
  const avgOdds = [];
  for (const name of players) {
    if (!oddsLists[name].length) continue;
    const probs = oddsLists[name].map(americanToProb);
    avgOdds.push({ player: name, avg_odds: pyRound(probToAmerican(probs.reduce((a, b) => a + b, 0) / probs.length)) });
  }
  const avgBy = Object.fromEntries(avgOdds.map((a) => [a.player, a.avg_odds]));

  return {
    table_sackos: Object.fromEntries(players.map((n) => [n, served[n]])),
    weekly_sackos: byDesc(players.map((n) => ({ player: n, sackos: sackos[n], cost: sackos[n] * SACKO_COST })), "sackos"),
    individual_wl: [...leg.entries()].map(([n, [w, l]]) => ({ player: n, w, l, win_pct: w + l ? pyRound(w / (w + l) * 100, 1) : 0 }))
      .sort(cmpKeys((r) => [-r.win_pct, -(avgBy[r.player] ?? -(10 ** 9))])),
    average_odds: byDesc(avgOdds, "avg_odds"),
    parlays_killed: byDesc(players.map((n) => ({
      player: n, kills: kills[n], kill_chances: chances[n],
      avg_bet_position: positions[n].length ? pyRound(positions[n].reduce((a, b) => a + b, 0) / positions[n].length, 2) : null,
    })), "kills"),
    potential_earnings: byDesc(players.map((n) => ({ player: n, winnings: pyRound(winnings[n], 2), losses: pyRound(lossesAmt[n], 2) })), "winnings"),
    streaks: players.map((n) => ({ player: n, ...streak[n] })).sort(cmpKeys((r) => [-r.longest_win, -r.current])),
    biggest_hits: Object.values(biggestHit).sort(cmpKeys((r) => [americanToProb(r.odds)])),
    safest_losses: Object.values(safestLoss).sort(cmpKeys((r) => [-americanToProb(r.odds)])),
    flat_bet_profit: Object.entries(flat).map(([n, f]) => ({ player: n, profit: pyRound(f.profit, 2), bets: f.bets })).sort(cmpKeys((r) => [-r.profit])),
    sport_wl: wlRows(sports, "sport"),
    bet_type_wl: wlRows(betTypes, "bet_type"),
    odds_type_wl: wlRows(oddsType, "odds_type"),
    over_under_wl: wlRows(overUnder, "side"),
    odds_range_wl: fixedRows(oddsRange, "range"),
    day_of_week_wl: fixedRows(dayOfWeek, "day"),
    biggest_misses: misses.slice().sort(cmpKeys((r) => [-r.payout])).slice(0, 3),
    closest_calls: closeCalls.slice().sort(cmpKeys((r) => [-r.legs_hit, -r.payout])).slice(0, 3),
    legs_won_per_parlay: [...perParlay.entries()].map(([legs, occurrences]) => ({ legs, occurrences })),
    legs_won_before_loss: [...beforeLoss.entries()].map(([legs, occurrences]) => ({ legs, occurrences })),
  };
}

export function buildPayload(players, rows, now = new Date()) {
  const weeks = loadWeeks(players, rows);
  for (const w of weeks) w.final.result = weekState(w, players).result;
  const years = [...new Set(weeks.map((w) => w.year))].sort((a, b) => a - b);
  const stats = { all: computeStats(players, weeks) };
  for (const y of years) stats[String(y)] = computeStats(players, weeks.filter((w) => w.year === y));
  return { generated_at: now.toISOString().replace("Z", "+00:00"), players, weeks, years, stats };
}
