// Rivals (personalization, 2026-10): who beats you most and who you beat
// most, and the little sheet that shows you against any manager.
//
// One file for two readers. The site loads it as a plain script (the standings
// tags, the tap-a-name sheet) and the Worker imports it (worker/src/push.js,
// the Rival alerts), so the rule for who counts can't drift apart. The rules
// are franchise.json's own (generate_franchise_data_d1.py compute_rivalries):
// every head-to-head game counts, whatever its type; a tie counts for neither
// side; at least 3 games; only managers in this season's league. Your Daddy is
// the one you do worst against, Your Bitch the one you do best against, and
// managers tied at the top of either are all named.
//
// Everything above "the sheet" is plain data with no DOM or fetching.
const Rivals = (() => {
  const MIN_GAMES = 3;
  const LABEL = { daddy: 'Your Daddy', bitch: 'Your Bitch' };

  // rows: [{ year, week, type, p1, p2, s1, s2, winner }] (league.json games)
  // active: this season's managers.
  function build(rows, active) {
    const games = rows
      .filter(g => g.p1 && g.p2 && g.type !== 'Bye' && g.winner !== 'In Progress' && g.s1 != null && g.s2 != null && g.s1 !== g.s2)
      .sort((a, b) => a.year - b.year || a.week - b.week);
    const pairs = new Map();
    for (const g of games) {
      const k = [g.p1, g.p2].sort().join('|');
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k).push(g);
    }
    const activeSet = new Set(active);

    // You against one manager, optionally only before a week ({ year, week }).
    // null when you've never met.
    function rec(a, b, before) {
      const list = (pairs.get([a, b].sort().join('|')) || [])
        .filter(g => !before || g.year < before.year || (g.year === before.year && g.week < before.week));
      if (!list.length) return null;
      let w = 0, l = 0, sum = 0, bigW = null, bigL = null;
      const form = [];
      for (const g of list) {
        const m = g.p1 === a ? g.s1 - g.s2 : g.s2 - g.s1;
        sum += m;
        form.push(m > 0 ? 'W' : 'L');
        if (m > 0) { w++; if (!bigW || m > bigW.m) bigW = { m, year: g.year, week: g.week }; }
        else { l++; if (!bigL || -m > bigL.m) bigL = { m: -m, year: g.year, week: g.week }; }
      }
      const last = form[form.length - 1];
      let n = 0;
      for (let i = form.length - 1; i >= 0 && form[i] === last; i--) n++;
      return { w, l, n: w + l, pct: w / (w + l), form: form.slice(-5), streak: { kind: last, n }, avg: sum / list.length, bigW, bigL };
    }

    // Everyone you've played at least MIN_GAMES times this season's league.
    const cache = new Map();
    function of(me) {
      if (cache.has(me)) return cache.get(me);
      const rows = [...activeSet].filter(o => o !== me).map(o => ({ o, r: rec(me, o) })).filter(x => x.r && x.r.n >= MIN_GAMES);
      let out = { daddy: [], bitch: [] };
      if (rows.length) {
        const key = x => Math.round(x.r.pct * 1e6);
        const lo = Math.min(...rows.map(key)), hi = Math.max(...rows.map(key));
        out = {
          daddy: rows.filter(x => key(x) === lo).map(x => x.o),
          bitch: rows.filter(x => key(x) === hi && key(x) !== lo).map(x => x.o),
        };
      }
      cache.set(me, out);
      return out;
    }
    // 'daddy', 'bitch' or null: what `opp` is to `me`.
    const kind = (me, opp) => { const r = of(me); return r.daddy.includes(opp) ? 'daddy' : r.bitch.includes(opp) ? 'bitch' : null; };
    return { rec, of, kind };
  }

  const word = (r) => (r.streak.n === 1 ? `${r.streak.kind === 'W' ? 'won' : 'lost'} the last one` : `${r.streak.kind === 'W' ? 'won' : 'lost'} the last ${r.streak.n}`);

  // ---------- the site's half: standings tag, tap-a-name sheet ----------
  // Everything below touches the page only when called.
  let loading = null, book = null;
  // The league.json history, built once. Resolves to the book, or null when
  // it can't be read (the tags and the sheet just don't appear).
  function ready() {
    if (!loading) {
      loading = fetch('data/league.json', { cache: 'no-cache' }).then(r => r.json()).then(d => {
        const rows = d.games.map(g => ({ year: g[0], week: g[1], type: g[2], p1: g[3], p2: g[4], s1: g[5], s2: g[6], winner: g[7] }));
        const year = Math.max(...d.seasons.map(s => s.year));
        book = build(rows, d.seasons.filter(s => s.year === year).map(s => s.player));
        return book;
      }).catch(err => { console.error('Rivals:', err); loading = null; return null; });
    }
    return loading;
  }

  // "Your Daddy" / "Your Bitch" on a standings row, in your ring color; ''
  // for your own row, a manager who is neither, or before the history lands.
  function pill(name) {
    if (!book || typeof getMe !== 'function') return '';
    const me = getMe();
    if (!me || !name || isMe(name)) return '';
    const k = book.kind(me, name);
    return k ? `<span class="rv-tag">${LABEL[k]}</span>` : '';
  }

  // The streak and margins as a sentence-sized stat box.
  const box = (label, big, sub) => `<div class="rv-box"><small>${label}</small><b>${big}</b><span>${sub}</span></div>`;
  const at = x => `${x.year} Wk ${x.week}`;

  let lastFocus = null;
  function closeSheet() {
    document.getElementById('rv-sheet')?.remove();
    document.getElementById('rv-scrim')?.remove();
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  const onKey = e => { if (e.key === 'Escape') closeSheet(); };

  // You against `name`, in a sheet. Needs getMe(); a no-op without it.
  async function openSheet(name) {
    const me = getMe();
    if (!me || !name || isMe(name) || document.getElementById('rv-sheet')) return;
    lastFocus = document.activeElement;
    await ready();
    if (document.getElementById('rv-sheet')) return;
    const r = book ? book.rec(me, name) : null;
    const mono = (n, you) => `<span class="rv-mono${you ? ' me' : ''}">${esc(monogram(n))}</span>`;
    const head = `<div class="rv-vs">
        <div class="rv-side">${mono(me, true)}<b>You</b></div>
        <div class="rv-rec">${r ? `${r.w}–${r.l}<small>${Math.round(r.pct * 100)}% for you</small>` : '–<small>never met</small>'}</div>
        <div class="rv-side">${mono(name, false)}<b>${esc(name)}</b></div>
      </div>`;
    const body = r ? `
      <div class="rv-form" aria-label="Last ${r.form.length} meetings, oldest first">${r.form.map(f => `<i class="${f}">${f}</i>`).join('')}</div>
      <div class="rv-grid">
        ${box('Streak', `${r.streak.kind}${r.streak.n}`, `${r.streak.kind === 'W' ? 'you' : esc(name)} ${r.streak.n === 1 ? 'won the last one' : 'won the last ' + r.streak.n}`)}
        ${box('Avg margin', `${r.avg >= 0 ? '+' : '−'}${Math.abs(r.avg).toFixed(1)}`, r.avg >= 0 ? 'in your favor' : 'in their favor')}
        ${box('Your best', r.bigW ? `+${r.bigW.m.toFixed(1)}` : '–', r.bigW ? at(r.bigW) : 'never beaten')}
        ${box('Their best', r.bigL ? `+${r.bigL.m.toFixed(1)}` : '–', r.bigL ? at(r.bigL) : 'never beaten you')}
      </div>` : '<div class="rv-none">You two have never played each other.</div>';
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="rv-scrim"></div>
      <div class="sheet rv-sheet" id="rv-sheet" role="dialog" aria-modal="true" aria-label="You against ${esc(name)}" tabindex="-1">
        <div class="sheet-grab"><span></span></div>
        <div class="sheet-body">
          ${head}${body}
          <a class="rv-go" href="${esc(pageLink('head-to-head.html', { a: me, b: name }))}">Open Head to Head</a>
          <a class="rv-go ghost" href="${esc(pageLink('franchise.html', { m: name }))}">Open ${esc(name)}'s Franchise Page</a>
          <button type="button" class="rv-done">Done</button>
        </div>
      </div>`);
    const sheet = document.getElementById('rv-sheet');
    document.getElementById('rv-scrim').addEventListener('click', closeSheet);
    sheet.querySelector('.rv-done').addEventListener('click', closeSheet);
    document.addEventListener('keydown', onKey);
    sheet.focus({ preventScroll: true });
  }

  return { build, ready, pill, openSheet, closeSheet, word, LABEL, get book() { return book; } };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Rivals;
