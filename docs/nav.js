// Shared hamburger navigation, injected into <div id="site-nav"></div> on
// every page. The page list lives here in exactly one place, so adding a
// new page to the site means adding one entry to PAGES rather than editing
// a nav block copy-pasted across every HTML file.
(function () {
  const PAGES = [
    { href: 'index.html', label: 'Live Dashboard' },
    { href: 'franchise.html', label: 'Franchise' },
    { href: 'head-to-head.html', label: 'Head to Head' },
    { href: 'overview.html', label: 'Overview' },
    { href: 'game-records.html', label: 'Game Records' },
    { href: 'standings.html', label: 'Standings' },
    { href: 'parlay-results.html', label: 'Parlay Results' },
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

    mount.innerHTML = `
      <div class="nav-bar">
        <button class="nav-toggle" id="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
        <div class="nav-brand">${current.label}</div>
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNav);
  } else {
    renderNav();
  }
})();
