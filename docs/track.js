// Anonymous visit counter: a random id kept in this browser plus the page name.
// Set localStorage 'rl-notrack' to any value to stop counting your own visits.
(function () {
  var host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return;
  try { if (localStorage.getItem('rl-notrack')) return; } catch (e) {}

  var URL_HIT = 'https://retirement-league-refresh-proxy.bradbutcher321.workers.dev/hit';
  var vid;
  try {
    vid = localStorage.getItem('rl-vid');
    if (!vid) {
      vid = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      localStorage.setItem('rl-vid', vid);
    }
  } catch (e) {
    vid = 'anon-' + Math.random().toString(36).slice(2, 14);
  }

  var page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '').toLowerCase();
  if (page === 'index') page = 'dashboard';

  function send(kind) {
    try {
      fetch(URL_HIT, { method: 'POST', body: JSON.stringify({ vid: vid, page: page, kind: kind }), headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  send('view');
  // Keeps "active now" accurate for someone reading one page for a while.
  setInterval(function () { if (!document.hidden) send('ping'); }, 120000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) send('ping'); });
})();
