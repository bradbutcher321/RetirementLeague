// Service worker (site audit II #37 and #38). Registered from page-common.js.
//
// Instant opens: every page, style, script and data file the site fetches
// is kept on the phone, so the Home Screen app still opens in a dead spot
// (a stadium) and the dashboard can paint its last known numbers before the
// fresh ones land (index.html paintFromCache). What comes from where:
//   - pages and data (league.json, the Worker's live numbers): the network
//     first, so a deploy or a score shows up on the very next open; the
//     kept copy only when the network fails or is slower than WAIT_MS.
//   - versioned files (theme.css?v=24) and fonts never change under the
//     same URL, so the kept copy wins and the network isn't asked.
//   - icons and logos: the kept copy at once, refreshed behind it.
//
// Notifications: the Worker (worker/src/push.js) sends the message; this
// shows it, and a tap opens (or focuses) the page it's about.
const CACHE = 'rl-v1';
const WAIT_MS = 2500;
const WORKER = 'https://retirement-league-refresh-proxy.bradbutcher321.workers.dev';
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

// Every page and the history files, fetched once on install, so a page
// you've never opened still opens in a dead spot. Each is kept by path
// (keyFor), the same key a visit to it uses.
const PAGES = ['index.html', 'feed.html', 'franchise.html', 'head-to-head.html', 'overview.html', 'game-records.html', 'standings.html',
  'parlay-results.html', 'parlay-legs.html', 'parlay-entry.html', 'commissioner.html', 'draft-board.html', 'rule-changes.html', 'wrapped.html', 'history.html', 'videos.html', 'data/league.json', 'data/franchise.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(Promise.all(PAGES.map(path => {
    const url = new URL(path, self.registration.scope).href;
    return fetch(url, { cache: 'no-cache' }).then(async res => {
      if (!path.endsWith('.html')) return put(url, res);
      const html = await res.clone().text();
      await put(url, res);
      // ...and the page's own scripts and styles (theme.css?v=25 and so on).
      const deps = [...html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map(m => new URL(m[1], url).href);
      await Promise.all(deps.map(d => caches.match(d).then(hit => hit || fetch(d).then(r => put(d, r)))).map(p => p.catch(() => {})));
    }).catch(() => {});
  })));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// A versioned file replaces its older versions, so the cache holds one copy.
async function put(req, res) {
  if (!res || !res.ok || res.type === 'opaque') return;
  const cache = await caches.open(CACHE);
  const url = new URL(typeof req === 'string' ? req : req.url);
  if (url.searchParams.has('v')) {
    for (const old of await cache.keys()) {
      const o = new URL(old.url);
      if (o.origin === url.origin && o.pathname === url.pathname && o.search !== url.search) cache.delete(old);
    }
  }
  await cache.put(req, res);
}

// Pages are kept by path alone: franchise.html?m=Brad opens from the same
// copy as franchise.html, since the query only picks what the page shows.
const keyFor = req => (req.mode === 'navigate' ? new URL(req.url).origin + new URL(req.url).pathname : req);
const match = req => caches.match(keyFor(req), { ignoreVary: true });

function networkFirst(e) {
  const req = e.request;
  const net = fetch(req).then(res => {
    e.waitUntil(put(keyFor(req), res.clone()));
    return res;
  });
  e.waitUntil(net.catch(() => {}));
  return new Promise(resolve => {
    let settled = false;
    const fallback = async () => {
      const hit = await match(req);
      if (hit && !settled) { settled = true; resolve(hit); }
      return hit;
    };
    const timer = setTimeout(fallback, WAIT_MS);
    net.then(res => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } })
      .catch(async () => {
        clearTimeout(timer);
        if (!(await fallback()) && !settled) { settled = true; resolve(Response.error()); }
      });
  });
}

async function cacheFirst(e, refresh) {
  const hit = await match(e.request);
  const net = fetch(e.request).then(res => { e.waitUntil(put(e.request, res.clone())); return res; });
  if (hit) {
    if (refresh) e.waitUntil(net.catch(() => {}));
    return hit;
  }
  return net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === WORKER) {
    // The live numbers, the parlay data and the median chart; analytics
    // and anything else go straight through.
    if (['/', '/parlay-stats', '/median-history'].includes(url.pathname)) e.respondWith(networkFirst(e));
    return;
  }
  if (FONTS.test(req.url)) { e.respondWith(cacheFirst(e, false)); return; }
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('.json') || url.pathname.endsWith('.webmanifest')) {
    e.respondWith(networkFirst(e));
  } else if (url.searchParams.has('v')) {
    e.respondWith(cacheFirst(e, false));
  } else {
    e.respondWith(cacheFirst(e, true));
  }
});

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { title: 'Retirement League', body: e.data && e.data.text() }; }
  const tasks = [self.registration.showNotification(m.title || 'Retirement League', {
    body: m.body || '',
    tag: m.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-32.png',
    data: { url: m.url || './' },
  })];
  // The icon's badge (audit III #21): one more for every notification since
  // the app was last open. The count lives in the cache (page-common.js
  // zeroes it when a page opens), and the page clears the icon itself.
  const nav = self.navigator;
  if (nav && 'setAppBadge' in nav) {
    tasks.push((async () => {
      const cache = await caches.open(CACHE);
      const key = new URL('badge-count', self.registration.scope).href;
      const hit = await cache.match(key);
      const n = (hit ? Number(await hit.text()) || 0 : 0) + 1;
      await cache.put(key, new Response(String(n)));
      await nav.setAppBadge(n);
    })().catch(() => {}));
  }
  e.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find(w => w.url.split('?')[0] === target.split('?')[0]);
    if (same) { await same.focus(); return; }
    if (wins[0] && 'navigate' in wins[0]) { await wins[0].navigate(target); await wins[0].focus(); return; }
    await self.clients.openWindow(target);
  })());
});
