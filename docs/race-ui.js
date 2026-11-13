// Playoff Race (site audit III #2, IV #2, VI #10), now Standings' Race tab
// (audit X #9; race.html only forwards there). The simulation is the site's
// one, in race-sim.js, so these odds match every other page. Pick winners in
// any week left (the week strip) and the rest of the season is replayed
// 6,000 times. Nothing is gold until you pick: a pick outlines the winner,
// and each side's button carries its current odds.
//
// RaceUI.draw(el, live, ctx) draws into el from the Worker's dashboard
// payload and keeps the picks while the same week is shown. ctx: { games,
// year, medianFrom } for the week-by-week chart (audit X #15). Also shows
// title odds and what each team can expect to win (audit X #14), from
// data/rule-changes.json's payouts. Needs race-sim.js, page-common.js (esc,
// isMe, pageLink) and features.css (rc-*, ft-*).
const RaceUI = (() => {
  const pct = RaceSim.pct; // never 100% / 0% until settled (audit X #2)
  const RUNS = RaceSim.RUNS;
  let EL = null, LIVE = null, KEY = null, CTX = null, OPTS = null, histPick = null;
  // The season's payouts (Rule Changes), once: { first, second, third, week, season }.
  let PAY = null;
  const payP = fetch('data/rule-changes.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).then(rc => {
    const list = (rc && rc.current && rc.current.payouts) || [];
    const amt = re => { const x = list.find(p => re.test(p.label)); return x ? x.amount : 0; };
    PAY = { first: amt(/^1st/), second: amt(/^2nd/), third: amt(/^3rd/), week: amt(/week/i), season: amt(/season/i), buyIn: (rc && rc.current && rc.current.buy_in) || 0 };
  }).catch(() => { PAY = {}; });
  let INP, TEAMS, base, sched, PICK_WEEK, SPOTS, BYES, N, BASELINE;
  const picks = {};              // "week|a|b" -> winner
  let wkSel = null;              // the week the pick card shows
  const picked = w => Object.keys(picks).filter(k => k.startsWith(w + '|')).length;
  const simulate = (n, force) => RaceSim.simulate(INP, n, picks, force, OPTS);
  const money = v => '$' + Math.round(v).toLocaleString('en-US');

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
    // Your path (audit IV #12): the record it takes, the same three finishes
    // your profile shows (audit X #5, XI #12): centred on the first one
    // that's better than even, one either side, with what you need from here.
    const meT = TEAMS.find(t => isMe(t));
    let pathCard = '';
    if (meT && res[meT].fw) {
      const total = INP.reg * 2, fw = res[meT].fw, have = base[meT].w, had = base[meT].l;
      const ks = Object.keys(fw).map(Number).filter(k => fw[k][0] >= RUNS * 0.005).sort((a, b) => a - b);
      const k50 = ks.find(k => fw[k][1] / fw[k][0] >= 0.5);
      const pick = k50 == null ? [] : [k50 - 1, k50, k50 + 1].filter(k => fw[k]);
      if (pick.length) pathCard = `<div class="glass ft-sec"><div class="panel-title">Your path <span class="ft-chip">${rec(meT)} now</span></div>
        <div class="ft-note">The record it takes: your playoff odds at each finish, and what you need from here.</div>
        <div class="ft-body"><div class="ft-tiles rc-path" style="--n:${pick.length}">${pick.map(k => {
          const p = fw[k][1] * 100 / fw[k][0], tone = p >= 90 ? ' good' : p <= 10 ? ' bad' : k === k50 ? ' lead' : '';
          return `<div class="ft-tile${tone}"><div class="ft-tl">At ${k}-${total - k}</div><div class="ft-tv">${pct(p)}</div><div class="ft-ts">${k - have}-${total - k - had} from here</div></div>`;
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
        ${moneyHtml(res, order)}
      </div></div>
      ${histHtml()}
      <div class="rc-foot">Each team scores like its average so far, pulled toward the league’s. Ties go to points scored, the league’s rule. The Sacko column is the chance of finishing ${N - 1}th or ${N}th, which since 2025 means playing in the Sacko game. These are the same odds the rest of the site shows.</div>`;
  }

  // Title odds and the money (audit X #14): the bracket played out on every
  // simulated season, and what's already up for grabs.
  function moneyHtml(res, order) {
    if (!PAY || !PAY.first) return '';
    const L = LIVE, rows = TEAMS.slice().sort((a, b) => res[b].title - res[a].title || res[b].po - res[a].po);
    const pfs = (L.teams || []).map(t => ({ m: t.manager, pf: t.pointsFor || 0 })).sort((a, b) => b.pf - a.pf);
    const hi = L.priorSeasonHigh;
    const lines = [
      hi && PAY.week ? `<div class="rc-ml"><div><b>High week · ${money(PAY.week)}</b><span>${esc(hi.manager)} ${hi.score.toFixed(2)}, Week ${hi.week}</span></div><em>${esc(hi.manager)}</em></div>` : '',
      pfs.length > 1 && PAY.season ? `<div class="rc-ml"><div><b>Season points · ${money(PAY.season)}</b><span>${esc(pfs[0].m)} ${pfs[0].pf.toFixed(2)} · ${esc(pfs[1].m)} is ${(pfs[0].pf - pfs[1].pf).toFixed(2)} back</span></div><em>${esc(pfs[0].m)}</em></div>` : '',
      `<div class="rc-ml"><div><b>1st ${money(PAY.first)}${PAY.second ? ` · 2nd ${money(PAY.second)}` : ''}${PAY.third ? ` · 3rd ${money(PAY.third)}` : ''}</b><span>Decided in the playoffs</span></div></div>`,
    ].join('');
    return `<div class="glass ft-sec"><div class="panel-title">Title odds and the money <span class="ft-chip">${RUNS.toLocaleString('en-US')} seasons</span></div>
      <div class="ft-body"><div class="rc-mls">${lines}</div>
      <div class="rc-head rc-mh"><span></span><span>Title</span><span>Expected</span></div>
      <div class="rc-list">${rows.map(t => `<a class="ft-item rc-tr rc-mr${isMe(t) ? ' me' : ''}" href="${esc(pageLink('franchise.html', { m: t }))}">
        <div><b>${esc(t)}</b><span class="sub">final ${pct(res[t].final)} · playoffs ${pct(res[t].po)}</span></div>
        <div class="rc-v"><span class="oddp ${res[t].title >= 10 ? 'good' : ''}">${pct(res[t].title)}</span></div>
        <div class="rc-v rc-ev">${money(res[t].ev)}</div></a>`).join('')}</div>
      <div class="ft-note" style="padding:0 2px">Expected is what a team wins on average across the simulated seasons, prizes included${PAY.buyIn ? `, against the ${money(PAY.buyIn)} buy-in` : ''}. Playoff games are played at each team's average.</div></div></div>`;
  }

  // Playoff odds after every week (audit X #15): yours (or the one picked)
  // over everyone else's in grey.
  function histHtml() {
    if (!CTX || !CTX.games) return '';
    const H = RaceSim.history(LIVE, CTX.games, CTX.year, CTX.medianFrom);
    if (!H) return '';
    const sel = histPick && H[histPick] ? histPick : TEAMS.find(t => isMe(t)) || TEAMS.slice().sort((a, b) => BASELINE[b].po - BASELINE[a].po)[0];
    const v = H[sel], n = v.length;
    if (n < 2) return '';
    const W = 600, Ht = 230, Lp = 36, Rp = 44, Tp = 12, Bp = 24;
    const x = i => Lp + i * (W - Lp - Rp) / (n - 1), y = p => Tp + (100 - p) * (Ht - Tp - Bp) / 100;
    const line = m => H[m].map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
    let hiI = 0, loI = 0, sw = 1;
    v.forEach((p, i) => { if (p > v[hiI]) hiI = i; if (p < v[loI]) loI = i; if (i && Math.abs(p - v[i - 1]) > Math.abs(v[sw] - v[sw - 1])) sw = i; });
    const wk = i => (i ? `Week ${i}` : 'the draft');
    // One picker in the title and tappable lines instead of twelve name
    // chips (audit XI #11); the line ends sit too close for name labels.
    return `<div class="glass ft-sec rc-hist"><div class="panel-title">Playoff odds, week by week <select class="lg-select rc-hsel" data-hist-sel aria-label="Whose odds">${TEAMS.map(t => `<option value="${esc(t)}"${t === sel ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="ft-body"><div class="rc-hc"><svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="${esc(sel)}'s playoff odds after each week: ${v.map(p => pct(p)).join(', ')}">
        ${[0, 25, 50, 75, 100].map(g => `<line x1="${Lp}" x2="${W - Rp}" y1="${y(g)}" y2="${y(g)}" class="${g === 50 ? 'mid' : 'gl'}"/><text x="${Lp - 6}" y="${y(g) + 3.5}" text-anchor="end">${g}%</text>`).join('')}
        ${v.map((_, i) => `<text x="${x(i)}" y="${Ht - 6}" text-anchor="middle">${i ? i : 'Draft'}</text>`).join('')}
        ${TEAMS.filter(t => t !== sel && H[t]).map(t => `<polyline class="o" points="${line(t)}"/>`).join('')}
        ${TEAMS.filter(t => t !== sel && H[t]).map(t => `<polyline class="hit" data-hist="${esc(t)}" points="${line(t)}"><title>${esc(t)}</title></polyline>`).join('')}
        <polyline class="a${isMe(sel) ? ' you' : ''}" points="${line(sel)}"/>
        ${v.map((p, i) => `<circle class="d${isMe(sel) ? ' you' : ''}" cx="${x(i)}" cy="${y(p)}" r="${i === n - 1 ? 5 : 3.5}"><title>${esc(sel)} after ${wk(i)}: ${pct(p)}</title></circle>`).join('')}
        <text x="${x(n - 1) + 9}" y="${y(v[n - 1]) + 4}" class="end">${pct(v[n - 1])}</text>
      </svg></div>
      <div class="ft-note" style="padding:0 2px"><b>${esc(sel)}</b>: high ${pct(v[hiI])} after ${wk(hiI)}, low ${pct(v[loI])} after ${wk(loI)}. Biggest swing: Week ${sw}, ${pct(v[sw - 1])} to ${pct(v[sw])}. Tap a dot for its week, or a grey line to follow that team.</div></div></div>`;
  }

  // Redraws, then puts focus back on the control that was tapped.
  const again = sel => { render(); const el = sel && EL && EL.querySelector(sel); if (el) el.focus({ preventScroll: true }); };
  document.addEventListener('change', e => {
    const s = e.target.closest && e.target.closest('[data-hist-sel]');
    if (!s || !EL || !EL.contains(s)) return;
    histPick = s.value; again('[data-hist-sel]');
  });
  document.addEventListener('click', e => {
    if (!EL || !EL.contains(e.target)) return;
    if (e.target.closest('[data-hist-sel]')) return;
    const b = e.target.closest('[data-k]');
    if (b) { if (b.dataset.v) picks[b.dataset.k] = b.dataset.v; else delete picks[b.dataset.k]; again(`[data-k="${CSS.escape(b.dataset.k)}"]${picks[b.dataset.k] ? '.on' : ''}`); return; }
    const hp = e.target.closest('[data-hist]');
    if (hp) { histPick = hp.dataset.hist; again(`[data-hist="${CSS.escape(histPick)}"]`); return; }
    const w = e.target.closest('[data-wk]');
    if (w) { wkSel = Number(w.dataset.wk); again(`[data-wk="${wkSel}"]`); return; }
    const c = e.target.closest('[data-clear]');
    if (c) { Object.keys(picks).filter(k => k.startsWith(c.dataset.clear + '|')).forEach(k => delete picks[k]); render(); return; }
    if (e.target.closest('[data-reset]')) { Object.keys(picks).forEach(k => delete picks[k]); render(); }
  });

  // Draws into el. The same week again keeps your picks; a new one starts over.
  function draw(el, live, ctx) {
    EL = el;
    if (ctx) CTX = ctx;
    OPTS = { bracket: true, pay: PAY || {}, high: live && live.priorSeasonHigh ? { score: live.priorSeasonHigh.score, manager: live.priorSeasonHigh.manager } : null };
    if (!PAY) payP.then(() => { KEY = null; if (EL && document.body.contains(EL)) draw(EL, LIVE, CTX); });
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
