// Lineup Check (site audit III #6): the box on your matchup card naming the
// starters who won't score this week -- on bye, ruled out, or (rarely) a
// questionable player whose projection ESPN has already dropped to 0.
//
// Deliberately narrow: no bench suggestions, no list of players who are
// fine, and no plain "Questionable" (most of them play). It is only shown
// while a swap is still possible: from Thursday 6 AM Eastern through the
// last kickoff of the week, and a starter whose own game has started is
// locked, so he isn't listed. No DOM and no fetching; handed the dashboard
// payload (worker/src/dashboard.js) and one side's starters.
const LineupCheck = (() => {
  const ET = 'America/New_York';
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const etFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });

  // A moment's Eastern wall-clock reading.
  function etParts(ms) {
    const p = {};
    etFormat.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, weekday: WEEKDAYS.indexOf(p.weekday) };
  }

  // 6:00 AM Eastern on the Thursday that opens the NFL week holding this
  // kickoff (a week whose first game isn't Thursday opens that same day).
  function windowOpens(firstKickoff) {
    const t = etParts(firstKickoff);
    const back = t.weekday >= 4 ? t.weekday - 4 : t.weekday === 0 ? 3 : 0;
    const wall = Date.UTC(t.y, t.mo - 1, t.d - back, 6);
    const at = etParts(wall);
    // `wall` read in Eastern shows how far Eastern sits from UTC then.
    return wall - (Date.UTC(at.y, at.mo - 1, at.d, at.h) - wall);
  }

  // data: the dashboard payload; now: ms.
  function isOpen(data, now) {
    if (!data || data.archived || !data.firstKickoff || !data.lastKickoff) return false;
    const first = Date.parse(data.firstKickoff), last = Date.parse(data.lastKickoff);
    return Number.isFinite(first) && Number.isFinite(last) && now >= windowOpens(first) && now < last;
  }

  const DOUBTFUL = new Set(['QUESTIONABLE', 'DOUBTFUL']);

  // The starters to flag, in lineup order: [{ player, kind }], kind 'bye' /
  // 'out' / 'zero'. avgSource comes from the Worker (averageValue()): it only
  // says 'out' while the player's game hasn't kicked off, and 'bye' when his
  // team has no game.
  function problems(players, data, now) {
    if (!isOpen(data, now)) return [];
    const out = [];
    (players || []).forEach(player => {
      if (player.avgSource === 'bye') out.push({ player, kind: 'bye' });
      else if (player.avgSource === 'out') out.push({ player, kind: 'out' });
      else if (DOUBTFUL.has(player.injury) && player.projectedPoints === 0 && player.game && player.game.state === 'pre') {
        out.push({ player, kind: 'zero' });
      }
    });
    return out;
  }

  return { problems, isOpen, windowOpens };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LineupCheck;
