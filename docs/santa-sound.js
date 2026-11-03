/* Secret Santa's sound (secret-santa.html). Everything is synthesized with Web
   Audio as it plays: no audio files. One AudioContext for the page, started by
   the first tap (iPhone only lets sound start from a tap, and mutes Web Audio
   with the silent switch unless the page asks for "playback").

   The music:
   - Carol of the Bells (Leontovych, 1914) on bells, for the drone show's opening.
   - The stadium riff from Zombie Nation's "Kernkraft 400", the section UCF plays
     in the Bounce House, looped. Its notes and rhythm are David Whittaker's
     "Star Dust" (Lazy Jones, C64, 1984, subtune 21), which the song is built on,
     read from the SID file and moved to B flat minor at 140 BPM like the
     stadium version. Four bars of eighths: the run up, the climb to the flat
     sixth and back, the turn, and the bouncing bar.
   Each part of the page plays through its own channel, so stopping the show
   silences only its sounds. */
const AE = (() => {
  const KEY = 'rl-santa-sound';
  const S = { ctx: null, on: true, out: null, bus: null, verbIn: null, delayIn: null, noise: null, pink: null, curve: null, chans: new Map(), spoke: false };
  try { S.on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}

  function impulse(ctx, secs, decay) {
    const len = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }
  function noiseBuf(ctx, secs, pink) {
    const len = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (!pink) { d[i] = w; continue; }
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    return b;
  }

  // Called from every tap (the page listens, with tap = true). The first call
  // builds the mixer; each one wakes the context, and the first tap also wakes
  // the phone's speech voice.
  function init(tap) {
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) {}
    if (tap && !S.spoke && window.speechSynthesis) {
      // iPhone only speaks after it has spoken once from a tap.
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); S.spoke = true; } catch (e) {}
    }
    if (S.ctx) { if (S.ctx.state !== 'running') { try { const r = S.ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch (e) {} } return S.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { S.ctx = new AC(); } catch (e) { return null; }
    const c = S.ctx;
    S.out = c.createGain(); S.out.gain.value = S.on ? 0.9 : 0;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.22;
    S.bus = c.createGain(); S.bus.gain.value = 0.85;
    S.bus.connect(comp); comp.connect(S.out); S.out.connect(c.destination);
    // A stadium-sized reverb and a dotted-eighth echo (140 BPM) every channel shares.
    const verb = c.createConvolver(); verb.buffer = impulse(c, 3.2, 2.4);
    S.verbIn = c.createGain(); const vOut = c.createGain(); vOut.gain.value = 0.5;
    S.verbIn.connect(verb); verb.connect(vOut); vOut.connect(comp);
    const dl = c.createDelay(1); dl.delayTime.value = 0.32; const fb = c.createGain(); fb.gain.value = 0.3;
    const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2800;
    const dOut = c.createGain(); dOut.gain.value = 0.32;
    S.delayIn = c.createGain(); S.delayIn.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(dOut); dOut.connect(comp);
    S.noise = noiseBuf(c, 2.5, false); S.pink = noiseBuf(c, 4, true);
    // The riff's grit: a soft clipper.
    S.curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; S.curve[i] = Math.tanh(2.6 * x) / Math.tanh(2.6); }
    try { const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch (e) {}
    if (c.state !== 'running') { try { const r = c.resume(); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
    return c;
  }
  const running = () => !!S.ctx && S.ctx.state === 'running';

  // The audio clock, or the wall clock when this browser has no Web Audio.
  const now = () => (S.ctx ? S.ctx.currentTime : performance.now() / 1000);
  const midi = m => 440 * Math.pow(2, (m - 69) / 12);

  /* ---------- A channel: its own volume, and every instrument ---------- */
  class Channel {
    constructor(name) {
      const c = S.ctx; this.name = name; this.c = c; this.dead = false;
      this.g = c.createGain(); this.g.gain.value = 1; this.g.connect(S.bus);
      this.vs = c.createGain(); this.vs.connect(S.verbIn);
      this.ds = c.createGain(); this.ds.connect(S.delayIn);
      // Bass, leads and pads go through the pump, which dips on every kick (the stadium "breathing").
      this.pump = c.createGain(); this.pump.connect(this.g);
    }
    stop(fade = 0.12) {
      if (this.dead) return; this.dead = true;
      const t = this.c.currentTime;
      [this.g, this.vs, this.ds].forEach(n => { n.gain.cancelScheduledValues(t); n.gain.setValueAtTime(n.gain.value, t); n.gain.linearRampToValueAtTime(0, t + fade); });
      setTimeout(() => { try { this.g.disconnect(); this.vs.disconnect(); this.ds.disconnect(); } catch (e) {} }, fade * 1000 + 400);
    }
    vol(v, t = this.c.currentTime, ramp = 0.3) { const g = this.g.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(v, t + ramp); }
    out(node, { rv = 0, dl = 0, pump = false } = {}) {
      node.connect(pump ? this.pump : this.g);
      if (rv) { const s = this.c.createGain(); s.gain.value = rv; node.connect(s); s.connect(this.vs); }
      if (dl) { const s = this.c.createGain(); s.gain.value = dl; node.connect(s); s.connect(this.ds); }
    }
    env(g, t, a, peak, d, hold = 0) {
      peak = Math.max(peak, 0.0002);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a);
      if (hold) g.gain.setValueAtTime(peak, t + a + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
      return t + a + hold + d;
    }
    osc(type, f, t, end) { const o = this.c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(end + 0.05); return o; }
    filt(type, f, q = 0.7) { const b = this.c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
    gain(v = 1) { const g = this.c.createGain(); g.gain.value = v; return g; }
    nz(t, { type = 'bandpass', f = 1000, q = 0.8, v = 0.3, a = 0.001, d = 0.1, hold = 0, rv = 0, pink = false, f2 = 0, dl = 0 } = {}) {
      const s = this.c.createBufferSource(); s.buffer = pink ? S.pink : S.noise;
      const fl = this.filt(type, f, q); if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + a + hold + d);
      const g = this.gain(0); const end = this.env(g, t, a, v, d, hold);
      s.connect(fl); fl.connect(g); this.out(g, { rv, dl });
      s.start(t, Math.random() * 1.5); s.stop(end + 0.05);
      return g;
    }

    /* Drums */
    kick(t, v = 0.9) {
      const o = this.osc('sine', 160, t, t + 0.45); o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
      const g = this.gain(0); this.env(g, t, 0.003, v, 0.42); o.connect(g); this.out(g);
      this.nz(t, { type: 'highpass', f: 2500, v: v * 0.18, d: 0.012 });
    }
    duck(t, depth = 0.35, rel = 0.2) { const p = this.pump.gain; p.cancelScheduledValues(t); p.setValueAtTime(depth, t); p.linearRampToValueAtTime(1, t + rel); }
    snare(t, v = 0.6) {
      this.nz(t, { type: 'bandpass', f: 1900, q: 0.8, v: v * 0.8, d: 0.17, rv: 0.15 });
      const o = this.osc('triangle', 190, t, t + 0.15); o.frequency.exponentialRampToValueAtTime(150, t + 0.1);
      const g = this.gain(0); this.env(g, t, 0.002, v * 0.4, 0.1); o.connect(g); this.out(g);
    }
    clap(t, v = 0.6) {
      for (let k = 0; k < 3; k++) this.nz(t + k * 0.011, { type: 'bandpass', f: 1150, q: 1.1, v, d: 0.02 });
      this.nz(t + 0.033, { type: 'bandpass', f: 1100, q: 0.9, v: v * 0.85, d: 0.2, rv: 0.35 });
    }
    hat(t, v = 0.3, open = false) { this.nz(t, { type: 'highpass', f: 7600, q: 0.6, v: v * 0.45, d: open ? 0.2 : 0.04 }); }
    crash(t, v = 0.5) { this.nz(t, { type: 'highpass', f: 4200, q: 0.5, v: v * 0.5, d: 1.8, rv: 0.4 }); }
    tom(t, f = 140, v = 0.5) {
      const o = this.osc('sine', f, t, t + 0.5); o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.3);
      const g = this.gain(0); this.env(g, t, 0.003, v, 0.38); o.connect(g); this.out(g, { rv: 0.25 });
    }
    taiko(t, v = 0.9) {
      const o = this.osc('sine', 115, t, t + 1); o.frequency.exponentialRampToValueAtTime(50, t + 0.35);
      const g = this.gain(0); this.env(g, t, 0.004, v, 0.85); o.connect(g); this.out(g, { rv: 0.45 });
      this.nz(t, { type: 'lowpass', f: 600, v: v * 0.5, d: 0.25, rv: 0.3 });
    }
    timpani(t, f = 98, v = 0.7) {
      const o = this.osc('sine', f * 1.03, t, t + 1.8); o.frequency.exponentialRampToValueAtTime(f, t + 0.2);
      const g = this.gain(0); this.env(g, t, 0.004, v, 1.5); o.connect(g); this.out(g, { rv: 0.4 });
      const o2 = this.osc('triangle', f * 2.01, t, t + 0.6); const g2 = this.gain(0); this.env(g2, t, 0.003, v * 0.25, 0.5); o2.connect(g2); this.out(g2);
      this.nz(t, { type: 'lowpass', f: 500, v: v * 0.4, d: 0.1 });
    }
    drumroll(t, dur = 2, v = 0.5) {
      const n = Math.floor(dur / 0.034);
      for (let k = 0; k < n; k++) { const p = k / n; this.nz(t + k * 0.034, { type: 'bandpass', f: 1700 + p * 600, q: 0.9, v: v * (0.18 + 0.82 * p * p), d: 0.06, rv: 0.12 }); }
    }

    /* Tones */
    bass(t, f, d = 0.18, v = 0.5) {
      const end = t + d + 0.08, lp = this.filt('lowpass', 900, 2); lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(220, t + d);
      const o1 = this.osc('sawtooth', f, t, end), o2 = this.osc('square', f / 2, t, end);
      const g2 = this.gain(0.6); o2.connect(g2); o1.connect(lp); g2.connect(lp);
      const g = this.gain(0); this.env(g, t, 0.005, v, 0.08, d); lp.connect(g); this.out(g, { pump: true });
    }
    // The riff's voice: a saw and a pulse a few cents apart, clipped, through a
    // resonant low-pass that snaps shut (the grinding SID lead of the record).
    zn(t, f, d = 0.19, v = 0.27, cut = 3000, hi = true) {
      const end = t + d + 0.1, mix = this.gain(0.42);
      const o1 = this.osc('sawtooth', f, t, end), o2 = this.osc('square', f * 1.004, t, end), o3 = this.osc('sawtooth', f * 0.996, t, end);
      const g2 = this.gain(0.55); o2.connect(g2); g2.connect(mix); o1.connect(mix); o3.connect(mix);
      const sh = this.c.createWaveShaper(); sh.curve = S.curve; try { sh.oversample = '2x'; } catch (e) {}
      const lp = this.filt('lowpass', cut * 2.4, 6); lp.frequency.setValueAtTime(cut * 2.4, t); lp.frequency.exponentialRampToValueAtTime(Math.max(300, cut), t + 0.09);
      mix.connect(sh); sh.connect(lp);
      const g = this.gain(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(v, 0.0002), t + 0.004);
      g.gain.setValueAtTime(Math.max(v, 0.0002), t + d * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.06);
      lp.connect(g); this.out(g, { rv: 0.18, dl: hi ? 0.1 : 0, pump: true });
    }
    bell(t, f, d = 1.8, v = 0.2) {
      const end = t + d + 0.1, car = this.osc('sine', f, t, end), mod = this.osc('sine', f * 3.5, t, end), mg = this.gain(f * 2.4);
      mg.gain.setValueAtTime(f * 2.4, t); mg.gain.exponentialRampToValueAtTime(f * 0.04, t + 1.2);
      mod.connect(mg); mg.connect(car.frequency);
      const g = this.gain(0); this.env(g, t, 0.002, v, d); car.connect(g); this.out(g, { rv: 0.4 });
      const h = this.osc('sine', f * 2, t, t + 0.9), hg = this.gain(0); this.env(hg, t, 0.002, v * 0.18, 0.8); h.connect(hg); this.out(hg, { rv: 0.3 });
    }
    pad(t, freqs, d = 2, v = 0.08, cut = 1400) {
      const end = t + d + 1, lp = this.filt('lowpass', cut, 0.5), g = this.gain(0);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + Math.min(0.6, d * 0.4)); g.gain.setValueAtTime(v, t + d); g.gain.linearRampToValueAtTime(0.0001, t + d + 0.9);
      freqs.forEach(f => [-7, 7].forEach(c => { const o = this.osc('sawtooth', f * Math.pow(2, c / 1200), t, end); const og = this.gain(0.5); o.connect(og); og.connect(lp); }));
      lp.connect(g); this.out(g, { rv: 0.45, pump: true });
    }
    stab(t, freqs, d = 0.14, v = 0.2) {
      const end = t + d + 0.2, lp = this.filt('lowpass', 3600, 2); lp.frequency.setValueAtTime(3600, t); lp.frequency.exponentialRampToValueAtTime(700, t + d + 0.1);
      freqs.forEach(f => [-9, 9].forEach(c => { const o = this.osc('sawtooth', f * Math.pow(2, c / 1200), t, end); o.connect(lp); }));
      const g = this.gain(0); this.env(g, t, 0.003, v, 0.12, d); lp.connect(g); this.out(g, { rv: 0.3, dl: 0.1, pump: true });
    }
    brass(t, freqs, d = 0.5, v = 0.22) {
      const end = t + d + 0.4, lp = this.filt('lowpass', 500, 1.5);
      lp.frequency.setValueAtTime(500, t); lp.frequency.exponentialRampToValueAtTime(3000, t + 0.06); lp.frequency.exponentialRampToValueAtTime(1400, t + 0.3);
      freqs.forEach(f => [-6, 0, 6].forEach(c => { const o = this.osc('sawtooth', f * Math.pow(2, c / 1200), t, end); o.connect(lp); }));
      const g = this.gain(0); this.env(g, t, 0.02, v, 0.3, d); lp.connect(g); this.out(g, { rv: 0.35 });
    }
    organ(t, f, d = 0.3, v = 0.16) {
      const end = t + d + 0.2, g = this.gain(0), sum = this.gain(1);
      [[1, 1], [2, 0.6], [3, 0.4], [4, 0.28], [6, 0.18], [8, 0.12]].forEach(([h, a]) => { const o = this.osc('sine', f * h, t, end); const og = this.gain(a); o.connect(og); og.connect(sum); });
      const trem = this.osc('sine', 6.5, t, end), tg = this.gain(0.12); trem.connect(tg); tg.connect(g.gain);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.012); g.gain.setValueAtTime(v, t + d); g.gain.linearRampToValueAtTime(0.0001, t + d + 0.08);
      sum.connect(g); this.out(g, { rv: 0.35 });
    }
    trombone(t, f, d = 0.4, v = 0.25, vib = false) {
      const end = t + d + 0.2, o = this.osc('sawtooth', f, t, end), lp = this.filt('lowpass', 1100, 1);
      if (vib) { const l = this.osc('sine', 5.5, t, end), lg = this.gain(f * 0.03); l.connect(lg); lg.connect(o.frequency); }
      const g = this.gain(0); this.env(g, t, 0.04, v, 0.15, d); o.connect(lp); lp.connect(g); this.out(g, { rv: 0.25 });
    }
    // A crowd singing "oh": a few detuned voices through two vowel formants.
    choir(t, f, d = 0.2, v = 0.2, vowel = 'oh') {
      const F = { oh: [480, 860], ah: [760, 1180], oo: [330, 820], eh: [560, 1750] }[vowel] || [480, 860];
      const end = t + d + 0.35, mix = this.gain(1), b1 = this.filt('bandpass', F[0], 5), b2 = this.filt('bandpass', F[1], 7), g1 = this.gain(1), g2 = this.gain(0.55);
      for (let k = 0; k < 6; k++) { const o = this.osc('sawtooth', f * Math.pow(2, (Math.random() * 30 - 15) / 1200), t + Math.random() * 0.03, end); o.connect(mix); }
      mix.connect(b1); mix.connect(b2); b1.connect(g1); b2.connect(g2);
      const g = this.gain(0); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.05); g.gain.setValueAtTime(v, t + d); g.gain.linearRampToValueAtTime(0.0001, t + d + 0.25);
      g1.connect(g); g2.connect(g); this.out(g, { rv: 0.55 });
    }
    roar(t, d = 3, v = 0.25) {
      const s = this.c.createBufferSource(); s.buffer = S.pink; s.loop = true;
      const bp = this.filt('bandpass', 950, 0.6), g = this.gain(0);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + Math.min(0.9, d * 0.3)); g.gain.setValueAtTime(v, t + d * 0.7); g.gain.linearRampToValueAtTime(0.0001, t + d);
      s.connect(bp); bp.connect(g); this.out(g, { rv: 0.5 }); s.start(t, Math.random() * 2); s.stop(t + d + 0.1);
      // A few whistles and "whoo"s on top.
      for (let k = 0; k < Math.floor(d * 1.5); k++) {
        const tt = t + 0.2 + Math.random() * (d * 0.75), f0 = 1400 + Math.random() * 900, o = this.osc('sine', f0, tt, tt + 0.7);
        o.frequency.linearRampToValueAtTime(f0 * (1.15 + Math.random() * 0.4), tt + 0.35);
        const og = this.gain(0); this.env(og, tt, 0.05, v * 0.08, 0.5); o.connect(og); this.out(og, { rv: 0.4 });
      }
    }
    airhorn(t, d = 0.7, v = 0.3) {
      const end = t + d + 0.15, bp = this.filt('bandpass', 1250, 0.8), lp = this.filt('lowpass', 3800, 0.7);
      [466.16, 587.33, 698.46].forEach(f => { const o = this.osc('sawtooth', f * 0.93, t, end); o.frequency.exponentialRampToValueAtTime(f, t + 0.07); o.connect(bp); });
      const g = this.gain(0); this.env(g, t, 0.01, v, 0.09, d); bp.connect(lp); lp.connect(g); this.out(g, { rv: 0.35 });
    }
    sleigh(t, d = 1.5, v = 0.3) {
      const step = 0.0714, n = Math.floor(d / step);
      for (let k = 0; k < n; k++) {
        const tt = t + k * step + (Math.random() - 0.5) * 0.01;
        this.nz(tt, { type: 'bandpass', f: 8200, q: 2.5, v: v * (k % 2 ? 0.55 : 1), d: 0.07, rv: 0.2 });
        if (k % 2 === 0) { const o = this.osc('sine', 5200 + Math.random() * 3000, tt, tt + 0.08); const g = this.gain(0); this.env(g, tt, 0.001, v * 0.05, 0.06); o.connect(g); this.out(g); }
      }
    }
    riser(t, d = 2, v = 0.3) {
      const s = this.c.createBufferSource(); s.buffer = S.noise; s.loop = true;
      const hp = this.filt('bandpass', 300, 1.2); hp.frequency.setValueAtTime(300, t); hp.frequency.exponentialRampToValueAtTime(7000, t + d);
      const g = this.gain(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + d);
      s.connect(hp); hp.connect(g); this.out(g, { rv: 0.3 }); s.start(t); s.stop(t + d + 0.02);
      const o = this.osc('sawtooth', 150, t, t + d), lp = this.filt('lowpass', 2400, 1), og = this.gain(0);
      o.frequency.exponentialRampToValueAtTime(1300, t + d);
      og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(v * 0.35, t + d);
      o.connect(lp); lp.connect(og); this.out(og, { rv: 0.3 });
      return { stop: (at = this.c.currentTime) => { [g, og].forEach(x => { x.gain.cancelScheduledValues(at); x.gain.setValueAtTime(Math.max(0.0001, x.gain.value), at); x.gain.exponentialRampToValueAtTime(0.0001, at + 0.25); }); } };
    }
    impact(t, v = 0.8) {
      const o = this.osc('sine', 78, t, t + 2); o.frequency.exponentialRampToValueAtTime(30, t + 1.4);
      const g = this.gain(0); this.env(g, t, 0.003, v, 1.6); o.connect(g); this.out(g, { rv: 0.5 });
      this.nz(t, { type: 'lowpass', f: 1100, v: v * 0.7, d: 1.1, rv: 0.6 });
      this.nz(t, { type: 'highpass', f: 3000, v: v * 0.25, d: 0.5, rv: 0.4 });
    }
    whoosh(t, d = 1.2, v = 0.18) { this.nz(t, { type: 'bandpass', f: 250, f2: 2600, q: 0.9, v, a: d * 0.6, d: d * 0.4, rv: 0.2 }); }
    whistle(t, d = 0.9, v = 0.06) {
      const o = this.osc('sine', 700, t, t + d); o.frequency.linearRampToValueAtTime(2300, t + d);
      const g = this.gain(0); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.1); g.gain.linearRampToValueAtTime(0.0001, t + d);
      o.connect(g); this.out(g, { rv: 0.2 });
    }
    crackle(t, d = 1.2, v = 0.15) { for (let k = 0; k < 34; k++) this.nz(t + Math.random() * d, { type: 'highpass', f: 3500, v: v * (0.3 + Math.random() * 0.7), d: 0.008 }); }
    boom(t, v = 0.6, crackle = true) {
      this.nz(t, { type: 'lowpass', f: 320, v, d: 1.3, rv: 0.5 });
      const o = this.osc('sine', 62, t, t + 1.3); o.frequency.exponentialRampToValueAtTime(34, t + 1); const g = this.gain(0); this.env(g, t, 0.004, v * 0.8, 1.1); o.connect(g); this.out(g);
      if (crackle) this.crackle(t + 0.3, 1.1, v * 0.35);
    }
    tick(t, v = 1) {
      const o = this.osc('sine', 1800, t, t + 0.08), g = this.gain(0); this.env(g, t, 0.001, 0.05 * v, 0.06); o.connect(g); this.out(g);
      const o2 = this.osc('sine', 90, t, t + 0.3), g2 = this.gain(0); this.env(g2, t, 0.002, 0.14 * v, 0.24); o2.connect(g2); this.out(g2);
    }
    ding(t, f = 1318.5, v = 0.12) {
      const o = this.osc('sine', f, t, t + 1.2), g = this.gain(0); this.env(g, t, 0.002, v, 1); o.connect(g); this.out(g, { rv: 0.3 });
      const o2 = this.osc('sine', f * 2.76, t, t + 0.4), g2 = this.gain(0); this.env(g2, t, 0.002, v * 0.2, 0.3); o2.connect(g2); this.out(g2);
    }
    chime(t, v = 0.07) { [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98].forEach((f, i) => { this.ding(t + i * 0.07, f, v); }); }
    clank(t, v = 0.4) {
      this.nz(t, { type: 'bandpass', f: 2400, q: 6, v, d: 0.14, rv: 0.25 });
      const o = this.osc('square', 180, t, t + 0.3), lp = this.filt('lowpass', 900), g = this.gain(0); this.env(g, t, 0.002, v * 0.25, 0.22); o.connect(lp); lp.connect(g); this.out(g, { rv: 0.2 });
    }
    ratchet(t, d = 1, v = 0.2) { for (let k = 0; k < d / 0.045; k++) this.nz(t + k * 0.045, { type: 'bandpass', f: 3800, q: 3, v, d: 0.012 }); }
    stamp(t, v = 0.5) {
      const o = this.osc('sine', 130, t, t + 0.3); o.frequency.exponentialRampToValueAtTime(55, t + 0.15);
      const g = this.gain(0); this.env(g, t, 0.002, v, 0.22); o.connect(g); this.out(g, { rv: 0.2 });
      this.nz(t, { type: 'lowpass', f: 1500, v: v * 0.5, d: 0.07 });
    }
    shutter(t, v = 0.3) { this.nz(t, { type: 'highpass', f: 2500, v, d: 0.015 }); this.nz(t + 0.07, { type: 'highpass', f: 1800, v: v * 0.8, d: 0.03 }); }
    clack(t, v = 0.15) { const o = this.osc('sine', 2200 + Math.random() * 900, t, t + 0.05), g = this.gain(0); this.env(g, t, 0.001, v, 0.03); o.connect(g); this.out(g); this.nz(t, { type: 'bandpass', f: 3200, q: 2, v: v * 0.6, d: 0.01 }); }
    heartbeat(t, v = 0.5) { [0, 0.22].forEach((o, k) => { const x = this.osc('sine', 60, t + o, t + o + 0.3), g = this.gain(0); this.env(g, t + o, 0.006, v * (k ? 0.7 : 1), 0.22); x.connect(g); this.out(g); }); }
    beep(t, f = 1000, d = 0.08, v = 0.08) { const o = this.osc('square', f, t, t + d + 0.02), lp = this.filt('lowpass', 3000), g = this.gain(0); this.env(g, t, 0.002, v, 0.02, d); o.connect(lp); lp.connect(g); this.out(g); }

    /* Stingers */
    charge(t, v = 0.2) { [[392, 0, 0.1], [523.25, 0.12, 0.1], [659.25, 0.24, 0.1], [783.99, 0.36, 0.28], [659.25, 0.72, 0.1], [783.99, 0.84, 0.6]].forEach(([f, o, d]) => this.organ(t + o, f, d, v)); }
    sadTrombone(t, v = 0.22) { [[233.08, 0, 0.32], [220, 0.4, 0.32], [207.65, 0.8, 0.32], [196, 1.2, 1.1, 1]].forEach(([f, o, d, vib]) => this.trombone(t + o, f, d, v, !!vib)); }
    choirChord(t, v = 0.2) { [196, 246.94, 293.66, 392].forEach(f => this.choir(t, f, 1.4, v * 0.6, 'ah')); }
    pickIsIn(t, v = 0.3) {
      this.brass(t, [196, 293.66, 392], 0.12, v); this.timpani(t, 98, v * 1.6);
      this.brass(t + 0.32, [233.08, 349.23, 466.16], 0.5, v * 1.1); this.timpani(t + 0.32, 116.54, v * 1.8); this.crash(t + 0.32, v);
    }
  }

  // Without Web Audio every instrument is a no-op, so the visuals still run.
  const SILENT = new Proxy({}, { get: (t, k) => (k === 'riser' ? () => ({ stop() {} }) : () => {}) });
  function channel(name) {
    if (!init()) return SILENT;
    let ch = S.chans.get(name);
    if (!ch || ch.dead) { ch = new Channel(name); S.chans.set(name, ch); }
    return ch;
  }
  function stopChannel(name, fade) { const ch = S.chans.get(name); if (ch) { ch.stop(fade); S.chans.delete(name); } }
  function setOn(on) {
    S.on = on; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
    if (S.out) { const t = S.ctx.currentTime; S.out.gain.cancelScheduledValues(t); S.out.gain.setValueAtTime(S.out.gain.value, t); S.out.gain.linearRampToValueAtTime(on ? 0.9 : 0, t + 0.1); }
    if (!on && window.speechSynthesis) speechSynthesis.cancel();
  }

  /* A step sequencer on the audio clock (looks 0.15s ahead every 25ms). Its
     start can be in the past (sound came on partway through): steps already
     gone are skipped, so it joins in time. */
  class Seq {
    constructor(stepDur, onStep) { this.dur = stepDur; this.onStep = onStep; this.timer = null; this.next = 0; this.t0 = 0; }
    start(at) {
      init(); this.t0 = at != null ? at : now() + 0.08;
      this.next = Math.max(0, Math.ceil((now() + 0.02 - this.t0) / this.dur));
      this.timer = setInterval(() => this.tick(), 25); this.tick(); return this;
    }
    tick() { const ahead = now() + 0.15; while (this.t0 + this.next * this.dur < ahead) { const s = this.next++; try { this.onStep(s, this.t0 + s * this.dur); } catch (e) { console.error(e); } } }
    stop() { clearInterval(this.timer); this.timer = null; }
    get running() { return !!this.timer; }
    timeOf(step) { return this.t0 + step * this.dur; }
    stepNow() { return Math.floor((now() - this.t0) / this.dur); }
    phase(stepsPerBeat) { const x = (now() - this.t0) / (this.dur * stepsPerBeat); return x - Math.floor(x); }
  }

  /* ---------- The music ---------- */
  // Carol of the Bells, 3/4 at 165 BPM in eighth notes: the four-note bell
  // figure over the falling G-F-Eb-D bass.
  const BELLS = { step: 60 / 165 / 2, bar: 6 };
  const OST = { 0: 466.16, 2: 440, 3: 466.16, 4: 392 }, OST3 = { 0: 587.33, 2: 523.25, 3: 587.33, 4: 466.16 };
  const BELL_ROOTS = [98, 87.31, 77.78, 73.42];
  const BELL_CHORDS = [[196, 233.08, 293.66], [174.61, 220, 261.63], [155.56, 196, 233.08], [146.83, 185, 220]];
  function bellsStep(ch, s, t, L) {
    const bar = Math.floor(s / 6), i = s % 6, n = OST[i];
    if (n && L.bells !== false) { ch.bell(t, n * 2, 1.7, 0.19); if (L.low) ch.bell(t, n, 1.3, 0.1); }
    if (n && L.harm) ch.bell(t, OST3[i] * 2, 1.2, 0.08);
    if (L.bass && i === 0 && bar % 2 === 0) { const k = (bar / 2) % 4; ch.bass(t, BELL_ROOTS[k], BELLS.step * 11, 0.42); ch.pad(t, BELL_CHORDS[k], BELLS.step * 12 - 0.1, 0.07); }
    if (L.drums) {
      if (i === 0) ch.taiko(t, 0.8); if (i === 2 || i === 3) ch.tom(t, 160, 0.32); if (i === 4) ch.tom(t, 110, 0.42);
      ch.hat(t, i % 2 ? 0.12 : 0.22);
    }
    if (L.pulse && i === 0) ch.heartbeat(t, 0.3);
  }
  // The stadium riff, 140 BPM in 4/4. The sequencer runs in sixteenths (16 a
  // bar, 64 a loop); the riff, the bass and the crowd play on the eighths.
  // Each eighth is [MIDI note, melody?]: the melody notes run Bb3 to Gb4, and
  // the low notes between them are the record's bouncing octaves.
  const STAD = { step: 60 / 140 / 4, bar: 16, loop: 64 };
  const RIFF = [
    [[34, 0], [58, 1], [61, 1], [63, 1], [65, 1], [46, 0], [34, 0], [46, 0]],
    [[34, 0], [58, 1], [61, 1], [63, 1], [65, 1], [66, 1], [65, 1], [61, 1]],
    [[63, 1], [51, 0], [39, 0], [51, 0], [61, 1], [53, 0], [65, 1], [58, 1]],
    [[34, 0], [46, 0], [34, 0], [46, 0], [34, 0], [46, 0], [34, 0], [46, 0]],
  ];
  // The bass: octaves on the chord's root, on every eighth (Bb minor, and in the
  // third bar half a bar each of Eb minor and F minor).
  const BASS = [[34, 46], [34, 46], [39, 51, 41, 53], [34, 46]];
  const CHORDS = [[[58, 61, 65], [58, 61, 65]], [[58, 61, 65], [58, 61, 65]], [[51, 54, 58], [53, 56, 60]], [[58, 61, 65], [58, 61, 65]]];
  function bassNote(bar, e) { const b = BASS[bar]; return b.length === 2 ? b[e % 2] : b[(e >= 4 ? 2 : 0) + (e % 2)]; }
  function stadiumStep(ch, s, t, L) {
    const bar = Math.floor(s / 16) % 4, i = s % 16, e = i >> 1, on8 = i % 2 === 0;
    if (L.kick && i % 4 === 0) { ch.kick(t, 0.95); if (L.bass || L.riff) ch.duck(t); }
    if (L.hat && i % 4 === 2) ch.hat(t, 0.55, true);
    if (L.shaker && i % 2 === 1) ch.hat(t, 0.2);
    if (L.clap && (i === 4 || i === 12)) ch.clap(t, L.bigClap ? 0.85 : 0.62);
    if (L.bigClap && (i === 4 || i === 12)) ch.clap(t + 0.015, 0.5);
    if (L.bass && on8) ch.bass(t, midi(bassNote(bar, e)), 0.16, e % 2 ? 0.48 : 0.34);
    if (on8 && (L.riff || L.chant)) {
      const [m, hi] = RIFF[bar][e];
      if (L.riff) ch.zn(t, midi(m), 0.19, hi ? 0.27 : 0.19, L.cut || 3000, !!hi);
      if (L.chant && hi) ch.choir(t, midi(m), 0.17, 0.2, 'oh');
    }
    if (L.stab && (i === 6 || i === 14)) ch.stab(t, CHORDS[bar][i < 8 ? 0 : 1].map(midi), 0.1, 0.16);
    if (L.roll && i % (L.roll > 1 ? 1 : 2) === 0) ch.snare(t, 0.18 + 0.3 * (i / 16));
    if (L.horn && i === 0 && bar === 0) ch.airhorn(t, 0.55, 0.22);
    if (L.crashBar && i === 0 && bar === 0) ch.crash(t, 0.45);
  }
  // What the beat sounds like with n of 12 holding the seal.
  const LAYERS = ['Heartbeat', 'Kick', 'Hats', 'Clap', 'Bass', 'Shaker', 'Synth riff', 'Filter opens', 'Chord stabs', 'Full synth', 'Crowd claps', 'Snare build', 'Everyone'];
  function layersFor(n) {
    return { kick: n >= 1, hat: n >= 2, clap: n >= 3, bass: n >= 4, shaker: n >= 5, riff: n >= 6, cut: n >= 9 ? 3200 : n >= 7 ? 1500 : 650, stab: n >= 8, bigClap: n >= 10, roll: n >= 11 ? 1 : 0 };
  }
  const FULL = { kick: 1, hat: 1, clap: 1, bass: 1, riff: 1, cut: 3600, stab: 1, shaker: 1, chant: 1, bigClap: 1, horn: 1, crashBar: 1 };

  // The phone's own voice. Never asked to say a giftee's name.
  function say(text, { rate = 0.88, pitch = 0.75, voiceHint = /Daniel|Alex|Fred|Google US English|Microsoft Guy|Aaron|Arthur/i, volume = 1 } = {}) {
    if (!S.on || !window.speechSynthesis) return null;
    try {
      const u = new SpeechSynthesisUtterance(text); u.rate = rate; u.pitch = pitch; u.volume = volume;
      const vs = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang));
      u.voice = vs.find(v => voiceHint.test(v.name)) || vs[0] || null;
      speechSynthesis.cancel(); speechSynthesis.speak(u); return u;
    } catch (e) { return null; }
  }
  if (window.speechSynthesis) { try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices(); } catch (e) {} }

  return {
    init, now, midi, channel, stopChannel, setOn, running, Seq, BELLS, STAD, bellsStep, stadiumStep, layersFor, LAYERS, FULL, say,
    get on() { return S.on; }, get ctx() { return S.ctx; },
    // The page's own one-off tones (secret-santa.html's A) play through the same master volume.
    get master() { return S.out; },
  };
})();
