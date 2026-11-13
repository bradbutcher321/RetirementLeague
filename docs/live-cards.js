// Live's announcement / vote / draft cards and the Secret Santa teaser
// (moved out of index.html, audit X #25). Each is its own self-running block.
  // The announcement and draft cards above the matchups. Quiet on any failure:
  // the section just stays hidden.
  (function () {
    const sec = document.getElementById('notice-section');
    if (!sec) return;
    const card = (title, chip, text) => `<div class="glass notice-card"><div class="panel-title"><span>${esc(title)}</span>${chip ? `<span class="notice-chip">${esc(chip)}</span>` : ''}</div>
      <div class="panel-body"><div class="item notice-box">${esc(text)}</div></div></div>`;
    function draft(at) {
      const target = new Date(at + ':00');
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      if (!(target > now)) return '';
      const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const n = Math.round((day(target) - day(now)) / 864e5);
      const when = target.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' at ' + target.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' ET';
      return card('Draft', n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`, when);
    }
    // A league vote (audit X #20): one tap to vote while signed in, then the count.
    async function voteCard(id) {
      const res = await fetch(WORKER_URL + '/polls', { cache: 'no-store', headers: authHeaders() }).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const p = res && res.poll;
      if (!p || p.id !== id) return '';
      const total = p.counts.reduce((a, b) => a + b, 0);
      const signed = !!getAuth();
      const closes = p.closes ? new Date(p.closes).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
      // Open and signed in: every option is a button (tap another to change
      // your vote); the counts show once you've voted, or after it closes.
      const shown = p.mine != null || p.closed || !signed;
      const opts = p.options.map((o, i) => signed && !p.closed
        ? `<button type="button" class="${shown ? 'vote-res' : 'vote-opt'}${p.mine === i ? ' mine' : ''}" data-vote="${i}" data-poll="${esc(p.id)}" aria-pressed="${p.mine === i}"><span>${esc(o)}</span>${shown ? `<b>${p.counts[i]}</b>` : ''}</button>`
        : `<div class="vote-res${p.mine === i ? ' mine' : ''}"><span>${esc(o)}</span><b>${p.counts[i]}</b></div>`).join('');
      return `<div class="glass notice-card" id="vote-card"><div class="panel-title"><span>League vote</span><span class="notice-chip">${p.closed ? 'Closed' : closes ? 'Closes ' + esc(closes) : 'Open'}</span></div>
        <div class="panel-body"><div class="vote-q">${esc(p.q)}</div><div class="vote-opts">${opts}</div>
        <div class="vote-note">${total} vote${total === 1 ? '' : 's'}${p.voters.length ? ': ' + esc(p.voters.join(', ')) : ''}${!signed ? '. Sign in under You to vote.' : p.mine != null ? '. You can change yours.' : ''}</div></div></div>`;
    }
    // Idiot of the Week (audit XI #19): the site's own vote on the week's
    // worst lineup calls. One tap votes (never for yourself; tap another to
    // change it); the counts show once you've voted, and the result stays
    // up for a day and a half after it closes.
    async function idiotCard() {
      const res = await fetch(WORKER_URL + '/idiot', { cache: 'no-store', headers: authHeaders() }).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const v = res && res.vote;
      if (!v || !v.cands || (v.closed && Date.now() - v.closes > 36 * 3600 * 1000)) return '';
      const auth = getAuth(), signed = !!auth, self = auth && auth.manager;
      const total = Object.values(v.counts).reduce((a, b) => a + b, 0);
      const shown = !!v.mine || v.closed || !signed;
      const closes = new Date(v.closes).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      const opts = v.cands.map(c => {
        const mine = v.mine === c.m, won = v.closed && (v.winners || []).includes(c.m);
        const inner = `<span class="iw-t"><b>${esc(c.m)}</b><small>${esc(c.why)}</small></span>${shown ? `<b class="iw-n">${v.counts[c.m] || 0}</b>` : ''}`;
        return signed && !v.closed && c.m !== self
          ? `<button type="button" class="iw-opt${mine ? ' mine' : ''}" data-idiot="${esc(c.m)}" data-idiot-id="${esc(v.id)}" aria-pressed="${mine}">${inner}</button>`
          : `<div class="iw-opt${mine ? ' mine' : ''}${won ? ' won' : ''}">${inner}</div>`;
      }).join('');
      const note = v.closed
        ? (v.winners && v.winners.length ? `${esc(v.winners.join(' and '))} ${v.winners.length === 1 ? 'wears' : 'wear'} the Idiot tag on Standings until next week's is in.` : 'Nobody voted.')
        : `${total} vote${total === 1 ? '' : 's'}${v.voters.length ? ': ' + esc(v.voters.join(', ')) : ''}.${!signed ? ' Sign in under You to vote.' : v.mine ? ' You can change yours.' : v.cands.some(c => c.m === self) ? " You're on the ballot, so you can't vote for yourself." : ''}`;
      return `<div class="glass notice-card" id="idiot-card"><div class="panel-title"><span>Idiot of Week ${esc(v.week)}</span><span class="notice-chip">${v.closed ? 'Final' : 'Vote · closes ' + esc(closes)}</span></div>
        <div class="panel-body"><div class="iw-opts">${opts}</div><div class="vote-note">${note}</div></div></div>`;
    }
    // A bet offered, taken or settled (bets.js): redraw its card, or add it.
    addEventListener('rl-bets', async () => {
      if (typeof RLBets === 'undefined') return;
      const html = await RLBets.liveCard();
      const old = document.getElementById('bets-card');
      if (old) { if (html) old.outerHTML = html; else old.remove(); return; }
      if (!html) return;
      let stack = sec.querySelector('.notice-stack');
      if (!stack) { sec.innerHTML = '<div class="notice-stack"></div>'; stack = sec.querySelector('.notice-stack'); }
      stack.insertAdjacentHTML('afterbegin', html);
      sec.hidden = false;
    });
    document.addEventListener('click', async e => {
      const b = e.target.closest('[data-idiot]');
      if (!b) return;
      b.disabled = true;
      const res = await fetch(WORKER_URL + '/idiot/vote', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ id: b.dataset.idiotId, m: b.dataset.idiot }) }).catch(() => null);
      const card = document.getElementById('idiot-card');
      if (card) card.outerHTML = await idiotCard() || '';
      if (!res || !res.ok) b.disabled = false;
    });
    document.addEventListener('click', async e => {
      const b = e.target.closest('[data-vote]');
      if (!b) return;
      b.disabled = true;
      const res = await fetch(WORKER_URL + '/polls/vote', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ id: b.dataset.poll, choice: Number(b.dataset.vote) }) }).catch(() => null);
      const card = document.getElementById('vote-card');
      if (card) card.outerHTML = await voteCard(b.dataset.poll) || '';
      if (!res || !res.ok) b.disabled = false;
    });
    fetch(WORKER_URL + '/site-info').then(r => r.ok ? r.json() : null).then(async info => {
      if (!info) return;
      if (info.lore && typeof loreFromSite === 'function') loreFromSite(info.lore);
      const [vote, idiot, bets] = await Promise.all([info.poll ? voteCard(info.poll.id) : '', idiotCard(), typeof RLBets !== 'undefined' ? RLBets.liveCard() : '']);
      const html = (info.announcement ? card('Announcement', '', info.announcement.text) : '') + bets + idiot + vote + (info.draft ? draft(info.draft.at) : '');
      if (!html) return;
      sec.innerHTML = `<div class="notice-stack">${html}</div>`;
      sec.hidden = false;
    }).catch(() => {});
  })();

  // Secret Santa teaser on the Live dashboard. Gone after Dec 31; a tap opens
  // the sign-up page.
  (function () {
    const sec = document.getElementById('santa-section');
    if (!sec) return;
    if (new Date() >= new Date(2027, 0, 1)) { sec.remove(); return; }
    const tk = document.getElementById('santa-tk');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const gap = (lo, hi) => lo + Math.random() * (hi - lo);
    const clamp01 = v => Math.max(0, Math.min(1, v));

    // ---- What the card says ----
    // Sign-ups open Sun, Nov 1 at 12:00 AM ET and close at 12:00 AM on
    // Fri, Nov 13, so the last day to sign up is Thu, Nov 12. Reveal night
    // is that Friday at 9:00 PM. The headline follows the clock (checked
    // every minute). ?santa=in or ?santa=drawn previews how it will read.
    const OPENS = new Date('2026-11-01T00:00:00-04:00'), CLOSES = new Date('2026-11-13T00:00:00-05:00'), REVEAL = new Date('2026-11-13T21:00:00-05:00');
    const me = getMe();
    const PREVIEW = {
      in: me ? `${esc(me)}, you're in` : 'You\'re in',
      drawn: 'Shopping for <b class="santa-blur">Santa</b>',
    };
    const phase = () => {
      const now = new Date();
      if (now < OPENS) return 'before';
      if (now < CLOSES) return 'open';
      if (now < REVEAL) return now.getDate() === 13 ? 'tonight' : 'closed';
      return now - REVEAL < 3 * 3600 * 1000 ? 'room' : 'drawn';
    };
    const elH = document.getElementById('santa-h');
    const leftSlot = sec.querySelector('.santa-slot.l');
    function fitWords() {
      elH.classList.remove('two');
      if (!elH.querySelector('b')) return;
      // A little tuck under the left shirt is fine; more than that hides the date.
      const room = leftSlot.getBoundingClientRect().left - elH.getBoundingClientRect().left + 28;
      if (elH.scrollWidth > room) elH.classList.add('two');
    }
    function setWords() {
      elH.innerHTML = PREVIEW[urlParam('santa')] || { before: 'Sign-ups open <b>Nov 1</b>', open: 'Sign up by <b>Nov 12</b>', closed: 'Reveal night <b>Nov 13</b>', tonight: 'Tonight at <b>9:00 PM</b>', room: 'The Room is <b>open</b>', drawn: PREVIEW.drawn }[phase()];
      fitWords();
    }
    // After the Room, the card carries your own status: your envelope, the next step for your
    // gift, new mail, event night. From the Worker when you're signed in (kept five minutes).
    const elS = document.getElementById('santa-s'), CARD = 'rl-santa-card';
    let mine = null;
    function cardWords(d) {
      if (d.unmasked) return ['The loop is <b>unmasked</b>', 'See who had who'];
      if (d.host) return ['Unwrap night is <b>live</b>', 'Follow along on your phone'];
      const y = d.you; if (!d.started || !y) return null;
      const day = t => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), key = t => { const x = new Date(t); return x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate(); };
      const ev = d.eventAt ? `Event night is ${day(d.eventAt)}` : 'Event night is TBD';
      if (d.eventAt && key(d.eventAt) === key(Date.now())) return ['Unwrap night \u00b7 <b>tonight</b>', `${new Date(d.eventAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${d.place ? ' \u00b7 ' + esc(d.place) : ''}. Bring the shirt.`];
      if (!y.opened) return ['Your envelope is <b>waiting</b>', 'Open it where nobody can see your screen'];
      let seen = 0; try { seen = Number(localStorage.getItem('rl-santa-mail-seen')) || 0; } catch (e) {}
      const fromG = y.msgs.giftee.filter(m => !m.mine).length, fromS = y.msgs.santa.filter(m => !m.mine).length;
      if (fromG + fromS > seen) return [fromS && (!fromG || y.msgs.santa[y.msgs.santa.length - 1].at > y.msgs.giftee[y.msgs.giftee.length - 1 < 0 ? 0 : y.msgs.giftee.length - 1].at) ? 'Your Santa <b>wrote you</b>' : 'Your giftee <b>wrote back</b>', 'Open the mailbox', true];
      const g = y.gift, at = !g ? 0 : g.wrapped ? 5 : g.delivered ? 4 : g.shipped ? 3 : g.ordered ? 2 : 1;
      const left = d.purchaseBy ? Math.ceil((new Date(d.purchaseBy + 'T23:59:59') - Date.now()) / 864e5) - 1 : null;
      const due = d.purchaseBy ? `Buy by ${day(d.purchaseBy + 'T12:00:00')}` : '';
      const clock = left == null ? 'Good Shirts takes about 3 weeks' : left > 1 ? `${left} days left \u00b7 3 weeks to arrive` : left === 1 ? 'Tomorrow is the last day' : left === 0 ? 'Today is the last day' : 'The buy-by date has passed';
      return [
        ['Pick <b>their shirt</b>', due ? `${due} \u00b7 ${clock}` : clock],
        [due ? `Buy by <b>${day(d.purchaseBy + 'T12:00:00')}</b>` : 'Buy <b>the shirt</b>', clock],
        ['<b>Ordered</b>', 'Waiting on Good Shirts to ship it'],
        ['<b>Shipped</b>', g && g.eta ? `Due ${day(g.eta + 'T12:00:00')}` : ev],
        ['<b>Wrap it</b>', ev],
        ['Wrapped. <b>Bring it.</b>', ev],
      ][at];
    }
    function applyMine(c) {
      mine = c && c.h ? c : null;
      if (mine) { elH.innerHTML = mine.h; elS.textContent = mine.s; fitWords(); }
    }
    async function santaStatus() {
      if (urlParam('santa') || new Date() < REVEAL) return;
      let a = null; try { a = JSON.parse(localStorage.getItem('rl-auth')); } catch (e) {}
      if (!a || !a.token || !a.manager) return;
      let c = null; try { c = JSON.parse(localStorage.getItem(CARD)); } catch (e) {}
      if (c && c.me === a.manager) { applyMine(c); if (Date.now() - c.at < 5 * 60 * 1000) return; }
      try {
        const d = await fetch(WORKER_URL + '/santa', { headers: { Authorization: 'Bearer ' + a.token }, cache: 'no-store' }).then(r => r.json());
        const w = cardWords(d), next = { me: a.manager, at: Date.now(), h: w ? w[0] : '', s: w ? w[1] : '', mail: !!(w && w[2]) };
        try { localStorage.setItem(CARD, JSON.stringify(next)); } catch (e) {}
        applyMine(next);
      } catch (e) {}
    }
    const clockWords = setWords;
    setWords = function () { if (mine) { elH.innerHTML = mine.h; fitWords(); } else clockWords(); };
    setWords();
    setInterval(() => { setWords(); santaStatus(); }, 60 * 1000);
    santaStatus();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) santaStatus(); });
    addEventListener('resize', fitWords);
    if (document.fonts) document.fonts.ready.then(fitWords);

    // ---- Sound (only ever after a press) ----
    const sfx = {
      ctx: null,
      init() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
      tone(f, type, peak, d, when = 0) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime + when, o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.value = f; o.connect(g); g.connect(this.ctx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.start(t); o.stop(t + d + 0.05);
      },
      tick() { this.tone(1600 + Math.random() * 400, 'square', 0.012, 0.03); },
      ding() { [1318, 1760, 2637].forEach((f, i) => this.tone(f, 'sine', 0.04, 0.8, i * 0.03)); },
    };

    // ---- The shirts ----
    // Three designs from every shirt design on thegoodshirts.com
    // (icons/santa/shirts/NNN.webp), dealt in a shuffled order. They only
    // change when someone presses and holds the card. Making My Way Downtown
    // is the first front shirt.
    const SHIRTS = 957;
    const holder = sec.querySelector('.santa-r');
    const [left, right] = [...sec.querySelectorAll('.santa-slot.l img, .santa-slot.r img')];
    const front = sec.querySelector('.santa-slot.c img');
    const imgs = [left, right, front];
    const file = n => `icons/santa/shirts/${String(n).padStart(3, '0')}.webp`;
    const sides = () => imgs.map(i => i.getAttribute('src'));
    const SHADOW = 'drop-shadow(0 8px 14px rgba(0,0,0,0.65))';
    let order = [], k = 0, onScreen = true;
    function nextFile() {
      if (k >= order.length) {
        const showing = sides();
        order = shuffle([...Array(SHIRTS).keys()].filter(n => !showing.includes(file(n))));
        k = 0;
      }
      return file(order[k++]);
    }
    // A small set loaded once, for the reels and the falling shirts, so they
    // don't fetch a new image every frame.
    const pool = [];
    setTimeout(() => { for (let i = 0; i < 16; i++) { const src = nextFile(), im = new Image(); im.src = src; pool.push(src); } }, 1500);
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { onScreen = es[0].isIntersecting; }).observe(sec);

    // ---- Press and hold to reroll ----
    // Held past HOLD_MS without moving, the shirts spin like slot reels until
    // let go, then stop one at a time, left to right. A plain tap still opens
    // the sheet; the click that ends a hold is swallowed.
    const HOLD_MS = 260;
    const stopOrder = [left, front, right];
    let hold = null, spinning = false, swallow = false, spinTimer = 0, stopped = new Set(), finals = [];
    const reelSrc = () => { const list = pool.length ? pool : sides(); return list[Math.floor(Math.random() * list.length)]; };
    function startSpin() {
      spinning = true; swallow = true;
      finals = [nextFile(), nextFile(), nextFile()];
      finals.forEach(src => { const im = new Image(); im.src = src; });
      stopped = new Set();
      tk.classList.add('spinning');
      spinTimer = setInterval(() => {
        for (const img of imgs) {
          if (stopped.has(img)) continue;
          img.src = reelSrc();
          if (!reduce) img.animate([{ transform: 'translateY(-14px)' }, { transform: 'translateY(10px)' }], { duration: 70 });
        }
        sfx.tick();
      }, 75);
    }
    async function stopSpin() {
      for (let i = 0; i < 3; i++) {
        const img = stopOrder[i];
        for (let n = 0; n < 3; n++) await sleep(70 + n * 40);
        stopped.add(img);
        img.src = finals[i];
        img.style.filter = SHADOW;
        if (!reduce) img.animate([{ transform: 'translateY(-16px)' }, { transform: 'translateY(4px)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.3,1.6,.5,1)' });
        sfx.ding();
        await sleep(240);
      }
      clearInterval(spinTimer);
      tk.classList.remove('spinning');
      imgs.forEach(img => { img.style.filter = ''; });
      spinning = false;
    }
    tk.addEventListener('pointerdown', e => {
      if (e.button !== 0 || spinning) return;
      swallow = false;
      sfx.init();
      hold = { x: e.clientX, y: e.clientY, timer: setTimeout(startSpin, HOLD_MS) };
    });
    tk.addEventListener('pointermove', e => {
      if (hold && !spinning && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) { clearTimeout(hold.timer); hold = null; }
    });
    const release = () => { if (!hold) return; clearTimeout(hold.timer); hold = null; if (spinning) stopSpin(); };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => tk.addEventListener(t, release));
    tk.addEventListener('contextmenu', e => e.preventDefault());

    // ---- Tilt and shine ----
    // The card leans toward the pointer (a hovering mouse, or a finger while
    // it's down); the shirts shift more than the words, and a highlight
    // follows like light on foil.
    const words = sec.querySelector('.santa-l'), glare = sec.querySelector('.santa-glare');
    let tiltRaf = 0, tiltEv = null;
    function tiltNow() {
      tiltRaf = 0;
      const e = tiltEv, r = tk.getBoundingClientRect();
      const x = clamp01((e.clientX - r.left) / r.width), y = clamp01((e.clientY - r.top) / r.height);
      tk.style.transition = 'none';
      tk.style.transform = `perspective(900px) rotateX(${((0.5 - y) * 7).toFixed(2)}deg) rotateY(${((x - 0.5) * 9).toFixed(2)}deg)`;
      holder.style.translate = `${((x - 0.5) * 12).toFixed(1)}px ${((y - 0.5) * 6).toFixed(1)}px`;
      words.style.translate = `${((x - 0.5) * -4).toFixed(1)}px 0`;
      glare.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
      glare.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      glare.style.opacity = 1;
    }
    function untilt() {
      if (tiltRaf) { cancelAnimationFrame(tiltRaf); tiltRaf = 0; }
      tk.style.transition = 'transform .5s cubic-bezier(.3,1.4,.5,1)';
      tk.style.transform = ''; holder.style.translate = ''; words.style.translate = ''; glare.style.opacity = 0;
    }
    if (!reduce) {
      tk.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse' && !hold && !spinning) return; tiltEv = e; if (!tiltRaf) tiltRaf = requestAnimationFrame(tiltNow); });
      ['pointerleave', 'pointercancel'].forEach(t => tk.addEventListener(t, untilt));
      tk.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') untilt(); });
    }

    // ---- Shirts falling like snow, behind everything ----
    const ss = sec.querySelector('.santa-ss');
    if (!reduce) setInterval(() => {
      if (!onScreen || document.hidden || !pool.length) return;
      const im = new Image(), w = 13 + Math.random() * 12, H = tk.offsetHeight;
      im.src = pool[Math.floor(Math.random() * pool.length)];
      im.alt = '';
      im.style.left = (Math.random() * 97).toFixed(1) + '%';
      im.style.width = w.toFixed(1) + 'px';
      ss.appendChild(im);
      im.animate([{ transform: `translateY(-30px) rotate(${Math.random() * 60 - 30}deg)` }, { transform: `translate(${Math.random() * 30 - 15}px,${H + 10}px) rotate(${Math.random() * 120 - 60}deg)` }],
        { duration: 6500 + Math.random() * 3000, easing: 'linear' }).finished.then(() => im.remove(), () => im.remove());
    }, 520);

    // ---- Opening the page ----
    // A plain tap goes to the sign-up page (secret-santa.html); the click
    // that ends a press-and-hold is swallowed.
    tk.addEventListener('click', () => {
      if (swallow) { swallow = false; return; }
      if (spinning) return;
      location.href = 'secret-santa.html';
    });
  })();
