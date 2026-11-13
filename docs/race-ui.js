// Playoff Race (site audit III #2, IV #2, VI #10), now Standings' Race tab
// (audit X #9; race.html only forwards there). The simulation is the site's
// one, in race-sim.js, so these odds match every other page. Pick winners in
// any week left (the week strip) and the rest of the season is replayed
// 6,000 times. Nothing is gold until you pick: a pick outlines the winner,
// and each side's button carries its current odds.
//
// RaceUI.draw(el, live) draws into el from the Worker's dashboard payload
// and keeps the picks while the same week is shown. Needs race-sim.js,
// page-common.js (esc, isMe, pageLink) and features.css (rc-*, ft-*).
const RaceUI = (() => {
  const pct = RaceSim.pct; // never 100% / 0% until settled (audit X #2)
  const RUNS = RaceSim.RUNS;
  let EL = null, LIVE = null, KEY = null;
  let INP, TEAMS, base, sched, PICK_WEEK, SPOTS, BYES, N, BASELINE;
  const picks = {};              // "week|a|b" -> winner
  let wkSel = null;              // the week the pick card shows
  const picked = w => Object.keys(picks).filter(k => k.startsWith(w + '|')).length;
  const simulate = (n, force) => RaceSim.simulate(INP, n, picks, force);

  function setup(live) {
    INP = RaceSim.inputs(live);
    if (!INP) return false;
    ({ teams: TEAMS, base, sched, pickWeek: PICK_WEEK, spots: SPOTS, byes: BYES } = INP);
    N = TEAMS.length;
    return true;
  }

  function render() {
    if (!EL || !document.body.contains(EL)) return;
    const n = Object.keys(picks).length;
    const res = n ? simulate(RUNS) : BASELINE;
    const order = TEAMS.slice().sort((a, b) => (res[b].po - res[a].po) || (res[a].sacko - res[b].sacko));
    if (!sched.some(s => s.w === wkSel)) wkSel = sched[0].w;
    const pk = sched.find(s => s.w === wkSel);
    const swing = TEAMS.map(t => ({ t, d: (BASELINE[t].ifWin ?? 0) - (BASELINE[t].ifLoss ?? 0) })).filter(x => BASELINE[x.t].ifWin != null && BASELINE[x.t].ifLoss != null).sort((a, b) => b.d - a.d).slice(0, 3);
    const rec = t => `${base[t].w}-${base[t].l}`;
    // Your path (audit IV #12): the records your season ends on most often, and how often each one makes it.
    const meT = TEAMS.find(t => isMe(t));
    let pathCard = '';
    if (meT && res[meT].fw) {
      const total = INP.reg * 2, fw = res[meT].fw;
      const share = k => fw[k][0] / RUNS;
      const common = Object.keys(fw).map(Number).sort((a, b) => share(b) - share(a)).slice(0, 6).sort((a, b) => b - a);
      pathCard = `<div class="glass ft-sec"><div class="panel-title">Your path <span class="ft-chip">${rec(meT)} now</span></div>
        <div class="ft-note">Your playoff odds for each record you could finish with, and how often the season ends there.</div>
        <div class="ft-body"><div class="ft-tiles rc-path">${common.map(k => {
          const p = fw[k][1] * 100 / fw[k][0], tone = p >= 90 ? ' good' : p <= 10 ? ' bad' : '';
          return `<div class="ft-tile${tone}"><div class="ft-tl">${k}-${total - k}</div><div class="ft-tv">${pct(p)}</div><div class="ft-ts">${Math.max(1, Math.round(share(k) * 100))}% of seasons</div></div>`;
        }).join('')}</div></div></div>`;
    }
    // You, pinned on top: your odds with every pick so far, and the change from today.
    const youCard = meT ? (() => {
      const d = res[meT].po - BASELINE[meT].po;
      return `<div class="glass rc-you me"><div><div class="rc-you-v">${pct(res[meT].po)}${n && Math.abs(d) >= 0.5 ? `<span class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${Math.round(Math.abs(d))}</span>` : ''}</div>
        <div class="rc-you-s">Your playoff odds${n ? ` with ${n} pick${n === 1 ? '' : 's'}` : ''}</div></div><button type="button" class="ft-btn sm" data-reset${n ? '' : ' disabled'}>Reset</button></div>`;
    })() : '';
    const btn = (k, side, other) => {
      const on = picks[k] === side;
      return `<button type="button" data-k="${esc(k)}" data-v="${esc(on ? '' : side)}" class="${on ? 'on' : ''}${picks[k] === other ? ' off' : ''}${isMe(side) ? ' you' : ''}" aria-pressed="${on}"><span class="nm">${esc(side)}</span><span class="pc">${pct(res[side].po)}</span></button>`;
    };
    EL.innerHTML = `<div class="rc-intro">Pick winners in any week left, or leave a game open. Each pick replays the rest of the season ${RUNS.toLocaleString('en-US')} times.</div>
      ${youCard}
      <div class="rc-weeks" role="tablist" aria-label="Week">${sched.map(s => `<button type="button" role="tab" data-wk="${s.w}" class="${s.w === wkSel ? 'on' : ''}" aria-selected="${s.w === wkSel}">Wk ${s.w}${picked(s.w) ? `<span class="ct">${picked(s.w)}</span>` : ''}</button>`).join('')}</div>
      <div class="rc-grid"><div>
        <div class="glass"><div class="panel-title">Week ${wkSel} ${meT ? (picked(wkSel) ? `<button type="button" class="ft-btn sm" data-clear="${wkSel}">Clear week</button>` : '<span class="ft-chip">Tap a winner</span>') : `<button type="button" class="ft-btn sm" data-reset${n ? '' : ' disabled'}>Reset</button>`}</div>
          <div class="ft-body">${pk.pairs.map(([a, b]) => {
            const k = wkSel + '|' + a + '|' + b;
            return `<div class="rc-pick">${btn(k, a, b)}<span class="vs">vs</span>${btn(k, b, a)}</div>`;
          }).join('')}</div></div>
        ${swing.length ? `<div class="glass ft-sec"><div class="panel-title">Most riding on Week ${PICK_WEEK}</div>
          <div class="ft-note">Each team’s playoff odds with a win and with a loss.</div>
          <div class="ft-body">${swing.map(({ t, d }) => `<div class="ft-item rc-sw"><b>${esc(t)}</b>
            <div class="rc-sw-r"><span>Win <b class="turf">${pct(BASELINE[t].ifWin)}</b></span><span>Lose <b class="lossc">${pct(BASELINE[t].ifLoss)}</b></span><span>${Math.round(d)} pts</span></div></div>`).join('')}</div></div>` : ''}
        ${pathCard}
      </div><div>
        <div class="glass"><div class="panel-title">Odds <span class="ft-chip">${RUNS.toLocaleString('en-US')} seasons</span></div>
          <div class="ft-body"><div class="rc-head"><span></span><span>Playoffs</span><span>Bye</span><span>Sacko</span></div>
          <div class="rc-list">${order.map((t, i) => {
            const r = res[t], d = r.po - BASELINE[t].po;
            return `<a class="ft-item rc-tr${isMe(t) ? ' me' : ''}" href="${esc(pageLink('franchise.html', { m: t }))}">
              <div><b>${esc(t)}</b><span class="sub">${rec(t)}</span></div>
              <div class="rc-v"><span class="oddp ${r.po >= 50 ? 'good' : 'bad'}">${pct(r.po)}</span>${Math.abs(d) >= 0.5 && n ? `<em class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' : '−'}${Math.round(Math.abs(d))}</em>` : ''}</div>
              <div class="rc-v sm">${BYES ? pct(r.bye) : '—'}</div>
              <div class="rc-v sm${r.sacko >= 25 ? ' red' : ''}">${pct(r.sacko)}</div></a>${i === SPOTS - 1 ? PLAYOFF_LINE : ''}`;
          }).join('')}</div></div></div>
      </div></div>
      <div class="rc-foot">Each team scores like its average so far, pulled toward the league’s. Ties go to points scored, the league’s rule. The Sacko column is the chance of finishing ${N - 1}th or ${N}th, which since 2025 means playing in the Sacko game. These are the same odds the rest of the site shows.</div>`;
  }

  // Redraws, then puts focus back on the control that was tapped.
  const again = sel => { render(); const el = sel && EL && EL.querySelector(sel); if (el) el.focus({ preventScroll: true }); };
  document.addEventListener('click', e => {
    if (!EL || !EL.contains(e.target)) return;
    const b = e.target.closest('[data-k]');
    if (b) { if (b.dataset.v) picks[b.dataset.k] = b.dataset.v; else delete picks[b.dataset.k]; again(`[data-k="${CSS.escape(b.dataset.k)}"]${picks[b.dataset.k] ? '.on' : ''}`); return; }
    const w = e.target.closest('[data-wk]');
    if (w) { wkSel = Number(w.dataset.wk); again(`[data-wk="${wkSel}"]`); return; }
    const c = e.target.closest('[data-clear]');
    if (c) { Object.keys(picks).filter(k => k.startsWith(c.dataset.clear + '|')).forEach(k => delete picks[k]); render(); return; }
    if (e.target.closest('[data-reset]')) { Object.keys(picks).forEach(k => delete picks[k]); render(); }
  });

  // Draws into el. The same week again keeps your picks; a new one starts over.
  function draw(el, live) {
    EL = el;
    const key = live ? `${live.week}|${live.updatedAt || ''}` : null;
    if (live !== LIVE || key !== KEY) {
      LIVE = live; KEY = key;
      if (!setup(live) || !sched.length || !sched[0].pairs.length) {
        BASELINE = null;
        el.innerHTML = '<div class="glass"><div class="ft-empty">The regular season is over, so there’s nothing left to pick. See the Bracket tab.</div></div>';
        return false;
      }
      const weekNow = `${live.week}`;
      if (draw.week !== weekNow) { Object.keys(picks).forEach(k => delete picks[k]); wkSel = null; draw.week = weekNow; }
      BASELINE = simulate(RUNS, true);
    } else if (!BASELINE) {
      el.innerHTML = '<div class="glass"><div class="ft-empty">The regular season is over, so there’s nothing left to pick. See the Bracket tab.</div></div>';
      return false;
    }
    render();
    return true;
  }
  return { draw };
})();
