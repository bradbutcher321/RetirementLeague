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

  // items: { name, sub, val, tone, long }. Top 3 become podium tiles when podium is true.
  function ranked(items, { podium = true, ranks = true } = {}) {
    if (!items.length) return '<div class="empty-note">No data yet.</div>';
    let html = '';
    let rest = items;
    let offset = 0;
    if (podium && items.length >= 3) {
      html += '<div class="podium">' + items.slice(0, 3).map((it, i) =>
        `<div class="pod"><div class="pod-rank">#${it.rank ?? i + 1}</div><div class="pod-name">${esc(it.name)}</div>` +
        `<div class="pod-val ${it.tone || ''}${String(it.val).length > 6 ? ' long' : ''}">${it.val}</div>` +
        `<div class="pod-sub">${it.sub ? esc(it.sub) : '&nbsp;'}</div></div>`).join('') + '</div>';
      rest = items.slice(3);
      offset = 3;
    }
    html += rest.map((it, i) => rowHtml(it, ranks ? (it.rank ?? offset + i + 1) : null)).join('');
    return html;
  }

  function rowHtml(it, rank) {
    const cls = ['row', rank === null ? 'norank' : '', it.wide ? 'wide-rank' : '', it.hl ? 'hl' : ''].filter(Boolean).join(' ');
    const right = it.stats
      ? `<div class="row-stats">${it.stats.map(s => `<div class="row-stat"><b>${s[0]}</b><span>${s[1]}</span></div>`).join('')}</div>`
      : `<div class="row-val ${it.tone || ''}">${it.val}</div>`;
    return `<div class="${cls}">` +
      (rank === null ? '' : `<div class="row-rank${it.wide ? ' year' : ''}">${rank}</div>`) +
      `<div style="min-width:0"><div class="row-name${it.wrap ? ' wrap' : ''}">${esc(it.name)}${it.badge || ''}</div>` +
      (it.sub ? `<div class="row-sub">${esc(it.sub)}</div>` : '') + `</div>${right}</div>`;
  }

  function showError(id, err) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="loading-row">Couldn't load league data (${esc(err.message)}).</div>`;
  }

  return { esc, f1, f2, pct, money, load, card, ranked, rowHtml, showError };
})();
