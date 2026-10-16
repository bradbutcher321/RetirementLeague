// Share pictures (site audit III #23).
//
// A card or list on the page, drawn to a PNG and handed to the phone's share
// sheet (straight into Messages); on a computer it goes onto the clipboard to
// paste. If the browser refuses either, the picture opens on screen to save by
// hand. Parlay Results was first; Head to Head, Game Records and the
// Dashboard's final matchups use the same thing.
//
//   const shot = RLShare.make({
//     nodes: () => [elements to copy, in order],
//     name:  () => 'file-name.png',
//     eyebrow: 'Retirement League · Head to Head',   // or a function
//     prep:  wrap => {},      // tweak the copy before it is drawn
//     eager: true,            // redraw in the background (see below)
//   });
//   shot.queue();             // eager: the page just changed, redraw soon
//   shot.share(button);       // from the button's click
//
// Anything inside a copy marked .share-btn, .chev or [data-noshot] is left out
// of the picture. A copy is made at the width the card has on screen, so a
// phone's picture is the phone's own layout.
//
// eager: the picture is redrawn a moment after every queue() and kept, so a
// tap hands it straight to the share sheet -- iPhone Safari refuses
// navigator.share once a tap has waited on anything. Without it (many cards,
// one button each) the picture is drawn on the tap, and if Safari then
// refuses the sheet it opens on screen with a Share button of its own.
const RLShare = (() => {
  const style = document.createElement('style');
  style.textContent = `
  .share-btn{ position: relative; background: none; border: 1px solid var(--gold); color: var(--gold); font-family: var(--body); font-weight: 600; font-size: 0.74rem; height: 30px; padding: 0 14px; border-radius: 999px; cursor: pointer; flex: none; white-space: nowrap; }
  .share-btn::before{ content: ''; position: absolute; inset: -7px -4px; }
  @media (hover: hover){ .share-btn:hover{ background: rgba(212,180,106,0.1); } }
  .share-btn:focus-visible{ outline: 2px solid var(--gold); outline-offset: 2px; }
  .share-btn:disabled{ opacity: 0.5; cursor: default; }
  /* The copy that gets drawn: parked offscreen, nothing animating, the
     page's buttons gone. */
  .share-shot{ position: fixed; left: -10000px; top: 0; padding: 16px; background: var(--bg); }
  .share-shot, .share-shot *{ animation: none !important; transition: none !important; }
  .share-shot .share-btn, .share-shot .chev, .share-shot [data-noshot]{ display: none !important; }
  .share-shot .eyebrow{ margin-bottom: 12px; }
  /* Fallback when the share sheet can't open: the picture itself, to
     press-and-hold (save / share) or right-click. */
  .share-overlay{ position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.85); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 16px; }
  .share-overlay img{ max-width: 100%; max-height: 78vh; border-radius: 12px; border: 1px solid var(--line); user-select: auto; -webkit-user-select: auto; -webkit-touch-callout: default; }
  .share-overlay p{ color: var(--text-dim); font-size: 0.85rem; margin: 0; }
  .share-overlay .share-actions{ display: flex; gap: 10px; }
  `;
  document.head.appendChild(style);

  // modern-screenshot draws a DOM node to a PNG (fonts included), loaded
  // only when a picture is first wanted.
  let lib = null;
  function loadLib() {
    if (!lib) lib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/modern-screenshot@4.7.0/dist/index.js';
      s.onload = () => resolve(window.modernScreenshot);
      s.onerror = () => { lib = null; reject(new Error('modern-screenshot')); };
      document.head.appendChild(s);
    });
    return lib;
  }

  // The site's two fonts as @font-face rules with the files inlined. The
  // library can't read Google's stylesheet itself (it's cross-origin), and
  // without this the picture falls back to system fonts -- wider, so names
  // truncate and chips wrap. Static one-weight files from Fontsource rather
  // than Google's variable ones: Safari draws a variable font at its
  // thinnest weight inside the picture. Latin only, all the league's text.
  const FONTS = [['Inter', 'inter', [400, 500, 600, 700]], ['Big Shoulders Display', 'big-shoulders-display', [600, 700, 800]]];
  let fonts = null;
  function loadFonts() {
    if (!fonts) {
      const toDataUrl = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
      fonts = Promise.all(FONTS.flatMap(([family, slug, weights]) => weights.map(w =>
        fetch(`https://cdn.jsdelivr.net/npm/@fontsource/${slug}@5/files/${slug}-latin-${w}-normal.woff2`)
          .then(r => r.blob()).then(toDataUrl)
          .then(d => `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};src:url(${d}) format('woff2');}`)
      ))).then(rules => rules.join('\n')).catch(() => '');
    }
    return fonts;
  }

  // The copy is taken straight away, before the library is fetched: a live
  // refresh that replaces the card while that loads can't change the picture.
  async function draw(cfg) {
    const nodes = cfg.nodes().filter(Boolean);
    if (!nodes.length) throw new Error('nothing to draw');
    const wrap = document.createElement('div');
    wrap.className = 'share-shot';
    wrap.style.width = `${nodes[0].offsetWidth + 32}px`;
    const eyebrow = typeof cfg.eyebrow === 'function' ? cfg.eyebrow() : cfg.eyebrow;
    wrap.innerHTML = `<div class="eyebrow">${esc(eyebrow || 'Retirement League')}</div>`;
    nodes.forEach(el => {
      const c = el.cloneNode(true);
      c.classList.remove('rise');
      wrap.appendChild(c);
    });
    // A second copy of a view-transition-name would cancel the page's own
    // transitions for as long as this one is in the document.
    wrap.querySelectorAll('[style*="view-transition-name"]').forEach(el => { el.style.viewTransitionName = ''; });
    if (cfg.prep) cfg.prep(wrap);
    document.body.appendChild(wrap);
    try {
      const [shotLib, fontCss] = await Promise.all([loadLib(), loadFonts()]);
      await document.fonts.ready;
      return await shotLib.domToBlob(wrap, {
        scale: Math.max(2, window.devicePixelRatio || 1), type: 'image/png',
        font: fontCss ? { cssText: fontCss } : undefined,
      });
    } finally {
      wrap.remove();
    }
  }

  function overlay(blob, file) {
    const url = URL.createObjectURL(blob);
    const o = document.createElement('div');
    o.className = 'share-overlay';
    const canShare = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
    o.innerHTML = `<img src="${url}" alt="Share picture"><p>Press and hold the picture to save ${canShare ? 'it' : 'or share it'}</p>` +
      `<div class="share-actions">${canShare ? '<button type="button" class="share-btn" data-go>Share</button>' : ''}<button type="button" class="share-btn">Close</button></div>`;
    o.addEventListener('click', e => {
      if (e.target.closest('img')) return;
      if (e.target.closest('[data-go]')) {
        navigator.share({ files: [file] }).catch(() => {});
        return;
      }
      o.remove();
      URL.revokeObjectURL(url);
    });
    document.body.appendChild(o);
  }

  function make(cfg) {
    let shot = null, blob = null, timer = null;
    const start = () => {
      const p = draw(cfg);
      shot = p;
      p.then(b => { if (shot === p) blob = b; }, () => { if (shot === p) shot = null; });
      return p;
    };
    // Dropped the instant the page changes, so a tap never shares a stale picture.
    const queue = () => {
      shot = blob = null;
      clearTimeout(timer);
      if (cfg.eager) timer = setTimeout(start, 800);
    };

    function share(btn) {
      if (btn && btn.disabled) return;
      const label = btn ? btn.textContent : '';
      const say = (text, ms) => { if (btn) { btn.textContent = text; setTimeout(() => { btn.textContent = label; }, ms); } };
      const busy = on => { if (btn) { btn.disabled = on; if (on) btn.textContent = '…'; else btn.textContent = label; } };
      if (!cfg.eager) shot = blob = null;
      if (!shot) { clearTimeout(timer); start(); }
      const pending = shot;
      const fileOf = b => new File([b], cfg.name(), { type: 'image/png' });
      const failed = () => say('Try again', 1500);
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        // Already drawn: share inside this same tap. Not yet: draw, then
        // try -- Safari may refuse that, which lands on the overlay.
        const sheet = b => {
          const f = fileOf(b);
          return navigator.share({ files: [f] }).catch(err => { if (err.name !== 'AbortError') overlay(b, f); });
        };
        if (blob) sheet(blob);
        else { busy(true); pending.then(b => { busy(false); sheet(b); }).catch(() => { busy(false); failed(); }); }
      } else if (navigator.clipboard && window.ClipboardItem) {
        busy(true);
        navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })])
          .then(() => { busy(false); say('Copied!', 1200); })
          .catch(() => pending.then(b => { busy(false); overlay(b, fileOf(b)); }).catch(() => { busy(false); failed(); }));
      } else {
        busy(true);
        pending.then(b => { busy(false); overlay(b, fileOf(b)); }).catch(() => { busy(false); failed(); });
      }
    }
    return { queue, share };
  }

  return { make, BUTTON: '<button type="button" class="share-btn" data-share>Share</button>' };
})();
