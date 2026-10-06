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
const TRACK_SEL = '.tabs, .tab-row, .seg, .sup-seg, .scope-row, .board-toggle';
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
    const cs = getComputedStyle(to);
    const pill = document.createElement('span');
    pill.className = 'glide-pill';
    pill.setAttribute('aria-hidden', 'true');
    pill.style.background = cs.backgroundColor;
    pill.style.boxShadow = cs.boxShadow;
    pill.style.borderRadius = cs.borderRadius;
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
      to.classList.remove('glide-to');
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
