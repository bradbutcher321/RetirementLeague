/* Secret Santa's drone show (secret-santa.html): a few hundred lights flying
   between formations (lettering, team logos, 3D shapes) with fireworks, over
   a lake at night (the reveal) or straight over the page (Unwrap night's
   wreath). Positions are in "units": the view's center is (0, 0) and one unit
   is `s` CSS pixels. */
const Drones = (() => {
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeIO = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const easeOut = k => 1 - Math.pow(1 - k, 3);
  const FONT = '"Big Shoulders Display", Impact, "Arial Narrow", sans-serif';
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  // Hilbert-curve index on a 1024 grid: matching two clouds in this order keeps neighbors together.
  function hil(x, y) {
    const n = 1024; let d = 0;
    for (let s = n >> 1; s > 0; s >>= 1) {
      const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ ry);
      if (ry === 0) { if (rx === 1) { x = n - 1 - x; y = n - 1 - y; } const t = x; x = y; y = t; }
    }
    return d;
  }
  const hkey = (x, y) => hil(clamp(Math.round((x + 2.6) / 5.2 * 1023), 0, 1023), clamp(Math.round((y + 2.6) / 5.2 * 1023), 0, 1023));

  /* ---------- Pictures ---------- */
  // A team logo, ready to draw on a canvas. Logos are PNG, JPG or SVG; an SVG
  // with only a viewBox has no size of its own, which Safari won't draw, so it
  // gets one first.
  const imgs = new Map();
  function loadImg(src) {
    if (imgs.has(src)) return imgs.get(src);
    const p = (async () => {
      let url = src, made = null;
      if (/\.svg(\?|$)/i.test(src)) {
        try {
          let t = await (await fetch(src)).text();
          const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(t);
          const w = vb ? +vb[1] : 1, h = vb ? +vb[2] : 1, k = 512 / Math.max(w, h);
          t = t.replace(/<svg\b/, `<svg width="${Math.round(w * k)}" height="${Math.round(h * k)}"`);
          made = url = URL.createObjectURL(new Blob([t], { type: 'image/svg+xml' }));
        } catch (e) {}
      }
      const im = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(i); i.src = url; });
      if (made) setTimeout(() => URL.revokeObjectURL(made), 60000);
      return im;
    })();
    imgs.set(src, p); return p;
  }

  /* ---------- Shapes (each returns [{x, y, z, c:[r,g,b], b}]) ---------- */
  // Draw anything on a canvas wU x hU units big, then put a drone on every lit spot of a hex grid.
  function drawn(wU, hU, draw, { pitch = 0.06, max = 560, ppu = 140, minA = 110 } = {}) {
    const W = Math.max(8, Math.ceil(wU * ppu)), H = Math.max(8, Math.ceil(hU * ppu));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d', { willReadFrequently: true });
    draw(x, W, H);
    const data = x.getImageData(0, 0, W, H).data;
    let p = pitch, pts = [];
    for (let tries = 0; tries < 10; tries++) {
      pts = []; const st = p * ppu;
      for (let r = 0, y = st / 2; y < H; y += st * 0.866, r++) {
        for (let x0 = r % 2 ? st : st / 2; x0 < W; x0 += st) {
          const i = ((y | 0) * W + (x0 | 0)) * 4;
          if (data[i + 3] < minA) continue;
          pts.push({ x: x0 / ppu - wU / 2, y: y / ppu - hU / 2, z: 0, c: [data[i], data[i + 1], data[i + 2]], b: 1 });
        }
      }
      if (pts.length <= max) break;
      p *= Math.sqrt(pts.length / max) * 1.01;
    }
    return pts;
  }
  // Lines of text (each line can have its own color), fitted into maxW units.
  function text(lines, { maxW = 1.9, lineH = 0.46, gap = 0.12, weight = 900, colors = ['#F3E2B3'], pitch = 0.055, max = 520, font = FONT, track = 0.02 } = {}) {
    const ppu = 140, m = document.createElement('canvas').getContext('2d');
    let F = lineH * ppu;
    const widths = () => lines.map(l => { m.font = `${weight} ${F}px ${font}`; return m.measureText(l).width + l.length * track * F; });
    let wMax = Math.max(...widths());
    if (wMax > maxW * ppu) { F *= (maxW * ppu) / wMax; wMax = Math.max(...widths()); }
    const lh = F * 0.92, hPx = lines.length * lh + (lines.length - 1) * gap * ppu;
    const wU = wMax / ppu + 0.1, hU = hPx / ppu + 0.1;
    return drawn(wU, hU, (x, W, H) => {
      x.font = `${weight} ${F}px ${font}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      try { x.letterSpacing = `${track * F}px`; } catch (e) {}
      lines.forEach((l, i) => { x.fillStyle = colors[i % colors.length]; x.fillText(l, W / 2, (H - hPx) / 2 + i * (lh + gap * ppu) + lh / 2); });
    }, { pitch, max, ppu });
  }
  // A picture (team logo, crest): a round (or square) grid of colored drones.
  function image(img, { d = 1.5, grid = 26, circle = true, max = 520, sat = 1.15 } = {}) {
    const S = grid * 6, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const x = cv.getContext('2d', { willReadFrequently: true });
    // Round logos fill the circle (like the site's avatars); square art fits whole.
    const iw = img.naturalWidth || S, ih = img.naturalHeight || S, k = circle ? Math.max(S / iw, S / ih) : Math.min(S / iw, S / ih);
    const dw = iw * k, dh = ih * k;
    try { x.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh); } catch (e) {}
    const data = x.getImageData(0, 0, S, S).data, st = S / grid, R = S / 2, pts = [];
    for (let r = 0, y = st / 2; y < S; y += st * 0.866, r++) {
      for (let x0 = r % 2 ? st : st / 2; x0 < S; x0 += st) {
        if (circle && Math.hypot(x0 - R, y - R) > R - st * 0.3) continue;
        const i = ((y | 0) * S + (x0 | 0)) * 4;
        if (data[i + 3] < 120) continue;
        let c = [data[i], data[i + 1], data[i + 2]];
        const mx = Math.max(...c), mn = Math.min(...c), l = mx / 255;
        if (sat !== 1 && mx > mn) { const avg = (c[0] + c[1] + c[2]) / 3; c = c.map(v => clamp(avg + (v - avg) * sat, 0, 255)); }
        if (mx < 70) { const f = 70 / Math.max(1, mx); c = c.map(v => Math.min(255, v * f)); }
        pts.push({ x: (x0 / S - 0.5) * d, y: (y / S - 0.5) * d, z: 0, c, b: 0.3 + 0.7 * Math.max(l, 0.25) });
      }
    }
    if (pts.length > max) { const keep = []; const step = pts.length / max; for (let i = 0; i < max; i++) keep.push(pts[Math.floor(i * step)]); return keep; }
    return pts;
  }
  function seg(pts, a, b, step, c, bb = 1) { const L = Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0)), n = Math.max(1, Math.round(L / step)); for (let i = 0; i <= n; i++) { const k = i / n; pts.push({ x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, z: (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * k, c, b: bb }); } }
  // A present: red box, gold ribbon and bow, in 3D.
  function giftBox({ a = 0.5, c = [222, 44, 58], rib = [243, 210, 120] } = {}) {
    const pts = [], st = 0.075, C = [[-a, -a, -a], [a, -a, -a], [a, a, -a], [-a, a, -a], [-a, -a, a], [a, -a, a], [a, a, a], [-a, a, a]];
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([i, j]) => seg(pts, C[i], C[j], st, c));
    for (let u = -a + 0.17; u < a - 0.1; u += 0.17) for (let v = -a + 0.17; v < a - 0.1; v += 0.17) {
      [[u, v, -a], [u, v, a], [-a, v, u], [a, v, u]].forEach(p => pts.push({ x: p[0], y: p[1], z: p[2], c, b: 0.55 }));
    }
    seg(pts, [0, -a, -a], [0, a, -a], st * 0.8, rib); seg(pts, [0, -a, a], [0, a, a], st * 0.8, rib);
    seg(pts, [-a, -a, 0], [-a, a, 0], st * 0.8, rib); seg(pts, [a, -a, 0], [a, a, 0], st * 0.8, rib);
    seg(pts, [0, -a, -a], [0, -a, a], st * 0.8, rib); seg(pts, [-a, -a, 0], [a, -a, 0], st * 0.8, rib);
    for (let i = 0; i < 44; i++) { const t = (i / 44) * TAU, r = 0.24 * Math.sin(t); pts.push({ x: r * Math.cos(t) * 1.4, y: -a - 0.16 * Math.abs(Math.sin(t)) - 0.02, z: r * 0.25, c: rib, b: 1 }); }
    return pts;
  }
  // A Christmas tree: a spiral of green lights with ornaments, star on top.
  function tree({ h = 1.75, r = 0.72, turns = 7, n = 400 } = {}) {
    const pts = [], orn = [[230, 50, 60], [243, 210, 120], [90, 160, 255], [255, 255, 255]];
    for (let i = 0; i < n; i++) {
      const k = i / n, y = -h / 2 + k * h, rad = 0.05 + k * r, a = k * turns * TAU;
      const o = i % 9 === 4 ? orn[(i / 9 | 0) % 4] : null;
      pts.push({ x: Math.cos(a) * rad, y, z: Math.sin(a) * rad, c: o || [60, 200, 100], b: o ? 1 : 0.85 });
    }
    for (let i = 0; i < 40; i++) { const rr = i % 2 ? 0.07 : 0.15, tt = (Math.floor(i / 2) / 20) * TAU - Math.PI / 2; pts.push({ x: Math.cos(tt) * rr, y: -h / 2 - 0.12 + Math.sin(tt) * rr, z: 0, c: [255, 220, 120], b: 1, fixed: 1 }); }
    for (let y = h / 2 + 0.03; y < h / 2 + 0.2; y += 0.06) for (let x = -0.07; x <= 0.07; x += 0.07) pts.push({ x, y, z: 0, c: [150, 95, 50], b: 0.6 });
    return pts;
  }
  // A T-shirt outline with a number inside.
  function shirt(label, { w = 1.5, color = '#FFFFFF', ink = '#F3D27A', max = 520 } = {}) {
    return drawn(w, w * 0.92, (x, W) => {
      const s = W / 100;
      x.lineWidth = 3.4 * s; x.strokeStyle = color; x.lineJoin = 'round';
      x.beginPath(); x.moveTo(34 * s, 6 * s); x.quadraticCurveTo(50 * s, 16 * s, 66 * s, 6 * s); x.lineTo(92 * s, 20 * s); x.lineTo(82 * s, 38 * s); x.lineTo(74 * s, 33 * s);
      x.lineTo(74 * s, 88 * s); x.lineTo(26 * s, 88 * s); x.lineTo(26 * s, 33 * s); x.lineTo(18 * s, 38 * s); x.lineTo(8 * s, 20 * s); x.closePath(); x.stroke();
      x.fillStyle = ink; x.font = `900 ${30 * s}px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(label, 50 * s, 56 * s);
    }, { pitch: 0.05, max });
  }
  // Small round clusters on a circle: one per manager, for the hold.
  function clusters(n, { R = 0.92, r = 0.085, cy = 0, c = [212, 180, 106] } = {}) {
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU - Math.PI / 2, cx = Math.cos(a) * R, yy = cy + Math.sin(a) * R * 0.92;
      for (let rr = 0; rr <= r + 1e-6; rr += r / 2.2) { const m = rr ? Math.round(TAU * rr / (r / 2.4)) : 1; for (let i = 0; i < m; i++) pts.push({ x: cx + Math.cos(i / m * TAU) * rr, y: yy + Math.sin(i / m * TAU) * rr, z: 0, c, b: 0.22, g: k }); }
    }
    return pts;
  }
  // A wreath of lights: green, with red and gold bulbs.
  function ring({ R = 0.9, n = 220, c = [60, 190, 100], cy = 0, width = 0.07 } = {}) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU, w = (i % 3 - 1) * width; pts.push({ x: Math.cos(a) * (R + w), y: cy + Math.sin(a) * (R + w), z: 0, c: i % 11 === 0 ? [255, 210, 120] : i % 7 === 0 ? [230, 60, 70] : c, b: i % 11 === 0 ? 1 : 0.7 }); }
    return pts;
  }
  const merge = (...parts) => [].concat(...parts);
  const move = (pts, dx = 0, dy = 0, k = 1) => pts.map(p => ({ ...p, x: p.x * k + dx, y: p.y * k + dy, z: (p.z || 0) * k }));
  // The two strongest colors of a set of points (for fireworks in a team's colors).
  function colorsOf(pts) {
    const bins = new Map();
    for (const p of pts) {
      const [r, g, b] = p.c, mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
      if (mx < 90) continue;
      let h = 0; if (mx !== mn) { h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4; h = (h * 60 + 360) % 360; }
      const key = sat < 0.22 ? 'w' : Math.round(h / 30) % 12, e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0, w: sat < 0.22 ? 0.35 : 1 };
      e.n += 1; e.r += r; e.g += g; e.b += b; bins.set(key, e);
    }
    const out = [...bins.values()].sort((a, b) => b.n * b.w - a.n * a.w).slice(0, 2).map(e => [e.r / e.n, e.g / e.n, e.b / e.n].map(v => Math.round(Math.min(255, v * 1.15))));
    while (out.length < 2) out.push([243, 210, 120]);
    return out;
  }

  /* ---------- The sky ---------- */
  // scene: 'lake' (the reveal: the lake, the stadium and the palms), 'night'
  // (stars) or 'clear' (nothing: the page shows through). fit: 'ring' makes
  // one unit the Secret Santa ring's seat radius (41% of the box), centered.
  class Sky {
    constructor(host, { n = 600, scene = 'lake', horizon = 0.74, cy = 0.4, scale = 1, fit = null } = {}) {
      this.host = host; this.n = n; this.scene = scene; this.hor = horizon; this.cyK = cy; this.scaleK = scale; this.fit = fit;
      this.cv = document.createElement('canvas'); this.cv.className = 'sky-cv'; host.prepend(this.cv);
      this.x = this.cv.getContext('2d');
      this.b1 = document.createElement('canvas'); this.b1x = this.b1.getContext('2d');
      this.b2 = document.createElement('canvas'); this.b2x = this.b2.getContext('2d');
      this.bg = document.createElement('canvas');
      this.d = [];
      for (let i = 0; i < n; i++) this.d.push({ x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, c: [255, 240, 210], fc: [255, 240, 210], tc: [255, 240, 210], br: 0, fbr: 0, tbr: 0, del: 0, ph: Math.random() * TAU, g: -1, fixed: 0, cs: 'rgb(255,240,210)', gt: 0, gd: 0, gfb: 0, gtb: 0, gfc: null, gtc: null, moving: false });
      this.t0 = 0; this.dur = 1; this.spin = 0; this.ang = 0; this.angTo = null; this.fw = []; this.alive = true; this.running = false; this.last = 0; this.time = 0;
      this.onBurst = null; this.wob = 1;
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host); this.resize();
      this.loop = this.loop.bind(this);
    }
    resize() {
      const W = Math.max(1, this.host.clientWidth), H = Math.max(1, this.host.clientHeight);
      if (W === this.W && H === this.H) return;
      this.W = W; this.H = H; this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.cv.width = Math.round(W * this.dpr); this.cv.height = Math.round(H * this.dpr);
      this.b1.width = Math.ceil(W / 3); this.b1.height = Math.ceil(H / 3);
      this.b2.width = Math.ceil(W / 12); this.b2.height = Math.ceil(H / 12);
      if (this.fit === 'ring') { this.s = W * 0.41; this.cx = W / 2; this.cy = H / 2; this.hy = H; }
      else { this.s = Math.min(W * 0.46, H * 0.3) * this.scaleK; this.cx = W / 2; this.cy = H * this.cyK; this.hy = H * this.hor; }
      this.paintBg();
      if (!this.running) this.draw();
    }
    // Half the usable width, in units (formations fit inside +-this).
    get halfW() { return (this.W * 0.45) / this.s; }
    get horizonU() { return (this.hy - this.cy) / this.s; }
    paintBg() {
      const c = this.bg, W = this.W, H = this.H, dpr = this.dpr; c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      if (this.scene === 'clear') return;
      const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
      const hy = this.scene === 'lake' ? this.hy : H;
      seed = 11;
      let g = x.createLinearGradient(0, 0, 0, hy); g.addColorStop(0, '#010207'); g.addColorStop(0.55, '#030817'); g.addColorStop(1, this.scene === 'lake' ? '#0b1630' : '#060b1a');
      x.fillStyle = g; x.fillRect(0, 0, W, hy);
      for (let i = 0; i < (W * H) / 2600; i++) { const sx = rnd() * W, sy = Math.pow(rnd(), 1.4) * hy * 0.95, r = 0.3 + rnd() * 0.9; x.fillStyle = `rgba(220,230,255,${0.15 + rnd() * 0.6})`; x.fillRect(sx, sy, r, r); }
      if (this.scene !== 'lake') return;
      // A warm glow where the stadium is.
      const sx = W * 0.5, sw = Math.min(W * 0.5, 420);
      g = x.createRadialGradient(sx, hy, 0, sx, hy, sw * 0.9); g.addColorStop(0, 'rgba(212,180,106,0.16)'); g.addColorStop(1, 'rgba(212,180,106,0)');
      x.fillStyle = g; x.fillRect(0, hy - sw, W, sw);
      // The stadium: a low bowl with light towers.
      const bh = Math.max(10, H * 0.032), l = sx - sw / 2, r = sx + sw / 2;
      x.fillStyle = '#04060c'; x.beginPath(); x.moveTo(l, hy); x.lineTo(l + sw * 0.06, hy - bh * 0.75); x.quadraticCurveTo(sx, hy - bh * 1.25, r - sw * 0.06, hy - bh * 0.75); x.lineTo(r, hy); x.closePath(); x.fill();
      for (let i = 0; i < 40; i++) { const k = i / 39, px = l + sw * 0.07 + k * sw * 0.86, py = hy - bh * 0.8 - Math.sin(k * Math.PI) * bh * 0.32; x.fillStyle = `rgba(255,236,190,${0.35 + rnd() * 0.4})`; x.fillRect(px, py, 1.2, 1.2); }
      [0.1, 0.32, 0.68, 0.9].forEach(k => {
        const px = l + sw * k, top = hy - bh * 2.3; x.fillStyle = '#06080e'; x.fillRect(px - 0.8, top, 1.6, bh * 1.6);
        x.fillStyle = 'rgba(255,246,220,0.95)'; x.fillRect(px - 4, top - 2, 8, 3);
        const bg = x.createLinearGradient(px, top, px, 0); bg.addColorStop(0, 'rgba(255,240,200,0.07)'); bg.addColorStop(1, 'rgba(255,240,200,0)');
        x.fillStyle = bg; x.beginPath(); x.moveTo(px - 3, top); x.lineTo(px + (k < 0.5 ? 60 : -60) - 40, 0); x.lineTo(px + (k < 0.5 ? 60 : -60) + 40, 0); x.lineTo(px + 3, top); x.fill();
      });
      // Tree line along the shore.
      x.fillStyle = '#020309'; x.beginPath(); x.moveTo(0, hy);
      for (let px = 0; px <= W; px += 6) { const t = Math.abs(px - sx) < sw * 0.55 ? 0 : 3 + rnd() * 6; x.lineTo(px, hy - t); }
      x.lineTo(W, hy); x.closePath(); x.fill();
      // Palms with Christmas lights.
      const palm = (px, ph, lean) => {
        const top = [px + lean, hy - ph];
        x.strokeStyle = '#020308'; x.lineWidth = Math.max(2.5, ph * 0.045); x.lineCap = 'round';
        x.beginPath(); x.moveTo(px, hy); x.quadraticCurveTo(px + lean * 0.2, hy - ph * 0.5, top[0], top[1]); x.stroke();
        for (let i = 0; i < 8; i++) {
          const a = -Math.PI / 2 + (i - 3.5) * 0.42 + (i % 2) * 0.1, L = ph * (0.42 + (i % 3) * 0.06);
          const ex = top[0] + Math.cos(a) * L, ey = top[1] + Math.sin(a) * L * 0.55 + L * 0.35;
          x.lineWidth = Math.max(1.2, ph * 0.03); x.beginPath(); x.moveTo(top[0], top[1]); x.quadraticCurveTo(top[0] + Math.cos(a) * L * 0.5, top[1] - L * 0.18, ex, ey); x.stroke();
        }
        const cols = ['#ff5a5a', '#5aff8a', '#ffd36b', '#6bb7ff'];
        for (let i = 0; i < 9; i++) { const k = (i + 0.5) / 9, py = hy - ph * k * 0.92, qx = px + lean * Math.pow(k, 1.6) + Math.sin(i * 2.1) * ph * 0.025; x.fillStyle = cols[i % 4]; x.globalAlpha = 0.85; x.fillRect(qx - 1, py - 1, 2, 2); x.globalAlpha = 0.18; x.fillRect(qx - 3, py - 3, 6, 6); x.globalAlpha = 1; }
      };
      const ph = Math.min(H * 0.15, W * 0.2);
      palm(W * 0.05, ph, ph * 0.12); palm(W * 0.15, ph * 0.8, -ph * 0.1); palm(W * 0.85, ph * 0.86, ph * 0.1); palm(W * 0.95, ph * 1.02, -ph * 0.14);
      // The lake.
      g = x.createLinearGradient(0, hy, 0, H); g.addColorStop(0, '#08101f'); g.addColorStop(1, '#010205');
      x.fillStyle = g; x.fillRect(0, hy, W, H - hy);
      for (let i = 0; i < 26; i++) { const py = hy + 4 + Math.pow(rnd(), 1.6) * (H - hy), lw = 20 + rnd() * 120; x.fillStyle = `rgba(212,180,106,${0.03 + rnd() * 0.05})`; x.fillRect(sx + (rnd() - 0.5) * sw, py, lw, 1); }
      for (let i = 0; i < 14; i++) { const px = l + rnd() * sw, lg = x.createLinearGradient(0, hy, 0, hy + 70); lg.addColorStop(0, 'rgba(255,236,190,0.12)'); lg.addColorStop(1, 'rgba(255,236,190,0)'); x.fillStyle = lg; x.fillRect(px, hy + 1, 1.2, 70); }
    }
    // Where the drones sit before liftoff: rows on the field below the stadium, barely lit.
    groundPts() {
      const pts = [], n = this.n, hyU = this.horizonU, w = this.halfW * 0.8, rows = 4, per = Math.ceil(n / rows);
      for (let r = 0; r < rows; r++) for (let i = 0; i < per; i++) { const k = per > 1 ? i / (per - 1) : 0.5; pts.push({ x: (k - 0.5) * 2 * w * (0.7 + r * 0.1), y: hyU + 0.01 + r * 0.035, z: 0, c: [255, 236, 200], b: 0.07 }); }
      return pts.slice(0, n);
    }
    gridPts(cols = 26, rows = 18) {
      const pts = [], w = Math.min(this.halfW * 0.92, 1.4), h = 0.95;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push({ x: -w + (2 * w * c) / (cols - 1), y: -h + (2 * h * r) / (rows - 1), z: 0, c: [255, 236, 200], b: 0.75 });
      return pts;
    }
    now() { return performance.now() / 1000; }
    // Fly to a formation. Extra drones go dark where they are.
    form(pts, { dur = 1.6, stagger = 0.5, spin = 0, order = 'hilbert', keepAngle = false } = {}) {
      const t = this.now(), N = this.n, D = this.d;
      for (const d of D) { d.fx = d.x; d.fy = d.y; d.fz = d.z; d.fc = d.c.slice(); d.fbr = d.br; d.gd = 0; }
      let P = pts;
      if (P.length > N) { const keep = [], step = P.length / N; for (let i = 0; i < N; i++) keep.push(P[Math.floor(i * step)]); P = keep; }
      const M = P.length;
      const dOrd = D.map((d, i) => [hkey(d.x, d.y), i]).sort((a, b) => a[0] - b[0]).map(a => a[1]);
      const pOrd = P.map((p, i) => [hkey(p.x, p.y), i]).sort((a, b) => a[0] - b[0]).map(a => a[1]);
      const used = new Uint8Array(N);
      for (let k = 0; k < M; k++) {
        const di = dOrd[Math.floor((k * N) / Math.max(1, M))], p = P[pOrd[k]], d = D[di];
        used[di] = 1; d.tx = p.x; d.ty = p.y; d.tz = p.z || 0; d.tc = p.c; d.tbr = p.b != null ? p.b : 1; d.g = p.g != null ? p.g : -1; d.fixed = p.fixed || 0;
        const ky = order === 'y' ? clamp(1 - (p.y + 1.2) / 2.4, 0, 1) : order === 'x' ? clamp((p.x + this.halfW) / (2 * this.halfW), 0, 1) : order === 'radial' ? clamp(Math.hypot(p.x, p.y) / 1.3, 0, 1) : order === 'random' ? Math.random() : k / Math.max(1, M);
        d.del = ky * stagger;
      }
      for (let i = 0; i < N; i++) if (!used[i]) { const d = D[i]; d.tx = d.x; d.ty = d.y; d.tz = d.z; d.tc = d.c; d.tbr = 0; d.g = -1; d.del = Math.random() * stagger * 0.5; }
      for (const d of D) d.moving = true;
      this.t0 = t; this.dur = dur; this.span = dur + stagger;
      if (!keepAngle) { this.spin = spin; if (!spin) { const r = Math.round(this.ang / TAU) * TAU; this.angFrom = this.ang; this.angTo = r; } else this.angTo = null; }
      return t + dur + stagger;
    }
    place(pts) { this.form(pts, { dur: 0.001, stagger: 0 }); this.t0 -= 1; this.update(this.now()); }
    // Brighten/dim one cluster in place (the hold: a person's lights come on).
    groupTo(g, { b = 1, c = null, dur = 0.4 } = {}) {
      const t = this.now();
      for (const d of this.d) if (d.g === g) { d.gfb = d.br; d.gtb = b; d.gfc = d.c.slice(); d.gtc = c || d.c.slice(); d.gt = t; d.gd = dur; }
    }
    darkAll(dur = 0.3) { const t = this.now(); for (const d of this.d) { d.gfb = d.br; d.gtb = 0; d.gfc = d.c.slice(); d.gtc = d.c.slice(); d.gt = t; d.gd = dur; } }
    /* Fireworks: a rocket climbs from the shore, then bursts. */
    firework(xU, yU, col, { kind = 'peony', size = 1, delay = 0, rocket = true } = {}) {
      const t = this.now() + delay;
      if (rocket) this.fw.push({ type: 'rocket', x: xU, y: this.horizonU, tx: xU, ty: yU, t0: t, dur: 0.85 + Math.random() * 0.25, col, kind, size, trail: [] });
      else this.fw.push({ type: 'pending', t0: t, x: xU, y: yU, col, kind, size });
    }
    burst(xU, yU, col, kind = 'peony', size = 1) {
      const n = Math.round((kind === 'ring' ? 70 : kind === 'willow' ? 110 : 120) * size), sp0 = (kind === 'willow' ? 0.55 : 0.75) * size;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, u = kind === 'ring' ? 0 : Math.random() * 2 - 1, pr = Math.sqrt(1 - u * u), v = sp0 * (kind === 'ring' ? 1 : 0.85 + Math.random() * 0.3);
        this.fw.push({ type: 'spark', x: xU, y: yU, vx: Math.cos(a) * pr * v, vy: Math.sin(a) * pr * v, life: 0, max: (kind === 'willow' ? 2.6 : 1.6) + Math.random() * 0.6, col: Math.random() < 0.15 ? [255, 250, 235] : col, kind, px: xU, py: yU, ck: kind === 'crackle' && Math.random() < 0.5 });
      }
      if (this.onBurst) this.onBurst(xU, yU, kind, size);
    }
    // Every lit drone flies outward and fades: the seal breaking in the sky.
    scatter(speed = 1.1) {
      for (const d of this.d) {
        if (d.br < 0.05) continue;
        const a = Math.atan2(d.y, d.x) + (Math.random() - 0.5) * 0.9, v = speed * (0.4 + Math.random());
        this.fw.push({ type: 'spark', x: d.x, y: d.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.3, life: 0, max: 1.2 + Math.random(), col: d.c.slice(), kind: 'peony', px: d.x, py: d.y });
        d.br = 0; d.tbr = 0; d.fbr = 0; d.gd = 0;
      }
    }
    start() { if (this.running || !this.alive) return; this.running = true; this.last = this.now(); requestAnimationFrame(this.loop); }
    stop() { this.running = false; }
    destroy() { this.alive = false; this.running = false; this.ro.disconnect(); this.cv.remove(); }
    loop() {
      if (!this.running || !this.alive) return;
      const t = this.now(), dt = Math.min(0.05, t - this.last); this.last = t; this.time += dt;
      this.update(t, dt); this.draw();
      requestAnimationFrame(this.loop);
    }
    update(t, dt = 0) {
      if (this.spin) this.ang += this.spin * dt;
      else if (this.angTo != null) { const k = easeIO(clamp((t - this.t0) / Math.max(0.3, this.dur), 0, 1)); this.ang = this.angFrom + (this.angTo - this.angFrom) * k; if (k >= 1) { this.ang = 0; this.angTo = null; } }
      for (const d of this.d) {
        if (d.moving) {
          const k = clamp((t - this.t0 - d.del) / this.dur, 0, 1), e = easeIO(k);
          d.x = d.fx + (d.tx - d.fx) * e; d.y = d.fy + (d.ty - d.fy) * e; d.z = d.fz + (d.tz - d.fz) * e;
          d.c[0] = d.fc[0] + (d.tc[0] - d.fc[0]) * e; d.c[1] = d.fc[1] + (d.tc[1] - d.fc[1]) * e; d.c[2] = d.fc[2] + (d.tc[2] - d.fc[2]) * e;
          d.br = d.fbr + (d.tbr - d.fbr) * e;
          d.cs = `rgb(${d.c[0] | 0},${d.c[1] | 0},${d.c[2] | 0})`;
          if (k >= 1) d.moving = false;
        }
        if (d.gd) {
          const k = clamp((t - d.gt) / d.gd, 0, 1), e = easeOut(k);
          d.br = d.gfb + (d.gtb - d.gfb) * e; d.tbr = d.br;
          d.c[0] = d.gfc[0] + (d.gtc[0] - d.gfc[0]) * e; d.c[1] = d.gfc[1] + (d.gtc[1] - d.gfc[1]) * e; d.c[2] = d.gfc[2] + (d.gtc[2] - d.gfc[2]) * e; d.tc = d.c.slice();
          d.cs = `rgb(${d.c[0] | 0},${d.c[1] | 0},${d.c[2] | 0})`;
          if (k >= 1) d.gd = 0;
        }
      }
      const keep = [];
      for (const f of this.fw) {
        if (f.type === 'pending') { if (t >= f.t0) this.burst(f.x, f.y, f.col, f.kind, f.size); else keep.push(f); continue; }
        if (f.type === 'rocket') {
          if (t < f.t0) { keep.push(f); continue; }
          const k = clamp((t - f.t0) / f.dur, 0, 1), e = easeOut(k);
          f.px = f.x; f.py = f.y; f.y = this.horizonU + (f.ty - this.horizonU) * e; f.x = f.tx + Math.sin(k * 9) * 0.01;
          f.trail.push([f.x, f.y]); if (f.trail.length > 8) f.trail.shift();
          if (k >= 1) this.burst(f.tx, f.ty, f.col, f.kind, f.size); else keep.push(f);
          continue;
        }
        f.life += dt; if (f.life > f.max) continue;
        const drag = f.kind === 'willow' ? 1.6 : 1.1;
        f.px = f.x; f.py = f.y; f.vx -= f.vx * drag * dt; f.vy -= f.vy * drag * dt; f.vy += (f.kind === 'willow' ? 0.32 : 0.22) * dt;
        f.x += f.vx * dt; f.y += f.vy * dt;
        if (f.ck && f.life > f.max * 0.7 && !f.popped) { f.popped = 1; for (let i = 0; i < 4; i++) keep.push({ type: 'spark', x: f.x, y: f.y, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, life: 0, max: 0.3, col: [255, 255, 255], kind: 'pop', px: f.x, py: f.y }); }
        keep.push(f);
      }
      this.fw = keep;
    }
    draw() {
      const X = this.x, W = this.W, H = this.H, dpr = this.dpr, s = this.s, cx = this.cx, cy = this.cy, tm = this.time;
      X.setTransform(dpr, 0, 0, dpr, 0, 0); X.globalCompositeOperation = 'source-over'; X.globalAlpha = 1;
      X.clearRect(0, 0, W, H);
      if (this.scene !== 'clear') X.drawImage(this.bg, 0, 0, W, H);
      const b1 = this.b1x, b2 = this.b2x;
      b1.setTransform(1, 0, 0, 1, 0, 0); b2.setTransform(1, 0, 0, 1, 0, 0);
      b1.globalCompositeOperation = 'source-over'; b2.globalCompositeOperation = 'source-over';
      b1.clearRect(0, 0, this.b1.width, this.b1.height); b2.clearRect(0, 0, this.b2.width, this.b2.height);
      b1.globalCompositeOperation = 'lighter'; b2.globalCompositeOperation = 'lighter';
      const ca = Math.cos(this.ang), sa = Math.sin(this.ang), pts = [];
      for (const d of this.d) {
        if (d.br < 0.02) continue;
        let x = d.x, z = d.z;
        if (!d.fixed && this.ang) { const x2 = x * ca + z * sa; z = -x * sa + z * ca; x = x2; }
        const p = 1 / (1 + z * 0.32), wb = this.wob * 0.004;
        const X0 = cx + (x + Math.sin(tm * 1.3 + d.ph) * wb) * s * p, Y0 = cy + (d.y + Math.cos(tm * 1.1 + d.ph) * wb) * s * p;
        const a = d.br * (z < 0 ? 1 : clamp(1 - z * 0.35, 0.45, 1));
        pts.push(X0, Y0, a, p, d);
        if (a < 0.12) continue; // dim drones get no glow (no smear of light on the ground)
        b1.globalAlpha = a * 0.8; b1.fillStyle = d.cs; b1.fillRect(X0 / 3 - 0.55, Y0 / 3 - 0.55, 1.1, 1.1);
        b2.globalAlpha = a * 0.5; b2.fillStyle = d.cs; b2.fillRect(X0 / 12 - 0.5, Y0 / 12 - 0.5, 1, 1);
      }
      const fwp = [];
      for (const f of this.fw) {
        if (f.type === 'pending' || (f.type === 'rocket' && !f.trail.length)) continue;
        const k = f.type === 'rocket' ? 1 : 1 - f.life / f.max, a = f.type === 'rocket' ? 0.9 : Math.min(1, k * 1.4) * (f.kind === 'pop' ? 1 : 0.95);
        const col = f.type === 'rocket' ? 'rgb(255,220,170)' : `rgb(${f.col[0] | 0},${f.col[1] | 0},${f.col[2] | 0})`;
        const X0 = cx + f.x * s, Y0 = cy + f.y * s; fwp.push(f, X0, Y0, a, col);
        b1.globalAlpha = a; b1.fillStyle = col; b1.fillRect(X0 / 3 - 0.7, Y0 / 3 - 0.7, 1.4, 1.4);
        b2.globalAlpha = a * 0.6; b2.fillStyle = col; b2.fillRect(X0 / 12 - 0.5, Y0 / 12 - 0.5, 1, 1);
      }
      X.globalCompositeOperation = 'lighter'; X.imageSmoothingEnabled = true;
      X.globalAlpha = 0.7; X.drawImage(this.b2, 0, 0, W, H); X.globalAlpha = 0.85; X.drawImage(this.b1, 0, 0, W, H); X.globalAlpha = 1;
      // The lake mirrors the sky (squashed, rippled, dim).
      if (this.scene === 'lake') {
        const hy = this.hy, k = 0.5;
        X.save(); X.beginPath(); X.rect(0, hy, W, H - hy); X.clip();
        for (let i = 0; i < 6; i++) {
          const y0 = hy + (i * (H - hy)) / 6, y1 = hy + ((i + 1) * (H - hy)) / 6, off = Math.sin(tm * 1.7 + i * 1.3) * (2 + i);
          X.save(); X.beginPath(); X.rect(0, y0, W, y1 - y0); X.clip();
          X.setTransform(dpr, 0, 0, -dpr * k, off * dpr, dpr * hy * (1 + k)); X.globalAlpha = 0.24 - i * 0.03; X.drawImage(this.b2, 0, 0, W, H); X.drawImage(this.b1, 0, 0, W, H);
          X.restore();
        }
        X.restore(); X.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      // Sharp cores.
      for (let i = 0; i < pts.length; i += 5) {
        const X0 = pts[i], Y0 = pts[i + 1], a = pts[i + 2], p = pts[i + 3], d = pts[i + 4], r = 1.3 * p * (this.W > 900 ? 1.25 : 1);
        X.globalAlpha = Math.min(1, a * 1.15); X.fillStyle = d.cs;
        X.beginPath(); X.arc(X0, Y0, r, 0, 6.283); X.fill();
        if (a > 0.5) { X.globalAlpha = (a - 0.5) * 1.2; X.fillStyle = '#fff'; X.fillRect(X0 - r * 0.42, Y0 - r * 0.42, r * 0.84, r * 0.84); }
      }
      for (let i = 0; i < fwp.length; i += 5) {
        const f = fwp[i], X0 = fwp[i + 1], Y0 = fwp[i + 2], a = fwp[i + 3], col = fwp[i + 4];
        X.globalAlpha = a; X.strokeStyle = col; X.lineWidth = f.type === 'rocket' ? 1.6 : 1.2;
        X.beginPath();
        if (f.type === 'rocket') { const tr = f.trail; X.moveTo(cx + tr[0][0] * s, cy + tr[0][1] * s); for (const q of tr) X.lineTo(cx + q[0] * s, cy + q[1] * s); }
        else { X.moveTo(cx + f.px * s, cy + f.py * s); X.lineTo(X0, Y0); }
        X.stroke();
        X.fillStyle = col; X.fillRect(X0 - 0.9, Y0 - 0.9, 1.8, 1.8);
      }
      X.globalAlpha = 1; X.globalCompositeOperation = 'source-over';
    }
  }

  return { Sky, loadImg, text, image, giftBox, tree, shirt, clusters, ring, merge, move, colorsOf, drawn, FONT };
})();
