// Hall of Fame (site audit III #8): legacy points on the Balanced weights,
// and a manager Elo, worked out from data/league.json (LG.load()). Now a
// tab on League History (audit X #9); hall-of-fame.html only forwards there.
//
// HofUI.html(D) returns the tab's markup; it redraws itself in place when
// you switch Legacy points / Elo or pick names. Needs page-common.js and
// features.css (ft-*, hf-*, elo-*).
const HofUI = (() => {
  // Balanced: a title is worth 10, a runner-up 5, a playoff trip 2, the
  // top seed 2, and a Sacko costs 3. Two or more titles is inducted.
  const WEIGHTS = { titles: 10, runner: 5, playoffs: 2, top_seed: 2, sackos: -3 };
  const NAMES = { titles: 'Title', runner: 'Runner-up', playoffs: 'Playoffs', top_seed: '#1 seed', sackos: 'Sacko' };
  const VIEWS = [['legacy', 'Legacy points'], ['elo', 'Elo']];
  const K = 24, PLAYOFF_X = 1.5, CARRY = 0.75;
  let D = null, view = 'legacy', LEG, ELO;
  const sel = { a: null, b: null };

  function legacy() {
    const parts = {};
    D.seasons.filter(s => D.completeYears.includes(s.year)).forEach(s => {
      const p = parts[s.player] || (parts[s.player] = { titles: 0, runner: 0, playoffs: 0, top_seed: 0, sackos: 0, seasons: 0 });
      p.seasons++;
      if (s.champ) p.titles++; else if (s.final_rank === 2) p.runner++;
      if (s.playoff) p.playoffs++;
      if (s.reg_rank === 1) p.top_seed++;
      if (s.sacko) p.sackos++;
    });
    const rows = Object.entries(parts).map(([m, p]) => ({ m, p, s: Object.entries(WEIGHTS).reduce((t, [k, w]) => t + p[k] * w, 0), active: D.active.has(m) }))
      .sort((a, b) => b.s - a.s || b.p.titles - a.p.titles || a.m.localeCompare(b.m));
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r.s !== prev) rank = i + 1; r.rank = rank; prev = r.s; });
    return rows;
  }

  // Everyone starts at 1500 and trades points each game. Beating a stronger
  // team moves you more, playoff games count 1.5x, and a quarter of every
  // rating drifts back to 1500 between seasons.
  function elo() {
    const rating = {}, hist = {}, peak = {};
    const get = m => rating[m] ?? (rating[m] = 1500);
    let lastYear = null;
    D.games.slice().sort((a, b) => a.year - b.year || a.week - b.week).forEach(g => {
      if (g.type === 'Bye' || g.type === 'Cons' || !g.p2 || g.s1 == null || g.s2 == null || g.winner === 'In Progress') return;
      if (g.year !== lastYear) {
        if (lastYear !== null) Object.keys(rating).forEach(m => { rating[m] = 1500 + (rating[m] - 1500) * CARRY; });
        lastYear = g.year;
      }
      const a = g.p1, b = g.p2, ra = get(a), rb = get(b);
      const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
      const sa = g.s1 > g.s2 ? 1 : g.s1 < g.s2 ? 0 : 0.5;
      const k = K * (g.type === 'Play' || g.type === 'Champ' ? PLAYOFF_X : 1);
      rating[a] += k * (sa - ea); rating[b] -= k * (sa - ea);
      [a, b].forEach(m => {
        (hist[m] || (hist[m] = [])).push([g.year, g.week, rating[m]]);
        if (!peak[m] || rating[m] > peak[m][0]) peak[m] = [rating[m], g.year, g.week];
      });
    });
    return { now: rating, hist, peak };
  }

  const detail = p => [p.titles ? `${p.titles} title${p.titles > 1 ? 's' : ''}` : '', p.runner ? `${p.runner} runner-up` : '', p.playoffs ? `${p.playoffs} playoffs` : '', p.sackos ? `${p.sackos} Sacko${p.sackos > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || `${p.seasons} season${p.seasons > 1 ? 's' : ''}`;

  function legacyView() {
    return `<div class="glass"><div class="panel-title">Legacy points <span class="ft-chip">${D.completeYears.length} seasons</span></div>
      <div class="ft-note">Points for what a manager has won, minus what a Sacko costs. Two or more titles is inducted.</div>
      <div class="ft-body"><div class="hf-weights">${Object.entries(WEIGHTS).map(([k, v]) => `<span class="hf-w"><b>${v > 0 ? '+' : '−'}${Math.abs(v)}</b> ${NAMES[k]}</span>`).join('')}</div>
      <div class="hf-list">${LEG.map(r => `<a class="ft-item hf-r${r.p.titles >= 2 ? ' in' : ''}${r.active ? '' : ' former'}${isMe(r.m) ? ' me' : ''}" href="${esc(pageLink('franchise.html', { m: r.m }))}">
        <span class="hf-rk">${r.rank}</span><div class="hf-n"><b>${esc(r.m)}</b><span>${esc(detail(r.p))}${r.active ? '' : ' · Former'}</span></div>
        ${r.p.titles >= 2 ? '<span class="ft-chip gold">Inducted</span>' : ''}<em class="hf-s">${r.s}</em></a>`).join('')}</div></div></div>`;
  }

  function chart() {
    const H = ELO.hist, W = 600, Ht = 240, padL = 36, padR = 10, padT = 12, padB = 24;
    const keys = [...new Set(Object.values(H).flatMap(h => h.map(([y, w]) => y * 100 + w)))].sort((a, b) => a - b);
    const xi = new Map(keys.map((k, i) => [k, i]));
    const all = Object.values(H).flatMap(h => h.map(x => x[2]));
    const lo = Math.floor(Math.min(...all) / 50) * 50, hi = Math.ceil(Math.max(...all) / 50) * 50;
    const X = i => padL + (i / (keys.length - 1)) * (W - padL - padR), Y = v => padT + (1 - (v - lo) / (hi - lo)) * (Ht - padT - padB);
    const path = m => H[m].map(([y, w, v], i) => `${i ? 'L' : 'M'}${X(xi.get(y * 100 + w)).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    const years = [...new Set(keys.map(k => Math.floor(k / 100)))].filter((y, i, a) => a.length < 8 || (y - a[0]) % 3 === 0);
    const grid = [];
    for (let v = lo; v <= hi; v += 50) grid.push(v);
    return `<svg class="elo" viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Elo rating over time">
      ${grid.map(v => `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" class="gl${v === 1500 ? ' mid' : ''}"/><text x="${padL - 6}" y="${Y(v) + 3}" class="ax" text-anchor="end">${v}</text>`).join('')}
      ${Object.keys(H).filter(m => m !== sel.a && m !== sel.b).map(m => `<path d="${path(m)}" class="o"/>`).join('')}
      ${H[sel.b] ? `<path d="${path(sel.b)}" class="b"/>` : ''}${H[sel.a] ? `<path d="${path(sel.a)}" class="a"/>` : ''}
      ${years.map(y => `<text x="${X(xi.get(keys.find(k => Math.floor(k / 100) === y)))}" y="${Ht - 6}" class="ax" text-anchor="middle">${y}</text>`).join('')}</svg>`;
  }

  function eloView() {
    const now = ELO.now, pk = ELO.peak;
    const active = Object.keys(now).filter(m => D.active.has(m)).sort((a, b) => now[b] - now[a]);
    const tile = (m, cls) => `<div class="ft-tile ${cls}"><div class="ft-tl">${esc(m)} now</div><div class="ft-tv">${Math.round(now[m])}</div>
      <div class="ft-ts">Peak ${Math.round(pk[m][0])}, ${pk[m][1]} Wk ${pk[m][2]}${active.includes(m) ? ` · #${active.indexOf(m) + 1} today` : ' · Former'}</div></div>`;
    return `<div class="glass"><div class="panel-title">Manager Elo <span class="ft-chip">Every game since ${D.years[0]}</span></div>
      <div class="ft-note">Tap two names to compare. Gold is the first, blue the second.</div>
      <div class="ft-body"><div class="elo-pick">${active.map(m => `<button type="button" data-hfm="${esc(m)}" class="${m === sel.a ? 'on' : m === sel.b ? 'on2' : ''}">${esc(m)}</button>`).join('')}</div>
      ${chart()}
      <div class="ft-tiles" style="--n:2">${tile(sel.a, 'lead')}${tile(sel.b, 'tile-b')}</div>
      <div class="hf-note">Everyone starts at 1500 and trades points each game. Beating a stronger team moves you more, playoff games count 1.5×, and a quarter of each rating drifts back to 1500 between seasons. Median games don’t count.</div></div></div>`;
  }

  const inner = () => `<div class="seg hf-views" role="tablist" aria-label="Hall of Fame">${VIEWS.map(([k, l]) => `<button type="button" role="tab" data-hfv="${k}" class="${k === view ? 'on' : ''}" aria-selected="${k === view}">${l}</button>`).join('')}</div>${view === 'legacy' ? legacyView() : eloView()}`;
  function redraw() { const root = document.getElementById('hof-root'); if (root) root.innerHTML = inner(); }

  document.addEventListener('click', e => {
    if (!e.target.closest || !e.target.closest('#hof-root')) return;
    const v = e.target.closest('[data-hfv]');
    if (v) { view = v.dataset.hfv; redraw(); return; }
    const b = e.target.closest('[data-hfm]');
    if (b) {
      const m = b.dataset.hfm;
      if (m === sel.a) return;
      sel.b = sel.a; sel.a = m;
      redraw();
    }
  });

  function html(data) {
    if (data !== D) {
      D = data;
      LEG = legacy();
      ELO = elo();
      const active = Object.keys(ELO.now).filter(m => D.active.has(m)).sort((a, b) => ELO.now[b] - ELO.now[a]);
      const me = typeof getMe === 'function' ? getMe() : '';
      sel.a = active.includes(me) ? me : active[0];
      sel.b = active.find(m => m !== sel.a);
    }
    return `<div id="hof-root">${inner()}</div>`;
  }
  return { html, setView: v => { if (VIEWS.some(([k]) => k === v)) view = v; } };
})();
