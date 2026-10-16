// Record Watch (site audit III #14): which of Game Records' records a live
// game is on pace for, or has just set -- good ones and bad ones.
//
// One file for two readers. The dashboard loads it as a plain script (the
// matchup cards' gold box) and the Worker imports it (worker/src/push.js, the
// "a record falls" notification), so the rules can't drift apart. No DOM, no
// fetching: it is handed the history and the live matchups.
//
// Records, with Game Records' own rules for which games count (consolation
// games count toward high scores and the highest score in a loss, and
// nothing else; byes, unplayed and in-progress games never count):
//   teamHi / teamLo       a team's score, highest / lowest
//   comboHi / comboLo     both teams' points added, most / fewest
//   marginHi / marginLo   the winner's margin, biggest / closest
//   lossHi / winLo        highest score in a loss / lowest score in a win
//   startHi / startLo     one starter's points, best / worst (data/lineups/records.json)
// A "settled" fact needs both lineups finished: a score that can still only
// climb (teamHi, comboHi, startHi) is real the moment it passes the record,
// and everything else waits for the games to end.
const RecordWatch = (() => {
  const f2 = n => (Math.round(n * 100) / 100).toFixed(2);
  const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const MAX_RANK = 10;
  const gk = (y, w, a, b) => `${y}:${w}:${[a, b].sort().join('|')}`;

  // ----- The history: each record's list, best first -----
  // games: [{ year, week, type, p1, p2, s1, s2, winner }]
  // players: data/lineups/records.json, or null
  function build(games, players) {
    const played = games.filter(g => g.p2 && g.type !== 'Bye' && g.s1 > 0 && g.s2 > 0 && g.winner !== 'In Progress');
    const reg = played.filter(g => g.type !== 'Cons');
    const decided = list => list.filter(g => g.winner === g.p1 || g.winner === g.p2);
    const at = g => `${g.year} Wk ${g.week}`;
    const e = (v, who, g, extra) => ({ v, who, k: gk(g.year, g.week, g.p1, g.p2), at: `${who} ${at(g)}`, ...extra });
    const hi = (a, b) => b.v - a.v, lo = (a, b) => a.v - b.v;
    const sides = (list, fn) => list.flatMap(g => [e(g.s1, g.p1, g), e(g.s2, g.p2, g)]);
    const loser = g => (g.winner === g.p1 ? g.p2 : g.p1);
    const wScore = g => (g.winner === g.p1 ? g.s1 : g.s2);
    const lScore = g => (g.winner === g.p1 ? g.s2 : g.s1);
    const both = g => `${g.p1} & ${g.p2}`;
    const book = {
      teamHi: sides(played).sort(hi),
      teamLo: sides(reg).sort(lo),
      comboHi: reg.map(g => e(g.s1 + g.s2, both(g), g)).sort(hi),
      comboLo: reg.map(g => e(g.s1 + g.s2, both(g), g)).sort(lo),
      marginHi: decided(reg).map(g => e(Math.abs(g.s1 - g.s2), g.winner, g)).sort(hi),
      marginLo: decided(reg).map(g => e(Math.abs(g.s1 - g.s2), g.winner, g)).sort(lo),
      lossHi: decided(played).map(g => e(lScore(g), loser(g), g)).sort(hi),
      winLo: decided(reg).map(g => e(wScore(g), g.winner, g)).sort(lo),
      startHi: [], startLo: [],
    };
    if (players && players.years) {
      // Each season holds its own top 10, so the best of them all is in there.
      const all = key => Object.values(players.years).flatMap(y => y[key] || [])
        .map(r => ({ v: r.pts, who: r.m, k: `${r.y}:${r.w}:${r.m}:${r.p}`, at: `${r.p} for ${r.m}, ${r.y} Wk ${r.w}` }));
      book.startHi = all('best').sort(hi).slice(0, 15);
      book.startLo = all('worst').sort(lo).slice(0, 15);
    }
    return book;
  }

  // ----- Phrases: [subject, verb phrase, value, tail] per record and state -----
  // state: 'pace' (still being played), 'broke' (past the record, games still
  // going), 'done' (settled). rank 1 + a record means a new one.
  const T = {
    teamHi: {
      title: 'New league scoring record', hi: true,
      say: (s, who, v, r) => s === 'pace' ? [who, 'is on pace for', f2(v), r === 1 ? ', a new record' : `, the ${ord(r)}-best score ever`]
        : s === 'broke' ? [who, 'broke the record with', f2(v), '']
        : [who, r === 1 ? 'set the record with' : 'scored', f2(v), r === 1 ? '' : `, the ${ord(r)}-best score ever`],
    },
    teamLo: {
      title: 'Lowest score in league history',
      say: (s, who, v, r) => s === 'pace' ? [who, 'is on pace for', f2(v), r === 1 ? ', a new low' : `, the ${ord(r)}-lowest score ever`]
        : [who, r === 1 ? 'set the record low with' : 'scored', f2(v), r === 1 ? '' : `, the ${ord(r)}-lowest score ever`],
    },
    comboHi: {
      title: 'Highest-scoring game ever', hi: true,
      say: (s, who, v, r) => s === 'pace' ? [who, 'are on pace for', f2(v), ` combined points${r === 1 ? ', a new record' : `, the ${ord(r)}-most ever`}`]
        : s === 'broke' ? [who, 'broke the record with', f2(v), ' combined points']
        : [who, r === 1 ? 'set the record with' : 'combined for', f2(v), ` ${r === 1 ? 'combined ' : ''}points${r === 1 ? '' : `, the ${ord(r)}-most ever`}`],
    },
    comboLo: {
      title: 'Lowest-scoring game ever',
      say: (s, who, v, r) => s === 'pace' ? [who, 'are on pace for', f2(v), ` combined points${r === 1 ? ', a new low' : `, the ${ord(r)}-fewest ever`}`]
        : [who, r === 1 ? 'set the record low with' : 'combined for', f2(v), ` ${r === 1 ? 'combined ' : ''}points${r === 1 ? '' : `, the ${ord(r)}-fewest ever`}`],
    },
    marginHi: {
      title: 'Biggest blowout in league history', hi: true,
      say: (s, who, v, r) => s === 'pace' ? [who, 'is on pace to win by', f2(v), r === 1 ? ', a new record' : `, the ${ord(r)}-biggest margin ever`]
        : [who, r === 1 ? 'set the record, winning by' : 'won by', f2(v), r === 1 ? '' : `, the ${ord(r)}-biggest margin ever`],
    },
    marginLo: {
      title: 'Closest finish in league history',
      say: (s, who, v, r) => [who, 'won by just', f2(v), r === 1 ? ', the closest finish ever' : `, the ${ord(r)}-closest finish ever`],
    },
    lossHi: {
      title: 'Highest score in a loss, ever', hi: true,
      say: (s, who, v, r) => [who, 'lost with', f2(v), r === 1 ? ', the most ever in a loss' : `, the ${ord(r)}-most ever in a loss`],
    },
    winLo: {
      title: 'Lowest score in a win, ever',
      say: (s, who, v, r) => [who, 'won with just', f2(v), r === 1 ? ', the fewest ever in a win' : `, the ${ord(r)}-fewest ever in a win`],
    },
    startHi: {
      title: 'Best individual start ever', hi: true,
      say: (s, who, v, r, x) => [x.p, s === 'done' ? 'scored' : 'has', f2(v), ` for ${x.m}${r === 1 ? ', a new record' : `, the ${ord(r)}-best start ever`}`],
    },
    startLo: {
      title: 'Worst individual start ever',
      say: (s, who, v, r, x) => [x.p, 'scored', f2(v), ` for ${x.m}${r === 1 ? ', a new low' : `, the ${ord(r)}-worst start ever`}`],
    },
  };

  // ----- The live side -----
  // A matchup in the Worker's shape, plus the season and week it belongs to
  // and whether the NFL game states were readable (a team "with nothing left"
  // is only finished when they were).
  function fromMatchup(m, year, week, known) {
    const side = p => ({
      who: m[p + 'Manager'] || m[p + 'Name'], now: parseFloat(m[p + 'Score']) || 0, proj: parseFloat(m[p + 'Projected']) || 0,
      done: Boolean(known) && !(parseInt(m[p + 'Remaining'], 10) || 0) && !(parseInt(m[p + 'InPlay'], 10) || 0),
      players: m[p + 'Players'] || [],
    });
    return { year, week, a: side('away'), b: side('home') };
  }

  // Everything in the top MAX_RANK of any record for this matchup:
  // [{ id, rank, achieved, settled, key, parts: [subject, verb, value, tail], record, title, sub }]
  // achieved: the live number is already past the record (rank 1 and beaten).
  function evaluate(book, game) {
    const { year, week, a, b } = game;
    if (!a.who || !b.who) return [];
    const gameKey = gk(year, week, a.who, b.who);
    const out = [];
    const final = a.done && b.done && a.now > 0 && b.now > 0;
    // Where `v` lands among the history's other entries (never counting this game itself).
    const place = (id, v, excl, hiEnd) => {
      const others = (book[id] || []).filter(x => x.k !== excl);
      if (!others.length || !isFinite(v)) return null;
      const rank = 1 + others.filter(x => (hiEnd ? x.v > v : x.v < v)).length;
      return rank <= MAX_RANK ? { rank, top: others[0], beat: hiEnd ? v > others[0].v : v < others[0].v } : null;
    };
    // v is the settled value or the pace; `nowV` (records that can only climb)
    // is what the games have already banked, which is what "broke it" is
    // judged on -- a pace that passes the record is still only a pace.
    const add = (id, v, who, settled, nowV, key, extra) => {
      const hiEnd = Boolean(T[id].hi);
      const p = place(id, v, extra && extra.excl || gameKey, hiEnd);
      if (!p) return;
      const achieved = settled ? p.beat : nowV !== null && nowV > p.top.v;
      const state = settled ? 'done' : achieved ? 'broke' : 'pace';
      if (state === 'broke') v = nowV; // "broke it with" quotes what's banked, not the pace
      out.push({
        id, rank: p.rank, achieved, settled, key: `${id}:${key}`, title: T[id].title, value: v,
        parts: T[id].say(state, who, v, p.rank, extra || {}),
        sub: `${achieved ? 'Old record' : 'Record'} ${f2(p.top.v)} · ${p.top.at}`,
      });
    };

    // A team's number now, or its pace: finished, ESPN's live projection, or nothing yet.
    const est = s => (s.done ? s.now : s.proj > 0 ? Math.max(s.now, s.proj) : null);
    for (const s of [a, b]) {
      add('teamHi', est(s) ?? s.now, s.who, s.done, s.now, s.who);
      const lo = est(s);
      if (lo !== null && lo > 0) add('teamLo', lo, s.who, s.done, null, s.who);
    }
    const ea = est(a), eb = est(b);
    add('comboHi', (ea ?? a.now) + (eb ?? b.now), `${a.who} & ${b.who}`, final, a.now + b.now, gameKey);
    if (ea !== null && eb !== null) {
      add('comboLo', ea + eb, `${a.who} & ${b.who}`, final, null, gameKey);
      if (ea !== eb) add('marginHi', Math.abs(ea - eb), ea > eb ? a.who : b.who, final, null, gameKey);
    }
    if (final && a.now !== b.now) {
      const w = a.now > b.now ? a : b, l = w === a ? b : a;
      add('marginLo', Math.abs(a.now - b.now), w.who, true, null, gameKey);
      add('lossHi', l.now, l.who, true, null, gameKey);
      add('winLo', w.now, w.who, true, null, gameKey);
    }
    // Starters: ESPN's points so far; a worst start is only real once his game is over.
    for (const s of [a, b]) {
      for (const p of s.players) {
        if (typeof p.livePoints !== 'number') continue;
        const excl = `${year}:${week}:${s.who}:${p.name}`;
        const over = Boolean(p.game) && p.game.state === 'post';
        const x = { p: p.name, m: s.who, excl };
        add('startHi', p.livePoints, s.who, over, p.livePoints, `${s.who}:${p.name}`, x);
        if (over) add('startLo', p.livePoints, s.who, true, null, `${s.who}:${p.name}`, x);
      }
    }
    return out.sort((x, y) => x.rank - y.rank || Number(y.achieved) - Number(x.achieved));
  }

  const plain = it => `${it.parts[0]} ${it.parts[1]} ${it.parts[2]}${it.parts[3]}`;

  return { build, fromMatchup, evaluate, plain, f2 };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = RecordWatch;
