// Tiny formatting helpers shared by pages that don't read data/league.json
// (so don't pull in league-common.js's LG object): Franchise, Parlay
// Results, Rule Changes, Draft Board. Previously each page defined its own
// copy of esc()/formatUpdated() -- identical in every copy -- which drifted
// out of one place to maintain for no reason.
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatUpdated(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}
