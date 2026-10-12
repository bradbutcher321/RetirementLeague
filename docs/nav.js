// Shared hamburger navigation, injected into <div id="site-nav"></div> on
// every page. The page list lives here in exactly one place, so adding a
// new page to the site means adding one entry to PAGES rather than editing
// a nav block copy-pasted across every HTML file.
(function () {
  const PAGES = [
    { href: 'index.html', label: 'Live Dashboard' },
    { href: 'franchise.html', label: 'Franchise' },
    { href: 'head-to-head.html', label: 'Head to Head' },
    { href: 'overview.html', label: 'League History' },
    { href: 'game-records.html', label: 'Game Records' },
    { href: 'standings.html', label: 'Standings' },
    { href: 'parlay-results.html', label: 'Parlay Results' },
    { href: 'draft-board.html', label: 'Draft Board' },
    { href: 'rule-changes.html', label: 'Rule Changes' },
  ];

  function currentFile() {
    const last = window.location.pathname.split('/').pop();
    return last === '' ? 'index.html' : last;
  }

  function renderNav() {
    const mount = document.getElementById('site-nav');
    if (!mount) return;

    // A page reached from inside another one (Season Wrapped, from
    // Franchise) isn't in the menu: the bar names it from its own <h1>.
    const h1 = document.querySelector('h1');
    const current = PAGES.find(p => p.href === currentFile()) || { href: currentFile(), label: h1 ? h1.textContent : 'Retirement League' };
    const links = PAGES.map(p => `<a class="nav-link${p.href === current.href ? ' active' : ''}" href="${p.href}">${p.label}</a>`).join('');
    // The desktop row (nav.css shows it only when all nine fit across).
    const inline = PAGES.map(p => `<a${p.href === current.href ? ' class="active" aria-current="page"' : ''} href="${p.href}">${p.label}</a>`).join('');

    mount.innerHTML = `
      <div class="nav-bar">
        <button class="nav-toggle" id="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
        <div class="nav-brand">${current.label}</div>
        <nav class="nav-links" aria-label="Pages">${inline}</nav>
        <button class="nav-me" id="nav-me" type="button" aria-haspopup="dialog"></button>
      </div>
      <div class="nav-backdrop" id="nav-backdrop"></div>
      <nav class="nav-drawer" id="nav-drawer" aria-hidden="true">
        <div class="nav-drawer-header">Retirement League</div>
        ${links}
      </nav>`;

    const toggle = mount.querySelector('#nav-toggle');
    const drawer = mount.querySelector('#nav-drawer');
    const backdrop = mount.querySelector('#nav-backdrop');

    function openNav() {
      drawer.classList.add('open');
      backdrop.classList.add('open');
      toggle.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      drawer.setAttribute('aria-hidden', 'false');
    }
    function closeNav() {
      drawer.classList.remove('open');
      backdrop.classList.remove('open');
      toggle.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      drawer.setAttribute('aria-hidden', 'true');
    }

    toggle.addEventListener('click', () => {
      if (drawer.classList.contains('open')) closeNav(); else openNav();
    });
    backdrop.addEventListener('click', closeNav);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });

    autoHide(mount.querySelector('.nav-bar'), drawer);
    wireYou(mount.querySelector('#nav-me'));
  }

  // ---------- You (site audit II #36 and #37) ----------
  // The round button at the right of the bar: your monogram once you've
  // picked your team (getMe/setMe in page-common.js), a person outline
  // before. It opens the You sheet: which team is yours, and the Home
  // Screen app's notifications. Anything else on a page can open the same
  // sheet with openYou() (the dashboard's first-visit prompt does).
  const WORKER = 'https://retirement-league-refresh-proxy.bradbutcher321.workers.dev';
  const VAPID_PUBLIC = 'BPvPSYw_tyBqsI3ZwzWEn4QdhCrPs5r6SB1X-6p8UrJE5BMc4GZW9hiHRc2Vj2_l3zSZTfnLhHKRmg8QT9ADT6c';
  const PREFS_KEY = 'rl-push-prefs';
  // [pref, label, about your own games]
  const PUSH_TYPES = [
    ['final', 'My matchup is final', true],
    ['median', 'I clinch the median win', true],
    ['parlay', 'My parlay leg hits or dies', true],
    ['parlayAll', "Every leg that hits, until it's killed", false],
    ['recap', 'Week in Review is up', false],
  ];
  const PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/></svg>';

  const pushReady = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function getPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) {}
    // Every leg is opt-in (worker/src/push.js PREF_OFF_BY_DEFAULT).
    return Object.fromEntries(PUSH_TYPES.map(([k]) => [k, k === 'parlayAll' ? p[k] === true : p[k] !== false]));
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
    btn.addEventListener('click', () => openYou());
    window.addEventListener('rl-me', () => drawChip(btn));
  }

  let lastFocus = null;
  const onKey = e => { if (e.key === 'Escape') closeYou(); };
  function closeYou() {
    document.getElementById('you-sheet')?.remove();
    document.getElementById('you-scrim')?.remove();
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  window.openYou = async function openYou() {
    if (document.getElementById('you-sheet')) return;
    lastFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="you-scrim"></div>
      <div class="sheet you-sheet" id="you-sheet" role="dialog" aria-modal="true" aria-labelledby="you-title">
        <div class="sheet-grab" aria-hidden="true"><span></span></div>
        <div class="sheet-head you-head"><div class="you-title" id="you-title">Which team is yours?</div><button class="x" type="button" aria-label="Close">✕</button></div>
        <div class="sheet-body"><div id="you-body"><div class="you-note">Loading…</div></div></div>
      </div>`);
    const sheet = document.getElementById('you-sheet');
    document.getElementById('you-scrim').addEventListener('click', closeYou);
    sheet.querySelector('.x').addEventListener('click', closeYou);
    document.addEventListener('keydown', onKey);
    sheet.querySelector('.x').focus();
    const names = await loadManagers();
    if (document.getElementById('you-sheet') === sheet) drawYou(names);
  };

  function drawYou(names) {
    const body = document.getElementById('you-body');
    if (!body) return;
    const me = getMe();
    const picks = names.map(n => `<button type="button" class="you-pick${n === me ? ' on' : ''}" data-me="${esc(n)}" aria-pressed="${n === me}">${esc(n)}</button>`).join('');
    body.innerHTML = `
      <div class="you-sub">Your matchup leads the dashboard, your row is ringed, and Franchise and Head to Head open on you.</div>
      <div class="you-picks">${picks}<button type="button" class="you-pick none${me ? '' : ' on'}" data-me="" aria-pressed="${!me}">Not in the league</button></div>
      <div class="you-sec">
        <div class="you-sec-t">Notifications</div>
        <div id="you-push"></div>
      </div>`;
    body.querySelectorAll('[data-me]').forEach(b => b.addEventListener('click', () => {
      setMe(b.dataset.me);
      drawYou(names);
      syncSub();
    }));
    drawPush();
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
      ${me ? '' : '<div class="you-note">Pick your team above for the ones about your games.</div>'}` : '');
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
  function autoHide(bar, drawer) {
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
      else if (!drawer.classList.contains('open')) bar.classList.add('tucked');
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

  function render() { renderNav(); renderFooter(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
