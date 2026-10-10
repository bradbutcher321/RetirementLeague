// Shared hamburger navigation, injected into <div id="site-nav"></div> on
// every page. The page list lives here in exactly one place, so adding a
// new page to the site means adding one entry to PAGES rather than editing
// a nav block copy-pasted across every HTML file.
(function () {
  // Dev switch for comparing the two state-accent readings on the real
  // pages: ?accent=outline keeps only the colored outline on a won/lost/
  // leading item, anything else keeps the default outline + tint. The
  // choice sticks across navigation so you can click through the whole
  // site in one mode. Remove this block (and the [data-accent] rules in
  // theme.css) once the call is made.
  try {
    const q = new URLSearchParams(window.location.search).get('accent');
    if (q) sessionStorage.setItem('rl-accent', q);
    const mode = q || sessionStorage.getItem('rl-accent');
    if (mode === 'outline') document.documentElement.setAttribute('data-accent', 'outline');
  } catch (e) { /* private mode / blocked storage -- fall through to the default */ }

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

    const current = PAGES.find(p => p.href === currentFile()) || PAGES[0];
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
