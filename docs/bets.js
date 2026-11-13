// Side bets (site audit XI #20): offer one from your matchup (Live's ⋯) or
// from a manager's name, take or pass on one offered to you, settle an
// "anything else" bet by hand, and the ledger on your profile. The Worker
// (worker/src/bets.js) keeps them and settles the rest from the final
// score. The site keeps score; it never moves money. Needs page-common.js.
const RLBets = (() => {
  const W = 'https://retirement-league-refresh-proxy.bradbutcher321.workers.dev';
  let state = null, loading = null;
  const signed = () => typeof getAuth === 'function' && !!getAuth();
  function load(force) {
    if (!signed()) return Promise.resolve(null);
    if (state && !force) return Promise.resolve(state);
    if (loading && !force) return loading;
    loading = fetch(W + '/bets', { cache: 'no-store', headers: authHeaders() })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { state = d; loading = null; return d; })
      .catch(() => { loading = null; return null; });
    return loading;
  }
  const f2 = n => Number(n).toFixed(2);
  // The bet in words, from your side (the Worker words its pushes the same way).
  function describe(b, me) {
    const other = me === b.a ? b.b : b.a;
    if (b.kind === 'matchup') return `${b.stake} on your matchup with ${other}`;
    if (b.kind === 'points') return `${b.stake} on who scores more this week, you or ${other}`;
    if (b.kind === 'ou') {
      const side = me === b.a ? b.side : b.side === 'over' ? 'under' : 'over';
      return `${b.stake}: ${b.subject === me ? 'your score' : `${b.subject}'s score`} ${side} ${f2(b.line)}`;
    }
    return `${b.stake}: ${b.note}`;
  }
  const outcome = (b, me) => (b.status !== 'settled' ? null : b.winner === 'push' ? 'push' : b.winner === me ? 'won' : 'lost');
  // "$20" is money the ledger can add up; anything else is listed as owed.
  const money = s => { const m = String(s).match(/^\s*\$\s*(\d+(?:\.\d+)?)\s*$/); return m ? Number(m[1]) : null; };
  async function post(path, body) {
    const r = await fetch(W + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    return { ok: !!(r && r.ok), j };
  }
  const changed = () => { state = null; dispatchEvent(new Event('rl-bets')); };
  const ERR = {
    bad_line: 'Give the line as a number, like 100.5.', no_note: 'Say what the bet is.', no_stake: 'Name the stake first.',
    not_your_opponent: "You don't play them this week.", already_over: 'That game is already over.',
    too_many: 'Six open bets in a week is the limit.', no_game: 'No game for that this week.', signed_out: 'Sign in under You first.',
  };

  // ---------- The offer sheet ----------
  function close() {
    document.getElementById('bet-sheet')?.remove();
    document.getElementById('bet-scrim')?.remove();
  }
  async function open(to) {
    if (!signed()) { if (typeof openYou === 'function') openYou('you'); return; }
    close();
    const s = await load(true);
    if (!s || !s.me || s.me === to) return;
    const me = s.me, opp = s.opponent === to;
    const kinds = [
      [opp ? 'matchup' : 'points', opp ? 'Our matchup' : 'More points', opp ? `Week ${s.week}, you vs ${to}` : `Week ${s.week}, you or ${to}`],
      ['ou', 'Over or under', 'One score against a line'],
      ['other', 'Something else', 'You write it; you two settle it'],
    ];
    let kind = kinds[0][0], subject = me, side = 'over';
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="bet-scrim"></div>
      <div class="sheet bet-sheet" id="bet-sheet" role="dialog" aria-modal="true" aria-label="Side bet with ${esc(to)}" tabindex="-1">
        <div class="sheet-grab"><span></span></div>
        <div class="sheet-body">
          <div class="bet-h"><b>Bet ${esc(to)}</b><span>Week ${esc(s.week)}</span></div>
          <div class="bet-kinds" role="radiogroup" aria-label="What kind of bet">${kinds.map(([k, t, sub]) => `<button type="button" role="radio" data-bk="${k}" aria-checked="${k === kind}" class="${k === kind ? 'on' : ''}"><b>${t}</b><small>${esc(sub)}</small></button>`).join('')}</div>
          <div class="bet-more" data-for="ou" hidden>
            <div class="bet-row"><span>Whose score</span><div class="bet-seg"><button type="button" data-bs="${esc(me)}" class="on">Yours</button><button type="button" data-bs="${esc(to)}">${esc(to)}'s</button></div></div>
            <div class="bet-row"><span>Your side</span><div class="bet-seg"><button type="button" data-bside="over" class="on">Over</button><button type="button" data-bside="under">Under</button></div></div>
            <div class="bet-row"><label for="bet-line">The line</label><input class="bet-in sm" id="bet-line" inputmode="decimal" autocomplete="off" placeholder="100.5"></div>
          </div>
          <div class="bet-more" data-for="other" hidden><label class="bet-lab" for="bet-note">The bet</label><input class="bet-in" id="bet-note" maxlength="120" autocomplete="off" placeholder="Allen outscores Burrow"></div>
          <label class="bet-lab" for="bet-stake">Stake</label>
          <input class="bet-in" id="bet-stake" maxlength="40" autocomplete="off" placeholder="$20, a beer, loser's team name for a week">
          <p class="bet-note">The site keeps score; it never moves money. Nothing is on until ${esc(to)} takes it.</p>
          <button type="button" class="bet-send" id="bet-send">Send to ${esc(to)}</button>
          <div class="bet-msg" id="bet-msg" role="status"></div>
        </div>
      </div>`);
    const sheet = document.getElementById('bet-sheet');
    document.getElementById('bet-scrim').addEventListener('click', close);
    sheet.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    sheet.addEventListener('click', async e => {
      const k = e.target.closest('[data-bk]');
      if (k) {
        kind = k.dataset.bk;
        sheet.querySelectorAll('[data-bk]').forEach(b => { const on = b === k; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
        sheet.querySelectorAll('[data-for]').forEach(x => { x.hidden = x.dataset.for !== kind; });
        return;
      }
      const sb = e.target.closest('[data-bs]');
      if (sb) { subject = sb.dataset.bs; sheet.querySelectorAll('[data-bs]').forEach(b => b.classList.toggle('on', b === sb)); return; }
      const sd = e.target.closest('[data-bside]');
      if (sd) { side = sd.dataset.bside; sheet.querySelectorAll('[data-bside]').forEach(b => b.classList.toggle('on', b === sd)); return; }
      const send = e.target.closest('#bet-send');
      if (!send) return;
      const msg = document.getElementById('bet-msg');
      const body = { kind, to, stake: document.getElementById('bet-stake').value.trim() };
      if (!body.stake) { msg.textContent = ERR.no_stake; return; }
      if (kind === 'ou') Object.assign(body, { subject, side, line: Number(String(document.getElementById('bet-line').value).replace(',', '.')) });
      if (kind === 'other') body.note = document.getElementById('bet-note').value.trim();
      send.disabled = true;
      const { ok, j } = await post('/bets', body);
      if (!ok) { send.disabled = false; msg.textContent = ERR[j.error] || 'Couldn’t send it. Try again.'; return; }
      close();
      changed();
      if (typeof playToast === 'function') playToast(`<span>Sent to ${esc(to)}. Nothing's on until it's taken.</span>`);
    });
    sheet.focus({ preventScroll: true });
  }

  // ---------- Live: what needs you, and this week's bets ----------
  function row(b, me) {
    const other = b.a === me ? b.b : b.a, o = outcome(b, me);
    let act = '';
    if (b.status === 'offered' && b.b === me) act = `<div class="bt-act"><button type="button" class="bt-yes" data-bt="accept" data-id="${esc(b.id)}">Take it</button><button type="button" class="bt-no" data-bt="decline" data-id="${esc(b.id)}">Pass</button></div>`;
    else if (b.status === 'offered') act = `<div class="bt-act"><button type="button" class="bt-no" data-bt="cancel" data-id="${esc(b.id)}">Take it back</button></div>`;
    else if (b.status === 'accepted' && b.kind === 'other') act = `<div class="bt-act"><button type="button" class="bt-no" data-bt="settle" data-w="${esc(me)}" data-id="${esc(b.id)}">I won</button><button type="button" class="bt-no" data-bt="settle" data-w="${esc(other)}" data-id="${esc(b.id)}">${esc(other)} won</button></div>`;
    const say = b.status === 'offered' ? (b.b === me ? `${esc(b.a)} offered it` : `Waiting on ${esc(other)}`)
      : b.status === 'accepted' ? (b.kind === 'other' ? 'On. Settle it when you know' : 'On. Settles from the final score')
        : `${o === 'won' ? `You won: ${esc(other)} owes you` : o === 'lost' ? `You lost: you owe ${esc(other)}` : 'A push'}${b.detail ? ` · ${esc(b.detail)}` : ''}`;
    return `<div class="bt-row${o ? ' ' + o : ''}"><div class="bt-t"><b>${esc(describe(b, me))}</b><small>${say}</small></div>${act}</div>`;
  }
  async function liveCard() {
    const s = await load();
    if (!s || !s.bets) return '';
    const now = Date.now();
    const list = s.bets.filter(b => b.status === 'offered' || b.status === 'accepted' || (b.status === 'settled' && now - b.updated < 2 * 864e5));
    if (!list.length) return '';
    const yours = list.filter(b => b.status === 'offered' && b.b === s.me).length;
    return `<div class="glass notice-card" id="bets-card"><div class="panel-title"><span>Side bets</span><span class="notice-chip">${yours ? `${yours} for you` : `Week ${esc(s.week)}`}</span></div>
      <div class="panel-body"><div class="bt-list">${list.map(b => row(b, s.me)).join('')}</div></div></div>`;
  }

  // ---------- The ledger, on your profile ----------
  async function ledger() {
    const s = await load();
    if (!s || !s.bets) return '';
    const me = s.me, live = s.bets.filter(b => b.status === 'offered' || b.status === 'accepted'), done = s.bets.filter(b => b.status === 'settled');
    let net = 0, any = false;
    const owed = [];
    done.forEach(b => {
      const o = outcome(b, me), m = money(b.stake), other = b.a === me ? b.b : b.a;
      if (o !== 'won' && o !== 'lost') return;
      if (m != null) { net += o === 'won' ? m : -m; any = true; } else owed.push(o === 'won' ? `${other} owes you: ${b.stake}` : `You owe ${other}: ${b.stake}`);
    });
    const chip = any ? `${net >= 0 ? '+' : '−'}$${Math.abs(Math.round(net * 100) / 100)}` : done.length ? `${done.length} settled` : 'None yet';
    const body = !live.length && !done.length
      ? '<div class="bt-empty">No side bets yet. Offer one from your matchup’s ⋯ on Live, or by tapping a manager’s name.</div>'
      : `${live.length ? `<div class="bt-cap">Open</div><div class="bt-list">${live.map(b => row(b, me)).join('')}</div>` : ''}
         ${done.length ? `<div class="bt-cap">Settled</div><div class="bt-list">${done.slice(0, 20).map(b => row(b, me)).join('')}</div>` : ''}
         ${owed.length ? `<div class="bt-owed">${owed.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}`;
    return { chip, body };
  }

  // Take it / Pass / Take it back / who won, wherever a list is drawn.
  document.addEventListener('click', async e => {
    const a = e.target.closest('[data-bt]');
    if (!a) return;
    a.disabled = true;
    const id = a.dataset.id, what = a.dataset.bt;
    const res = what === 'accept' || what === 'decline' ? await post('/bets/answer', { id, accept: what === 'accept' })
      : what === 'cancel' ? await post('/bets/cancel', { id }) : await post('/bets/settle', { id, winner: a.dataset.w });
    if (!res.ok) { a.disabled = false; return; }
    changed();
  });
  return { load, open, liveCard, ledger, describe };
})();
