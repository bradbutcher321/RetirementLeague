// Shared navigation (site audit III #10), injected into
// <div id="site-nav"></div> on every page. Five places plus You: a tab bar
// along the bottom of a phone, where the thumb already is, and the same
// five as links in a top bar at 1080px and up, with search beside them
// (⌘K or /). Every history page hangs off History, a hub with one search
// box (history.html). The lists live here in exactly one place, so adding
// a page means adding one entry to HISTORY rather than editing every file.
(function () {
  const SVG = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
  const ICONS = {
    feed: SVG('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
    live: SVG('<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>'),
    ticket: SVG('<path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4V7z"/><path d="M14 7v10" stroke-dasharray="2 2.2"/>'),
    list: SVG('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/>'),
    book: SVG('<path d="M12 6.5C10.3 5.2 7.6 4.6 4 4.8v13.4c3.6-.2 6.3.4 8 1.8 1.7-1.4 4.4-2 8-1.8V4.8c-3.6-.2-6.3.4-8 1.7z"/><path d="M12 6.5V20"/>'),
    person: SVG('<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>'),
    search: SVG('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>', ' stroke-width="2.2"'),
    chart: SVG('<path d="M4 19h16"/><path d="m5 15 4-5 4 3 6-7"/>'),
    people: SVG('<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.7-3.2 2.9-4.9 5.5-4.9s4.8 1.7 5.5 4.9"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.6 14.3c2.3.1 4.2 1.6 4.9 4.7"/>'),
    shield: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8 19 5.6v5.1c0 5.2-3.5 8.5-7 9.5-3.5-1-7-4.3-7-9.5V5.6l7-2.8z"/></svg>',
    grid: SVG('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
    cal: SVG('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    play: SVG('<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="m10 9.5 4.5 2.5-4.5 2.5z" fill="currentColor"/>'),
    swap: SVG('<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>'),
    trophy: SVG('<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7"/>'),
    jersey: SVG('<path d="M8.5 4 4 6.2l1.6 4 2.4-1V20h8V9.2l2.4 1 1.6-4L15.5 4a3.6 3.6 0 0 1-7 0z"/>'),
    flag: SVG('<path d="M5 21V4M5 5h12l-2.5 3.8L17 12.5H5"/>'),
    pen: SVG('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"/><path d="M14 7l3 3"/>'),
    clip: SVG('<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3.5h6v1M8.5 10h7M8.5 13.5h7M8.5 17h4"/>'),
    spark: SVG('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  };

  // The tab bar, left to right. `pages` are the files that light a tab up;
  // anything not listed (every history page) lights History.
  const TABS = [
    { key: 'live', href: 'index.html', label: 'Live', icon: ICONS.live, pages: ['index.html', 'secret-santa.html'] },
    { key: 'feed', href: 'feed.html', label: 'Feed', icon: ICONS.feed, pages: ['feed.html'] },
    { key: 'parlay', href: 'parlay-results.html', label: 'Parlay', icon: ICONS.ticket, pages: ['parlay-results.html', 'parlay-legs.html'] },
    { key: 'standings', href: 'standings.html', label: 'Standings', icon: ICONS.list, pages: ['standings.html'] },
    { key: 'history', href: 'history.html', label: 'History', icon: ICONS.book, pages: [] },
  ];
  // Pages that belong to no tab, so none lights up.
  const NO_TAB = ['commissioner.html', 'you.html'];
  // Pages that keep their eyebrow instead of a back link: Secret Santa lights
  // the Live tab, which already goes back to Live.
  const NO_BACK = ['secret-santa.html'];
  // The History hub's tiles (history.html). `group` files each under a heading;
  // the tiles show in the order below within it.
  const HISTORY = [
    { href: 'column.html', label: 'The Column', sub: 'Tuesday recap, Thursday preview', icon: ICONS.pen, group: 'This season' },
    { href: 'overview.html', label: 'League History', sub: 'Champions, timeline, leaderboards', icon: ICONS.book, group: 'Records' },
    { href: 'game-records.html', label: 'Game Records', sub: 'Every single-game record', icon: ICONS.chart, group: 'Records' },
    { href: 'head-to-head.html', label: 'Head to Head', sub: 'Any two managers', icon: ICONS.people, group: 'Managers' },
    { href: 'franchise.html', label: 'Franchise', sub: 'One manager’s whole career', icon: ICONS.shield, group: 'Managers' },
    { href: 'parlay-stats.html', label: 'Parlay Stats', sub: 'Hit rates, streaks and bet breakdowns', icon: ICONS.ticket, group: 'Records' },
    { href: 'wrapped.html', label: 'Season Wrapped', sub: 'Any manager’s season, told as a story', icon: ICONS.spark, group: 'Managers' },
    { href: 'hall-of-fame.html', label: 'Hall of Fame', sub: 'Legacy points and manager Elo', icon: ICONS.trophy, group: 'Records' },
    { href: 'draft-board.html', label: 'Draft Board', sub: 'Every draft since 2015', icon: ICONS.grid, group: 'Drafts & rules' },
    { href: 'players.html', label: 'Players', sub: 'Every player’s story in this league', icon: ICONS.jersey, group: 'Managers' },
    { href: 'moves.html', label: 'Trades & Waivers', sub: 'Every trade graded, best pickups', icon: ICONS.swap, group: 'This season' },
    { href: 'roster.html', label: 'Your Roster', sub: 'Byes ahead, free agents, position ranks', icon: ICONS.clip, group: 'This season' },
    { href: 'race.html', label: 'Playoff Race', sub: 'Pick winners, watch the odds move', icon: ICONS.flag, group: 'This season' },
    { href: 'rule-changes.html', label: 'Rule Changes', sub: 'How the league has changed', icon: ICONS.cal, group: 'Drafts & rules' },
    { href: 'videos.html', label: 'League Videos', sub: 'Weekly recaps, sign-in required', icon: ICONS.play, group: 'This season' },
  ];

  function currentFile() {
    const last = window.location.pathname.split('/').pop();
    return last === '' ? 'index.html' : last;
  }

  function renderNav() {
    const mount = document.getElementById('site-nav');
    if (!mount) return;

    const file = currentFile();
    noteVisit(file);
    const active = NO_TAB.includes(file) ? '' : (TABS.find(t => t.pages.includes(file)) || TABS.find(t => t.key === 'history')).key;
    // The page you're on is only "current" when it's the tab's own page:
    // Franchise lights History but isn't the History page.
    const cur = t => t.key === active ? ` class="on"${t.href === file ? ' aria-current="page"' : ''}` : '';
    const links = TABS.map(t => `<a${cur(t)} href="${t.href}">${t.label}</a>`).join('');
    const tabs = TABS.map(t => `<a${cur(t)} href="${t.href}" data-tab="${t.key}"><span class="tb-ic">${t.icon}</span><span class="tb-lab">${t.label}</span></a>`).join('');
    // You lives in the title row (headerTools); a page without the usual
    // header keeps it as a sixth tab.
    const titled = !!document.querySelector('.wrap > header h1');

    mount.innerHTML = `
      <div class="nav-bar">
        <a class="nav-brand" href="index.html">Retirement League</a>
        <nav class="nav-links" aria-label="Pages">${links}</nav>
        <div class="nav-end">
          <button class="nav-search" id="nav-search" type="button" aria-label="Search" aria-keyshortcuts="Meta+K Control+K /">${ICONS.search}<kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl '}K</kbd></button>
          <button class="nav-me" id="nav-me" type="button" aria-haspopup="dialog"></button>
        </div>
      </div>
      <nav class="tabbar" aria-label="Pages"><div class="tb-in"><div class="tb-cap">${tabs}${titled ? '' : '<button type="button" class="tb-you" id="tb-you" aria-haspopup="dialog"><span class="tb-ic"></span><span class="tb-lab">You</span></button>'}</div><button type="button" class="tb-search" id="tb-search" aria-label="Search">${ICONS.search}</button></div></nav>`;

    // Tapping History while already on the hub goes to its search box.
    const histTab = mount.querySelector('.tabbar [data-tab="history"]');
    histTab.addEventListener('click', e => {
      const q = document.getElementById('hub-q');
      if (!q) return;
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      q.focus();
    });

    mount.querySelector('#nav-search').addEventListener('click', openSearch);
    document.addEventListener('keydown', e => {
      const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openSearch(); }
      else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openSearch(); }
    });

    // Search on a phone: the circle beside the tab bar. On the History hub,
    // whose page is a search box, it goes to that box.
    mount.querySelector('#tb-search').addEventListener('click', () => {
      const q = document.getElementById('hub-q');
      if (!q) { openSearch(); return; }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      q.focus();
    });

    autoHide(mount.querySelector('.nav-bar'));
    tabbarShrink(mount.querySelector('.tabbar'));
    wireYou(mount.querySelector('#nav-me'));
    wireYouTab(mount.querySelector('#tb-you'));
    headerTools();
    backButton(file);
  }

  // ---------- A way back (site audit VI #2) ----------
  // The Home Screen app has no Back button, so every page under a tab puts
  // one where "Retirement League" was, named for the page you came from:
  // ‹ History, ‹ Standings. The five tab pages keep their label. A short
  // trail of pages lives in sessionStorage; when the page before this one is
  // on the site, the button is history.back(), so the page you return to
  // keeps its scroll and open cards. With no trail (a shared link, a push)
  // it goes to the page's own tab, or the History hub if it has none.
  const TRAIL_KEY = 'rl-trail';
  const TAB_FILES = TABS.map(t => t.href);
  const here = () => currentFile() + location.search;
  function pageName(file) {
    const t = TABS.find(x => x.href === file);
    if (t) return t.label;
    const h = HISTORY.find(x => x.href === file);
    if (h) return h.label;
    const h1 = document.querySelector('.wrap > header h1');
    return h1 ? h1.textContent.trim() : 'Back';
  }
  function noteTrail() {
    let trail = [];
    try { trail = JSON.parse(sessionStorage.getItem(TRAIL_KEY)) || []; } catch (e) {}
    const cur = here(), file = currentFile();
    // Back from the page after this one: drop it. Otherwise this page goes on the end.
    if (trail.length >= 2 && trail[trail.length - 2].f === cur) trail.pop();
    else if (!trail.length || trail[trail.length - 1].f !== cur) trail.push({ f: cur, t: pageName(file) });
    trail = trail.slice(-15);
    try { sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail)); } catch (e) {}
    return trail;
  }
  function backButton(file) {
    const trail = noteTrail();
    if (TAB_FILES.includes(file) || NO_TAB.includes(file) || NO_BACK.includes(file)) return;
    const eb =document.querySelector('.wrap > header .eyebrow');
    if (!eb) return;
    const prev = trail.length >= 2 ? trail[trail.length - 2] : null;
    // No page before this one (a push, a shared link, the Home Screen): go to
    // the tab the page lives under -- Parlay Legs is a Parlay page -- and only
    // to the History hub for a page that belongs to no tab.
    const own = TABS.find(t => t.pages.includes(file));
    const label = prev ? prev.t : own ? own.label : 'History';
    const a = document.createElement('a');
    a.className = 'hdr-back';
    a.href = prev ? prev.f : own ? own.href : 'history.html';
    a.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg><span>${esc(label)}</span>`;
    a.setAttribute('aria-label', `Back to ${label}`);
    a.addEventListener('click', e => {
      // The page before is still in this tab's history: go back to it as it was.
      if (!prev || history.length < 2 || !document.referrer || new URL(document.referrer).origin !== location.origin) return;
      e.preventDefault();
      history.back();
    });
    eb.replaceWith(a);
  }
  // A page restored from the back/forward cache didn't run its scripts again.
  addEventListener('pageshow', e => { if (e.persisted) noteTrail(); });

  // ---------- The title row and the folding title (audit V #4, #5) ----------
  // The eyebrow line's right end holds the page's buttons: the dashboard's
  // week stepper (moved out of the old Updated column), then your monogram,
  // which opens You (nav.css hides it at 1080px, where the top bar has it).
  // Past the title, a slim glass bar takes the title's place at the top,
  // with the title (or the h1's data-fold, e.g. "Week 6") and the status line.
  // Your monogram opens your page (you.html, audit VIII #15) once your team
  // is picked; before that, and on that page itself, it opens the You sheet.
  function youTap() {
    if (getMe() && currentFile() !== 'you.html') location.href = 'you.html';
    else openYou();
  }
  function meButton(cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-haspopup', 'dialog');
    const draw = () => {
      const me = getMe();
      b.classList.toggle('none', !me);
      b.innerHTML = me ? esc(monogram(me)) : ICONS.person;
      b.setAttribute('aria-label', me ? `You: ${me}` : 'You: pick your team');
    };
    draw();
    b.addEventListener('click', youTap);
    window.addEventListener('rl-me', draw);
    return b;
  }
  // ---------- Inbox bell (audit VIII #16) ----------
  // Every alert the site would have pushed you, kept by the Worker for a
  // week (GET /push/recent), whether or not this phone has notifications on.
  // The bell shows only while some are unread, with the count; it opens
  // You › Notifications, where they're listed, and opening that marks them read.
  const INBOX_READ = 'rl-inbox-read';
  const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15L6 17z"/><path d="M10 21h4"/></svg>';
  const inboxRead = () => { try { return Number(localStorage.getItem(INBOX_READ)) || 0; } catch (e) { return 0; } };
  function markInboxRead() {
    try { localStorage.setItem(INBOX_READ, String(Date.now())); } catch (e) {}
    document.querySelectorAll('.hdr-bell').forEach(b => { b.hidden = true; });
  }
  function bellButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hdr-bell';
    b.hidden = true;
    b.addEventListener('click', () => { markInboxRead(); openYou('push'); });
    const draw = async () => {
      if (!getMe()) { b.hidden = true; return; }
      const alerts = await recentAlerts();
      const n = alerts ? inboxList(alerts).filter(a => a.ts > inboxRead()).length : 0;
      b.hidden = !n;
      b.innerHTML = `${BELL}<i>${n > 9 ? '9+' : n}</i>`;
      b.setAttribute('aria-label', `${n} new alert${n === 1 ? '' : 's'}`);
    };
    draw();
    window.addEventListener('rl-me', draw);
    return b;
  }

  function headerTools() {
    const hdr = document.querySelector('.wrap > header');
    const h1 = hdr && hdr.querySelector('h1');
    if (!h1) return;
    const row = hdr.querySelector('.header-row') || hdr;
    const tools = document.createElement('div');
    tools.className = 'hdr-tools';
    const step = row.querySelector('.wk-step');
    if (step) tools.appendChild(step);
    tools.appendChild(bellButton());
    tools.appendChild(meButton('hdr-me'));
    row.appendChild(tools);

    document.body.insertAdjacentHTML('beforeend', '<div class="top-band" aria-hidden="true"></div><div class="fold" id="fold"><div class="fold-in"><span></span><button type="button" class="fold-t" aria-label="Back to the top"><b></b><span></span></button></div></div>');
    const fold = document.getElementById('fold');
    fold.querySelector('.fold-in').appendChild(meButton('fold-me'));
    const tb = fold.querySelector('.fold-t b'), ts = fold.querySelector('.fold-t span');
    fold.querySelector('.fold-t').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    const status = () => {
      const st = hdr.querySelector('.updated-block');
      return st ? st.textContent.replace(/\s+/g, ' ').trim() : '';
    };
    let shown = false, queued = false;
    const update = () => {
      queued = false;
      if (!fold.offsetHeight) return; // desktop: hidden
      const on = h1.getBoundingClientRect().bottom < fold.offsetHeight;
      if (on) {
        tb.textContent = h1.dataset.fold || h1.textContent.trim();
        ts.textContent = status();
      }
      if (on === shown) return;
      shown = on;
      fold.classList.toggle('show', on);
      fold.setAttribute('aria-hidden', String(!on));
      document.documentElement.classList.toggle('folded', on);
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    fold.setAttribute('aria-hidden', 'true');
    queue();
  }

  // The floating tab bar drops its labels and shrinks while you scroll
  // down, and comes back on any scroll up or near the top (audit V #4).
  function tabbarShrink(bar) {
    if (!bar) return;
    let lastY = window.scrollY, queued = false;
    const update = () => {
      queued = false;
      const y = window.scrollY, max = document.documentElement.scrollHeight - window.innerHeight;
      if (y < 0 || y > max) return; // iOS rubber-banding
      if (y < 40) { bar.classList.remove('min'); lastY = y; return; }
      const dy = y - lastY;
      if (Math.abs(dy) < 6) return;
      bar.classList.toggle('min', dy > 0 && y > 80);
      lastY = y;
    };
    window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  }

  // ---------- Search (site audit III #10) ----------
  // One box over managers, every team name the league has had, every
  // drafted player and every season. Built in the browser from the same
  // data files the history pages read: league.json at once, and the much
  // bigger players-index.json only once someone starts typing.
  let idx = null, playersIdx = null, playersList = null;
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tidy = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const span = ys => { const a = Math.min(...ys), b = Math.max(...ys); return a === b ? String(a) : `${a}–${b}`; };

  function loadIndex() {
    if (!idx) {
      idx = fetch('data/league.json').then(r => r.json()).then(d => {
        const last = Math.max(...d.seasons.map(s => s.year));
        const byMgr = new Map(), byTeam = new Map(), byYear = new Map();
        for (const s of d.seasons) {
          const m = byMgr.get(s.player) || { years: [], titles: 0 };
          m.years.push(s.year); m.titles += s.champ ? 1 : 0;
          byMgr.set(s.player, m);
          const name = tidy(s.team);
          const k = name + '\u0000' + s.player;
          const t = byTeam.get(k) || { name, mgr: s.player, years: [] };
          t.years.push(s.year);
          byTeam.set(k, t);
          const y = byYear.get(s.year) || { champ: null };
          if (s.champ) y.champ = s.player;
          byYear.set(s.year, y);
        }
        const out = [];
        for (const [name, m] of byMgr) {
          const since = Math.min(...m.years), current = m.years.includes(last);
          const titles = m.titles ? ` · ${m.titles} title${m.titles > 1 ? 's' : ''}` : '';
          out.push({ kind: 'Manager', rank: 0, name, sub: (current ? `Since ${since}` : `Former · ${span(m.years)}`) + titles, href: pageLink('franchise.html', { m: name }) });
        }
        for (const t of byTeam.values()) {
          out.push({ kind: 'Team', rank: 2, name: t.name, sub: `${t.mgr} · ${span(t.years)}`, href: t.years.length === 1 ? pageLink('wrapped.html', { m: t.mgr, year: t.years[0] }) : pageLink('franchise.html', { m: t.mgr }) });
        }
        for (const [year, y] of [...byYear].sort((a, b) => b[0] - a[0])) {
          out.push({ kind: 'Season', rank: 1, name: String(year), sub: year === last ? 'This season' : y.champ ? `Won by ${y.champ}` : 'Standings', href: pageLink('standings.html', { year }) });
        }
        out.forEach(e => { e.key = norm(e.name); });
        return out;
      }).catch(() => { idx = null; return []; });
    }
    return idx;
  }
  function loadPlayers() {
    if (!playersIdx) {
      playersIdx = fetch('data/players-index.json').then(r => r.json()).then(d => (playersList = d.players.map(([id, name, pos, n, pts]) => ({
        kind: 'Player', rank: 3, name, key: norm(name), n,
        sub: `${pos ? pos + ' · ' : ''}${n ? `Drafted ${n}×` : 'Never drafted'}${pts ? ` · ${Math.round(pts).toLocaleString('en-US')} pts started` : ''}`,
        href: pageLink('players.html', { p: id }),
      })))).catch(() => { playersIdx = null; return []; });
    }
    return playersIdx;
  }

  // Best first: the whole name, then a word that starts with what you
  // typed, then the letters anywhere; managers before seasons before teams
  // before players at the same strength, and oft-drafted players first.
  function find(entries, q) {
    const k = norm(q);
    if (!k) return [];
    const scored = [];
    for (const e of entries) {
      let s;
      if (e.key === k) s = 0;
      else if (e.key.startsWith(k)) s = 1;
      else if ((' ' + e.key).includes(' ' + k)) s = 2;
      else if (e.key.includes(k)) s = 3;
      else continue;
      scored.push([s, e]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].rank - b[1].rank || (b[1].n || 0) - (a[1].n || 0) || a[1].name.localeCompare(b[1].name)).map(x => x[1]);
  }

  const MAX_HITS = 12;
  // Wires a search box to a results list. `onResults(has)` lets the page
  // swap its other content out while results show (the hub hides its tiles).
  function wireSearch(input, results, onResults) {
    let seq = 0;
    const draw = async () => {
      const q = input.value;
      const my = ++seq;
      if (!norm(q)) { results.innerHTML = ''; results.hidden = true; onResults && onResults(false); return; }
      const base = await loadIndex();
      if (my !== seq) return;
      let hits = find(base, q);
      const players = playersList;
      if (players) hits = hits.concat(find(players, q));
      else loadPlayers().then(() => { if (my === seq) draw(); });
      hits = hits.slice(0, MAX_HITS);
      results.hidden = false;
      results.innerHTML = hits.length
        ? hits.map(h => `<a class="sr-hit" href="${esc(h.href)}"><span class="sr-k">${h.kind}</span><b>${esc(h.name)}</b><span class="sr-s">${esc(h.sub)}</span></a>`).join('')
        : `<div class="sr-none">${players ? 'Nothing matches.' : 'Searching…'}</div>`;
      onResults && onResults(true);
    };
    const clear = input.parentNode.querySelector('.sr-x');
    const showClear = () => { clear.hidden = !input.value; };
    input.addEventListener('input', () => { showClear(); draw(); });
    clear.addEventListener('click', () => { input.value = ''; showClear(); draw(); input.focus(); });
    input.addEventListener('focus', () => { loadIndex(); loadPlayers(); }, { once: true });
    // Enter opens the top result.
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = results.querySelector('.sr-hit');
      if (first) { e.preventDefault(); location.href = first.href; }
    });
    if (input.value) { showClear(); draw(); }
  }

  const searchBox = id => `<div class="sr-box"><span class="sr-ic">${ICONS.search}</span><input type="search" id="${id}" placeholder="Managers, teams, players, seasons" aria-label="Search the league" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"><button type="button" class="sr-x" aria-label="Clear search" hidden>✕</button></div>`;

  // The last three hub pages visited, newest first (localStorage; the hub
  // works without it).
  const RECENT_KEY = 'hubRecent';
  const readRecent = () => {
    try { const r = JSON.parse(localStorage.getItem(RECENT_KEY)); return Array.isArray(r) ? r.filter(h => HISTORY.some(p => p.href === h)).slice(0, 3) : []; } catch (e) { return []; }
  };
  const noteVisit = file => {
    if (!HISTORY.some(p => p.href === file)) return;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([file, ...readRecent().filter(h => h !== file)].slice(0, 3))); } catch (e) {}
  };

  // The History hub (history.html): the search box, the pages you were last
  // on, then the tiles under four headings.
  window.renderHistoryHub = function renderHistoryHub(mount) {
    const tile = p => `<a class="hub-tile" href="${p.href}"><span class="hub-ic">${p.icon}</span><b>${p.label}</b><span>${p.sub}</span></a>`;
    const groups = [...new Set(HISTORY.map(p => p.group))];
    const recent = readRecent().map(h => HISTORY.find(p => p.href === h));
    mount.innerHTML = `${searchBox('hub-q')}
      <div class="sr-results glass" id="hub-results" hidden></div>
      <div id="hub-grid">
        ${recent.length ? `<div class="hub-h"><b>Pick up where you left off</b></div><div class="hub-recent">${recent.map(p => `<a class="hub-chip" href="${p.href}"><i>${p.icon}</i>${p.label}</a>`).join('')}</div>` : ''}
        <div class="hub-cols">${groups.map((g, i) => `<section class="hub-sec"><div class="hub-h${i === 0 ? ' live' : ''}"><b>${esc(g)}</b></div><div class="hub-g">${HISTORY.filter(p => p.group === g).map(tile).join('')}</div></section>`).join('')}</div>
      </div>`;
    const grid = mount.querySelector('#hub-grid');
    wireSearch(mount.querySelector('#hub-q'), mount.querySelector('#hub-results'), has => { grid.hidden = has; });
    loadIndex();
  };

  // Search from any page at 1080px and up: a card near the top of the
  // screen, opened from the bar's button, ⌘K/Ctrl K or /. Under 1080px the
  // field opens at the bottom, where the search circle is, lifted above the
  // keyboard, with the results stacked up toward it (site audit VI #3).
  function openSearch() {
    if (document.getElementById('search-sheet')) return;
    // On the hub the box is already on the page.
    const hub = document.getElementById('hub-q');
    if (hub) { hub.focus(); return; }
    if (!matchMedia('(min-width: 1080px)').matches) { openBottomSearch(); return; }
    const back = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="search-scrim"></div>
      <div class="sheet search-sheet" id="search-sheet" role="dialog" aria-modal="true" aria-label="Search">
        <div class="sheet-body">${searchBox('search-q')}<div class="sr-results" id="search-results" hidden></div></div>
      </div>`);
    const close = () => {
      document.getElementById('search-sheet')?.remove();
      document.getElementById('search-scrim')?.remove();
      document.removeEventListener('keydown', onEsc);
      if (back && back.focus) back.focus();
    };
    const onEsc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);
    document.getElementById('search-scrim').addEventListener('click', close);
    const input = document.getElementById('search-q');
    wireSearch(input, document.getElementById('search-results'));
    input.focus();
  }

  // The phone's search: the list over the field, the field over the keyboard.
  // Before you type, Jump to: your matchup, the head-to-head with this week's
  // opponent, Playoff Race and your Franchise page, then this season's
  // managers. The Jump rows read the Worker's last answer (the service
  // worker keeps it), or ask for it.
  function openBottomSearch() {
    const back = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="search-scrim"></div>
      <div class="search-bottom" id="search-sheet" role="dialog" aria-modal="true" aria-label="Search">
        <div class="sb-list glass"><div id="search-jump"></div><div class="sr-results" id="search-results" hidden></div></div>
        <div class="sb-field">${searchBox('search-q')}<button type="button" class="sb-cancel">Cancel</button></div>
      </div>`);
    const panel = document.getElementById('search-sheet');
    document.documentElement.classList.add('searching');
    const vv = window.visualViewport;
    // Lift the panel by the keyboard's height as it opens and closes.
    const lift = () => {
      const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      panel.style.setProperty('--kb', kb + 'px');
      panel.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px');
      panel.classList.toggle('kb', kb > 40);
    };
    if (vv) { vv.addEventListener('resize', lift); vv.addEventListener('scroll', lift); }
    lift();
    const close = () => {
      document.documentElement.classList.remove('searching');
      panel.remove();
      document.getElementById('search-scrim')?.remove();
      document.removeEventListener('keydown', onEsc);
      if (vv) { vv.removeEventListener('resize', lift); vv.removeEventListener('scroll', lift); }
      if (back && back.focus) back.focus({ preventScroll: true });
    };
    const onEsc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);
    document.getElementById('search-scrim').addEventListener('click', close);
    panel.querySelector('.sb-cancel').addEventListener('click', close);
    const input = document.getElementById('search-q');
    const jump = document.getElementById('search-jump');
    wireSearch(input, document.getElementById('search-results'), has => { jump.hidden = has; });
    drawJump(jump);
    input.focus();
  }
  async function drawJump(box) {
    const me = getMe();
    const names = await loadManagers();
    let live = null;
    try {
      const hit = 'caches' in window ? await caches.match(WORKER, { ignoreVary: true }) : null;
      live = hit ? await hit.json() : null;
      if (!live || !live.teams) live = await fetch(WORKER, { cache: 'no-store' }).then(r => r.json());
    } catch (e) {}
    if (!document.body.contains(box)) return;
    const rows = [];
    const t = me && live && (live.teams || []).find(x => x.manager === me);
    const mu = me && live && (live.matchups || []).find(m => m.awayManager === me || m.homeManager === me);
    if (mu) {
      const home = mu.homeManager === me, opp = home ? mu.awayManager : mu.homeManager;
      const wp = home ? mu.homeWinProbability : mu.awayWinProbability;
      rows.push({ k: 'This week', name: `You vs ${opp}`, sub: `Week ${live.week}${typeof wp === 'number' ? ` · ${Math.round(wp)}% to win` : ''}`, href: 'index.html' });
      rows.push({ k: 'Rivalry', name: `Head to Head: ${me} vs ${opp}`, sub: 'Every game you two have played', href: pageLink('head-to-head.html', { a: me, b: opp }) });
    }
    rows.push({ k: 'Odds', name: 'Playoff Race', sub: t ? `${t.record} · pick winners, watch your odds move` : 'Pick winners, watch the odds move', href: 'race.html' });
    if (me) rows.push({ k: 'You', name: 'Your Franchise page', sub: `${me}'s whole career`, href: pageLink('franchise.html', { m: me }) });
    const hit = r => `<a class="sr-hit" href="${esc(r.href)}"><span class="sr-k">${r.k}</span><b>${esc(r.name)}</b><span class="sr-s">${esc(r.sub)}</span></a>`;
    box.innerHTML = `<div class="sb-grp">Jump to</div>${rows.map(hit).join('')}
      ${names.length ? `<div class="sb-grp">Managers</div><div class="sb-mgrs">${names.map(n => `<a href="${esc(pageLink('franchise.html', { m: n }))}"><span class="sb-mono${n === me ? ' you' : ''}">${esc(monogram(n))}</span>${esc(n)}</a>`).join('')}</div>` : ''}`;
  }

  // ---------- You (site audit II #36 and #37) ----------
  // The round button at the right of the bar: your monogram once you've
  // picked your team (getMe/setMe in page-common.js), a person outline
  // before. It opens the You sheet, three panels behind one slider: which
  // team is yours, the Home Screen app's notifications, and your settings
  // (getSettings/setSetting in page-common.js). Anything else on a page can
  // open the same sheet with openYou(panel) (the dashboard's first-visit
  // prompt does).
  const WORKER = 'https://retirement-league-refresh-proxy.bradbutcher321.workers.dev';
  const VAPID_PUBLIC = 'BPvPSYw_tyBqsI3ZwzWEn4QdhCrPs5r6SB1X-6p8UrJE5BMc4GZW9hiHRc2Vj2_l3zSZTfnLhHKRmg8QT9ADT6c';
  const PREFS_KEY = 'rl-push-prefs';
  // [pref, label, about your own games]
  const PUSH_TYPES = [
    ['final', 'Matchup goes Final', true],
    ['median', 'Median Clinched', true],
    ['lineup', 'Starter on Bye or Out', true],
    ['rival', 'Rival Game Alerts', true],
    ['parlay', 'Parlay Leg Wins or Loses', true],
    ['legIn', 'Missing Parlay Leg', true],
    ['parlayAll', 'Parlay Status Updates', false],
    ['recap', 'Week in Review is up', false],
    ['record', 'League Record Falls', false],
  ];
  const PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/></svg>';

  const pushReady = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function getPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) {}
    // Every leg and the rival alerts are opt-in (worker/src/push.js PREF_OFF_BY_DEFAULT).
    const out = Object.fromEntries(PUSH_TYPES.map(([k]) => [k, (k === 'parlayAll' || k === 'rival') ? p[k] === true : p[k] !== false]));
    // The daily site health alert isn't in this list: it lives on the Commissioner
    // page's Site Health screen, and only a signed-in commissioner can have it on.
    out.health = p.health === true && isCommissioner(getAuth());
    return out;
  }
  async function currentSub() {
    if (!pushReady()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  const post = (path, body) => fetch(WORKER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // Tells the Worker who this phone is and what it wants, whenever either changes.
  async function syncSub() {
    const sub = await currentSub().catch(() => null);
    if (sub) await post('/push/subscribe', { sub: sub.toJSON(), me: getMe(), prefs: getPrefs() }).catch(() => {});
  }
  // For a notification switch that lives on another page (the Commissioner
  // page's site health alert): whether this phone can have notifications
  // ('on' once Notify me is on, else 'off', 'blocked' or 'unsupported'), and
  // reading or changing one choice, which is saved like the You sheet's.
  window.rlPush = {
    async state() {
      if (!pushReady()) return 'unsupported';
      if (Notification.permission === 'denied') return 'blocked';
      return (await currentSub().catch(() => null)) ? 'on' : 'off';
    },
    get: key => !!getPrefs()[key],
    // For a prompt elsewhere (Parlay Legs after a save, audit VIII #16):
    // 'ask' (one tap turns them on), 'install' (iPhone Safari: Home Screen
    // app first), 'blocked', 'on', or 'no' (this browser can't).
    async how() {
      if (!pushReady()) return ios() && !installed() ? 'install' : 'no';
      if (Notification.permission === 'denied') return 'blocked';
      return (await currentSub().catch(() => null)) ? 'on' : 'ask';
    },
    // Straight from a tap: Safari only shows the permission prompt then.
    async enable() {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
      const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC) });
      await post('/push/subscribe', { sub: sub.toJSON(), me: getMe(), prefs: getPrefs() });
      return true;
    },
    async set(key, on) {
      let p = {};
      try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) {}
      p[key] = !!on;
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
      await syncSub();
    },
  };
  function b64uToBytes(s) {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  }

  // This season's managers, from the same league.json the history pages read.
  let managers = null;
  function loadManagers() {
    if (!managers) {
      managers = fetch('data/league.json').then(r => r.json()).then(d => {
        const year = Math.max(...d.seasons.map(s => s.year));
        return [...new Set(d.seasons.filter(s => s.year === year).map(s => s.player))].sort((a, b) => a.localeCompare(b));
      }).catch(() => { managers = null; return []; });
    }
    return managers;
  }

  function drawChip(btn) {
    const me = getMe();
    btn.classList.toggle('set', !!me);
    btn.innerHTML = me ? `<span>${esc(monogram(me))}</span>` : PERSON;
    btn.setAttribute('aria-label', me ? `You: ${me}` : 'Pick your team');
  }

  function wireYou(btn) {
    if (!btn) return;
    drawChip(btn);
    btn.addEventListener('click', youTap);
    window.addEventListener('rl-me', () => drawChip(btn));
  }

  // The tab bar's You: the same monogram in a ring once you've picked your
  // team, the person outline before.
  function wireYouTab(btn) {
    if (!btn) return;
    const draw = () => {
      const me = getMe();
      btn.querySelector('.tb-ic').innerHTML = me ? `<span class="tb-mono">${esc(monogram(me))}</span>` : ICONS.person;
      btn.setAttribute('aria-label', me ? `You: ${me}` : 'You: pick your team');
    };
    draw();
    btn.addEventListener('click', youTap);
    window.addEventListener('rl-me', draw);
  }

  let lastFocus = null;
  // Script focus counts as "keyboard" focus to WebKit when the last thing
  // focused showed a ring, so on a phone Done (and then the You tab it hands
  // focus back to) kept coming up in a gold box. Only move focus onto a
  // button, and back, when the sheet was opened from the keyboard.
  let byKeyboard = false;
  document.addEventListener('keydown', () => { byKeyboard = true; }, true);
  document.addEventListener('pointerdown', () => { byKeyboard = false; }, true);
  const onKey = e => { if (e.key === 'Escape') closeYou(); };
  function closeYou() {
    document.getElementById('you-sheet')?.remove();
    document.getElementById('you-scrim')?.remove();
    document.removeEventListener('keydown', onKey);
    if (byKeyboard && lastFocus && lastFocus.focus) lastFocus.focus();
  }

  const YOU_PANELS = [['you', 'You'], ['push', 'Notifications'], ['settings', 'Settings']];
  let youPanel = 'you';
  let youNames = [];

  window.openYou = async function openYou(panel) {
    if (document.getElementById('you-sheet')) return;
    lastFocus = document.activeElement;
    youPanel = YOU_PANELS.some(([k]) => k === panel) ? panel : 'you';
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="you-scrim"></div>
      <div class="sheet you-sheet" id="you-sheet" role="dialog" aria-modal="true" aria-label="You" tabindex="-1">
        <div class="sheet-grab" data-grab><span></span><button type="button" class="you-done">Done</button></div>
        <div class="sheet-head you-head" data-grab>
          <div class="sup-seg you-tabs" role="tablist" aria-label="You">${YOU_PANELS.map(([k, label]) =>
            `<button type="button" role="tab" data-you-panel="${k}" id="you-tab-${k}" aria-controls="you-body">${label}</button>`).join('')}</div>
          <button class="x" type="button" aria-label="Close">✕</button>
        </div>
        <div class="sheet-body"><div id="you-body" role="tabpanel"><div class="you-note">Loading…</div></div></div>
      </div>`);
    const sheet = document.getElementById('you-sheet');
    document.getElementById('you-scrim').addEventListener('click', closeYou);
    // Done on the phone's sheet, ✕ on the desktop card (nav.css shows one).
    const closers = [...sheet.querySelectorAll('.you-done, .x')];
    closers.forEach(b => b.addEventListener('click', closeYou));
    sheet.querySelectorAll('[data-you-panel]').forEach(b => b.addEventListener('click', () => {
      youPanel = b.dataset.youPanel;
      drawPanel();
    }));
    document.addEventListener('keydown', onKey);
    // The sheet itself takes focus (tabindex -1, no ring) unless a keyboard
    // opened it, in which case the close button does.
    if (byKeyboard) (closers.find(b => b.offsetParent) || closers[0]).focus();
    else sheet.focus({ preventScroll: true });
    drawTabs();
    youNames = await loadManagers();
    if (document.getElementById('you-sheet') === sheet) drawPanel();
  };

  function drawTabs() {
    document.querySelectorAll('#you-sheet [data-you-panel]').forEach(b => {
      const on = b.dataset.youPanel === youPanel;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    });
    const body = document.getElementById('you-body');
    if (body) body.setAttribute('aria-labelledby', 'you-tab-' + youPanel);
  }

  function drawPanel() {
    drawTabs();
    if (youPanel !== 'you') youFeedback = false;
    if (youPanel === 'push') drawPushPanel();
    else if (youPanel === 'settings') drawSettings();
    else drawYou(youNames);
  }

  // ---------- Signing in (site audit III #24) ----------
  // The commissioner texts each manager a link. Opening it signs that
  // browser in (claimFromLink). The Home Screen app keeps its own storage
  // and a link can't open it, so the website shows a signed-in manager a
  // code to paste into the app's You sheet instead. getAuth/setAuth in
  // page-common.js keep the result; worker/src/auth.js is the other end.
  const COMMISH = 'Brad';
  // Commissioners get a way to the Commissioner page in their You sheet once
  // signed in (isCommissioner() in page-common.js; the Worker says who is one,
  // /auth/me, kept in the saved sign-in). Only a shortcut: the page checks again.
  // What a sign-in box was given: the texted link (or a whole text with it
  // in), or the eight-character code. '' while it's neither.
  function codeIn(text) {
    const t = String(text || '');
    const link = t.match(/#k=([A-Za-z0-9]{16})(?![A-Za-z0-9])/);
    if (link) return link[1].toUpperCase();
    const bare = t.replace(/[\s-]/g, '').toUpperCase();
    return /^[A-HJKMNP-Z2-9]{8}$/.test(bare) ? bare : '';
  }
  const fmtCode = c => c.slice(0, 4) + '-' + c.slice(4);
  const SIGNIN_HELP = `Tap the link in ${COMMISH}'s text. The website shows your code to paste here.`;
  const SIGNIN_ERRORS = {
    wrong_code: b => `That code didn't work. Tap the link in ${COMMISH}'s text to see your code again.${b.triesLeft >= 0 ? ` ${b.triesLeft} ${b.triesLeft === 1 ? 'try' : 'tries'} left.` : ''}`,
    wrong_link: () => `That link has been replaced. Ask ${COMMISH} for a new one.`,
    locked: () => 'Too many wrong codes. Signing in is locked for an hour.',
    not_configured: () => "Signing in isn't set up yet.",
  };
  const signInError = (err, fromLink) => {
    const kind = err && err.error === 'wrong_code' && fromLink ? 'wrong_link' : err && err.error;
    return SIGNIN_ERRORS[kind] ? SIGNIN_ERRORS[kind](err) : "Couldn't reach the league. Try again.";
  };
  // What went wrong last, for the sign-in box to say when it's next drawn.
  let signinNote = '';
  // The signed-in manager's app code once fetched: { token, code }.
  let appCode = null;

  async function signIn(code) {
    const res = await fetch(WORKER + '/auth/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, kind: installed() ? 'app' : 'web' }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw out;
    const old = getAuth();
    setAuth({ token: out.token, manager: out.manager, commissioner: !!out.commissioner });
    // The key this browser held before, if any, is no use to anyone now.
    if (old) fetch(WORKER + '/auth/signout', { method: 'POST', headers: { Authorization: 'Bearer ' + old.token }, keepalive: true }).catch(() => {});
    syncSub();
  }

  // Arriving from the texted link: sign in, take the key out of the address
  // bar so it isn't left in the history or a screenshot, and open You on
  // the result.
  async function claimFromLink() {
    const m = location.hash.match(/^#k=([A-Za-z0-9]{16})$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    signinNote = '';
    try { await signIn(m[1].toUpperCase()); } catch (err) { signinNote = signInError(err, true); }
    youPanel = 'you';
    if (document.getElementById('you-sheet')) drawPanel(); else openYou('you');
  }

  function drawYou(names) {
    const body = document.getElementById('you-body');
    if (!body) return;
    const auth = getAuth();
    if (auth && youFeedback) { drawFeedback(body, auth); return; }
    if (auth) { signinNote = ''; drawSignedIn(body, auth); return; }
    const me = getMe();
    const picks = names.map(n => `<button type="button" class="you-pick${n === me ? ' on' : ''}" data-me="${esc(n)}" aria-pressed="${n === me}">${esc(n)}</button>`).join('');
    // Signing in comes first; the picker under it is for anyone who only
    // follows along (it sets the ring and nothing else).
    body.innerHTML = `
      <form class="you-signin" id="you-signin">
        <input class="you-code${signinNote ? ' err' : ''}" id="you-code" type="text" placeholder="Your code" aria-label="Your sign-in code" aria-describedby="you-signin-note" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go">
        <button type="button" class="you-btn" id="you-paste">Paste</button>
      </form>
      <div class="you-note${signinNote ? ' err' : ''}" id="you-signin-note" role="status">${esc(signinNote || SIGNIN_HELP)}</div>
      <div class="you-sec">
        <div class="you-sub">Just following along? Pick a team to see it ringed across the site.</div>
        <div class="you-picks">${picks}<button type="button" class="you-pick none${me ? '' : ' on'}" data-me="" aria-pressed="${!me}">Not in the league</button></div>
      </div>`;
    body.querySelectorAll('[data-me]').forEach(b => b.addEventListener('click', () => {
      setMe(b.dataset.me);
      drawYou(names);
      syncSub();
    }));

    const input = body.querySelector('#you-code');
    const note = body.querySelector('#you-signin-note');
    const say = (text, err) => {
      note.textContent = text;
      note.classList.toggle('err', !!err);
      input.classList.toggle('err', !!err);
    };
    let busy = false;
    async function submit(text) {
      if (busy) return;
      const code = codeIn(text);
      if (!code) { say("That isn't a code. Yours is eight letters and numbers.", true); return; }
      busy = true;
      input.disabled = true;
      say('Checking your code…');
      try {
        await signIn(code);
        if (document.body.contains(body)) drawPanel();
      } catch (err) {
        busy = false;
        input.disabled = false;
        signinNote = signInError(err, code.length > 8);
        say(signinNote, true);
        input.select();
      }
    }
    // Typed or pasted by hand: goes as soon as a whole code is in the box.
    input.addEventListener('input', () => {
      signinNote = '';
      say(SIGNIN_HELP);
      if (codeIn(input.value)) submit(input.value);
    });
    body.querySelector('#you-signin').addEventListener('submit', e => { e.preventDefault(); submit(input.value); });
    body.querySelector('#you-paste').addEventListener('click', async () => {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch (e) {}
      // No clipboard to read (or nothing on it): the box is theirs to type in.
      if (!text.trim()) { input.focus(); return; }
      const code = codeIn(text);
      input.value = code.length === 8 ? fmtCode(code) : '';
      submit(text);
    });
  }

  // ---------- Feedback ----------
  // A signed-in manager reports a bug or suggests something; the
  // commissioners get a push and answer on the Commissioner page's Feedback
  // tool (worker/src/feedback.js). Under the form: what you've sent, with
  // where it stands and any reply.
  let youFeedback = false;
  const FB_KINDS = [['bug', 'Bug', 'What happened, and on which page?'], ['improve', 'Improvement', 'What would make the site better?'], ['feature', 'Feature idea', 'What should the site do?'], ['other', 'Other', "What's on your mind?"]];
  const FB_STATUS = { new: 'Sent', planned: 'Planned', done: 'Done', no: "Won't do" };
  let fbKind = 'bug', fbDraft = '', fbNote = '';
  function drawFeedback(body, auth) {
    const kind = FB_KINDS.find(k => k[0] === fbKind) || FB_KINDS[0];
    body.innerHTML = `
      <button type="button" class="you-back" id="you-fb-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg><span>You</span></button>
      <div class="you-sec-h">Send feedback</div>
      <div class="you-sub">Brad and Jon get it right away.</div>
      <div class="you-picks you-fb-kinds" role="radiogroup" aria-label="Kind">${FB_KINDS.map(([k, label]) =>
        `<button type="button" role="radio" class="you-pick${k === fbKind ? ' on' : ''}" data-fb-kind="${k}" aria-checked="${k === fbKind}">${label}</button>`).join('')}</div>
      <textarea class="you-code you-fb-text" id="you-fb-text" maxlength="1000" placeholder="${esc(kind[2])}" aria-label="Your feedback">${esc(fbDraft)}</textarea>
      <div class="you-fb-send"><span class="you-note${fbNote && fbNote !== 'sent' ? ' err' : ''}" id="you-fb-note" role="status">${fbNote === 'sent' ? "Thanks. It's in." : esc(fbNote)}</span><button type="button" class="you-btn" id="you-fb-go">Send</button></div>
      <div class="you-sec" id="you-fb-mine"></div>`;
    body.querySelector('#you-fb-back').addEventListener('click', () => { youFeedback = false; fbNote = ''; drawPanel(); });
    const ta = body.querySelector('#you-fb-text');
    ta.addEventListener('input', () => { fbDraft = ta.value; });
    body.querySelectorAll('[data-fb-kind]').forEach(b => b.addEventListener('click', () => {
      fbKind = b.dataset.fbKind;
      fbDraft = ta.value;
      drawFeedback(body, auth);
      const again = body.querySelector(`[data-fb-kind="${fbKind}"]`);
      if (again) again.focus();
    }));
    const go = body.querySelector('#you-fb-go');
    go.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (text.length < 3) { fbNote = 'Write a few words first.'; drawFeedback(body, auth); body.querySelector('#you-fb-text').focus(); return; }
      go.disabled = true;
      go.textContent = 'Sending…';
      let res = null;
      try {
        res = await fetch(WORKER + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ kind: fbKind, text, page: currentFile() }) });
      } catch (e) {}
      const out = res ? await res.json().catch(() => ({})) : {};
      if (res && res.ok) { fbDraft = ''; fbNote = 'sent'; }
      else fbNote = out.error === 'too_many' ? "That's a lot for one day. Try again tomorrow." : out.error === 'signed_out' ? 'You were signed out. Sign in again to send it.' : "Couldn't send it. Try again.";
      if (document.body.contains(body)) drawFeedback(body, auth);
    });
    drawMine(body.querySelector('#you-fb-mine'));
  }
  async function drawMine(box) {
    let items = null;
    try {
      const res = await fetch(WORKER + '/feedback/mine', { headers: authHeaders(), cache: 'no-store' });
      if (res.ok) items = (await res.json()).items;
    } catch (e) {}
    if (!document.body.contains(box)) return;
    if (!Array.isArray(items) || !items.length) { box.remove(); return; }
    const label = k => (FB_KINDS.find(x => x[0] === k) || FB_KINDS[3])[1];
    box.innerHTML = `<div class="you-sec-t">You sent</div><div class="you-fbs">${items.map(f => `
      <div class="you-fb item">
        <div class="you-fb-h"><span>${esc(label(f.kind))} · ${esc(alertWhen(f.ts))}</span><span class="you-fb-st ${esc(f.status)}">${esc(FB_STATUS[f.status] || 'Sent')}</span></div>
        <div class="you-fb-t">${esc(f.text)}</div>
        ${f.reply ? `<div class="you-fb-r">${esc(f.reply)}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  function drawSignedIn(body, auth) {
    // The app can't be opened by a link, so the website hands over a code
    // for it. Inside the app there's nobody left to hand it to.
    const web = !installed();
    const known = appCode && appCode.token === auth.token ? appCode.code : '';
    body.innerHTML = `
      <div class="you-acct item">
        <span class="you-mono" aria-hidden="true">${esc(monogram(auth.manager))}</span>
        <div class="you-acct-t"><b>${esc(auth.manager)}</b><span>Signed in on this ${web ? 'browser' : 'phone'}</span></div>
        <button type="button" class="you-txt" id="you-signout">Sign out</button>
      </div>
      ${isCommissioner(auth) && currentFile() !== 'commissioner.html' ? `<a class="you-link item" id="you-commish" href="commissioner.html">Commissioner<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></a>` : ''}
      <button type="button" class="you-link item" id="you-fb">Send feedback<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
      ${web ? `<div class="you-sec" id="you-handoff">
        <div class="you-sec-h">Use the app on your home screen?</div>
        <div class="you-sub">It signs in on its own. Copy your code, open the app, tap You and paste.</div>
        <button type="button" class="you-copy" id="you-copy"${known ? '' : ' disabled'}><span class="you-copy-code">${known ? fmtCode(known) : '····-····'}</span><span class="you-copy-lab">Copy</span></button>
      </div>` : ''}`;
    body.querySelector('#you-fb').addEventListener('click', () => { youFeedback = true; drawPanel(); });
    body.querySelector('#you-signout').addEventListener('click', () => {
      fetch(WORKER + '/auth/signout', { method: 'POST', headers: authHeaders(), keepalive: true }).catch(() => {});
      setAuth(null);
      drawPanel();
    });
    const copy = body.querySelector('#you-copy');
    if (copy) copy.addEventListener('click', async () => {
      const lab = copy.querySelector('.you-copy-lab');
      if (!appCode) return;
      try {
        await navigator.clipboard.writeText(fmtCode(appCode.code));
        lab.textContent = 'Copied';
        copy.classList.add('done');
        setTimeout(() => { lab.textContent = 'Copy'; copy.classList.remove('done'); }, 2000);
      } catch (e) {
        lab.textContent = 'Type it in';
      }
    });
    // Asks the Worker whether this browser's key is still good (a reset
    // signs every phone out) and, on the website, for the code to show.
    const still = () => youPanel === 'you' && document.body.contains(body) && (getAuth() || {}).token === auth.token;
    fetch(WORKER + '/auth/me' + (web ? '?code=1' : ''), { headers: { Authorization: 'Bearer ' + auth.token } }).then(async res => {
      if (res.status === 401) {
        if ((getAuth() || {}).token !== auth.token) return;
        setAuth(null);
        signinNote = `You were signed out. Tap the link in ${COMMISH}'s text to sign back in.`;
        if (youPanel === 'you' && document.body.contains(body)) drawPanel();
        return;
      }
      const out = await res.json();
      if (out.commissioner !== undefined && out.commissioner !== isCommissioner(getAuth())) {
        patchAuth({ commissioner: out.commissioner });
        if (youPanel === 'you' && document.body.contains(body)) drawPanel();
      }
      if (!web || !out.code) return;
      appCode = { token: auth.token, code: out.code };
      if (!still() || !copy) return;
      copy.querySelector('.you-copy-code').textContent = fmtCode(out.code);
      copy.disabled = false;
    }).catch(() => {});
  }

  function drawPushPanel() {
    const body = document.getElementById('you-body');
    if (!body) return;
    body.innerHTML = '<div id="you-recent"></div><div id="you-push"></div>';
    drawRecent();
    drawPush();
  }

  // Settings: where your matchup sits on the dashboard, and your ring's
  // color -- each swatch drawn ringed, so the pick shows as it will look.
  function drawSettings() {
    const body = document.getElementById('you-body');
    if (!body) return;
    const set = getSettings();
    const me = getMe();
    const current = meColor()[0];
    const hidden = hiddenCards();
    const commish = isCommissioner(getAuth());
    const loreEggs = (() => { try { return localStorage.getItem('rl-lore-eggs') === '1'; } catch (e) { return false; } })();
    body.innerHTML = `
      <label class="you-row"><span>Your matchup at the top of the dashboard<small>Off: it leads the matchups list instead</small></span><input type="checkbox" role="switch" class="you-sw" id="you-set-top"${set.meTop ? ' checked' : ''}></label>
      <div class="you-sec">
        <div class="you-sec-t">Your color</div>
        <div class="you-sub">The ring around your matchup, cards and standings row.</div>
        <div class="you-colors" role="radiogroup" aria-label="Your color">${ME_COLORS.map(([k, name, ring]) =>
          `<button type="button" role="radio" class="you-color${k === current ? ' on' : ''}" data-color="${k}" aria-checked="${k === current}" style="--ring:${ring}"><span class="you-swatch" aria-hidden="true"></span>${esc(name)}</button>`).join('')}</div>
        ${me ? '' : '<div class="you-note">Pick your team under You to see it on the site.</div>'}
      </div>${hidden.length ? `
      <div class="you-sec">
        <div class="you-sec-t">Hidden cards</div>
        ${hidden.map(h => `<div class="you-row hid"><span>${esc(h.label)}<small>${esc(h.note)}</small></span><button type="button" class="you-show" data-show="${h.id}">Show again</button></div>`).join('')}
      </div>` : ''}${commish ? `
      <div class="you-sec">
        <div class="you-sec-t">Commissioner</div>
        <label class="you-row"><span>League Lore: easter eggs only<small>On this phone. Flip through them on the card.</small></span><input type="checkbox" role="switch" class="you-sw" id="you-set-eggs"${loreEggs ? ' checked' : ''}></label>
      </div>` : ''}`;
    body.querySelector('#you-set-top').addEventListener('change', e => setSetting('meTop', e.target.checked));
    // Easter eggs only (site audit VI #15): index.html reads rl-lore-eggs,
    // and honors it only while you're signed in as a commissioner.
    const eggs = body.querySelector('#you-set-eggs');
    if (eggs) eggs.addEventListener('change', () => {
      try { if (eggs.checked) localStorage.setItem('rl-lore-eggs', '1'); else localStorage.removeItem('rl-lore-eggs'); } catch (e) {}
      window.dispatchEvent(new CustomEvent('rl-settings'));
    });
    body.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => {
      setSetting('meColor', b.dataset.color);
      drawSettings();
      const again = body.querySelector(`[data-color="${b.dataset.color}"]`);
      if (again) again.focus();
    }));
    body.querySelectorAll('[data-show]').forEach(b => b.addEventListener('click', () => {
      const card = hidden.find(h => h.id === b.dataset.show);
      if (card) card.keys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
      // The dashboard listens for settings changes and redraws, so the card is back before the sheet closes.
      window.dispatchEvent(new CustomEvent('rl-settings'));
      drawSettings();
    }));
  }

  // Cards a ✕ put away (audit IV #14), each with the localStorage keys that keep it hidden.
  // The status line is hidden for the week it was closed in, so it only counts for six days.
  function hiddenCards() {
    const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const out = [];
    if (get('rl-status-hidden') && Date.now() - Number(get('rl-status-hidden-at') || 0) < 6 * 864e5) {
      out.push({ id: 'status', label: 'Status line', note: 'Back next week', keys: ['rl-status-hidden', 'rl-status-hidden-at'] });
    }
    if (!getMe() && (get('rl-me-ask-hidden') || get('rl-feed-me-ask-hidden'))) {
      out.push({ id: 'ask', label: 'Which team is yours?', note: 'The ask on the dashboard and the Feed', keys: ['rl-me-ask-hidden', 'rl-feed-me-ask-hidden'] });
    }
    if (ios() && !installed() && Number(get('rl-a2hs-hide-until')) > Date.now()) {
      out.push({ id: 'a2hs', label: 'Add to Home Screen', note: 'Hidden for 30 days', keys: ['rl-a2hs-hide-until'] });
    }
    return out;
  }

  // Recent alerts (audit IV #11): the last seven days of what the Worker sent
  // you and everyone, each opening the page it's about. Opening the app clears
  // the icon badge and a swiped-away alert is gone from Notification Center,
  // so this is where a final score or a dead leg can still be found. Shown
  // for the switches you have on, as the alerts themselves would be.
  const ALERT_ICONS = {
    final: '<path d="M5 21V4M5 5h12l-2.5 3.8L17 12.5H5"/>',
    rival: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    median: '<path d="M4 12h16M7 8l-3 4 3 4M17 8l3 4-3 4"/>',
    lineup: '<path d="M12 4 3 19h18zM12 10v4M12 17h.01"/>',
    parlay: '<path d="M5 8a2 2 0 0 0 0 4v1h14v-1a2 2 0 0 1 0-4V7H5zM5 13v4h14v-4M10 7v10"/>',
    recap: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/>',
    record: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  };
  ALERT_ICONS.parlayAll = ALERT_ICONS.legIn = ALERT_ICONS.parlay;
  const alertWhen = ts => {
    const tz = { timeZone: 'America/New_York' }, d = new Date(ts);
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...tz });
    return d.toLocaleDateString('en-US', tz) === new Date().toLocaleDateString('en-US', tz) ? time : `${d.toLocaleDateString('en-US', { weekday: 'short', ...tz })} ${time}`;
  };
  // GET /push/recent, kept for a few minutes this tab so every page's bell
  // doesn't ask again. `fresh` asks anyway (the Recent list itself).
  const ALERTS_KEY = 'rl-recent';
  async function recentAlerts(fresh) {
    const me = getMe() || '';
    if (!fresh) {
      try { const c = JSON.parse(sessionStorage.getItem(ALERTS_KEY)); if (c && c.me === me && Date.now() - c.at < 3 * 60 * 1000) return c.alerts; } catch (e) {}
    }
    try {
      const res = await fetch(WORKER + '/push/recent?me=' + encodeURIComponent(me), { cache: 'no-store' });
      if (!res.ok) return null;
      const alerts = (await res.json()).alerts;
      try { sessionStorage.setItem(ALERTS_KEY, JSON.stringify({ me, at: Date.now(), alerts })); } catch (e) {}
      return Array.isArray(alerts) ? alerts : null;
    } catch (e) { return null; }
  }
  // What the Worker would not have sent you: a switch that's off, a rival result that stood in for the plain final, your own leg when My parlay leg is on.
  function inboxList(alerts) {
    const prefs = getPrefs();
    const me = (getMe() || '').toLowerCase();
    const stood = new Set(prefs.rival ? alerts.filter(a => a.replaces).map(a => a.replaces) : []);
    return alerts.filter(a => prefs[a.pref] && !stood.has(a.k) && !(a.about && prefs.parlay && a.about.toLowerCase() === me));
  }
  // For a page that lists them too (you.html).
  window.rlInbox = { list: async () => { const a = await recentAlerts(); return a ? inboxList(a) : null; } };
  async function drawRecent() {
    const alerts = await recentAlerts(true);
    const box = document.getElementById('you-recent');
    if (!box) return;
    if (!Array.isArray(alerts)) { box.innerHTML = ''; return; }
    markInboxRead();
    const list = inboxList(alerts);
    const SHOW = 6;
    const row = a => `<a class="you-al" href="${esc(a.url || 'index.html')}"><i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ALERT_ICONS[a.pref] || ALERT_ICONS.final}</svg></i><span><b>${esc(a.title)}</b><span>${esc(a.body)}</span></span><time>${esc(alertWhen(a.ts))}</time></a>`;
    box.innerHTML = `<div class="you-sec-t">Recent · last 7 days</div>` + (list.length
      ? `<div class="you-als item">${list.slice(0, SHOW).map(row).join('')}</div>${list.length > SHOW ? `<button type="button" class="you-more" data-more>Show ${list.length - SHOW} more</button>` : ''}`
      : '<div class="you-note">Nothing yet this week.</div>');
    const more = box.querySelector('[data-more]');
    if (more) more.addEventListener('click', () => {
      box.querySelector('.you-als').insertAdjacentHTML('beforeend', list.slice(SHOW).map(row).join(''));
      more.remove();
    });
  }

  async function drawPush() {
    const box = document.getElementById('you-push');
    if (!box) return;
    if (!pushReady()) {
      box.innerHTML = `<div class="you-note">${ios() && !installed()
        ? 'Add League to your Home Screen and open it from there to turn these on.'
        : "This browser can't show notifications from a website."}</div>`;
      return;
    }
    if (Notification.permission === 'denied') {
      box.innerHTML = `<div class="you-note">Notifications are blocked for this site. Turn them on in ${ios() ? 'Settings › Notifications › League' : 'your browser settings'}, then come back.</div>`;
      return;
    }
    const sub = await currentSub().catch(() => null);
    const prefs = getPrefs();
    const me = getMe();
    const sw = (id, label, on, dis) => `<label class="you-row${dis ? ' dis' : ''}"><span>${label}</span><input type="checkbox" role="switch" class="you-sw" id="${id}"${on ? ' checked' : ''}${dis ? ' disabled' : ''}></label>`;
    box.innerHTML = sw('you-push-on', 'Notify me', !!sub) + (sub ? `
      <div class="you-types">${PUSH_TYPES.map(([k, label, mine]) => sw('you-pt-' + k, label, prefs[k] && (!mine || !!me), mine && !me)).join('')}</div>
      ${me ? '' : '<div class="you-note">Pick your team under You for the ones about your games.</div>'}` : '');
    box.querySelector('#you-push-on').addEventListener('change', e => togglePush(e.target));
    PUSH_TYPES.forEach(([k]) => {
      const el = box.querySelector('#you-pt-' + k);
      if (el) el.addEventListener('change', () => {
        const p = getPrefs();
        p[k] = el.checked;
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (err) {}
        syncSub();
      });
    });
  }

  async function togglePush(input) {
    input.disabled = true;
    try {
      if (input.checked) {
        // Asked first, while the tap still counts as the reason: Safari
        // only shows the prompt straight from a tap.
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { drawPush(); return; }
        const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
        await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC) });
        await post('/push/subscribe', { sub: sub.toJSON(), me: getMe(), prefs: getPrefs() });
      } else {
        const sub = await currentSub();
        if (sub) {
          await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe();
        }
      }
    } catch (e) {
      console.error('Notifications:', e);
    }
    drawPush();
  }

  // Tuck the sticky bar away while the page scrolls down and bring it back
  // on any scroll up, so it costs no screen while reading but is one flick
  // away from the bottom of a long page. Movement under SLACK px is held
  // until it adds up, so a resting thumb's jitter doesn't flicker the bar.
  function autoHide(bar) {
    const SLACK = 6;
    let lastY = window.scrollY;
    let queued = false;

    function update() {
      queued = false;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      // iOS rubber-banding past either end reports positions outside the
      // page; the snap back from the bottom would read as a scroll up.
      if (y < 0 || y > max) return;
      if (y <= bar.offsetHeight) {
        bar.classList.remove('tucked');
        lastY = y;
        return;
      }
      const dy = y - lastY;
      if (Math.abs(dy) < SLACK) return;
      if (dy < 0) bar.classList.remove('tucked');
      else bar.classList.add('tucked');
      lastY = y;
    }

    window.addEventListener('scroll', () => {
      if (!queued) { queued = true; requestAnimationFrame(update); }
    }, { passive: true });
    // Tabbing into a tucked bar brings it back into view.
    bar.addEventListener('focusin', () => bar.classList.remove('tucked'));
  }

  // The same one-line footer on every page: where the data comes from, plus
  // an optional per-page note (data-note), with data-source standing in for
  // the default where a page doesn't read ESPN at all (Parlay Results).
  function renderFooter() {
    const foot = document.getElementById('site-footer');
    if (!foot) return;
    const parts = [foot.dataset.source || 'Data via ESPN Fantasy'];
    if (foot.dataset.note) parts.push(foot.dataset.note);
    foot.textContent = parts.join(' · ');
  }

  function render() { renderNav(); renderFooter(); claimFromLink(); }
  // The link tapped again while the site is already open in this tab.
  window.addEventListener('hashchange', claimFromLink);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
