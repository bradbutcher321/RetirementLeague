// Shared helpers for the pages that read data/league.json.
const LG = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = n => (n === null || n === undefined ? '—' : Number(n).toFixed(1));
  const f2 = n => (n === null || n === undefined ? '—' : Number(n).toFixed(2));
  const pct = n => (n === null || n === undefined || Number.isNaN(n) ? '—' : (n * 100).toFixed(1) + '%');
  const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

  function formatUpdated(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  }

  async function load() {
    const res = await fetch('data/league.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const el = document.getElementById('updated-at');
    if (el && data.generated_at) el.textContent = formatUpdated(data.generated_at);
    data.games = data.games.map(g => ({
      year: g[0], week: g[1], type: g[2], p1: g[3], p2: g[4], s1: g[5], s2: g[6], winner: g[7], gid: g[8], median: g[9],
    }));
    // A season counts as complete once its championship game has a result.
    data.completeYears = [...new Set(data.games.filter(g => g.type === 'Champ').map(g => g.year))].sort((a, b) => a - b);
    data.years = [...new Set(data.seasons.map(s => s.year))].sort((a, b) => a - b);
    data.currentYear = data.years[data.years.length - 1];
    data.active = new Set(data.seasons.filter(s => s.year === data.currentYear).map(s => s.player));
    return data;
  }

  function card(title, body, note) {
    return `<div class="stat-card"><div class="stat-card-title">${title}</div>` +
      (note ? `<div class="stat-card-note">${note}</div>` : '') + `<div class="stat-card-body">${body}</div></div>`;
  }

  function showError(id, err) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="loading-row">Couldn't load league data (${esc(err.message)}).</div>`;
  }

  return { esc, f1, f2, pct, money, load, card, showError };
})();
