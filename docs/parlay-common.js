// Parlay leg helpers shared by Parlay Results and Parlay Stats' Managers
// tab: what kind of bet a pick is, and the final-score pill a graded leg
// shows ("17-10", "44", "1 TD", "Pereira · Round 1"). Loaded after
// page-common.js (esc). Moved out of parlay-results.html so both pages
// draw a leg's result the same way.

// reconstruct_pick_text (generate_parlay_data.py) writes every pick as
// "{bet type}: {details}", for bet types it knows and for ones it doesn't,
// and a pick with no bet type is never published -- so the prefix is always
// there to read.
const betTypeOf = p => String(p.pick || '').split(':')[0].trim();
// An over/under on a game's combined score. Mirrors parlay_note_parser.py's
// TOTAL_VS. A UFC "Total Rounds" bet is in that set but has no two scores to
// add -- the round a fight ended in is the one number there, and its graded
// detail reads "<winner> won (round 3)" -- so it simply never matches the
// two-score shape the sum below looks for.
const TOTAL_BET_TYPES = new Set(['Total Points', 'Total Goals', 'Total Rounds']);
// The bets that grade off one player's stat line rather than a game's score
// -- parlay_note_parser.py's PLAYER_OU plus PLAYER_ONLY.
const PLAYER_BET_TYPES = new Set(['Receiving Yards', 'Passing TD', 'Home Runs', 'Player Points',
  'Interceptions', 'Total Yards', 'Receptions', 'Passing Yards', 'Anytime TD', 'Coin Toss']);
const isTotalBet = p => TOTAL_BET_TYPES.has(betTypeOf(p));
// What a live prop's running stat counts, [one, many] -- "1 TD", "0 TDs".
const PROP_STAT_UNITS = {
  'Anytime TD': ['TD', 'TDs'], 'Passing TD': ['Pass TD', 'Pass TDs'],
  'Passing Yards': ['Pass Yd', 'Pass Yds'], 'Receiving Yards': ['Rec Yd', 'Rec Yds'], 'Total Yards': ['Yd', 'Yds'],
  'Receptions': ['Rec', 'Rec'], 'Interceptions': ['INT', 'INTs'], 'Home Runs': ['HR', 'HRs'], 'Player Points': ['Pt', 'Pts'],
};

// Rewrites the graded detail -- free text out of the sheet's Grade Detail
// column, written by auto_grade_results.py -- into what the chip shows.
// The sheet keeps the original wording as the audit trail; this is purely
// how it reads on the page, which is also why every past leg picks these
// up with no backfill.
function finalChipText(p, detail) {
  const bet = betTypeOf(p);

  // A totals bet is about the combined number, so "17-27" becomes 44.
  if (TOTAL_BET_TYPES.has(bet)) {
    detail = detail.replace(/^(\d+)\s*-\s*(\d+)\b/, (_m, a, b) => String(Number(a) + Number(b)));
  }

  // A player prop grades to "<player>: <stat>". The player's name is
  // already on the bet line beside it, while what the number measures
  // isn't -- so it reads the way the live stat did: "64 Rec Yds", "1 TD".
  // A bet type with no unit takes the label's place: "Coin Toss: 1".
  if (PLAYER_BET_TYPES.has(bet)) {
    detail = detail.replace(/^.+?:\s*(-?\d+(?:\.\d+)?)$/, (_m, n) => {
      const units = PROP_STAT_UNITS[bet];
      return units ? `${n} ${Number(n) === 1 ? units[0] : units[1]}` : `${bet}: ${n}`;
    });
  }

  // A UFC bout grades to "Pereira won (round 1)" -- tightened to
  // "Pereira · Round 1", the same middot separator the rest of the site
  // uses between a fact and its qualifier. A decision with no round
  // recorded keeps its plain "<winner> won".
  detail = detail.replace(/^(.+?)\s+won\s*\(round\s*(\d+(?:\.\d+)?)\)$/i,
    (_m, who, round) => `${who} · Round ${round}`);

  return detail;
}

// The pill beside the status: what the leg was graded from. Empty string
// until the leg is actually decided -- a live leg gets livePillHtml in the
// same spot instead, and a leg that hasn't kicked off gets nothing.
function finalChipHtml(p) {
  if (p.result !== 'Win' && p.result !== 'Loss') return '';
  // auto_grade_results.py writes a score-graded detail as "17-10 final";
  // the chip is already in the verdict's own slot, so a trailing "final"
  // in the value would be saying it twice. Other shapes (a prop's
  // "Player: 2", a 1st-half score, a UFC result) never end in that word.
  const raw = (p.detail || '').replace(/\s*\bfinal\b\s*$/i, '').trim();
  if (!raw) return '';
  const text = finalChipText(p, raw);
  // Digits, and a prop's short "64 Rec Yds", get the condensed scoreboard
  // face; anything else with words in it takes the body face a size down
  // -- see .fin.is-text. Either may shrink before the status does.
  const unitText = PLAYER_BET_TYPES.has(betTypeOf(p)) && /^-?\d+(\.\d+)?\s\S/.test(text) && text.length <= 12;
  const cls = /^[\d\s.–—-]+$/.test(text) || unitText ? 'fin' : 'fin is-text';
  return `<span class="${cls}" title="${esc(text)}">${esc(text)}</span>`;
}
