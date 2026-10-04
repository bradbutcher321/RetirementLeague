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
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
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

// Centre a scrolling selector track (.scroll, see theme.css) on its selected
// item, so after a re-render the choice you just made isn't off-screen.
function keepSelectedInView(track) {
  if (!track || track.scrollWidth <= track.clientWidth) return;
  const on = track.querySelector('.on, .active');
  if (on) track.scrollLeft = on.offsetLeft - track.offsetLeft - (track.clientWidth - on.offsetWidth) / 2;
}
