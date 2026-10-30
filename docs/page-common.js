// Tiny formatting helpers every page needs, whatever data it reads.
//
// Loaded directly by the pages that don't read data/league.json (Franchise,
// Parlay Results, Rule Changes, Draft Board), and loaded ahead of
// league-common.js by the four that do -- LG re-exports esc/formatUpdated
// from here rather than keeping a second copy, which is what it used to do.
// Every page defined its own identical copy before that.
// `?? ''` so a missing value renders as nothing rather than the literal
// strings "null"/"undefined" -- the league.json pages relied on that in
// their own copy, and it's the right behaviour for the others too.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatUpdated(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}

// ---------- What a page covers (audit V #11) ----------
// A time in the status line only where it changes by the minute (Live,
// Feed, Parlay Results). Everywhere else the line says what the page
// covers, so a history page built on Friday doesn't look stale on Tuesday.
// Week 1 kicks off the Thursday after Labor Day; a week is over once its
// Monday night is (Tuesday, 4 AM Eastern, taken as 8 AM UTC).
function seasonKickoff(year) {
  const d = new Date(Date.UTC(year, 8, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); // Labor Day
  d.setUTCDate(d.getUTCDate() + 3);
  return d;
}
function throughLabel(iso, lastWeek = 17) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  let year = t.getUTCFullYear();
  if (t < seasonKickoff(year)) year--;
  const firstEnd = seasonKickoff(year).getTime() + 5 * 864e5 + 8 * 36e5;
  const weeks = Math.floor((t.getTime() - firstEnd) / (7 * 864e5)) + 1;
  if (weeks < 1) return `Through the ${year - 1} season`;
  if (weeks >= lastWeek) return `${year} season`;
  return `Through Week ${weeks}`;
}
// Puts it in the header's status line in place of "Updated <time>".
function setPageStatus(text) {
  const el = document.getElementById('updated-at');
  if (!el || !text) return;
  el.textContent = text;
  const label = el.parentElement && el.parentElement.querySelector('.updated-label');
  if (label) label.textContent = '';
}

// Two-letter monogram per manager: first and last initial, as the league
// knows everyone (TJ is just TJ). Shared so Game Records and Franchise's
// Head to Head ledger always show the same letters for the same person.
const MONOGRAMS = {
  Collin: 'CR', 'Joe G': 'JG', Brad: 'BB', Flanders: 'NF', TJ: 'TJ', Kris: 'KC', Jon: 'JD',
  Chad: 'CG', Ben: 'BR', 'Joe K': 'JK', Jared: 'JS', Jeff: 'JR', Chappy: 'DS', Corey: 'CC',
};
function monogram(name) {
  return MONOGRAMS[name] || String(name ?? '').slice(0, 2).toUpperCase();
}

// ---------- This is me (audit II #36) ----------
// The manager this phone belongs to, picked once in the You sheet (nav.js)
// and kept in this browser. Pages read it to lead with your matchup, ring
// your row and open on you; picking again fires 'rl-me' so an open page can
// redraw. Empty when nobody's been picked (or "Not in the league").
const ME_KEY = 'rl-me';
function getMe() {
  try { return localStorage.getItem(ME_KEY) || ''; } catch (e) { return ''; }
}
function setMe(name) {
  try { if (name) localStorage.setItem(ME_KEY, name); else localStorage.removeItem(ME_KEY); } catch (e) {}
  window.dispatchEvent(new CustomEvent('rl-me', { detail: name || '' }));
}
function isMe(name) {
  const me = getMe();
  return !!me && !!name && me.toLowerCase() === String(name).toLowerCase();
}

// ---------- Signed in (audit III #24) ----------
// "This is me" above is only a setting. Signing in proves it: the link the
// commissioner texts (or the code the website shows for the Home Screen
// app) is swapped by the Worker for a key kept in this browser, and the
// Worker reads who you are from that key (worker/src/auth.js). The You
// sheet (nav.js) does the signing in and out; a page that saves something
// in your name sends authHeaders() with it. setAuth fires 'rl-auth'.
const AUTH_KEY = 'rl-auth';
function getAuth() {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY));
    return a && a.token && a.manager ? a : null;
  } catch (e) { return null; }
}
function setAuth(auth) {
  try { if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); else localStorage.removeItem(AUTH_KEY); } catch (e) {}
  if (auth) setMe(auth.manager);
  window.dispatchEvent(new CustomEvent('rl-auth', { detail: auth || null }));
}
// Adds fields to the saved sign-in (the Worker's word on whether you're a
// commissioner) without announcing a new sign-in.
function patchAuth(fields) {
  const a = getAuth();
  if (!a) return;
  try { localStorage.setItem(AUTH_KEY, JSON.stringify({ ...a, ...fields })); } catch (e) {}
}
// Brad and Jon until the Worker has said otherwise (auth.commissioner, kept by nav.js).
function isCommissioner(a) {
  return !!a && (a.commissioner !== undefined ? !!a.commissioner : ['Brad', 'Jon'].includes(a.manager));
}
function authHeaders() {
  const a = getAuth();
  return a ? { Authorization: 'Bearer ' + a.token } : {};
}

// ---------- Your settings (You sheet › Settings, nav.js) ----------
// Kept in this browser like the pick above. Changing one fires
// 'rl-settings' so an open page can redraw.
//   meTop:   the dashboard puts your matchup at the top of the page instead
//            of first in its matchups list.
//   meColor: the ring on your rows and cards (theme.css .me, --me-ring).
const SETTINGS_KEY = 'rl-settings';
// [key, name, ring]. No gold (it marks a leader), green or red (they mean
// winning and losing) -- the ring only ever says "this one's yours". No
// white either: the Feed marks your opponent's plays in white. The first is
// the default, and what an old saved "white" pick falls back to.
const ME_COLORS = [
  ['canaveral', 'Canaveral blue', '#7AAEDB'],
  ['pink', 'Pink', '#F29BC4'],
  ['lavender', 'Lavender', '#B7A4F2'],
  ['orange', 'Orange', '#F0A35E'],
  ['seafoam', 'Seafoam', '#86D9C6'],
  ['teal', 'Teal', '#3FC1C9'],
];
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  applyMeColor();
  window.dispatchEvent(new CustomEvent('rl-settings', { detail: s }));
}
function meColor() {
  return ME_COLORS.find(c => c[0] === getSettings().meColor) || ME_COLORS[0];
}
function applyMeColor() {
  document.documentElement.style.setProperty('--me-ring', meColor()[2]);
}
applyMeColor();

// Service worker (sw.js, audit II #37/#38): instant opens from the last
// copy, and the Home Screen app's notifications. Real site only -- on the
// localhost preview it would serve yesterday's edit -- unless ?sw is added.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || /[?&]sw\b/.test(location.search))) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- App icon badge (audit III #21) ----------
// The red number on the Home Screen icon (navigator.setAppBadge: iOS 16.4+,
// Home Screen app only, and only once notifications are allowed): how many
// notifications have come in since the app was last open. sw.js adds one per
// push; opening any page clears the icon and the count (kept in the same
// cache as the pages, under 'badge-count').
(() => {
  if ('setAppBadge' in navigator) { try { navigator.clearAppBadge().catch(() => {}); } catch (e) {} }
  if ('caches' in window) caches.open('rl-v1').then(c => c.put('badge-count', new Response('0'))).catch(() => {});
})();

// Record-type tile (audit II #5): the mark at the head of a record row says
// what kind of record it is, never who holds it -- the holder's name is
// printed right beside it. Game Records only needs hi/lo (every card is a
// high/low pair); League History names one per record. Styled as .type-tile
// in theme.css; 'loss' tints it red (the Sacko).
const TILE_STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const TILE_TROPHY = '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 3 3.2M17 6h2.5a2.5 2.5 0 0 1-3 3.2"/><path d="M12 14v3.5M8.5 20.5h7"/>';
const TYPE_ICONS = {
  hi: `<path d="M12 19V5"/><path d="M5.5 11.5 12 5l6.5 6.5"/>`,
  lo: `<path d="M12 5v14"/><path d="M5.5 12.5 12 19l6.5-6.5"/>`,
  trophy: TILE_TROPHY,
  sacko: `<g transform="rotate(180 12 12)">${TILE_TROPHY}</g>`,
  points: `<path d="M4 20h16"/><path d="M7 16v-4M12 16V8M17 16V5"/>`,
  record: `<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/><path d="m9 15 2 2 4-4"/>`,
  streak: `<path d="M12 3c.6 3.2 4.5 5.3 4.5 9.6A4.5 4.5 0 0 1 12 17a4.5 4.5 0 0 1-4.5-4.4c0-2 1-3.2 2-4.1.1 1.6.9 2.6 1.8 2.6C11.3 8.5 11 5.6 12 3z"/><path d="M8 21h8"/>`,
  playoffs: `<path d="M4 5h5v5H4M4 14h5v5H4"/><path d="M9 7.5h3v9H9M12 12h7"/>`,
  finish: `<path d="M3 20h18"/><path d="M9.5 20V9h5v11M4 20v-6h5.5M14.5 20v-8H20v8"/>`,
  money: `<path d="M12 3v18"/><path d="M16.5 7.5c-.8-1.3-2.4-2-4.5-2-2.6 0-4.3 1.2-4.3 3.1 0 4.4 9 2.3 9 6.8 0 2-1.9 3.1-4.7 3.1-2.2 0-4-.8-4.8-2.3"/>`,
};
function typeTile(kind, cls) {
  return `<span class="type-tile${cls ? ' ' + cls : ''}" aria-hidden="true"><svg viewBox="0 0 24 24" ${TILE_STROKE}>${TYPE_ICONS[kind] || ''}</svg></span>`;
}

// Centre a scrolling selector track (.scroll, see theme.css) on its selected
// item, so after a re-render the choice you just made isn't off-screen.
// Measured from the two boxes rather than offsetLeft: tracks are positioned
// now (for the gliding pill), which changes what offsetLeft is relative to.
// Right after a tap on this same track it scrolls smoothly, alongside the
// pill's glide; a first render or a rebuilt track still jumps straight there.
function keepSelectedInView(track) {
  if (!track || track.scrollWidth <= track.clientWidth) return;
  const on = track.querySelector('.on, .active');
  if (!on) return;
  const t = track.getBoundingClientRect(), o = on.getBoundingClientRect();
  const left = track.scrollLeft + (o.left - t.left) - (track.clientWidth - o.width) / 2;
  const smooth = track === glideTap.track && performance.now() - glideTap.at < 600 && !reducedMotion();
  track.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  updateEdgeFade(track);
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Playoff race (site audit 29), shared by the dashboard's standings and the
// Standings page. `rows` are in standings order, each { w, l, t }; `spots`
// is how many teams make the playoffs; `totalGames` is every team's full
// regular-season game count (median games included). Per row:
//   clinched -- fewer than `spots` other teams can still reach its wins
//   out      -- `spots` teams already have more wins than it can reach
//   gb       -- wins behind the last playoff spot (rows below the line only)
// Ties in wins go to total points, which nobody can promise, so a tie
// counts against the team both ways: only a certainty earns a tag. Teams
// playing each other are ignored too, which can only delay a tag, never
// award a wrong one. Null when the season length isn't known.
function playoffRace(rows, spots, totalGames) {
  if (!spots || !totalGames || rows.length <= spots) return null;
  const score = r => r.w + (r.t || 0) / 2;
  const best = r => score(r) + Math.max(0, totalGames - r.w - r.l - (r.t || 0));
  const line = score(rows[spots - 1]);
  return rows.map((r, i) => {
    const others = rows.filter(o => o !== r);
    return {
      clinched: others.filter(o => best(o) >= score(r)).length < spots,
      out: others.filter(o => score(o) > best(r)).length >= spots,
      gb: i >= spots ? Math.max(0, line - score(r)) : 0,
    };
  });
}
// A row's race marker, one more part of its record line: Clinched (turf),
// Eliminated (red), or how far a team below the line trails it. A word
// rather than a pill badge, because a badge didn't fit beside a record at
// phone width. A team level with the line shows nothing; the records say so.
function raceMark(r) {
  if (!r) return '';
  if (r.clinched) return '<span class="race-in">Clinched</span>';
  if (r.out) return '<span class="race-out">Eliminated</span>';
  return r.gb > 0 ? `<span>${Number.isInteger(r.gb) ? r.gb : r.gb.toFixed(1)} GB</span>` : '';
}
const PLAYOFF_LINE = '<div class="po-line" role="separator" aria-label="Playoff line">Playoff line</div>';
// Strength of the schedule left (site audit II #31): the combined win % of
// every opponent a team still has to play, each counted once per meeting,
// from their records in the same standings (median games included).
// ahead: opponents' names; recordOf(name) -> { w, l, t } or null.
function scheduleLeft(ahead, recordOf) {
  let won = 0, games = 0;
  (ahead || []).forEach(o => {
    const r = recordOf(o);
    if (!r) return;
    won += r.w + (r.t || 0) / 2;
    games += r.w + r.l + (r.t || 0);
  });
  return games ? { pct: won / games, n: ahead.length } : null;
}
// "SOS #3" after the race marker: where a team's schedule left ranks, #1
// the hardest (the highest combined win %). Every team gets its own number:
// equal schedules go in standings order, the higher team first.
// The top quarter reads in the loss red, so the tough road stands out. `r`
// is that team's entry from rankSchedules().
function sosMark(s, r) {
  if (!s || !r) return '';
  const say = `Remaining schedule ${sosOrdinal(r.rank)} hardest of ${r.of}: opponents' combined win % ${(s.pct * 100).toFixed(1)}% across ${s.n} game${s.n === 1 ? '' : 's'} left`;
  return `<span class="sos${r.hard ? ' hard' : ''}" title="${say}" aria-label="${say}">SOS #${r.rank}</span>`;
}
const sosOrdinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
// sosMark's rank for every team at once: { rank, of, hard } or null. `list`
// is in standings order, which a stable sort keeps for equal schedules.
function rankSchedules(list) {
  const order = list.map((s, i) => [s, i]).filter(([s]) => s).sort((a, b) => b[0].pct - a[0].pct);
  const of = order.length, hardCut = Math.floor(of / 4), out = list.map(() => null);
  order.forEach(([, i], k) => { out[i] = { rank: k + 1, of, hard: of >= 4 && k < hardCut }; });
  return out;
}

// ---------- Shareable views (site audit 21) ----------
// Franchise (?m=Brad&tab=scoring), Head to Head (?a=Joe+G&b=Joe+K),
// Standings (?year=2024&tab=reg), Game Records (?year=2024) and Draft Board
// (?year=2019&view=team) keep their view in the query string so it can be sent as a link. urlParam reads it on
// load, ahead of each page's localStorage fallback; setUrlParams writes
// changes back with replaceState, so picks don't pile up in Back. A null
// value drops the key; keys it isn't given (?recap, ?accent) stay put.
function urlParam(key) {
  return new URLSearchParams(location.search).get(key);
}
function setUrlParams(params) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) q.delete(k); else q.set(k, v);
  }
  const s = q.toString();
  try { history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + location.hash); } catch (e) {}
}
// A link straight to another page's view: pageLink('franchise.html', { m: 'Brad' }).
// Goes through esc() like any other text when it lands in an href.
function pageLink(page, params) {
  return page + '?' + new URLSearchParams(params);
}
// A manager's name as a link to their Franchise page (site audit #22). Given
// the league's managers as `known`, anything else ("League", a player) stays
// plain text. Inherits its row's color and type (theme.css a.mgr).
function mgrLink(name, known) {
  if (known && !known.has(name)) return esc(name);
  return `<a class="mgr" data-rv="${esc(name)}" href="${esc(pageLink('franchise.html', { m: name }))}">${esc(name)}</a>`;
}

// ---------- Tap a name ----------
// Once you've picked your team, tapping a manager's name (a standings row, a
// mgrLink, anything carrying data-rv="Name") opens a sheet with you against
// them instead of going to their Franchise page; the sheet has a button on to
// it. Your own name, and a tap with a modifier key (open in a new tab), go
// where they always did. rivals.js loads the first time it's needed.
function openRival(name) {
  if (typeof Rivals !== 'undefined') return Rivals.openSheet(name);
  return new Promise(done => {
    const s = document.createElement('script');
    s.src = 'rivals.js?v=4';
    s.onload = s.onerror = done;
    document.head.appendChild(s);
  }).then(() => (typeof Rivals !== 'undefined' ? Rivals.openSheet(name) : null));
}
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const el = e.target.closest && e.target.closest('[data-rv]');
  if (!el) return;
  const name = el.getAttribute('data-rv');
  if (!name || !getMe() || isMe(name)) return;
  e.preventDefault();
  e.stopPropagation();
  openRival(name);
}, true);
// The real name for one typed into a URL by hand, ignoring case (?m=brad).
function matchName(names, s) {
  const k = String(s ?? '').trim().toLowerCase();
  return (k && names.find(n => n.toLowerCase() === k)) || null;
}

// ---------- Weekly finishes (audit II #4) ----------
// Where every manager's score landed each regular-season week, from
// league.json's games ({ year, week, type, p1, p2, s1, s2, winner }), so
// Franchise, Game Records, League History and League Lore all count the
// same weeks the same way. The median is that week's own (the average of the
// two middle scores), so it reaches back before the official median game
// started in 2025. A week with any game unfinished is left out whole: a
// missing score would move the median and the bubble.
//   high / low     the week's top and bottom score
//   bubW           the lowest score that still beat the median
//   bubL           the highest score that still lost to it
//   beat / lost    scored above / below the median; margin sums score - median
//   stolen         won the matchup while scoring below the median
//   robbed         lost it while scoring above
//   boom / bust    scored 150+ / under 80
//   sd             standard deviation of the week's scores: how far a
//                  typical week swings from the manager's own average
//   dist12         finish counts (1st..12th) in 12-team weeks, weeks12 of them
// Returns { weeks: number of weeks counted, by: Map(name -> tallies) }.
const BOOM_PTS = 150, BUST_PTS = 80;
function weeklyFinishes(games) {
  const weeks = new Map(), broken = new Set();
  games.forEach(g => {
    if (g.type !== 'Reg' || !g.p2) return;
    const k = `${g.year}:${g.week}`;
    if (g.winner === 'In Progress' || !(g.s1 > 0) || !(g.s2 > 0)) { broken.add(k); return; }
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push({ p: g.p1, s: g.s1, won: g.winner === g.p1, lost: g.winner === g.p2 },
      { p: g.p2, s: g.s2, won: g.winner === g.p2, lost: g.winner === g.p1 });
  });
  const by = new Map();
  const of = p => by.get(p) || by.set(p, { weeks: 0, high: 0, low: 0, bubW: 0, bubL: 0, beat: 0, lost: 0, margin: 0,
    stolen: 0, robbed: 0, boom: 0, bust: 0, dist12: Array(12).fill(0), weeks12: 0, sum: 0, sq: 0, sd: 0 }).get(p);
  let counted = 0;
  weeks.forEach((list, k) => {
    if (broken.has(k) || list.length < 2) return;
    counted++;
    const s = list.map(x => x.s).sort((a, b) => b - a), n = s.length;
    const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    const above = s.filter(v => v > med), below = s.filter(v => v < med);
    const bubW = above.length ? above[above.length - 1] : null, bubL = below.length ? below[0] : null;
    list.forEach(x => {
      const t = of(x.p);
      t.weeks++;
      if (x.s === s[0]) t.high++;
      if (x.s === s[n - 1]) t.low++;
      if (x.s === bubW) t.bubW++;
      if (x.s === bubL) t.bubL++;
      if (x.s > med) t.beat++; else if (x.s < med) t.lost++;
      t.margin += x.s - med;
      if (x.won && x.s < med) t.stolen++;
      if (x.lost && x.s > med) t.robbed++;
      if (x.s >= BOOM_PTS) t.boom++;
      if (x.s < BUST_PTS) t.bust++;
      t.sum += x.s; t.sq += x.s * x.s;
      if (n === 12) { t.weeks12++; t.dist12[s.indexOf(x.s)]++; }
    });
  });
  by.forEach(t => { if (t.weeks) t.sd = Math.sqrt(Math.max(0, t.sq / t.weeks - (t.sum / t.weeks) ** 2)); });
  return { weeks: counted, by };
}
// Every name at the top of one weeklyFinishes() tally, for "most" claims
// that have to name a tie rather than pick one. names may limit the pool.
function weeklyLeaders(wf, key, names) {
  const rows = [...wf.by].filter(([n]) => !names || names.has(n));
  const value = Math.max(0, ...rows.map(([, t]) => t[key]));
  return { value, names: value ? rows.filter(([, t]) => t[key] === value).map(([n]) => n) : [] };
}

// ---------- Gliding selection (site audit Motion B) ----------
// Every selector track on the site (theme.css "Selectors") gets this with no
// page wiring: a capture-phase click listener notes where the selected pill
// is before the page's own handler runs, then waits for that handler's
// re-render and slides a stand-in pill from there to the new choice. Pages
// re-render tracks three different ways -- toggling .on in place, rebuilding
// the track's buttons, or rebuilding the whole card the track sits in -- so
// the track is found again by its path from the nearest id'd ancestor, and
// for a few frames, since Median Watch applies its toggle inside a view
// transition a frame or two later.
//
// A track with data-glide-panel also slides the content it switches in
// from the side you moved toward: the value is the id of that container,
// or "next" for the track's next sibling.
const TRACK_SEL = '.tabs, .seg, .sup-seg, .scope-row, .board-toggle';

// Haptics (audit III #25): a light tick for a tap that changes something.
// iOS gives web pages no vibration API, but since iOS 18 Safari ticks when
// a switch control flips, so a hidden one is flipped instead; Android has
// navigator.vibrate. Either only works inside the tap's own handler, so a
// matchup going final on its own can't tick. The hidden switch's click is
// kept from bubbling, so no page handler mistakes it for a tap elsewhere.
const haptic = (() => {
  let label = null;
  return () => {
    if (typeof navigator.vibrate === 'function') { navigator.vibrate(8); return; }
    if (!label) {
      label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.display = 'none';
      label.innerHTML = '<input type="checkbox" switch tabindex="-1">';
      label.addEventListener('click', e => e.stopPropagation());
      document.head.appendChild(label);
    }
    label.click();
  };
})();
// A tap on a track's unselected choice, or a tab in the bottom bar.
// Capture phase, so it sees the choice before the page's own handler marks
// it selected (Median Watch flips .on in place).
document.addEventListener('click', e => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest('button, a');
  if (!btn || btn.matches('.on, .active, [aria-current="page"]')) return;
  if (btn.parentElement?.matches(TRACK_SEL) || btn.closest('.tabbar')) haptic();
}, true);
const glideTap = { track: null, at: 0 };
(() => {
  const items = track => [...track.children].filter(c => !c.classList.contains('glide-pill'));
  const selected = track => items(track).find(c => c.matches('.on, .active'));
  // The pill's box in the track's scrolled content, which is where an
  // absolutely positioned child of a positioned scroller is placed.
  const boxOf = (track, el) => {
    const t = track.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - t.left - track.clientLeft + track.scrollLeft, y: r.top - t.top - track.clientTop + track.scrollTop, w: r.width, h: r.height };
  };
  const place = (pill, b) => {
    pill.style.width = b.w + 'px';
    pill.style.height = b.h + 'px';
    pill.style.transform = `translate(${b.x}px, ${b.y}px)`;
  };
  // The button takes the pill's place the instant the pill goes: its own
  // color fade would otherwise run from clear back to gold, a flash of no
  // gold right as the glide lands.
  const land = btn => {
    btn.style.transition = 'none';
    btn.classList.remove('glide-to');
    getComputedStyle(btn).backgroundColor;
    btn.style.transition = '';
  };
  const pathTo = el => {
    const parts = [];
    for (; el && el !== document.body; el = el.parentElement) {
      if (el.id) return [`#${CSS.escape(el.id)}`, ...parts].join(' > ');
      parts.unshift(`${el.tagName.toLowerCase()}:nth-child(${[...el.parentElement.children].indexOf(el) + 1})`);
    }
    return ['body', ...parts].join(' > ');
  };

  function glide(track, from, to) {
    track.querySelector(':scope > .glide-pill')?.remove();
    // The new choice's own fade to gold has only just started, so read its
    // selected look with that fade cut short. Read mid-fade, the pill came
    // out nearly clear and glided as a grey gap.
    to.style.transition = 'none';
    const cs = getComputedStyle(to);
    const look = { background: cs.backgroundColor, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius };
    to.style.transition = '';
    const pill = document.createElement('span');
    pill.className = 'glide-pill';
    pill.setAttribute('aria-hidden', 'true');
    pill.style.background = look.background;
    pill.style.boxShadow = look.boxShadow;
    pill.style.borderRadius = look.borderRadius;
    pill.style.transition = 'none';
    place(pill, from);
    // Appended last so pages that map track.children by index still line
    // their buttons up with the right entries.
    track.append(pill);
    to.classList.add('glide-to');
    // The overshoot would carry the pill past the end of a track that
    // doesn't scroll; clip it to the track's rounded edge, as a scrolling
    // one already does. Never on a scroller: overflow: clip would reset it.
    const clip = getComputedStyle(track).overflowX === 'visible';
    if (clip) track.classList.add('glide-clip');
    pill.getBoundingClientRect();
    pill.style.transition = '';
    place(pill, boxOf(track, to));
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      pill.remove();
      land(to);
      if (clip) track.classList.remove('glide-clip');
    };
    pill.addEventListener('transitionend', e => { if (e.propertyName === 'transform') done(); });
    setTimeout(done, 800);
  }

  function slidePanel(track, dir) {
    const key = track.dataset.glidePanel;
    const panel = key === 'next' ? track.nextElementSibling : key && document.getElementById(key);
    if (!panel) return;
    panel.classList.remove('glide-in-r', 'glide-in-l');
    void panel.offsetWidth;
    panel.classList.add(dir > 0 ? 'glide-in-r' : 'glide-in-l');
    const end = e => {
      if (e.target !== panel) return;
      panel.classList.remove('glide-in-r', 'glide-in-l');
      panel.removeEventListener('animationend', end);
    };
    panel.addEventListener('animationend', end);
  }

  document.addEventListener('click', e => {
    if (reducedMotion() || !(e.target instanceof Element)) return;
    const btn = e.target.closest('button');
    const track = btn?.parentElement;
    if (!track || !track.matches(TRACK_SEL) || btn.matches('.on, .active')) return;
    const old = selected(track);
    if (!old) return;
    // Mid-glide, start from wherever the moving pill is right now.
    const moving = track.querySelector(':scope > .glide-pill');
    const from = boxOf(track, moving || old);
    const fromIdx = items(track).indexOf(old);
    const path = pathTo(track);
    glideTap.track = track;
    glideTap.at = performance.now();
    let tries = 0;
    const settle = () => {
      // The page started a view transition for this tap; it carries the
      // pill instead (see below).
      if (glideTap.vt) return;
      const now = track.isConnected ? track : document.querySelector(path);
      const to = now && now.matches(TRACK_SEL) && selected(now);
      const toIdx = to ? items(now).indexOf(to) : -1;
      if (!to || toIdx === fromIdx) {
        if (++tries < 12) requestAnimationFrame(settle);
        return;
      }
      glide(now, from, to);
      slidePanel(now, toIdx - fromIdx);
    };
    requestAnimationFrame(settle);
  }, true);

  // When the tap also starts a view transition (the dashboard's Median
  // Watch and Season So Far toggles animate their content with one), the
  // whole page, track included, is shown as a pair of pictures until it
  // ends. Chrome keeps redrawing those pictures, but an iPhone shows them
  // still, so the glide above never appeared there: the gold vanished and
  // jumped. Instead the transition carries the pill itself. A plain pill
  // named gp-pill sits on the old choice in the "before" picture and on
  // the new one in the "after", and the transition slides it across. The
  // track's buttons are named too (gp-b0, gp-b1, ...) so their labels are
  // drawn above the pill rather than under it in the page's own picture.
  // The transition's pill slides as its own layer over the whole page, so
  // its overshoot used to carry it out past the track's end -- and on an
  // iPhone, heading for the last choice, it vanished for the whole slide.
  // The plain glide (League History) clips the same overshoot at the track,
  // so the pill bounces behind the track's border instead. This redraws the
  // transition's slide the same way: the UA's own animation is replaced by
  // one sampled along the same curve, clipped each frame to the track.
  const bezier = (x1, y1, x2, y2) => t => {
    // Solve x(u) = t for u (Newton, then bisection), return y(u).
    const c = (a, b, u) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const x = c(x1, x2, u) - t;
      const d = 3 * x1 * (1 - u) * (1 - u) + 6 * (x2 - x1) * u * (1 - u) + 3 * (1 - x2) * u * u;
      if (Math.abs(x) < 1e-5 || !d) break;
      u -= x / d;
    }
    if (!(u >= 0 && u <= 1)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 30; i++) { u = (lo + hi) / 2; if (c(x1, x2, u) < t) lo = u; else hi = u; }
    }
    return c(y1, y2, u);
  };
  const easeOf = css => {
    const m = /cubic-bezier\(([^)]+)\)/.exec(css || '');
    const v = m && m[1].split(',').map(Number);
    if (v && v.length === 4 && v.every(n => !isNaN(n))) return bezier(...v);
    return { linear: t => t, 'ease-in': bezier(.42, 0, 1, 1), 'ease-out': bezier(0, 0, .58, 1), 'ease-in-out': bezier(.42, 0, .58, 1) }[css] || bezier(.25, .1, .25, 1);
  };
  function clipPillToTrack(pillBox, trackBox, trackCs) {
    const name = '::view-transition-group(gp-pill)';
    const anim = document.getAnimations().find(a => a.effect && a.effect.pseudoElement === name);
    if (!anim) return;
    const kf = anim.effect.getKeyframes();
    const first = kf[0], last = kf[kf.length - 1];
    if (!first || !last || !first.transform || !last.transform) return;
    const a = new DOMMatrix(first.transform), b = new DOMMatrix(last.transform);
    const num = (v, dflt) => { const n = parseFloat(v); return isNaN(n) ? dflt : n; };
    const w0 = num(first.width, pillBox.width), w1 = num(last.width, pillBox.width);
    const h0 = num(first.height, pillBox.height), h1 = num(last.height, pillBox.height);
    // The track's inside edge, in the transition's own coordinates: offset
    // from where the pill lands, which the last keyframe places.
    const bl = num(trackCs.borderLeftWidth, 0), br = num(trackCs.borderRightWidth, 0);
    const left = b.e + (trackBox.left + bl - pillBox.left);
    const right = b.e + (trackBox.right - br - pillBox.left);
    // A pill's ends are half its height round; so is the track's inside
    // corner, near enough, so the clipped end tucks in along its curve.
    const radius = pillBox.height / 2;
    const timing = anim.effect.getComputedTiming();
    const ease = easeOf(first.easing && first.easing !== 'linear' ? first.easing : getComputedStyle(document.documentElement, name).animationTimingFunction);
    const frames = [];
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const t = i / N, e = ease(t);
      const x = a.e + (b.e - a.e) * e, y = a.f + (b.f - a.f) * e;
      const w = w0 + (w1 - w0) * e, h = h0 + (h1 - h0) * e;
      const cl = Math.max(0, Math.min(w, left - x)), cr = Math.max(0, Math.min(w, x + w - right));
      frames.push({
        offset: t, easing: 'linear',
        transform: `translate(${x}px, ${y}px)`, width: `${w}px`, height: `${h}px`,
        clipPath: `inset(0 ${cr}px 0 ${cl}px round ${radius}px)`,
      });
    }
    anim.cancel();
    document.documentElement.animate(frames, { duration: timing.duration, delay: timing.delay || 0, fill: 'both', pseudoElement: name });
  }

  if (!document.startViewTransition) return;
  const nativeVT = document.startViewTransition.bind(document);
  document.startViewTransition = arg => {
    const track = glideTap.track;
    if (!track || !track.isConnected || performance.now() - glideTap.at > 400 || reducedMotion()) return nativeVT(arg);
    // A track marked data-glide-jump skips the glide for this switch: its
    // pill goes straight to the new choice and the transition shows it
    // there from the start. The dashboard sets it on the pinned Season So
    // Far toggle in Safari, where the carried pill below vanished.
    if (track.matches('[data-glide-jump]')) {
      glideTap.vt = true;
      const vt = nativeVT(arg);
      const off = () => { glideTap.vt = false; };
      vt.finished.then(off, off);
      return vt;
    }
    const path = pathTo(track);
    const named = [];
    let pill = null, on = null;
    const unname = () => {
      named.forEach(el => { el.style.viewTransitionName = ''; el.style.viewTransitionClass = ''; });
      named.length = 0;
      if (pill) pill.remove();
      if (on) land(on);
      pill = on = null;
    };
    // A pill on the selected button of track `t`, the button gone clear
    // so only the pill shows gold, and every button named.
    const pillOn = t => {
      on = t && t.matches(TRACK_SEL) ? selected(t) : null;
      if (!on) return;
      // A track that flips .on in place (Median Watch's) has the button's
      // own color fade just starting, which would read as clear; read the
      // selected look with that fade cut short.
      on.style.transition = 'none';
      const cs = getComputedStyle(on);
      const look = { background: cs.backgroundColor, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius, transition: 'none' };
      on.style.transition = '';
      pill = document.createElement('span');
      pill.className = 'glide-pill';
      pill.setAttribute('aria-hidden', 'true');
      Object.assign(pill.style, look);
      place(pill, boxOf(t, on));
      t.append(pill);
      on.classList.add('glide-to');
      pill.style.viewTransitionName = 'gp-pill';
      named.push(pill);
      items(t).forEach((b, i) => { b.style.viewTransitionName = 'gp-b' + i; b.style.viewTransitionClass = 'gp-btn'; named.push(b); });
    };
    glideTap.vt = true;
    pillOn(track);
    const update = typeof arg === 'function' ? arg : arg && arg.update;
    const run = async () => {
      if (update) await update();
      unname();
      dest = track.isConnected ? track : document.querySelector(path);
      pillOn(dest);
      if (pill) { pillBox = pill.getBoundingClientRect(); trackBox = dest.getBoundingClientRect(); trackCs = getComputedStyle(dest); }
    };
    let dest = null, pillBox = null, trackBox = null, trackCs = null;
    const vt = nativeVT(typeof arg === 'object' && arg ? { ...arg, update: run } : run);
    vt.ready.then(() => { if (pillBox) clipPillToTrack(pillBox, trackBox, trackCs); }).catch(() => {});
    const done = () => { unname(); glideTap.vt = false; };
    vt.finished.then(done, done);
    return vt;
  };
})();

// Fade whichever edge of a sideways scroller still has more to show, so a
// tab past the edge reads as "keep swiping" rather than not existing. Covers
// every .scroll track plus any other strip marked .edge-fade (see theme.css).
// Pages don't wire anything up: scrolls are caught at the document, and
// re-renders, resizes and late font loads re-check every track.
const EDGE_FADE_SEL = '.scroll, .edge-fade';
function updateEdgeFade(el) {
  const max = el.scrollWidth - el.clientWidth;
  // 2px of slack: scrollLeft can land a fraction short of the end on
  // high-density screens, which would leave a fade over the last item.
  el.classList.toggle('fade-l', max > 2 && el.scrollLeft > 2);
  el.classList.toggle('fade-r', max > 2 && el.scrollLeft < max - 2);
}
function updateAllEdgeFades() {
  document.querySelectorAll(EDGE_FADE_SEL).forEach(updateEdgeFade);
}
(() => {
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; updateAllEdgeFades(); });
  };
  document.addEventListener('scroll', e => {
    if (e.target instanceof Element && e.target.matches(EDGE_FADE_SEL)) updateEdgeFade(e.target);
  }, { capture: true, passive: true });
  window.addEventListener('resize', queue);
  const start = () => {
    new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
    queue();
    if (document.fonts) document.fonts.ready.then(queue);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

// First-load entrance: the cards that just replaced a page's loading
// skeleton (theme.css "Loading skeleton") rise into place one after
// another. Pages call this once, after their first render only, so a tab
// switch or a 2-minute refresh never replays it. Past `cap` items the rest
// land together, so a long list doesn't keep trickling in. The class comes
// off as each one lands (see theme.css for why); the target check skips
// animations bubbling up from inside a card, like a live pip's pulse.
// `elapsed`: ms since the entrance began, for a second call that lands
// mid-entrance (index.html re-renders its cards when the live data arrives
// right after the cached paint): cards that were swapped out join the same
// animation at the point the others have reached, and any card that already
// rose is left alone.
const risenEls = new WeakSet();
function riseIn(els, cap = 8, elapsed = 0) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  [...els].forEach((el, i) => {
    if (risenEls.has(el)) return;
    risenEls.add(el);
    el.style.setProperty('--rise-i', Math.min(i, cap));
    if (elapsed) el.style.setProperty('--rise-t', Math.round(elapsed) + 'ms');
    el.classList.add('rise');
    const done = e => {
      if (e.target !== el) return;
      el.classList.remove('rise');
      el.style.removeProperty('--rise-i');
      el.style.removeProperty('--rise-t');
      el.removeEventListener('animationend', done);
      el.removeEventListener('animationcancel', done);
    };
    el.addEventListener('animationend', done);
    el.addEventListener('animationcancel', done);
  });
}

// "Add to Home Screen" card (theme.css "Home Screen card"). iPhones give a
// website no install button, so this shows where to tap instead, sitting
// just above Safari's bottom toolbar with its arrow on the button to tap
// first. Only Safari and Chrome on an iPhone/iPad see it; never once the
// site is opened from its Home Screen icon; at most once per visit, 2s
// after load; the ✕ hides it for 30 days. Add ?a2hs to any URL to force it
// (on any device) for testing.
(() => {
  const KEY = 'rl-a2hs-hide-until', SEEN = 'rl-a2hs-seen';
  const ua = navigator.userAgent;
  const force = /[?&]a2hs\b/.test(location.search);
  const store = (which, fn) => { try { return fn(which === 'local' ? localStorage : sessionStorage); } catch { return null; } };
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const chrome = /CriOS\//.test(ua);
  // In-app browsers (Instagram, Facebook, the Google app...) can't add to
  // the Home Screen at all, so only plain Safari and Chrome qualify.
  const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|Instagram|FBAN|FBAV|Line\//.test(ua);
  if (!force) {
    if (!ios || installed || !(safari || chrome)) return;
    if (Number(store('local', s => s.getItem(KEY))) > Date.now()) return;
    if (store('session', s => s.getItem(SEEN))) return;
  }
  // Safari 26 keeps Share behind the ⋯ button at the bottom right, and its
  // share sheet hides Add to Home Screen behind View More. Older Safari has
  // Share in the middle of its bottom toolbar. Chrome has it in the address
  // bar at the top, so there is nothing below for the arrow to point at.
  const ver = Number((ua.match(/Version\/(\d+)/) || [])[1]) || 0;
  const kind = force || (safari && ver >= 26) ? 'safari26' : safari ? 'safari' : 'chrome';
  const I = {
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.5 7.5 12 3l4.5 4.5"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/></svg>',
    viewMore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>',
    add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  };
  const chip = (icon, label, aria) => `<span class="a2hs-k"${aria ? ` role="img" aria-label="${aria}"` : ''}>${I[icon]}${label}</span>`;
  const steps = {
    safari26: [chip('more', '', 'More'), chip('share', 'Share'), chip('viewMore', 'View More'), chip('add', 'Add to Home Screen')],
    safari: [chip('share', 'Share'), chip('add', 'Add to Home Screen')],
    chrome: [chip('share', 'Share'), chip('viewMore', 'View More'), chip('add', 'Add to Home Screen')],
  }[kind];
  const show = () => {
    store('session', s => s.setItem(SEEN, '1'));
    const card = document.createElement('div');
    card.className = 'a2hs';
    card.dataset.arrow = { safari26: 'right', safari: 'center', chrome: 'none' }[kind];
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Add League to your Home Screen');
    card.innerHTML = `<div class="a2hs-row">
        <img class="a2hs-icon" src="icons/apple-touch-icon.png" alt="">
        <div class="a2hs-txt"><div class="a2hs-ttl">Add League to your Home Screen</div><div class="a2hs-sub">Opens full screen, straight to the dashboard.</div></div>
        <button class="x" type="button" aria-label="Close">✕</button>
      </div>
      <div class="a2hs-steps">${kind === 'chrome' ? '<span class="a2hs-then">In the address bar,</span>' : ''}${steps.map((c, i) => i ? `<span class="a2hs-step"><span class="a2hs-then">then</span>${c}</span>` : c).join('')}</div>`;
    card.querySelector('.x').addEventListener('click', () => {
      store('local', s => s.setItem(KEY, String(Date.now() + 30 * 864e5)));
      card.remove();
    });
    document.body.appendChild(card);
  };
  const later = () => setTimeout(show, 2000);
  if (document.readyState === 'complete') later(); else addEventListener('load', later);
})();

// Pull to refresh (theme.css "Pull to refresh"). Opened from its Home
// Screen icon the site has no reload button and iOS gives web apps no pull
// to refresh, so a stale page could only be fixed by force-quitting it.
// Pulling down from the very top drops a round arrow in from above; past
// ARM it turns gold, and letting go there refreshes. A page with live data
// (Live, Feed, Parlay Results) sets window.pageRefresh to its own poll, so a
// pull fetches new numbers without closing anything you opened (site audit
// VI #5); every other page reloads. Only the Home Screen app gets it (Safari
// and Chrome have their own); add ?ptr to any URL to force it for testing.
(() => {
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!installed && !/[?&]ptr\b/.test(location.search)) return;
  const ARM = 72, MAX = 110;
  // Taps inside these scroll or close something of their own.
  const SKIP = '.sheet, .scrim, .tabbar, .pop, .a2hs';
  let el = null, startX = 0, startY = 0, pull = 0, state = 'idle'; // idle | maybe | pulling | busy

  const chip = () => {
    if (!el) {
      el = document.createElement('div');
      el.className = 'ptr';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/></svg>';
      document.body.appendChild(el);
    }
    return el;
  };
  const draw = d => {
    const c = chip();
    c.style.setProperty('--ptr-y', `${d}px`);
    c.style.setProperty('--ptr-p', Math.min(d / ARM, 1));
    c.classList.toggle('armed', d >= ARM);
  };
  const reset = () => {
    state = 'idle';
    if (!el) return;
    el.classList.add('settle');
    draw(0);
    el.addEventListener('transitionend', () => el && el.classList.remove('settle'), { once: true });
  };

  addEventListener('touchstart', e => {
    if (state === 'busy' || e.touches.length !== 1 || window.scrollY > 0) return;
    if (e.target.closest(SKIP) || document.querySelector('.sheet')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    pull = 0;
    state = 'maybe';
  }, { passive: true });

  addEventListener('touchmove', e => {
    if (state !== 'maybe' && state !== 'pulling') return;
    if (e.touches.length !== 1) { reset(); return; }
    const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
    if (state === 'maybe') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // A sideways swipe (a tab row, Draft Board's board) or an upward
      // scroll isn't a pull.
      if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) { state = 'idle'; return; }
      state = 'pulling';
      if (el) el.classList.remove('settle');
    }
    // Half the finger's travel, easing off toward MAX like a rubber band.
    pull = MAX * (1 - Math.exp(-Math.max(dy, 0) * 0.5 / MAX));
    draw(pull);
  }, { passive: true });

  const end = () => {
    if (state === 'maybe') { state = 'idle'; return; }
    if (state !== 'pulling') return;
    if (pull < ARM) { reset(); return; }
    state = 'busy';
    haptic();
    el.classList.add('settle', 'busy');
    draw(ARM);
    if (typeof window.pageRefresh !== 'function') {
      // Long enough to see the spin start, so the reload reads as an answer.
      setTimeout(() => location.reload(), 350);
      return;
    }
    // Spin until the page's poll answers (at least long enough to read as
    // an answer, at most 8 seconds), then put the arrow away.
    const t0 = Date.now();
    Promise.race([Promise.resolve().then(window.pageRefresh), new Promise(r => setTimeout(r, 8000))])
      .catch(() => {})
      .then(() => setTimeout(() => { el.classList.remove('busy'); reset(); }, Math.max(0, 600 - (Date.now() - t0))));
  };
  addEventListener('touchend', end);
  addEventListener('touchcancel', reset);
  // Coming back to a page from the back/forward cache, drop a spinning chip.
  addEventListener('pageshow', e => { if (e.persisted && el) { el.classList.remove('busy'); reset(); } });
})();

// ---------- What a Feed row says (audit III #7) ----------
// One change to a starter's points, from his stats before (e.ps) and after
// (e.s), keyed by ESPN stat id (worker/src/dashboard.js FEED_STATS):
// "23-yd TD catch", "3 catches, 41 yds", "sack", "14 pts allowed". Shared
// by the Feed page and the dashboard's Flow captions.
function feedWhat(e) {
  const s = e.s || {}, ps = e.ps || {};
  const v = (o, ...ids) => { for (const id of ids) if (o[id]) return o[id]; return 0; };
  const dd = (...ids) => v(s, ...ids) - v(ps, ...ids);
  const num = (k, one, many) => (k === 1 ? one : `${k} ${many}`);
  const parts = [];
  const passTd = dd(4), rushTd = dd(25), recTd = dd(43);
  const cmp = dd(1), pyd = dd(3), car = dd(23), ryd = dd(24), rec = dd(41, 53), cyd = dd(42, 61);
  const passOne = passTd === 1 && cmp === 1, rushOne = rushTd === 1 && car === 1, recOne = recTd === 1 && rec === 1;
  if (passTd > 0) parts.push(passOne ? `${pyd}-yd TD pass` : num(passTd, 'TD pass', 'TD passes'));
  if (rushTd > 0) parts.push(rushOne ? `${ryd}-yd TD run` : num(rushTd, 'TD run', 'TD runs'));
  if (recTd > 0) parts.push(recOne ? `${cyd}-yd TD catch` : num(recTd, 'TD catch', 'TD catches'));
  if (e.pos === 'D/ST') {
    if (dd(105) > 0) parts.push(num(dd(105), 'defensive TD', 'defensive TDs'));
  } else if (dd(101) + dd(102) > 0) parts.push('return TD');
  if (dd(19) + dd(26) + dd(44) > 0) parts.push('2-pt conversion');
  if (dd(20) > 0) parts.push(num(dd(20), 'INT thrown', 'INTs thrown'));
  if (dd(72) > 0) parts.push('fumble lost');
  if (pyd && !passOne) parts.push(cmp === 1 ? `${pyd}-yd completion` : `${pyd} pass yds`);
  if ((ryd || car > 0) && !rushOne) {
    parts.push(car === 1 ? (ryd > 0 ? `${ryd}-yd run` : ryd < 0 ? `${-ryd}-yd loss` : 'no gain')
      : car > 1 ? `${car} carries, ${ryd} yds` : `${ryd} rush yds`);
  }
  if ((cyd || rec > 0) && !recOne) parts.push(rec === 1 ? `${cyd}-yd catch` : rec > 1 ? `${rec} catches, ${cyd} yds` : `${cyd} rec yds`);
  // Kicking: made field goals by distance (what's left of all makes is 60+).
  let fgSaid = 0;
  [[74, '50+ yd FG'], [77, '40–49 yd FG'], [80, 'FG']].forEach(([id, label]) => {
    const k = dd(id);
    if (k > 0) { parts.push(num(k, label, label + 's')); fgSaid += k; }
  });
  if (dd(83) > fgSaid) parts.push('60+ yd FG');
  if (dd(85) > 0) parts.push('missed FG');
  if (dd(86) > 0) parts.push(num(dd(86), 'extra point', 'extra points'));
  if (dd(88) > 0) parts.push('missed extra point');
  // Defense.
  if (dd(99) > 0) parts.push(num(dd(99), 'sack', 'sacks'));
  if (dd(95) > 0) parts.push(num(dd(95), 'INT', 'INTs'));
  if (dd(96) > 0) parts.push('fumble recovery');
  if (dd(98) > 0) parts.push('safety');
  if (dd(97) > 0) parts.push('blocked kick');
  if (e.pos === 'D/ST' && (dd(120) !== 0 || !parts.length)) parts.push(`${v(s, 120)} pts allowed`);
  return parts.length ? parts.join(', ') : 'points adjusted';
}

// ---------- Sheets swipe down to close, every one of them ----------
// One handler for every bottom sheet on the site, so a sheet can't be built
// without it (the tap-a-name sheet once shipped that way). Drag down from the
// handle, the header or anywhere in the body once that is scrolled to the top;
// let go past 90px (or with a quick flick) and it closes the way a tap on its
// scrim does, which each page already wires, so no sheet needs its own code.
// Only a sheet that is pinned to the bottom of the screen: on desktop the same
// element is a card near the top and stays put.
(() => {
  const FAR = 90, FLICK = 0.5; // px, px/ms
  let g = null; // { sheet, x, y, t, dy, on }

  const isBottomSheet = sheet => getComputedStyle(sheet).bottom === '0px';
  // Is anything between the touch and the sheet scrolled down from its top?
  const scrolledDown = (el, sheet) => {
    for (; el && el !== sheet; el = el.parentElement) {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return true;
    }
    return false;
  };
  const close = sheet => {
    const scrim = sheet.previousElementSibling;
    if (scrim && scrim.classList.contains('scrim')) scrim.click();
    else sheet.remove();
    // Something kept it open (it asked first, say): put it back.
    if (sheet.isConnected) { sheet.style.transition = 'transform .18s ease-out'; sheet.style.transform = ''; }
  };
  const settle = sheet => {
    sheet.style.transition = 'transform .18s ease-out';
    sheet.style.transform = '';
    setTimeout(() => { sheet.style.transition = ''; }, 200);
  };

  addEventListener('touchstart', e => {
    g = null;
    const sheet = e.target.closest && e.target.closest('.sheet');
    if (!sheet || e.touches.length !== 1 || !isBottomSheet(sheet)) return;
    g = { sheet, el: e.target, x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp, dy: 0, on: false };
  }, { passive: true });

  addEventListener('touchmove', e => {
    if (!g) return;
    const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
    if (!g.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Sideways (a scroll strip) or upward, or the body still has more above
      // it to scroll: that's the page's gesture, not ours.
      if (dy <= 0 || Math.abs(dx) > dy || scrolledDown(g.el, g.sheet)) { g = null; return; }
      g.on = true;
      g.y = e.touches[0].clientY; // measure from here, so the sheet doesn't jump
      g.sheet.style.animation = 'none';
      g.sheet.style.transition = '';
      g.t = e.timeStamp;
    }
    g.dy = Math.max(0, e.touches[0].clientY - g.y);
    g.sheet.style.transform = `translateY(${g.dy}px)`;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  const end = e => {
    if (!g) return;
    const { sheet, dy, on, t } = g;
    g = null;
    if (!on) return;
    const fast = dy / Math.max(e.timeStamp - t, 1) > FLICK && dy > 30;
    if (e.type !== 'touchcancel' && (dy > FAR || fast)) close(sheet);
    else settle(sheet);
  };
  addEventListener('touchend', end);
  addEventListener('touchcancel', end);

  // A mouse (a narrow desktop window) drags the handle or header the same way.
  let m = null;
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('button, a, input, select, textarea')) return;
    const grip = e.target.closest('.sheet-grab, .sheet-head');
    const sheet = grip && grip.closest('.sheet');
    if (!sheet || !isBottomSheet(sheet)) return;
    m = { sheet, grip, y: e.clientY, dy: 0, id: e.pointerId };
    sheet.style.animation = 'none';
    grip.setPointerCapture(e.pointerId);
  });
  addEventListener('pointermove', e => {
    if (!m || e.pointerId !== m.id) return;
    m.dy = Math.max(0, e.clientY - m.y);
    m.sheet.style.transform = `translateY(${m.dy}px)`;
  });
  const mouseEnd = e => {
    if (!m || e.pointerId !== m.id) return;
    const { sheet, dy } = m;
    m = null;
    if (e.type !== 'pointercancel' && dy > FAR) close(sheet); else settle(sheet);
  };
  addEventListener('pointerup', mouseEnd);
  addEventListener('pointercancel', mouseEnd);
})();

// ---------- Team logos (site audit IX) ----------
// Each manager's current team logo from franchise.json, which the service
// worker keeps, asked for once per page. avatarHtml draws the round avatar:
// the logo once it's known, the monogram until then (or for good, without one).
let teamLogosP = null;
function teamLogos() {
  if (!teamLogosP) {
    teamLogosP = fetch('data/franchise.json').then(r => r.json())
      .then(d => Object.fromEntries((d.players || []).filter(p => p.current_team_logo).map(p => [p.name, p.current_team_logo])))
      .catch(() => { teamLogosP = null; return {}; });
  }
  return teamLogosP;
}
function avatarHtml(name, logos, cls = '') {
  const url = logos && logos[name];
  return `<span class="rl-av${cls ? ' ' + cls : ''}" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<i>${esc(monogram(name))}</i>`}</span>`;
}

// ---------- Play toast (site audit IX #11) ----------
// A short pill at the top of the screen when a poll brings points for your
// matchup: whose, what, how many. One at a time; a newer one replaces it.
function playToast(html, ms = 3800) {
  document.getElementById('rl-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'rl-toast';
  t.className = 'rl-toast';
  t.setAttribute('role', 'status');
  t.innerHTML = html;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
