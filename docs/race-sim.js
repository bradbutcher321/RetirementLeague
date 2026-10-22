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
  function simulate(inp, n, picks, force) {
    let seed = 20261013;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const { teams, base, mu, live, sched, week, pickWeek, spots, byes } = inp;
    const N = teams.length;
    // fw: how often the season ends on each win total -> [seasons, seasons in the playoffs] (Playoff Race's Your path, audit IV #12).
    const out = Object.fromEntries(teams.map(t => [t, { po: 0, bye: 0, sacko: 0, fw: {} }]));
    const cond = force ? { win: Object.fromEntries(teams.map(t => [t, [0, 0]])), loss: Object.fromEntries(teams.map(t => [t, [0, 0]])) } : null;
    for (let k = 0; k < n; k++) {
      const w = {}, pf = {}, pickRes = {};
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
    }
    teams.forEach(t => { const o = out[t]; o.po *= 100 / n; o.bye *= 100 / n; o.sacko *= 100 / n; });
    if (cond) teams.forEach(t => {
      out[t].ifWin = cond.win[t][0] ? cond.win[t][1] * 100 / cond.win[t][0] : null;
      out[t].ifLoss = cond.loss[t][0] ? cond.loss[t][1] * 100 / cond.loss[t][0] : null;
    });
    return out;
  }

  // Overwrites the Worker's ESPN playoffPct with the site's number. The
  // result is kept for the same inputs, so moving between pages is instant.
  function apply(d) {
    const inp = inputs(d);
    if (!inp || !inp.sched.length) return d;
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
    });
    return d;
  }

  return { RUNS, inputs, simulate, apply };
})();
