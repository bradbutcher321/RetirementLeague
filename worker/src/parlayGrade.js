/**
 * Grading a parlay leg, and its live state -- ports of
 * archive/parlay_python's auto_grade_results.py and publish_parlay_stats.py's build_live_scores
 * (site audit X #26), on the lookups in parlayEspn.js.
 *
 * gradeLeg(ctx, pick) -> { outcome: 'Win'|'Loss'|null, detail, why }
 *   outcome null with `why` = needs a human (a push, Coin Toss, a player
 *   not on the box score...), or not final yet. Same rules as the Python:
 *   a Money Line tie is a Loss, landing exactly on a line is a push (left
 *   for a human), an Anytime TD "2x Name" needs two.
 * liveLeg(ctx, pick) -> { live, matchup } for the Parlay Results page.
 *
 * pick: a picks row ({ sport, bet_type, team, opponent, player_prop, line,
 * side, gametime, game_id }).
 */
import { INDIVIDUAL_SPORTS, abbrevOf, eventById, findEvent, findIndividual, gameState, halfScores, locateProp, toNum } from "./parlayEspn.js";

const TEAM_LINE_VS = new Set(["Spread", "Alt Spread", "1st Half Spread"]);
const VS_ONLY = new Set(["Money Line"]);
const TOTAL_VS = new Set(["Total Points", "Total Goals", "Total Rounds"]);
const PLAYER_OU = new Set(["Receiving Yards", "Passing TD", "Home Runs", "Player Points", "Interceptions", "Total Yards", "Receptions", "Passing Yards"]);
const SCORE_BET_TYPES = new Set([...[...TEAM_LINE_VS].filter((b) => b !== "1st Half Spread"), ...VS_ONLY, ...TOTAL_VS]);
const HALF_SCORE_BET_TYPES = new Set(["1st Half Spread"]);
const PROP_BINARY = new Set(["Anytime TD"]);
export const PROP_BET_TYPES = new Set([...PLAYER_OU, ...PROP_BINARY]);
export const GRADABLE = new Set([...SCORE_BET_TYPES, ...HALF_SCORE_BET_TYPES, ...PROP_BET_TYPES]);
const MULTI = /^(\d+)x\s+(.+)$/i;

/** parlay_note_parser.parse_signed_number */
export function parseSigned(text) {
  const t = String(text ?? "").trim().replace(/[, ]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** Python's "{:g}" for a score or stat. */
export const g = (x) => {
  if (x == null) return "";
  const v = Number(x);
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(6)));
};

export function gradeOverUnder(value, line, side) {
  const l = parseSigned(line);
  if (l == null || (side !== "Over" && side !== "Under")) return null;
  if (value === l) return null;
  const above = value > l;
  return (side === "Over" ? above : !above) ? "Win" : "Loss";
}
export function gradePick(bet, teamScore, oppScore, line, side) {
  if (VS_ONLY.has(bet)) return teamScore > oppScore ? "Win" : "Loss";
  if (TEAM_LINE_VS.has(bet)) {
    const l = parseSigned(line);
    if (l == null) return null;
    const covered = teamScore - oppScore + l;
    if (covered === 0) return null;
    return covered > 0 ? "Win" : "Loss";
  }
  if (TOTAL_VS.has(bet)) return gradeOverUnder(teamScore + oppScore, line, side);
  return null;
}
function gradeIndividual(bet, aWon, rounds, line, side) {
  if (VS_ONLY.has(bet)) return aWon ? "Win" : "Loss";
  if (TOTAL_VS.has(bet)) return rounds == null ? null : gradeOverUnder(rounds, line, side);
  return null;
}
const propTarget = (prop) => { const m = String(prop).match(MULTI); return m ? [Number(m[1]), m[2]] : [1, prop]; };
const tone = (outcome) => (outcome === "Win" ? "up" : outcome === "Loss" ? "down" : null);

/** The game a team leg is on: its id first (Parlay Legs saved it), else the Python's search. */
async function teamGame(ctx, p) {
  if (p.game_id) {
    const hit = await eventById(ctx, p.sport, p.game_id, p.team, p.opponent);
    if (hit) return { comp: hit[0], teamC: hit[1], oppC: hit[2] };
  }
  const ev = await findEvent(ctx, p.team, p.opponent, p.sport, p.gametime);
  return ev ? { comp: ev[0].competitions[0], teamC: ev[1], oppC: ev[2] } : null;
}

export async function gradeLeg(ctx, p) {
  const bet = p.bet_type;
  if (!GRADABLE.has(bet)) return { outcome: null, why: `'${bet}' isn't auto-gradable (ESPN doesn't report a Coin Toss)` };
  if (PROP_BET_TYPES.has(bet)) {
    if (!p.player_prop) return { outcome: null, why: "missing Player Prop" };
    const [need, name] = propTarget(p.player_prop);
    const loc = await locateProp(ctx, name, bet, p.sport, p.gametime, true, p.game_id);
    if (!loc || !loc.found) return { outcome: null, why: `'${name}' not found in the box score (not final yet, a DNP, or a name mismatch)` };
    const total = loc.total;
    if (PROP_BINARY.has(bet)) return { outcome: total >= need ? "Win" : "Loss", detail: `${p.player_prop}: ${g(total)}` };
    const outcome = gradeOverUnder(total, p.line, p.side);
    if (!outcome) return { outcome: null, why: `push or missing Line/Side -- stat was ${g(total)}` };
    return { outcome, detail: `${p.player_prop}: ${g(total)}` };
  }
  if (!p.team || !p.opponent) return { outcome: null, why: "missing Team/Opponent" };
  if (INDIVIDUAL_SPORTS.has(p.sport)) {
    const hit = await findIndividual(ctx, p.team, p.opponent, p.sport, p.gametime);
    const status = hit && (hit[0].status || {});
    if (!hit || !((status.type || {}).completed)) return { outcome: null, why: `matchup not found or not final yet (${p.team} vs ${p.opponent}, ${p.sport})` };
    const aWon = !!hit[1].winner, rounds = status.period ?? null;
    const outcome = gradeIndividual(bet, aWon, rounds, p.line, p.side);
    if (!outcome) return { outcome: null, why: `push, missing Line/Side, or '${bet}' isn't gradable for ${p.sport}` };
    return { outcome, detail: `${aWon ? p.team : p.opponent} won${rounds != null ? ` (round ${g(rounds)})` : ""}` };
  }
  const game = await teamGame(ctx, p);
  if (!game || !((game.comp.status || {}).type || {}).completed) return { outcome: null, why: `game not found or not final yet (${p.team} vs ${p.opponent}, ${p.sport})` };
  let a, b, label;
  if (HALF_SCORE_BET_TYPES.has(bet)) {
    const h = halfScores(game.teamC, game.oppC);
    if (!h) return { outcome: null, why: `no halftime score for ${p.team} vs ${p.opponent}` };
    [a, b] = h; label = "1st half";
  } else {
    a = toNum(game.teamC.score); b = toNum(game.oppC.score); label = "final";
    if (a == null || b == null) return { outcome: null, why: `no final score for ${p.team} vs ${p.opponent}` };
  }
  const outcome = gradePick(bet, a, b, p.line, p.side);
  if (!outcome) return { outcome: null, why: `push -- ${g(a)}-${g(b)} (${label}) lands exactly on the line` };
  return { outcome, detail: `${g(a)}-${g(b)} ${label}` };
}

/** A Pending leg's game right now: { live, matchup } (either may be null). */
export async function liveLeg(ctx, p) {
  const bet = p.bet_type;
  if (!bet || !p.gametime) return { live: null, matchup: null };
  if (PROP_BET_TYPES.has(bet)) {
    if (!p.player_prop) return { live: null, matchup: null };
    const [need, name] = propTarget(p.player_prop);
    const loc = await locateProp(ctx, name, bet, p.sport, p.gametime, false, p.game_id);
    if (!loc || !loc.teamC || !loc.oppC) return { live: null, matchup: null };
    const st = gameState(loc.comp, loc.teamC, loc.oppC);
    const matchup = `${abbrevOf(loc.teamC)} vs. ${abbrevOf(loc.oppC)}`;
    const stat = loc.found ? loc.total : null;
    if (st.state === "pre" || stat == null) return { live: null, matchup };
    let hit = false, t;
    if (PROP_BINARY.has(bet)) { hit = stat >= need; t = hit ? "up" : "down"; }
    else t = tone(gradeOverUnder(stat, p.line, p.side));
    return { matchup, live: { kind: "prop", stat, team_score: st.team_score, opponent_score: st.opponent_score, period: st.period, clock: st.clock, detail: st.detail, tone: t, hit } };
  }
  if (!p.team || !p.opponent || INDIVIDUAL_SPORTS.has(p.sport)) return { live: null, matchup: null };
  const game = await teamGame(ctx, p);
  if (!game) return { live: null, matchup: null };
  const st = gameState(game.comp, game.teamC, game.oppC);
  if (st.state !== "in") return { live: null, matchup: null };
  const t = HALF_SCORE_BET_TYPES.has(bet) ? null : tone(gradePick(bet, st.team_score, st.opponent_score, p.line, p.side));
  return { matchup: null, live: { kind: "team", team_score: st.team_score, opponent_score: st.opponent_score, period: st.period, clock: st.clock, detail: st.detail, tone: t } };
}
