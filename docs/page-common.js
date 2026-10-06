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
  updateEdgeFade(track);
}

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
function riseIn(els, cap = 8) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  [...els].forEach((el, i) => {
    el.style.setProperty('--rise-i', Math.min(i, cap));
    el.classList.add('rise');
    const done = e => {
      if (e.target !== el) return;
      el.classList.remove('rise');
      el.style.removeProperty('--rise-i');
      el.removeEventListener('animationend', done);
      el.removeEventListener('animationcancel', done);
    };
    el.addEventListener('animationend', done);
    el.addEventListener('animationcancel', done);
  });
}
