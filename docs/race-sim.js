// The site's one playoff simulation (site audit IV #2). Every page that shows
// playoff odds -- the dashboard, the status line, Standings, Playoff Race --
// gets them from here, so a team has one number everywhere instead of ESPN's
// on one page and ours on another.
//
// Every remaining regular-season game is played, the median game too, and
// ties go to points scored. Each team scores like its average so far, pulled
// toward the league's (worth SHRINK games). The live week counts what has
// happened: a game whose players are all done is locked in, and the rest
// start from their live score. Input is the Worker's dashboard payload.
const RaceSim = (() => {
  const RUNS = 6000, SD = 22, SHRINK = 20, LEAGUE_AVG = 100;
  const STORE = 'rl-race-odds';

  function inputs(d) {
    if (!d || d.archived || !d.teams || !d.matchups) return null;
    const reg = d.regularSeasonWeeks, spots = d.playoffTeamCount, week = d.week;
    if (!reg || !spots || !week || week > reg) return null;
    const rows = d.teams.filter(t => t.manager && t.prior && Array.isArray(t.ahead));
    if (rows.length < 4) return null;
    const teams = rows.map(t => t.manager).sort();
    const done = week - 1;
    const base = {}, sc = {};
    rows.forEach(t => { base[t.manager] = { w: t.prior.w, l: t.prior.l, pf: t.prior.pf }; sc[t.manager] = done; });
    const league = rows.reduce((a, t) => a + t.prior.pf, 0) / (rows.length * done || 1);
    const lm = done ? league : LEAGUE_AVG;

    const ms = d.matchups;
    const over = m => !m.awayRemaining && !m.homeRemaining && !m.awayInPlay && !m.homeInPlay;
    const allOver = ms.length > 0 && ms.every(over);
    const live = {};
    let pickWeek = week;
    const lock = (a, sa, sb, medianWin) => {
      const r = base[a]; if (!r) return;
      r.pf += sa; sc[a]++;
      if (sa > sb) r.w++; else r.l++;
      if (medianWin != null) { if (medianWin) r.w++; else r.l++; }
    };
    if (allOver) {
      pickWeek = week + 1;
      ms.forEach(m => {
        lock(m.awayManager, m.awayScore, m.homeScore, m.awayScore > d.currentMedian);
        lock(m.homeManager, m.homeScore, m.awayScore, m.homeScore > d.currentMedian);
      });
    } else {
      ms.forEach(m => {
        const fin = over(m);
        live[m.awayManager] = { s: m.awayScore, proj: m.awayProjected, fin };
        live[m.homeManager] = { s: m.homeScore, proj: m.homeProjected, fin };
        if (fin) { lock(m.awayManager, m.awayScore, m.homeScore, null); lock(m.homeManager, m.homeScore, m.awayScore, null); }
      });
    }
    const mu = {};
    teams.forEach(t => { const n = sc[t], m = n ? base[t].pf / n : lm; mu[t] = (n * m + SHRINK * lm) / (n + SHRINK); });

    const ahead = Object.fromEntries(rows.map(t => [t.manager, t.ahead]));
    const sched = [];
    for (let w = pickWeek; w <= reg; w++) {
      const i = w - week, seen = new Set(), pairs = [];
      teams.forEach(t => {
        const o = ahead[t][i];
        if (!o || seen.has(t) || !teams.includes(o)) return;
        if (w === week && live[t] && live[t].fin) return; // already over
        seen.add(t); seen.add(o); pairs.push([t, o]);
      });
      sched.push({ w, pairs });
    }
    return { teams, base, mu, live, sched, week, pickWeek, done: pickWeek - 1, reg, spots, byes: spots >= 6 ? 2 : 0 };
  }

  // Same seed every time, so the same inputs always give the same odds.
  // opts.bracket (audit X #14) also plays each season on through the
  // bracket and pays it out: out[t].title / .final, and .ev, the dollars a
  // team can expect from opts.pay ({ first, second, third, week, season })
  // with opts.high ({ score, manager }) as the high week to beat. Those
  // draws come after the regular season's, so the odds don't change.
  function simulate(inp, n, picks, force, opts) {
    let seed = 20261013;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const { teams, base, mu, live, sched, week, pickWeek, spots, byes } = inp;
    const N = teams.length;
    // fw: how often the season ends on each win total -> [seasons, seasons in the playoffs] (Playoff Race's Your path, audit IV #12).
    const out = Object.fromEntries(teams.map(t => [t, { po: 0, bye: 0, sacko: 0, fw: {}, title: 0, final: 0, ev: 0 }]));
    const br = opts && opts.bracket, pay = (opts && opts.pay) || {};
    // The bracket draws from its own stream, so the regular season's draws
    // (and every odds number) are the same with it or without it.
    let seed2 = 7310013;
    const rnd2 = () => { seed2 = (seed2 * 16807) % 2147483647; return (seed2 - 1) / 2147483646; };
    const gauss2 = () => { let u = 0, v = 0; while (u === 0) u = rnd2(); while (v === 0) v = rnd2(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const cond = force ? { win: Object.fromEntries(teams.map(t => [t, [0, 0]])), loss: Object.fromEntries(teams.map(t => [t, [0, 0]])) } : null;
    for (let k = 0; k < n; k++) {
      const w = {}, pf = {}, pickRes = {};
      let hiS = br && opts.high ? opts.high.score : 0, hiM = br && opts.high ? opts.high.manager : null;
      teams.forEach(t => { w[t] = base[t].w; pf[t] = base[t].pf; });
      sched.forEach(({ w: wk, pairs }) => {
        const sc = {};
        teams.forEach(t => {
          const L = wk === week ? live[t] : null;
          if (L && L.fin) sc[t] = L.s;
          else if (L) { const f = L.proj > 0 ? Math.min(1, Math.max(0.05, (L.proj - L.s) / L.proj)) : 1; sc[t] = Math.max(L.s, L.proj) + SD * Math.sqrt(f) * gauss(); }
          else sc[t] = mu[t] + SD * gauss();
        });
        pairs.forEach(([a, b]) => {
          // picks: "week|a|b" -> the winner you chose (Playoff Race, any week left).
          const forced = picks ? picks[wk + '|' + a + '|' + b] : null;
          if (forced && ((forced === a) !== (sc[a] > sc[b]))) { const x = sc[a]; sc[a] = sc[b]; sc[b] = x; }
          const winner = sc[a] > sc[b] ? a : b;
          w[winner]++;
          if (wk === pickWeek) { pickRes[a] = winner === a; pickRes[b] = winner === b; }
        });
        teams.slice().sort((x, y) => sc[y] - sc[x]).slice(0, N / 2).forEach(t => { w[t]++; });
        if (br) teams.forEach(t => { if (sc[t] > hiS) { hiS = sc[t]; hiM = t; } });
        teams.forEach(t => { if (!(wk === week && live[t] && live[t].fin)) pf[t] += sc[t]; });
      });
      const rank = teams.slice().sort((x, y) => (w[y] - w[x]) || (pf[y] - pf[x]));
      rank.forEach((t, i) => {
        const o = out[t];
        if (i < spots) o.po++;
        const fw = o.fw[w[t]] || (o.fw[w[t]] = [0, 0]);
        fw[0]++;
        if (i < spots) fw[1]++;
        if (i < byes) o.bye++;
        if (i >= N - 2) o.sacko++;
        if (cond && pickRes[t] !== undefined) { const c = pickRes[t] ? cond.win[t] : cond.loss[t]; c[0]++; if (i < spots) c[1]++; }
      });
      if (br) {
        // The bracket: six teams, the top two on byes, the top seed meets the
        // lowest one left; four teams, 1 v 4 and 2 v 3. Then a final and a
        // third-place game. Every playoff score is the team's own average.
        const g = (a, b) => (mu[a] + SD * gauss2() > mu[b] + SD * gauss2() ? a : b);
        const lose = (a, b, win) => (win === a ? b : a);
        const s = rank.slice(0, spots);
        let semis;
        if (spots >= 6) {
          const q1 = g(s[2], s[5]), q2 = g(s[3], s[4]);
          const low = rank.indexOf(q1) > rank.indexOf(q2) ? q1 : q2, other = low === q1 ? q2 : q1;
          semis = [[s[0], low], [s[1], other]];
        } else semis = [[s[0], s[3]], [s[1], s[2]]];
        const f1 = g(...semis[0]), f2 = g(...semis[1]);
        const champ = g(f1, f2), second = lose(f1, f2, champ);
        const l1 = lose(...semis[0], f1), l2 = lose(...semis[1], f2), third = g(l1, l2);
        out[champ].title++; out[f1].final++; out[f2].final++;
        out[champ].ev += pay.first || 0; out[second].ev += pay.second || 0; out[third].ev += pay.third || 0;
        if (hiM && out[hiM]) out[hiM].ev += pay.week || 0;
        const pfTop = teams.reduce((a, t) => (pf[t] > pf[a] ? t : a), teams[0]);
        out[pfTop].ev += pay.season || 0;
      }
    }
    teams.forEach(t => { const o = out[t]; o.po *= 100 / n; o.bye *= 100 / n; o.sacko *= 100 / n; o.title *= 100 / n; o.final *= 100 / n; o.ev /= n; });
    if (cond) teams.forEach(t => {
      out[t].ifWin = cond.win[t][0] ? cond.win[t][1] * 100 / cond.win[t][0] : null;
      out[t].ifLoss = cond.loss[t][0] ? cond.loss[t][1] * 100 / cond.loss[t][0] : null;
    });
    return out;
  }

  // What is settled for sure (audit X #2). 6,000 seasons never seeing a
  // team miss doesn't make it certain, so odds read >99% / <1% until this
  // says so. Every game left is a matchup or a median game; a tie on wins
  // counts against the team (points decide it, and they aren't played yet),
  // and two rivals meeting each other is ignored -- both only make it
  // stricter, so a mark here is never wrong, only sometimes late.
  //   z  sure of a bye (top `byes`)     x  sure of a playoff spot     e  out
  function clinch(d) {
    const inp = inputs(d);
    if (!inp) return {};
    const { teams, base, sched, spots, byes } = inp;
    const left = Object.fromEntries(teams.map(t => [t, sched.length + sched.reduce((n, s) => n + (s.pairs.some(p => p.includes(t)) ? 1 : 0), 0)]));
    const lo = t => base[t].w, hi = t => base[t].w + left[t];
    const out = {};
    teams.forEach(t => {
      const others = teams.filter(o => o !== t);
      const threats = others.filter(o => hi(o) >= lo(t)).length;
      const above = others.filter(o => lo(o) > hi(t)).length;
      out[t] = byes && threats < byes ? 'z' : threats < spots ? 'x' : above >= spots ? 'e' : null;
    });
    return out;
  }
  const MARKS = { z: 'Clinched a bye', x: 'Clinched a playoff spot', e: 'Out of the playoffs' };
  // Odds as text: whole percents, but never 100% or 0% (see clinch).
  function pct(v) {
    if (v == null || isNaN(v)) return '—';
    return v >= 99.5 ? '>99%' : v < 0.5 ? '<1%' : Math.round(v) + '%';
  }

  // Overwrites the Worker's ESPN playoffPct with the site's number. The
  // result is kept for the same inputs, so moving between pages is instant.
  function apply(d) {
    const inp = inputs(d);
    if (!inp || !inp.sched.length) return d;
    const marks = clinch(d);
    const key = JSON.stringify([inp.base, inp.live, inp.sched, inp.week, inp.spots]);
    let odds = null;
    try { const c = JSON.parse(localStorage.getItem(STORE) || 'null'); if (c && c.k === key) odds = c.o; } catch (e) {}
    if (!odds) {
      odds = simulate(inp, RUNS);
      Object.values(odds).forEach(o => { delete o.fw; }); // only Playoff Race wants these
      try { localStorage.setItem(STORE, JSON.stringify({ k: key, o: odds })); } catch (e) {}
    }
    d.teams.forEach(t => {
      const o = odds[t.manager];
      if (o) { t.playoffPct = o.po; t.byePct = o.bye; t.sackoPct = o.sacko; }
      t.clinch = marks[t.manager] || null;
    });
    return d;
  }

  // Odds after each finished week (audit X #15), rebuilt from the season's
  // games with this same sim (fewer runs), then today's number from the
  // live payload `d` (after apply). games: league.json rows as objects
  // ({ year, week, type, p1, p2, s1, s2, winner, median }). Returns
  // { manager: [after the draft, after Week 1, ..., now] }, kept per tab.
  function history(d, games, year, medianFrom) {
    if (!d || !d.teams || !d.regularSeasonWeeks) return null;
    const gs = games.filter(g => g.year === year && g.type === 'Reg' && g.p2 && g.winner && g.winner !== 'In Progress' && (g.s1 > 0 || g.s2 > 0));
    const done = gs.length ? Math.max(...gs.map(g => g.week)) : 0;
    const key = `rl-odds-path:${year}:${done}:${gs.length}:${Math.round(d.teams.reduce((a, t) => a + (t.playoffPct || 0), 0))}`;
    try { const c = JSON.parse(sessionStorage.getItem(key)); if (c) return c; } catch (e) {}
    const mgrs = d.teams.map(t => t.manager);
    const oppOf = Object.fromEntries(mgrs.map(m => [m, {}]));
    games.filter(g => g.year === year && g.type === 'Reg' && g.p2).forEach(g => { if (oppOf[g.p1]) oppOf[g.p1][g.week] = g.p2; if (oppOf[g.p2]) oppOf[g.p2][g.week] = g.p1; });
    d.teams.forEach(t => (t.ahead || []).forEach((o, i) => { oppOf[t.manager][d.week + i] = o; }));
    const out = Object.fromEntries(mgrs.map(m => [m, []]));
    for (let k = 0; k < Math.min(done, d.week - 1); k++) {
      const prior = Object.fromEntries(mgrs.map(m => [m, { w: 0, l: 0, pf: 0 }]));
      gs.filter(g => g.week <= k).forEach(g => [[g.p1, g.s1, g.s2], [g.p2, g.s2, g.s1]].forEach(([m, s, o]) => {
        const r = prior[m]; if (!r) return;
        r.pf += s; if (s > o) r.w++; else r.l++;
        if (year >= medianFrom && g.median != null) { if (s > g.median) r.w++; else r.l++; }
      }));
      const ahead = m => { const a = []; for (let w = k + 1; w <= d.regularSeasonWeeks; w++) a.push(oppOf[m][w] || null); return a; };
      const inp = inputs({ week: k + 1, regularSeasonWeeks: d.regularSeasonWeeks, playoffTeamCount: d.playoffTeamCount, matchups: [], teams: mgrs.map(m => ({ manager: m, prior: prior[m], ahead: ahead(m) })) });
      if (!inp) continue;
      const res = simulate(inp, 1200);
      mgrs.forEach(m => out[m].push(res[m].po));
    }
    d.teams.forEach(t => out[t.manager].push(t.playoffPct));
    try { sessionStorage.setItem(key, JSON.stringify(out)); } catch (e) {}
    return out;
  }

  return { RUNS, inputs, simulate, apply, clinch, pct, MARKS, history };
})();
