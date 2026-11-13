// Live (index.html)'s own script, moved out of the page (audit X #25) so a
// phone keeps it between visits; bump ?v= in index.html when this changes.
  // This Worker fetches ESPN directly and caches the computed result in KV
  // (see the retirement-league-refresh-proxy repo/src/index.js) — no more
  // Google Sheet or GitHub Action in the loop for this page. A GET here
  // either returns data cached within the last 15 seconds instantly, or
  // fetches fresh from ESPN, caches it, and returns that.
  const WORKER_URL = 'https://retirement-league-refresh-proxy.bradbutcher321.workers.dev';

  function fmtScore(n) {
    const num = parseFloat(n);
    return isNaN(num) ? n : num.toFixed(2);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function fmtOdds(o) {
    if (o === null || o === undefined) return '—';
    const n = Math.round(o);
    return (n > 0 ? '+' : '') + n.toLocaleString();
  }
  const PARLAY_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtKickoff(iso) {
    if (!iso) return 'TBD';
    const d = new Date(iso);
    const h = d.getHours();
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${PARLAY_DAYS[d.getDay()]} ${h % 12 || 12}:${mins} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // Which matchups are currently expanded, keyed by team-name pair rather
  // than array index so expansion survives the list re-sorting finals to
  // the bottom, or the whole innerHTML being rebuilt on the next poll.
  const expandedMatchups = new Set();
  const matchupKey = (m) => m._key || `${m.awayName}::${m.homeName}`;
  // Your own matchup has you on the left every week (site audit VII #1):
  // ESPN's away/home order flips week to week, so a card with you at home is
  // drawn from a copy with the sides swapped. The copy keeps ESPN's key, so
  // the ⋯ sheet, open rosters and Flow still find the game.
  function meLeft(m) {
    if (!m || m._key || !isMe(m.homeManager)) return m;
    const s = { _key: matchupKey(m) };
    Object.keys(m).forEach(k => { s[/^away/.test(k) ? 'home' + k.slice(4) : /^home/.test(k) ? 'away' + k.slice(4) : k] = m[k]; });
    return s;
  }

  // Four states a starter's real NFL game can be in: hasn't kicked off
  // yet, in progress, in progress AND their team has the ball (the single
  // highest-attention moment), or over. Drives the roster cell's outline
  // and the card's starter pips via .mu-pc.* / .mu-pip.* -- colors live in CSS.
  function playerState(p) {
    if (p && !p.game && p.done) return 'final'; // a past season: no game line, all over
    if (!p || !p.game) return null;
    if (p.game.state === 'pre') return 'pre';
    if (p.game.state === 'post') return 'final';
    return p.game.hasPossession ? 'possession' : 'live';
  }

  // "J. Allen" -- the roster is two players to a row on a 430px phone, so
  // full first names clipped constantly. A D/ST's name ("Bears D/ST") is
  // left whole: its first word is the only part that identifies it.
  function shortName(p) {
    const parts = (p.name || '').split(' ');
    if (parts.length < 2 || p.slot === 'D/ST' || /D\/ST/.test(p.name)) return p.name || '';
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
  }

  // A starter's projection right now. ESPN serves each player's pregame
  // projection and never moves it (only the team total moves), so a game in
  // progress is projected here the way Average mode does it (shareLeft() in
  // worker/src/dashboard.js): points so far plus the pregame projection for
  // the share of the game still to play. On live games this lands within about
  // half a point of ESPN's own team projection. Not started, finished, or
  // without a projection, it is the pregame number, untouched -- a finished
  // player's card compares his points to that, so it has to survive.
  // dir: 'up' / 'down' when a live projection has drifted off the pregame one.
  function liveProj(p) {
    const orig = p && p.projectedPoints;
    if (orig === null || orig === undefined) return null;
    const state = playerState(p);
    if (state !== 'live' && state !== 'possession') return { now: orig, orig, live: false, dir: '' };
    const g = p.game;
    const [m, s] = String(g.clock || '0:00').split(':').map(x => parseInt(x, 10) || 0);
    const left = g.period > 4 ? 0 : g.period < 1 ? 1 : Math.min(1, Math.max(0, ((4 - g.period) * 15 + m + s / 60) / 60));
    const now = (p.livePoints || 0) + orig * left;
    return { now, orig, live: true, dir: now - orig > 0.05 ? 'up' : now - orig < -0.05 ? 'down' : '' };
  }

  // mu-n is shown on a narrow (phone) card, mu-w on a wide (desktop) one.
  function playerGameLine(p, state) {
    const g = p.game;
    if (!g) return '';
    if (state === 'pre') {
      const kickoff = g.date ? new Date(g.date) : null;
      if (!kickoff) return `vs ${g.opponent}`;
      const day = kickoff.toLocaleDateString([], { weekday: 'short' });
      const time = kickoff.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `vs ${g.opponent} · ${day} <span class="mu-n">${time.replace(/\s?PM$/i, '')}</span><span class="mu-w">${time}</span>`;
    }
    const score = `${g.teamScore}–${g.opponentScore}`;
    if (state === 'final') return `Final · ${score}<span class="mu-w"> vs ${g.opponent}</span>`;
    const period = g.period > 4 ? 'OT' : `Q${g.period}`;
    const mark = state === 'possession' ? '<span class="ball"></span>' : '<span class="ldot"></span>';
    return `${mark}<span class="clk">${period} ${g.clock}</span> · ${score}<span class="mu-w"> vs ${g.opponent}</span>`;
  }

  function renderPlayerCell(p, side, state) {
    if (!p) return `<div class="mu-pc ${side}"></div>`;
    const hasLiveScore = p.livePoints !== null && p.livePoints !== undefined;
    const proTeam = (p.game && p.game.team) || p.team;
    const teamTag = proTeam ? `<span class="team-tag">${esc(proTeam)}</span>` : '';
    // Once the game is over the pre-game projection stops being the useful
    // number — how far the player beat or missed it is. ESPN keeps serving
    // the original projection after the final whistle, so this delta stays
    // meaningful rather than collapsing to zero.
    const delta = state === 'final' && hasLiveScore && p.projectedPoints !== null && p.projectedPoints !== undefined
      ? p.livePoints - p.projectedPoints
      : null;
    // While his game is on, the number is his projection as of now, green or
    // red against the pregame one (see liveProj); before kickoff it is the
    // pregame one.
    const lp = liveProj(p);
    const scoreSub = !lp ? ''
      : delta !== null
      ? `<div class="mu-sub ${delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : ''}" title="Projected ${fmtScore(p.projectedPoints)}">${delta >= 0 ? '▲' : '▼'} ${fmtScore(Math.abs(delta))}</div>`
      : lp.live
      ? `<div class="mu-sub ${lp.dir}" title="Pregame projection ${fmtScore(lp.orig)}">${fmtScore(lp.now)}</div>`
      : `<div class="mu-sub">${fmtScore(lp.now)}</div>`;
    return `
      <div class="mu-pc ${side} ${state || ''}${p.id && p.id === plOpenId ? ' pl-on' : ''}" data-pn="${encodeURIComponent(p.name || '')}"${p.id ? ` data-pid="${p.id}" role="button" tabindex="0" aria-label="${esc(p.name || '')}: game log"` : ''}>
        <div class="mu-pinfo">
          <div class="player-name"><span class="name-text">${shortName(p)}</span>${teamTag}</div>
          <div class="mu-gline">${playerGameLine(p, state)}</div>
          ${p.statLine ? `<div class="mu-sline">${p.statLine}</div>` : ''}
        </div>
        <div class="mu-pscore">
          <div class="mu-pts ${hasLiveScore ? '' : 'none'}">${hasLiveScore ? fmtScore(p.livePoints) : '–'}</div>
          ${scoreSub}
        </div>
      </div>`;
  }

  function renderMatchupDetails(m, top = '') {
    const awayPlayers = m.awayPlayers || [];
    const homePlayers = m.homePlayers || [];
    const rowCount = Math.max(awayPlayers.length, homePlayers.length);
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const a = awayPlayers[i];
      const h = homePlayers[i];
      rows.push(`
        <div class="mu-row">
          ${renderPlayerCell(a, 'away', playerState(a))}
          <span class="mu-slot">${(a && a.slot) || (h && h.slot) || ''}</span>
          ${renderPlayerCell(h, 'home', playerState(h))}
        </div>`);
    }
    return `<div class="matchup-details"><div class="mu-det-in"><div class="mu-det-body">${top}${rows.join('')}</div></div></div>`;
  }

  // A matchup is decided (FINAL, sinks to the bottom) once nobody is left to
  // play on either side, or once a team with no players left is already behind
  // its opponent's current score: the opponent's score can only go up, so the
  // finished team can't catch back up. The second case needs the NFL game
  // states to be readable; otherwise a team with "0 left" might just be missing data.
  function matchupDecided(m) {
    const hIn = parseInt(m.homeInPlay, 10) || 0, aIn = parseInt(m.awayInPlay, 10) || 0;
    const hRem = parseInt(m.homeRemaining, 10) || 0, aRem = parseInt(m.awayRemaining, 10) || 0;
    if (hIn + aIn + hRem + aRem === 0) return true;
    if (!medianStatusKnown) return false;
    const hs = parseFloat(m.homeScore), as = parseFloat(m.awayScore);
    return (hIn + hRem === 0 && hs < as) || (aIn + aRem === 0 && as < hs);
  }

  // The round ⋯ on every card (audit V #8, #15): Share a picture, Open in
  // ESPN, Head to Head, in a sheet (a centred card on desktop).
  const MU_MORE = '<button type="button" class="mu-more" data-more data-noshot aria-label="More: share, ESPN, head to head" aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg></button>';
  // A manager's team logo (Franchise's), or their monogram until it's known.
  const mgrLogo = name => {
    const p = name && franchiseData && franchiseData.players.find(x => x.name === name);
    return (p && p.current_team_logo) || '';
  };
  const muLogoHtml = name => {
    if (!name) return '';
    const url = mgrLogo(name);
    return `<span class="mu-lg" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : esc(monogram(name))}</span>`;
  };
  // Every manager's record and streak once this week counts. The streak
  // counts the median game too, as ESPN's does; when the two games split,
  // their order isn't known, so the streak is left off.
  let muAfterFor = null, muAfterMap = null;
  function muAfter(m) {
    if (muAfterFor !== shownData) {
      muAfterFor = shownData;
      muAfterMap = {};
      const table = standingsAfter(shownData);
      const median = shownData.medianGames === false ? null : shownData.currentMedian;
      (shownData.matchups || []).forEach(x => {
        [[x.awayManager, x.awayStreak, +x.awayScore, +x.homeScore], [x.homeManager, x.homeStreak, +x.homeScore, +x.awayScore]].forEach(([mgr, stk, own, opp]) => {
          const row = mgr && table.get(mgr);
          if (!row) return;
          const res = [own > opp ? 'W' : 'L'].concat(typeof median === 'number' ? [own > median ? 'W' : 'L'] : []);
          let streak = null;
          if (own !== opp && res.every(r => r === res[0])) {
            const k = res[0], n = stk && stk[0] === k ? parseInt(stk.slice(1), 10) || 0 : 0;
            streak = k + (n + res.length);
          }
          muAfterMap[mgr] = { rec: row.rec, streak };
        });
      });
    }
    return muAfterMap;
  }

  function renderMatchupCard(m) {
    m = meLeft(m);
    const awayScore = parseFloat(m.awayScore) || 0;
    const homeScore = parseFloat(m.homeScore) || 0;
    const homeInPlay = parseInt(m.homeInPlay, 10) || 0;
    const awayInPlay = parseInt(m.awayInPlay, 10) || 0;
    const homeRemaining = parseInt(m.homeRemaining, 10) || 0;
    const awayRemaining = parseInt(m.awayRemaining, 10) || 0;
    const isFinal = matchupDecided(m);
    const isLive = !isFinal && homeInPlay + awayInPlay > 0;

    // Live, the trailing score steps back; decided, the winner goes gold.
    const scoreClass = (mine, theirs) => isFinal
      ? (mine > theirs ? 'won' : mine < theirs ? 'lost' : '')
      : (mine < theirs ? 'trail' : '');

    // Managers lead, teams follow (audit V #8): the line under the name is
    // record · streak · team. Once the whole week is over (#9) the record
    // and streak already count this week, as Standings' final view does.
    const after = weekFinal ? muAfter(m) : null;
    const metaParts = (manager, record, streak, team) => {
      const a = after && manager && after[manager];
      if (a) { record = a.rec; streak = a.streak; }
      return [
        record ? `<span>${record}</span>` : '',
        streak ? `<span class="mu-stk ${streak[0] === 'W' ? 'win' : 'loss'}">${streak}</span>` : '',
        manager && team ? `<span>${esc(team)}</span>` : '',
      ].filter(Boolean);
    };

    // Once decided, the live projection has nothing left to say, so its line
    // reports how the team did against its starters' pregame projection
    // instead (ESPN's per-player projection, which stays put after kickoff,
    // summed). The line is always rendered -- even blank, if there are no
    // projections to sum -- so a decided card keeps a live card's height.
    const vsProj = (players, score) => {
      const proj = players.reduce((sum, p) => sum + (p.projectedPoints || 0), 0);
      if (!proj) return '<div class="mu-proj">&nbsp;</div>';
      const diff = Math.round((score - proj) * 100) / 100;
      const tone = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
      const arrow = diff ? `<svg class="mu-arrow" viewBox="0 0 10 8" aria-hidden="true"><path d="${diff > 0 ? 'M5 0L10 8H0Z' : 'M0 0H10L5 8Z'}" fill="currentColor"/></svg>` : '';
      return `<div class="mu-proj vs ${tone}" title="Projected ${fmtScore(proj)} before kickoff">${arrow}${fmtScore(Math.abs(diff))} <span>vs proj</span></div>`;
    };

    const side = (cls, name, manager, meta, score, theirScore, projected, players) => `
      <div class="mu-side ${cls}">
        <div class="mu-who">${muLogoHtml(manager)}<span class="team-name">${esc(manager || name)}</span></div>
        <div class="mu-meta">${meta.join(' · ')}</div>
        <div class="mu-score ${scoreClass(score, theirScore)}"><span class="mu-val">${fmtScore(score)}</span></div>
        ${isFinal ? vsProj(players, score) : `<div class="mu-proj">proj ${fmtScore(projected)}</div>`}
      </div>`;

    // Win-odds meter while undecided; once decided, the winning margin.
    const awayWP = typeof m.awayWinProbability === 'number' ? m.awayWinProbability
      : typeof m.homeWinProbability === 'number' ? 100 - m.homeWinProbability : null;
    let oddsRow = '';
    if (isFinal) {
      const winner = awayScore > homeScore ? (m.awayManager || m.awayName) : homeScore > awayScore ? (m.homeManager || m.homeName) : null;
      // A past season's playoff games say which game they were.
      const tag = m.label ? `<b class="mu-label">${esc(m.label)}</b> · ` : '';
      const said = winner ? `${tag}${esc(winner)} by ${fmtScore(Math.abs(awayScore - homeScore))}` : `${tag}Tied`;
      oddsRow = `<div class="mu-margin">${said}${MU_MORE}</div>`;
    } else if (awayWP !== null) {
      const a = Math.max(1, Math.min(99, Math.round(awayWP)));
      const h = 100 - a;
      const awayFav = a >= 50;
      oddsRow = `
        <div class="mu-odds">
          <span class="${awayFav ? 'fav' : ''}">${a}%</span>
          <div class="mu-bar" role="img" aria-label="Win odds ${a}% to ${h}%"><span class="${awayFav ? 'fav' : ''}" style="flex-grow:${a}"></span><span class="${awayFav ? '' : 'fav'}" style="flex-grow:${h}"></span></div>
          <span class="${awayFav ? '' : 'fav'}">${h}%</span>
          ${MU_MORE}
        </div>`;
    } else {
      oddsRow = `<div class="mu-margin">${MU_MORE}</div>`;
    }

    // What the trailing team has to do (audit IV #13): the points that pass
    // the other score (a tie isn't a win, hence the extra cent), spread over
    // the starters it has left, next to what its projection still expects.
    // Only while the game is undecided and that team has someone left.
    let needRow = '';
    if (!isFinal && awayScore !== homeScore && awayScore + homeScore > 0) {
      const awayBehind = awayScore < homeScore;
      const left = awayBehind ? awayInPlay + awayRemaining : homeInPlay + homeRemaining;
      const leaderLeft = awayBehind ? homeInPlay + homeRemaining : awayInPlay + awayRemaining;
      // Early on it only restates the score (audit X #8): wait until the
      // trailing team is down to four players, or the leader is done.
      if (left > 0 && (left <= 4 || leaderLeft === 0)) {
        const mgr = awayBehind ? m.awayManager : m.homeManager;
        const gap = Math.abs(awayScore - homeScore) + 0.01;
        const proj = parseFloat(awayBehind ? m.awayProjected : m.homeProjected);
        const toGo = Number.isFinite(proj) ? Math.max(0, proj - (awayBehind ? awayScore : homeScore)) : null;
        const who = isMe(mgr) ? 'You need' : `${esc(mgr || (awayBehind ? m.awayName : m.homeName))} needs`;
        // One player left reads as that player ("from J. Allen"), not
        // "from 1 · about 6.45 each"; more than one gets the per-player split.
        let from;
        if (left === 1) {
          const lastOne = ((awayBehind ? m.awayPlayers : m.homePlayers) || []).filter(p => { const st = playerState(p); return st && st !== 'final'; });
          from = `from ${lastOne.length === 1 ? esc(shortName(lastOne[0])) : 'the last player'}${toGo === null ? '' : ` · projected ${fmtScore(toGo)}`}`;
        } else {
          from = `from ${left} players · ${fmtScore(gap / left)} each${toGo === null ? '' : ` · projected ${fmtScore(toGo)} combined`}`;
        }
        needRow = `<div class="mu-need ${awayBehind ? 'away' : 'home'}"><b>${who} ${fmtScore(gap)}</b> ${from}</div>`;
      }
    }

    const pips = (players, inPlay, remaining, cls) => {
      const bits = [];
      if (inPlay) bits.push(`<span class="n-live">${inPlay} live</span>`);
      if (remaining) bits.push(`${remaining} to play`);
      return `
        <div class="mu-pips-wrap ${cls}">
          <div class="mu-pips">${players.map(p => {
            const st = playerState(p);
            return `<span class="mu-pip ${st && st !== 'pre' ? st : ''}"></span>`;
          }).join('')}</div>
          ${bits.length ? `<span class="mu-pip-text">${bits.join(' · ')}</span>` : ''}
        </div>`;
    };

    const chev = '<span class="chev" aria-hidden="true"></span>';
    const status = isFinal ? `<span class="mu-status final">Final${chev}</span>`
      : isLive ? `<span class="mu-status live"><span class="pulse-dot"></span>Live${chev}</span>`
      : `<span class="mu-status">VS${chev}</span>`;

    const key = matchupKey(m);
    const expanded = expandedMatchups.has(key);
    const mine = isMe(m.awayManager) || isMe(m.homeManager);

    return `
      <div class="matchup-card${expanded ? ' expanded' : ''}${mine ? ' me' : ''}${isFinal ? ' done' : ''}" data-key="${encodeURIComponent(key)}">
        ${isFinal ? playoffTag(m) : cardTagHtml(m)}
        <div class="mu-head">
          ${side('away', m.awayName, m.awayManager, metaParts(m.awayManager, m.awayRecord, m.awayStreak, m.awayName), awayScore, homeScore, m.awayProjected, m.awayPlayers || [])}
          ${isFinal ? `<div class="mu-mid">${status}</div>` : ''}
          ${side('home', m.homeName, m.homeManager, metaParts(m.homeManager, m.homeRecord, m.homeStreak, m.homeName), homeScore, awayScore, m.homeProjected, m.homePlayers || [])}
        </div>
        ${oddsRow}
        ${needRow}
        ${mine && !isFinal ? onLineHtml(m) : ''}
        ${isFinal ? '' : `<div class="mu-foot">
          ${pips(m.awayPlayers || [], awayInPlay, awayRemaining, 'away')}
          ${status}
          ${pips(m.homePlayers || [], homeInPlay, homeRemaining, 'home')}
        </div>`}
        ${mine ? lineupHtml(m) : ''}
        ${recordHtml(m)}
        ${seriesHtml(m)}
        ${renderMatchupDetails(m, flowHtml(m))}
      </div>`;
  }
  // ---------- Before kickoff (site audit VI #7, #8) ----------
  // From the Tuesday rollover to the week's first kickoff every card read
  // 0.00 to 0.00. A matchup is pregame while none of its starters' games has
  // started (and nobody has a point). Yours becomes a preview at the top of
  // the page; the rest fold into a projected scoreboard, and each turns back
  // into its full card at its own first kickoff.
  function matchupPregame(m) {
    if (!medianStatusKnown || (parseFloat(m.awayScore) || 0) + (parseFloat(m.homeScore) || 0) > 0) return false;
    const ps = [...(m.awayPlayers || []), ...(m.homePlayers || [])];
    return ps.length > 0 && ps.every(p => !p.game || p.game.state === 'pre');
  }
  // Started but nobody on the field right now (audit X #7): a Thursday
  // player made it a full card of zeros until Sunday. It stays one line
  // until one of its games is on again; a tap opens it.
  function matchupWaiting(m) {
    if (matchupPregame(m) || matchupDecided(m)) return false;
    return (parseInt(m.awayInPlay, 10) || 0) + (parseInt(m.homeInPlay, 10) || 0) === 0;
  }
  const ET_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  function etKick(iso) {
    const p = {};
    ET_PARTS.formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
    return { day: p.weekday, time: `${p.hour}:${p.minute}`, ap: (p.dayPeriod || '').toLowerCase().slice(0, 1) };
  }
  // The chance a score with this projection clears `line`, with the playoff
  // sim's spread (race-sim.js, SD 22).
  function chanceOver(proj, line) {
    const x = (proj - line) / (22 * Math.SQRT2), s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return 50 * (1 + s * erf);
  }
  const lastName = n => { const p = String(n || '').replace(/ (Jr\.|Sr\.|II|III|IV)$/, '').split(' '); return /D\/ST/.test(n) ? p[0] : p.length > 1 ? p.slice(1).join(' ') : n; };
  const PRE_POS = ['QB', 'RB', 'WR', 'TE', 'FLEX'];
  function renderPreviewCard(m) {
    m = meLeft(m);
    const A = m.awayPlayers || [], B = m.homePlayers || [];
    const meHome = isMe(m.homeManager);
    const nameOf = (mgr, team) => esc(mgr || team);
    const aProj = parseFloat(m.awayProjected) || 0, bProj = parseFloat(m.homeProjected) || 0;
    const kicks = [...A, ...B].map(p => p.game && p.game.date).filter(Boolean).sort();
    const first = kicks[0] ? etKick(kicks[0]) : null;
    const awayWP = typeof m.awayWinProbability === 'number' ? m.awayWinProbability : typeof m.homeWinProbability === 'number' ? 100 - m.homeWinProbability : 50;
    const wa = Math.max(1, Math.min(99, Math.round(awayWP))), wb = 100 - wa, aFav = wa >= 50;
    const meta = (rec, stk, team) => [rec ? `<span>${rec}</span>` : '', stk ? `<span class="mu-stk ${stk[0] === 'W' ? 'win' : 'loss'}">${stk}</span>` : '', team ? `<span>${esc(team)}</span>` : ''].filter(Boolean).join(' · ');
    const side = (cls, mgr, team, rec, stk, proj, fav) => `<div class="pre-s ${cls}">
        <div class="mu-who">${muLogoHtml(mgr)}<span class="team-name">${nameOf(mgr, team)}</span></div>
        <div class="mu-meta">${meta(rec, stk, team)}</div>
        <div class="pre-v${fav ? ' fav' : ''}">${cls === 'home' ? '<small>PROJ</small>' : ''}${fmtScore(proj)}${cls === 'away' ? '<small>PROJ</small>' : ''}</div></div>`;
    // Your two games: the one against your opponent, and the one against the median.
    const meProj = meHome ? bProj : aProj, oppProj = meHome ? aProj : bProj;
    const meWP = meHome ? wb : wa, opp = meHome ? (m.awayManager || m.awayName) : (m.homeManager || m.homeName);
    const med = shownData && shownData.medianGames !== false && typeof shownData.projectedMedian === 'number' && shownData.projectedMedian > 0 ? shownData.projectedMedian : null;
    const gap = meProj - oppProj;
    const two = `<div class="pre-two">
        <div class="item"><div class="k">Your game vs ${esc(opp)}</div><div class="v${meWP >= 50 ? ' good' : ''}">${meWP}%</div><div class="s">${Math.abs(gap) < 0.005 ? 'Even on projection' : `${fmtScore(Math.abs(gap))} ${gap > 0 ? 'ahead' : 'behind'} on projection`}</div></div>
        ${med ? (() => { const p = Math.round(chanceOver(meProj, med)); return `<div class="item"><div class="k">Your median game</div><div class="v${p >= 50 ? ' good' : ''}">${p}%</div><div class="s">Projected median ${fmtScore(med)}</div></div>`; })() : ''}
      </div>`;
    const labels = [meHome ? esc(m.awayManager || m.awayName) : 'You', meHome ? 'You' : esc(m.homeManager || m.homeName)];
    // Kickoffs: who plays when, both sides.
    const win = new Map();
    [[A, 'a'], [B, 'b']].forEach(([ps, s]) => ps.forEach(p => { if (!p.game || !p.game.date) return; const k = p.game.date; if (!win.has(k)) win.set(k, { a: [], b: [] }); win.get(k)[s].push(p); }));
    const ppl = (ps, mine) => `<div class="pre-ppl${mine ? ' mine' : ''}">${ps.map(p => `<em${p.game ? '' : ' class="z"'}>${esc(lastName(p.name))}</em>`).join('')}</div>`;
    const lanes = [...win.keys()].sort().map(k => {
      const t = etKick(k), w = win.get(k), n = w.a.length + w.b.length;
      return `<div class="pre-lane">${ppl(w.a, !meHome)}<div class="pre-when">${t.day} ${t.time.replace(':00', '')}${t.ap}<small>${n} starter${n === 1 ? '' : 's'}</small></div>${ppl(w.b, meHome)}</div>`;
    }).join('') + (() => {
      // Starters with no game this week, struck through (audit VIII #5).
      const ba = A.filter(p => !p.game), bb = B.filter(p => !p.game);
      return ba.length || bb.length ? `<div class="pre-lane">${ppl(ba, !meHome)}<div class="pre-when">Bye<small>0 projected</small></div>${ppl(bb, meHome)}</div>` : '';
    })();
    // Projected by position.
    const sum = (ps, s) => ps.filter(p => p.slot === s).reduce((t, p) => t + (p.projectedPoints || 0), 0);
    const edge = PRE_POS.map(s => ({ s, a: sum(A, s), b: sum(B, s) })).filter(e => e.a || e.b);
    const maxE = Math.max(1, ...edge.map(e => Math.max(e.a, e.b)));
    const edgeHtml = edge.map(e => `<div class="pre-edge"><span class="n">${e.a.toFixed(1)}</span><div class="bl"><span class="${e.a > e.b ? 'win' : ''}" style="width:${(e.a / maxE * 100).toFixed(0)}%"></span></div><span class="p">${e.s}</span><div class="br"><span class="${e.b > e.a ? 'win' : ''}" style="width:${(e.b / maxE * 100).toFixed(0)}%"></span></div><span class="n r">${e.b.toFixed(1)}</span></div>`).join('');
    // The same NFL game on both sides: the one to put on.
    const gk = p => p.game && p.game.team && p.game.opponent ? [p.game.team, p.game.opponent].sort().join('–') : null;
    const same = new Map();
    A.forEach(p => { const k = gk(p); if (k) { if (!same.has(k)) same.set(k, { a: [], b: [], date: p.game.date }); same.get(k).a.push(p); } });
    B.forEach(p => { const k = gk(p); if (k && same.has(k)) same.get(k).b.push(p); });
    const sameRows = [...same.entries()].filter(([, v]) => v.b.length).sort((x, y) => String(x[1].date).localeCompare(String(y[1].date)));
    const sameHtml = sameRows.map(([k, v]) => `<div class="pre-same"><span class="${meHome ? '' : 'mine'}">${v.a.map(p => esc(p.name)).join(', ')}</span><b>${esc(k)}</b><span class="r${meHome ? ' mine' : ''}">${v.b.map(p => esc(p.name)).join(', ')}</span></div>`).join('');
    const key = matchupKey(m);
    const expanded = expandedMatchups.has(key);
    return `
      <div class="matchup-card pre-card me${expanded ? ' expanded' : ''}" data-key="${encodeURIComponent(key)}">
        ${cardTagHtml(m)}
        <div class="pre-h">
          ${side('away', m.awayManager, m.awayName, m.awayRecord, m.awayStreak, aProj, aProj >= bProj)}
          <div class="pre-mid">${first ? `<span class="pre-ko">${first.day}<b>${first.time}${first.ap}</b></span>` : ''}</div>
          ${side('home', m.homeManager, m.homeName, m.homeRecord, m.homeStreak, bProj, bProj > aProj)}
        </div>
        <div class="mu-odds">
          <span class="${aFav ? 'fav' : ''}">${wa}%</span>
          <div class="mu-bar" role="img" aria-label="Win odds ${wa}% to ${wb}%"><span class="${aFav ? 'fav' : ''}" style="flex-grow:${wa}"></span><span class="${aFav ? '' : 'fav'}" style="flex-grow:${wb}"></span></div>
          <span class="${aFav ? '' : 'fav'}">${wb}%</span>
          ${MU_MORE}
        </div>
        <div class="pre-body">
          ${two}
          ${stakesNow && onLineHtml(m) ? onLineHtml(m) : `<div class="pre-worth" data-worth${rootNow && rootNow.me ? '' : ' hidden'}>${worthHtml(rootNow)}</div>`}
          ${preTabsHtml([
            ['k', 'Kickoffs', lanes ? `<div class="pre-bt"><span>${labels[0]}</span><span></span><span>${labels[1]}</span></div>${lanes}` : ''],
            ['p', 'Positions', edgeHtml ? `<div class="pre-bt"><span>${labels[0]}</span><span></span><span>${labels[1]}</span></div>${edgeHtml}` : ''],
            ['s', `Same game · ${sameRows.length}`, sameHtml],
          ])}
        </div>
        ${lineupHtml(m)}
        ${seriesHtml(m)}
        ${renderMatchupDetails(m)}
      </div>`;
  }
  // Kickoffs, Positions and Same game behind one switch (audit VIII #5), the
  // choice kept on this phone. The tap is handled in onMatchupClick.
  const PRE_TAB = 'rl-pre-tab';
  function preTabsHtml(tabs) {
    tabs = tabs.filter(t => t[2]);
    if (!tabs.length) return '';
    let sel = '';
    try { sel = localStorage.getItem(PRE_TAB) || ''; } catch (e) {}
    if (!tabs.some(t => t[0] === sel)) sel = tabs[0][0];
    return `<div class="pre-seg" role="tablist" aria-label="Show">${tabs.map(([k, l]) => `<button type="button" role="tab" data-pretab="${k}" class="${k === sel ? 'on' : ''}" aria-selected="${k === sel}">${esc(l)}</button>`).join('')}</div>
      ${tabs.map(([k, , html]) => `<div class="pre-blk" data-pane="${k}"${k === sel ? '' : ' hidden'}>${html}</div>`).join('')}`;
  }
  // The other matchups until their games are on (audit VI #8, X #7, XI #1):
  // one row each with the same number on both sides, the projection, and
  // any points already in underneath, so a side with Thursday's points never
  // sits beside a side's projection. A tap opens the full card under its
  // row, as the finished scoreboard does. With the week's stakes (audit XI
  // #16) each row says what rides on it for both teams.
  function boardHtml(list) {
    if (!list.length) return '';
    const top = gotwKey();
    return `<div class="sb psb glass">${list.map(m => {
      const key = matchupKey(m);
      const open = sbOpen.has(key);
      const as = parseFloat(m.awayScore) || 0, hs = parseFloat(m.homeScore) || 0;
      const ap = parseFloat(m.awayProjected) || 0, hp = parseFloat(m.homeProjected) || 0;
      const awp = typeof m.awayWinProbability === 'number' ? m.awayWinProbability : typeof m.homeWinProbability === 'number' ? 100 - m.homeWinProbability : 50;
      const wa = Math.max(1, Math.min(99, Math.round(awp))), wb = 100 - wa, fa = wa >= 50;
      const nm = (mgr, team) => `<span class="${isMe(mgr) ? 'you' : ''}">${esc(mgr || team)}</span>`;
      const root = mgr => `<b class="psb-root" data-root="${esc(mgr || '')}">${rootMark(rootNow, mgr)}</b>${holeTag(mgr === m.awayManager ? m.awayPlayers : m.homePlayers)}`;
      const pj = (p, sc, fav) => `<span class="pj${fav ? ' fav' : ''}">${fmtScore(p)}${sc > 0 ? `<small>${fmtScore(sc)} in</small>` : ''}</span>`;
      const say = (mgr, sc, p) => `${esc(mgr)} ${fmtScore(p)} projected${sc > 0 ? `, ${fmtScore(sc)} in` : ''}`;
      return `${pairKey(m) === top ? '<div class="psb-gotw">Game of the week</div>' : ''}<button type="button" class="sb-row psb-row" data-sb="${encodeURIComponent(key)}" aria-expanded="${open}" aria-label="${say(m.awayManager || m.awayName, as, ap)}, ${wa}%, against ${say(m.homeManager || m.homeName, hs, hp)}, ${wb}%">
          <span class="n">${muLogoHtml(m.awayManager)}${nm(m.awayManager, m.awayName)}${root(m.awayManager)}</span>
          ${pj(ap, as, ap >= hp)}
          <span class="mini"><span class="mu-bar"><span class="${fa ? 'fav' : ''}" style="flex-grow:${wa}"></span><span class="${fa ? '' : 'fav'}" style="flex-grow:${wb}"></span></span><small><span class="${fa ? 'fav' : ''}">${wa}%</span><span class="${fa ? '' : 'fav'}">${wb}%</span></small></span>
          ${pj(hp, hs, hp > ap)}
          <span class="n r">${nm(m.homeManager, m.homeName)}${muLogoHtml(m.homeManager)}${root(m.homeManager)}</span>
          ${stakeRowHtml(m)}
        </button>${open ? `<div class="sb-open">${renderMatchupCard(m)}</div>` : ''}`;
    }).join('')}<div class="psb-ft" data-root-all${rootAllHtml(rootNow, list) ? '' : ' hidden'}>${rootAllHtml(rootNow, list)}</div></div>`;
  }

  // ---------- What the week is worth (site audit VII #2, #3) ----------
  // The playoff sim (race-sim.js) asked a few more questions: your odds if
  // you win or lose this week, and for every other game this week, which
  // result helps you and by how much. One sim per question, each a short
  // task after the page has painted (about 150ms apiece), kept per payload
  // like RaceSim.apply's, so a poll with the same numbers costs nothing.
  const ROOT_STORE = 'rl-root-odds';
  // rootCur: the answer for the newest payload (filled in as its sims finish);
  // rootNow: the one the cards on the page were drawn with (null: none apply).
  let rootCur = null, rootNow = null;
  function rootFor(data, me) {
    const inp = data && !data.archived && me && typeof RaceSim !== 'undefined' ? RaceSim.inputs(data) : null;
    const wk = inp && inp.sched[0];
    if (!wk || wk.w !== inp.week) return null; // the week is over: nothing left to pick
    const mine = wk.pairs.find(p => p.includes(me));
    if (!mine) return null;
    const key = JSON.stringify([inp.base, inp.live, inp.sched, inp.week, inp.spots, me]);
    if (rootCur && rootCur.k === key) return rootCur;
    try { const c = JSON.parse(localStorage.getItem(ROOT_STORE) || 'null'); if (c && c.k === key) return (rootCur = c); } catch (e) {}
    const R = rootCur = { k: key, opp: mine[0] === me ? mine[1] : mine[0], me: null, games: [], allPo: null };
    const pk = (p, w) => ({ [wk.w + '|' + p[0] + '|' + p[1]]: w });
    const steps = [() => { const o = RaceSim.simulate(inp, RaceSim.RUNS, null, true)[me]; R.me = { po: o.po, ifWin: o.ifWin, ifLoss: o.ifLoss }; rootPaint(R); }];
    wk.pairs.filter(p => p !== mine).forEach(p => steps.push(() => {
      const [x, y] = p.map(w => RaceSim.simulate(inp, RaceSim.RUNS, pk(p, w))[me].po);
      R.games.push({ a: p[0], b: p[1], root: x >= y ? p[0] : p[1], swing: Math.abs(x - y) });
    }));
    steps.push(() => {
      R.allPo = RaceSim.simulate(inp, RaceSim.RUNS, Object.assign({}, ...R.games.map(g => pk([g.a, g.b], g.root))))[me].po;
      try { localStorage.setItem(ROOT_STORE, JSON.stringify(R)); } catch (e) {}
      rootPaint(R);
    });
    // A newer payload replaces the job; the first sim waits for the page to settle.
    const next = () => { if (rootCur !== R) return; steps.shift()(); if (steps.length) setTimeout(next, 0); };
    (window.requestIdleCallback || (f => setTimeout(f, 400)))(next, { timeout: 2000 });
    return R;
  }
  const wholePct = RaceSim.pct; // never 100% / 0% until settled (audit X #2)
  function worthHtml(R) {
    if (!R || !R.me) return '';
    const p = wholePct;
    return `<div class="k">Your playoff odds</div><div class="g3">
        <div><b>${p(R.me.po)}</b><span>Now</span></div>
        <div class="up"><b>${p(R.me.ifWin)}</b><span>Beat ${esc(R.opp)}</span></div>
        <div class="dn"><b>${p(R.me.ifLoss)}</b><span>Lose</span></div></div>`;
  }
  // Under the name to pull for, once the swing is worth saying (half a point).
  function rootMark(R, mgr) {
    const g = R && R.allPo != null && mgr && R.games.find(x => x.root === mgr);
    return g && g.swing >= 0.5 ? `Root +${g.swing.toFixed(1)}%` : '';
  }
  // The total, only while the board holds every other game of the week.
  const ROOT_N = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  function rootAllHtml(R, list) {
    if (!R || R.allPo == null || R.games.length < 2 || list.length !== R.games.length) return '';
    return `<span>All ${ROOT_N[R.games.length] || R.games.length} go your way</span><span><b>${wholePct(R.me.po)}</b> → <b class="up">${wholePct(R.allPo)}</b></span>`;
  }
  function rootPaint(R) {
    if (R !== rootNow) return;
    document.querySelectorAll('[data-worth]').forEach(el => { el.innerHTML = worthHtml(R); el.hidden = !el.innerHTML; });
    document.querySelectorAll('.psb-root[data-root]').forEach(el => { el.textContent = rootMark(R, el.dataset.root); });
    document.querySelectorAll('[data-root-all]').forEach(el => {
      const n = el.parentElement.querySelectorAll('.psb-row').length;
      el.innerHTML = rootAllHtml(R, { length: n });
      el.hidden = !el.innerHTML;
    });
  }

  // ---------- Stakes (site audit XI #16) ----------
  // What each game this week is worth: the playoff sim's odds for both teams
  // with a win and with a loss -- RaceSim's conditional run, the same numbers
  // as the preview card's and the Race tab's "riding on this week" -- for the
  // playoffs, a bye and the Sacko game. One sim covers all six games. Its key
  // is the records and the schedule, not the live scores, so it runs a few
  // times a week per phone, and Live redraws when it lands. The order of the
  // other matchups (most riding on it first) is set by the week's first run
  // and kept, so cards never reshuffle during the games.
  const STAKES_STORE = 'rl-stakes';
  let stakesNow = null, stakesJob = null;
  const STAKE_KINDS = [['po', 'Playoffs', 'w', 'l', 'now'], ['bye', 'Bye', 'wb', 'lb', 'bye'], ['sk', 'Sacko', 'ws', 'ls', 'sk']];
  const pairKey = m => [m.awayManager || m.awayName, m.homeManager || m.homeName].sort().join('|');
  function stakesFor(data) {
    const inp = data && !data.archived && !isPlayoffWeek(data) && typeof RaceSim !== 'undefined' ? RaceSim.inputs(data) : null;
    const wk = inp && inp.sched[0];
    if (!wk || wk.w !== inp.week) return null; // the week is over
    const year = data.year || leagueYear;
    const key = JSON.stringify([year, inp.week, inp.base, inp.sched, inp.spots]);
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(STAKES_STORE) || 'null'); } catch (e) {}
    const sameWeek = x => x && x.y === year && x.wk === inp.week;
    if (stakesNow && stakesNow.k === key) return stakesNow;
    if (cached && cached.k === key) return cached;
    if (stakesJob !== key) {
      stakesJob = key;
      (window.requestIdleCallback || (f => setTimeout(f, 400)))(() => {
        if (stakesJob !== key) return;
        stakesJob = null;
        const out = RaceSim.simulate(inp, RaceSim.RUNS, null, true);
        const t = {};
        Object.keys(out).forEach(mgr => {
          const o = out[mgr];
          t[mgr] = { now: o.po, bye: o.bye, sk: o.sacko, w: o.ifWin, l: o.ifLoss, wb: o.ifWinBye, lb: o.ifLossBye, ws: o.ifWinSacko, ls: o.ifLossSacko };
        });
        const S = { k: key, y: year, wk: inp.week, t, ord: null };
        const prev = sameWeek(stakesNow) ? stakesNow : sameWeek(cached) ? cached : null;
        S.ord = prev && prev.ord ? prev.ord : stakeOrder(S, data.matchups || []);
        try { localStorage.setItem(STAKES_STORE, JSON.stringify(S)); } catch (e) {}
        if (shownData === data || (shownData && !shownData.archived && (shownData.year || leagueYear) === year && shownData.week === inp.week)) {
          stakesNow = S;
          renderDashboard(shownData, false, true);
        }
      }, { timeout: 2500 });
    }
    // Until it lands, the week's last answer (same order, nearly the same numbers).
    return sameWeek(stakesNow) ? stakesNow : sameWeek(cached) ? cached : null;
  }
  // A team's biggest swing this week: [kind, label, with a win, with a loss, now, size].
  function stakeOf(mgr, S = stakesNow) {
    const o = S && mgr && S.t[mgr];
    if (!o) return null;
    return STAKE_KINDS.map(([k, label, w, l, now]) => [k, label, o[w], o[l], o[now]])
      .filter(x => typeof x[2] === 'number' && typeof x[3] === 'number')
      .map(x => [...x, Math.abs(x[2] - x[3])])
      .sort((x, y) => y[5] - x[5])[0] || null;
  }
  const stakeSize = (m, S) => { const a = stakeOf(m.awayManager || m.awayName, S), b = stakeOf(m.homeManager || m.homeName, S); return (a ? a[5] : 0) + (b ? b[5] : 0); };
  const stakeOrder = (S, ms) => ms.slice().sort((x, y) => stakeSize(y, S) - stakeSize(x, S)).map(pairKey);
  const stakeRank = m => { const i = stakesNow && stakesNow.ord ? stakesNow.ord.indexOf(pairKey(m)) : -1; return i < 0 ? 99 : i; };
  // The game of the week: the first in the week's order, if anything rides on it.
  function gotwKey() {
    const k = stakesNow && stakesNow.ord && stakesNow.ord[0];
    return k && Object.values(stakesNow.t).some(o => o) ? k : null;
  }
  // Under a board row: each team's biggest swing, under its own side.
  function stakeRowHtml(m) {
    if (!stakesNow) return '';
    const a = stakeOf(m.awayManager), b = stakeOf(m.homeManager);
    if (!a && !b) return '';
    const half = (x, cls) => `<span class="${cls}">${x && x[5] >= 1 ? `${x[1]} <b>${RaceSim.pct(x[2])}</b> win · ${RaceSim.pct(x[3])} loss` : 'Little riding on it'}</span>`;
    return `<span class="psb-stk">${half(a, '')}${half(b, 'r')}</span>`;
  }
  // On your own card: what rides on it for you (every swing of 3 points or
  // more, biggest first, at most two) and for the other side (its biggest).
  function onLineHtml(m) {
    if (!stakesNow) return '';
    const me = isMe(m.awayManager) ? m.awayManager : isMe(m.homeManager) ? m.homeManager : null;
    const o = me && stakesNow.t[me];
    if (!o || typeof o.w !== 'number') return '';
    const opp = me === m.awayManager ? m.homeManager : m.awayManager;
    const kinds = mgr => { const t = stakesNow.t[mgr]; return t ? STAKE_KINDS.map(([k, label, w, l, now]) => [label, t[now], t[w], t[l]]).filter(x => typeof x[2] === 'number' && typeof x[3] === 'number').map(x => [...x, Math.abs(x[2] - x[3])]).sort((x, y) => y[4] - x[4]) : []; };
    const mine = kinds(me).filter((x, i) => i === 0 || x[4] >= 3).slice(0, 2);
    const theirs = kinds(opp).slice(0, 1);
    const p = RaceSim.pct;
    const row = (who, x, tone) => `<span>${esc(who)} · ${x[0] === 'Sacko' ? 'Sacko' : x[0].toLowerCase()}</span><b>${p(x[1])}</b><b class="${tone ? 'up' : ''}">${p(x[2])}</b><b class="${tone ? 'dn' : ''}">${p(x[3])}</b>`;
    return `<div class="mu-line"><span class="h">On the line</span><span class="h">Now</span><span class="h">Win</span><span class="h">Loss</span>
      ${mine.map(x => row('You', x, true)).join('')}${theirs.map(x => row(opp, x, false)).join('')}</div>`;
  }

  // ---------- The playoffs on Live (site audit XI #17) ----------
  // The Worker names each playoff game (bracket: Play, Champ, 3rd, 5th,
  // Cons, Sacko) but doesn't flag the week, so a week past the regular
  // season is a playoff week. Every card says which game it is, a bracket
  // strip sits under the status line, and the status line says what a win
  // or a loss means for you. Seeds are the teams' standing (ESPN's playoff
  // seed once the regular season is over).
  const isPlayoffWeek = d => !!d && (Boolean(d.playoffWeek) || (d.regularSeasonWeeks > 0 && d.week > d.regularSeasonWeeks));
  function seedsOf(d) {
    const out = new Map();
    (d.teams || []).forEach(t => { if (t.manager && typeof t.standing === 'number' && t.standing < 900) out.set(t.manager, t.standing); });
    return out;
  }
  const pRound = (d, type) => {
    const k = d.week - (d.regularSeasonWeeks || 0), six = (d.playoffTeamCount || 6) >= 6;
    return type === 'Play' ? (six && k <= 1 ? 'Quarterfinal' : 'Semifinal')
      : type === 'Champ' ? 'Championship' : type === '3rd' ? '3rd place game' : type === '5th' ? '5th place game'
        : type === 'Cons' ? 'Consolation' : type === 'Sacko' ? 'Sacko game' : '';
  };
  // What a quarterfinal winner gets: the top seed takes the lowest seed left.
  // From the other quarterfinal's result when it's in, else both chances.
  function qfNext(d, mgr) {
    const seeds = seedsOf(d), mine = seeds.get(mgr);
    if (!mine) return '';
    const byName = s => [...seeds].find(([, v]) => v === s)?.[0] || `the ${s} seed`;
    if (mine === 6) return byName(1);
    if (mine === 3) return byName(2);
    const other = (d.matchups || []).find(m => m.bracket === 'Play' && [m.awayManager, m.homeManager].some(x => [3, 6].includes(seeds.get(x))));
    if (other && matchupDecided(other)) {
      const w = (parseFloat(other.awayScore) || 0) > (parseFloat(other.homeScore) || 0) ? other.awayManager : other.homeManager;
      return seeds.get(w) === 6 ? byName(2) : byName(1);
    }
    return `${byName(1)} or ${byName(2)}`;
  }
  function playoffTag(m) {
    const d = shownData;
    if (!d || d.archived || !m.bracket || !isPlayoffWeek(d)) return '';
    const name = pRound(d, m.bracket);
    if (!name) return '';
    const pay = SUP_PAY || {};
    const say = m.bracket === 'Champ' ? (pay.first ? `$${pay.first.toLocaleString()} to the winner` : 'for the title')
      : m.bracket === '3rd' ? (pay.third ? `$${pay.third.toLocaleString()} to the winner` : '')
        : m.bracket === 'Play' ? (name === 'Quarterfinal' ? 'winner to the semifinals' : 'winner to the final')
          : m.bracket === 'Cons' ? 'counts for the high score and season points'
            : m.bracket === 'Sacko' ? 'the loser takes the Sacko' : '';
    return `<div class="mu-tag${m.bracket === 'Sacko' ? ' sacko' : ''}">${name}${say ? ` · ${say}` : ''}</div>`;
  }
  // The tag over a card: its playoff game, or Game of the week.
  const cardTagHtml = m => playoffTag(m) || (pairKey(m) === gotwKey() ? '<div class="mu-tag">Game of the week</div>' : '');
  // Up 6.40 with 3 to play / Final: you won 112.40–98.20.
  function playoffScoreSay(m, me) {
    const mine = isMe(m.awayManager) ? 'away' : 'home', other = mine === 'away' ? 'home' : 'away';
    const a = parseFloat(m[mine + 'Score']) || 0, b = parseFloat(m[other + 'Score']) || 0;
    if (matchupDecided(m)) return a === b ? `Final: a tie at ${fmtScore(a)}.` : `Final: you ${a > b ? 'won' : 'lost'} ${fmtScore(a)}–${fmtScore(b)}.`;
    if (!a && !b) return '';
    const left = (parseInt(m[mine + 'Remaining'], 10) || 0) + (parseInt(m[mine + 'InPlay'], 10) || 0);
    return `${a === b ? 'Tied' : a > b ? `Up ${fmtScore(a - b)}` : `Down ${fmtScore(b - a)}`}${left ? ` with ${left} to play` : ''}.`;
  }
  function renderPlayoffLine(el, data, t) {
    const me = t.manager, seeds = seedsOf(data), seed = seeds.get(me);
    const m = (data.matchups || []).find(x => isMe(x.awayManager) || isMe(x.homeManager));
    const k = data.week - (data.regularSeasonWeeks || 0);
    let text;
    if (!m) {
      if (!(seed <= 2 && k === 1)) return false;
      text = `<b>Bye week.</b> You're through to the semifinal against the lowest seed left.`;
    } else {
      const opp = isMe(m.awayManager) ? m.homeManager : m.awayManager;
      const score = playoffScoreSay(m, me);
      const name = pRound(data, m.bracket) || 'This week';
      const pay = SUP_PAY || {};
      const lowest = [...seeds.values()].sort((a, b) => b - a).slice(0, 2);
      const next = m.bracket === 'Play' && name === 'Quarterfinal' ? ` Win and you play <b>${esc(qfNext(data, me))}</b> in the semifinal; lose and you play for 5th.`
        : m.bracket === 'Play' ? ' Win and you play for the title; lose and you play for 3rd.'
          : m.bracket === 'Champ' ? (pay.first ? ` $${pay.first.toLocaleString()} to the winner, $${(pay.second || 0).toLocaleString()} to the loser.` : '')
            : m.bracket === '3rd' ? (pay.third ? ` $${pay.third.toLocaleString()} to the winner.` : '')
              : m.bracket === 'Sacko' ? ' The loser takes the Sacko.'
                : m.bracket === 'Cons' ? (lowest.includes(seed) && k < 3 ? ' You play in the Sacko game in the last week.' : " You're clear of the Sacko.") : '';
      text = `<b>${esc(name)} vs ${esc(opp)}${score ? ':' : '.'}</b> ${score}${next}`;
    }
    el.innerHTML = `<div class="st-line"><span class="st-mono">${esc(monogram(me))}</span><p class="st-text">${text}</p></div>`;
    el.hidden = false;
    return true;
  }
  // The bracket under the status line: quarterfinals, semifinals and final
  // (this week's games live from the Worker, earlier rounds from league.json),
  // and the Sacko game beside them.
  function renderBracketStrip(data) {
    const el = document.getElementById('bracket-section');
    if (!el) return;
    if (!data || data.archived || !isPlayoffWeek(data) || (data.year || leagueYear) !== leagueYear) { el.hidden = true; el.innerHTML = ''; return; }
    const reg = data.regularSeasonWeeks, k = data.week - reg, seeds = seedsOf(data), year = data.year || leagueYear;
    const byName = s => [...seeds].find(([, v]) => v === s)?.[0] || '';
    const past = (leagueGames || []).filter(g => g.year === year && g.week > reg);
    // One game: this week's (live) or an earlier round's (final).
    const live = (data.matchups || []).filter(m => m.bracket);
    const gameBox = (a, sa, b, sb, on, done) => {
      const lead = done || on ? (sa > sb ? 0 : sb > sa ? 1 : -1) : -1;
      const row = (n, sc, i) => `<div class="bk-r${i === lead ? ' lead' : ''}${isMe(n) ? ' you' : ''}"><span class="sd">${seeds.get(n) || ''}</span><span class="bn">${esc(n)}</span>${done || on ? `<b>${fmtScore(sc)}</b>` : ''}</div>`;
      return `<div class="bk-g${on ? ' on' : ''}${[a, b].some(isMe) ? ' me' : ''}">${row(a, sa, 0)}${row(b, sb, 1)}${on ? '<span class="bk-live">Live</span>' : ''}</div>`;
    };
    const fromLive = m => gameBox(m.awayManager, parseFloat(m.awayScore) || 0, m.homeManager, parseFloat(m.homeScore) || 0, !matchupDecided(m) && (parseFloat(m.awayScore) || 0) + (parseFloat(m.homeScore) || 0) > 0, matchupDecided(m));
    const fromPast = g => gameBox(g.p1, g.s1, g.p2, g.s2, false, true);
    const tbd = (s, say) => `<div class="bk-g tbd"><div class="bk-r${isMe(byName(s)) ? ' you' : ''}"><span class="sd">${s}</span><span class="bn">${esc(byName(s))}</span></div><div class="bk-say">${say}</div></div>`;
    const round = (wk, type, ph) => (k === wk - reg ? live.filter(m => m.bracket === type).map(fromLive) : past.filter(g => g.week === wk && g.type === type).map(fromPast)).join('') || ph;
    const qf = round(reg + 1, 'Play', '');
    const sf = round(reg + 2, 'Play', tbd(1, 'vs the lowest seed left') + tbd(2, 'vs the other winner'));
    const fin = round(reg + 3, 'Champ', `<div class="bk-g tbd"><div class="bk-say">${SUP_PAY && SUP_PAY.first ? `$${SUP_PAY.first.toLocaleString()} to the winner` : 'For the title'}</div></div>`);
    const lows = [...seeds].sort((x, y) => y[1] - x[1]).slice(0, 2).map(x => x[0]).reverse();
    const sacko = round(reg + 3, 'Sacko', lows.length === 2 ? gameBox(lows[0], 0, lows[1], 0, false, false) : '');
    const col = (label, html, more = '') => html ? `<div class="bk-col"><div class="bk-lab">${label}</div>${html}${more}</div>` : '';
    const sk = sacko ? `<div class="bk-lab sacko">Sacko game</div><div class="bk-sk">${sacko}</div>` : '';
    el.innerHTML = `<div class="glass bk-card"><div class="bk-head"><span class="bk-title">The bracket</span><span class="badge gold">Week ${data.week} · ${esc(pRound(data, k >= 3 ? 'Champ' : 'Play'))}${k >= 3 ? '' : 's'}</span></div>
      <div class="bk scroll">${col('Quarterfinals', qf)}${col('Semifinals', sf)}${col('Final', fin, sk)}</div></div>`;
    el.hidden = false;
  }

  // The pair's all-time series before this week (site audit 27), as a link
  // to Head to Head with the two managers preselected, away side on the left.
  let dashWeek = 1;
  function seriesHtml(m) {
    const a = m.awayManager, b = m.homeManager;
    const s = seriesFor(a, b, dashWeek);
    if (!s) return '';
    // Your own matchup says it from your side, with the streak and the last
    // five meetings; every other card keeps the plain series.
    const meA = isMe(a), meB = isMe(b);
    if ((meA || meB) && s.form.length) {
      const f = meA ? s.form : s.form.map(x => (x === 'W' ? 'L' : 'W'));
      const kind = f[f.length - 1];
      let n = 0;
      for (let i = f.length - 1; i >= 0 && f[i] === kind; i--) n++;
      const say = `${kind === 'W' ? 'won' : 'lost'} the last ${n === 1 ? 'one' : n}`;
      const opp = meA ? b : a;
      return `<a class="mu-series" href="${esc(pageLink('head-to-head.html', { a, b }))}">
        <span class="mu-series-lead">You're <b>${meA ? s.a : s.b}-${meA ? s.b : s.a}</b> vs ${esc(opp)} · ${say}</span>
        <span class="mu-series-last"><span class="mu-form" aria-label="Last ${Math.min(5, f.length)} meetings, oldest first">${f.slice(-5).map(x => `<i class="${x}">${x}</i>`).join('')}</span><svg viewBox="0 0 8 12" aria-hidden="true"><path d="M2 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </a>`;
    }
    const lead = s.a === s.b
      ? (s.a ? `Series tied <b>${s.a}-${s.b}</b>` : 'First meeting')
      : `<b>${esc(s.a > s.b ? a : b)}</b> leads the series <b>${Math.max(s.a, s.b)}-${Math.min(s.a, s.b)}</b>`;
    const last = s.last ? `Last met ${s.last.year === shownYear() ? '' : s.last.year + ' · '}Wk ${s.last.week}` : '';
    return `<a class="mu-series" href="${esc(pageLink('head-to-head.html', { a, b }))}">
        <span class="mu-series-lead">${lead}</span>
        <span class="mu-series-last">${last}<svg viewBox="0 0 8 12" aria-hidden="true"><path d="M2 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </a>`;
  }
  function medianTeamName(t) { return t.manager || t.name; }
  // A Median Watch name as a link to that manager's Franchise page (site
  // audit #22), when the Worker knew the manager (otherwise it's a team name).
  function mwNameHtml(name) {
    const known = (lastMedianTeams || []).some(t => t.manager && t.manager === name);
    return known ? mgrLink(name) : esc(name);
  }

  // The lines under each score, as separate facts rather than one slot that
  // can only hold one of them:
  //   - how many of this team's starters are in play right now and how many
  //     haven't kicked off yet;
  //   - whether the result is already locked (can't change) or the team is
  //     done for the week.
  // These used to share a single line, with locked/final taking priority, so
  // a locked team stopped reporting its remaining players entirely -- and got
  // them back as soon as the lock lifted (the lock line rises as more teams
  // finish, so a team can come back out of it on any refresh). That read as
  // the count randomly disappearing and reappearing between refreshes. They
  // are independent facts, so they get independent lines: a team locked above
  // with five still to play is both of those things at once.
  // Everything stays blank when the NFL game state couldn't be read, so
  // nobody is wrongly shown as finished.
  function miniStatusLines(t) {
    if (!t.statusKnown) return [];
    const lines = [];
    const players = [];
    if (t.inPlay) players.push(`${t.inPlay} live`);
    if (t.remaining) players.push(`${t.remaining} to play`);
    if (players.length) lines.push({ parts: players, cls: t.inPlay ? 'live' : '' });
    // A done team has no players line (nothing left to count), so "Final"
    // lands on the first line and that card doesn't grow a second one.
    if (t.locked) lines.push({ text: `Locked ${t.lockedAbove ? 'above' : 'below'}`, cls: 'locked' });
    else if (t.done) lines.push({ text: 'Final', cls: 'final' });
    return lines;
  }

  // How far a team sits above or below the median, signed, e.g. "+12.02" /
  // "−0.97" (a real minus sign, so it lines up with the plus).
  function fmtMwMargin(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2); }

  // Average mode flags a manager the season averages put on the other side
  // of the median from ESPN's projection.
  function mwAvgFlip(name) {
    if (medianViewMode !== 'average' || !lastMedianTeams) return '';
    const topHalf = key => new Set(lastMedianTeams.slice().sort((a, b) => b[key] - a[key])
      .slice(0, Math.floor(lastMedianTeams.length / 2)).map(medianTeamName));
    const avg = topHalf('average').has(name), proj = topHalf('projected').has(name);
    if (avg === proj) return '';
    return `<span class="mw-flip ${avg ? 'up' : 'dn'}">${avg ? 'Above' : 'Below'} on avg</span>`;
  }

  function mwCardHtml(t, tone, median) {
    const lines = miniStatusLines(t);
    // One line per fact group, never wrapped. No live dot here -- the spread
    // chart beside the cards already marks who's live.
    const statHtml = l => {
      const parts = l.parts || [l.text];
      const lead = l.cls === 'locked' ? '\u2713 ' : '';
      return `<div class="mw-stat ${l.cls}">${lead}${parts.map((x, i) => `${i ? '<span class="sep">\u00b7</span>' : ''}<span>${x}</span>`).join('')}</div>`;
    };
    // Every card opens to its starters (see "a manager's starters" below).
    const can = true;
    const canAttrs = can ? ' role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false"' : '';
    return `<div class="mb-card${isMe(t.name) ? ' me' : ''}${lines.some(l => l.cls === 'locked') ? ' locked' + (t.lockedBelow ? ' locked-below' : '') : ''}${can ? ' can' : ''}" data-name="${t.name}"${canAttrs}>${mwAvgFlip(t.name)}
      <div class="mw-top">
        <span class="mw-name">${mwNameHtml(t.name)}</span>
        <div class="mw-score" style="color:var(--${tone});">${fmtScore(t.score)}</div>
      </div>
      <div class="mw-bot">
        <div class="mw-margin" style="color:var(--${tone});">${fmtMwMargin(t.score - median)}</div>
        <div class="mw-stats">${lines.map(statHtml).join('')}</div>
      </div>
    </div>`;
  }

  function mwGridHtml(list, tone, median) {
    return `<div class="mw-grid">${list.map(t => mwCardHtml(t, tone, median)).join('')}</div>`;
  }

  // ---------- Median Watch: a manager's starters ----------
  // Tapping any card lists that manager's starters: a bottom sheet on a
  // phone, a popover under the card on desktop -- the same two surfaces, and
  // the same 720px switch, the Game Records page uses for its top 10s
  // (theme.css "Detail panels"). Neither moves a card. The open panel is
  // rebuilt on every refresh, so its scores stay live.
  const mwOneColumn = matchMedia('(max-width:720px)');
  let mwOpen = null;
  // While the desktop popover is up, the cards hold the places they had when
  // it opened (card name -> place): a poll re-ranks the managers every 15
  // seconds on a Sunday, and a card hopping to a new spot would take its
  // popover with it. Scores keep counting; only the order waits, and a manager
  // who crosses the median still moves to the other half. It lifts when the
  // popover closes (or the mode changes, which ranks them differently).
  let mwHeld = null;

  const mwCardEl = name => document.querySelector(`#median-container .mb-card[data-name="${CSS.escape(name)}"]`);
  const mwStillToCome = p => ['pre', 'live', 'possession'].includes(playerState(p));
  // A starter on bye isn't finished while he can still be benched: Lineup
  // Check's window, up to the week's last kickoff (lineup-check.js).
  const mwOpenBye = p => !p.game && !!lastMedianData
    && LineupCheck.problems([p], lastMedianData, Date.now(), { anyDay: true }).some(x => x.kind === 'bye');
  const mwClock = g => `${g.period > 4 ? 'OT' : `Q${g.period}`} ${g.clock}`;
  const mwGame = g => `${g.team} ${g.teamScore}–${g.opponentScore} ${g.opponent}`;

  function mwPlayersLeft(name) {
    const t = (lastMedianTeams || []).find(x => medianTeamName(x) === name);
    if (!t || !lastMedianData) return null;
    const m = (lastMedianData.matchups || []).find(x => x.awayName === t.name || x.homeName === t.name);
    const players = m ? (m.awayName === t.name ? m.awayPlayers : m.homePlayers) || [] : [];
    return { t, players };
  }

  // One starter: slot, name, a status line, his stat line, and the number he
  // counts for in this mode, with a smaller second number under it. Gold is
  // a number still being estimated (a projection or an average); white is
  // points he has scored.
  function mwRowHtml(p, sub, val, small, cls) {
    return `<div class="mwa-row${cls}">
      <span class="mwa-slot">${p.slot || ''}</span>
      <div class="mwa-main"><div class="mwa-nm">${p.name}</div>${sub}${p.statLine ? `<span class="mwa-sl">${p.statLine}</span>` : ''}</div>
      <div class="mwa-r">${val}${small ? `<div class="mwa-small">${small}</div>` : ''}</div>
    </div>`;
  }

  // Average mode: what each starter counts for and where it came from
  // (avgSource, set by averageValue() in worker/src/dashboard.js).
  function mwAvgRowHtml(p) {
    const g = p.game || {};
    const avg = p.seasonAvg === null || p.seasonAvg === undefined ? '' : fmtScore(p.seasonAvg);
    const src = {
      final: 'Final',
      live: `${mwClock(g)} · ${fmtScore(p.livePoints || 0)} so far, rest at ${p.gamesPlayed >= 2 ? `avg ${avg}` : 'ESPN proj'}`,
      avg: `Avg of ${p.gamesPlayed} games · ESPN ${fmtScore(p.projectedPoints)}`,
      proj: `ESPN proj · ${p.gamesPlayed === 1 ? 'only 1 game' : 'no games'} yet`,
      out: 'Ruled out',
      bye: 'Bye week',
    }[p.avgSource] || '';
    const tone = ['avg', 'proj', 'live'].includes(p.avgSource) ? ' gold' : ['out', 'bye'].includes(p.avgSource) ? ' none' : '';
    return mwRowHtml({ slot: p.slot, name: p.name }, `<div class="mwa-sub">${src}</div>`,
      `<div class="mwa-val${tone}">${fmtScore(p.avgPoints || 0)}</div>`, '', '');
  }

  // Current and Projected: the game clock and NFL score (or kickoff, or the
  // final), then his points so far, with his projection under it (gold in
  // Projected while his game is still to finish, since that's what counts).
  function mwLiveRowHtml(p, mode) {
    const g = p.game || {};
    const state = playerState(p);
    const live = state === 'live' || state === 'possession';
    const bye = mwOpenBye(p);
    const sub = live ? `<div class="mwa-sub live"><i class="ld"></i>${mwClock(g)} <span>· ${mwGame(g)}</span></div>`
      : state === 'pre' ? `<div class="mwa-sub">${fmtKickoff(g.date)} · ${g.team} vs ${g.opponent}</div>`
      : state === 'final' ? `<div class="mwa-sub">Final · ${mwGame(g)}</div>`
      : bye ? '<div class="mwa-sub hole">Bye week <span>· can still be swapped out</span></div>'
      : '<div class="mwa-sub">Bye week</div>';
    const done = state !== 'pre' && !live && !bye;
    const num = (v, tone = '') => `<div class="mwa-val${tone}">${v}</div>`;
    // While his game is on, his projection is as of now, green or red against
    // the pregame one (liveProj); otherwise the pregame number.
    const lp = liveProj(p);
    const proj = (cls = '') => {
      if (!lp) return '';
      if (!lp.live) return cls ? `<span class="${cls}">proj ${fmtScore(lp.now)}</span>` : `proj ${fmtScore(lp.now)}`;
      return `<span class="${lp.dir === 'up' ? 'up' : lp.dir === 'down' ? 'dn' : cls}" title="Pregame projection ${fmtScore(lp.orig)}">proj ${fmtScore(lp.now)}</span>`;
    };
    let val, small;
    if (mode === 'current') {
      val = state === 'pre' ? num('—', ' none') : num(fmtScore(p.livePoints || 0));
      small = proj();
    } else if (done || bye) {
      val = num(fmtScore(p.livePoints || 0));
      small = proj();
    } else {
      val = live ? num(fmtScore(p.livePoints || 0)) : num('—', ' none');
      small = proj('gold');
    }
    return mwRowHtml(p, sub, val, small, done ? ' is-done' : '');
  }

  // Players still to come first (live ones before those yet to kick off,
  // then a bye he can still bench), then the finished ones under a divider.
  function mwListHtml(players, mode) {
    if (mode === 'average') return `<div class="mwa-list">${players.map(mwAvgRowHtml).join('')}</div>`;
    const open = p => mwStillToCome(p) || mwOpenBye(p);
    const rank = p => ({ possession: 0, live: 0, pre: 1, final: 3 })[playerState(p)] ?? (mwOpenBye(p) ? 2 : 4);
    const sorted = players.slice().sort((a, b) => rank(a) - rank(b));
    const up = sorted.filter(open), done = sorted.filter(p => !open(p));
    return `<div class="mwa-list">${up.map(p => mwLiveRowHtml(p, mode)).join('')}${up.length && done.length ? '<div class="mwa-div">Finished</div>' : ''}${done.map(p => mwLiveRowHtml(p, mode)).join('')}</div>`;
  }

  // The one number the card itself doesn't show: the other mode's total.
  const mwOtherTotal = t => lastMedianData && lastMedianData.archived ? 'final'
    : medianViewMode === 'current' ? `proj<b>${fmtScore(t.projected)}</b>`
    : medianViewMode === 'average' ? `proj<b>${fmtScore(t.projected)}</b> · now<b>${fmtScore(t.current)}</b>`
    : `now<b>${fmtScore(t.current)}</b>`;

  // Phone only: the sheet covers the card, so it repeats the manager,
  // scored the way their card is right now (Current or Projected).
  function mwHeadHtml(t, name) {
    const mode = medianViewMode;
    const median = mwMedian(mode);
    const card = mwCardEl(name);
    const tone = card && card.closest('#median-below') ? 'loss' : 'turf';
    return `<div class="mwp-head">
      <div style="min-width:0"><div class="mwp-name">${mwNameHtml(name)}</div>
        <div class="mwp-sub"><span style="color:var(--${tone})">${fmtMwMargin(t[mode] - median)}</span> vs median · ${mwOtherTotal(t)}</div></div>
      <div class="mwp-score" style="color:var(--${tone})">${fmtScore(t[mode])}</div>
    </div>`;
  }

  function mwShow(name, animate) {
    const info = mwPlayersLeft(name);
    if (!info || !info.players.length || !mwCardEl(name)) { mwHide(); return; }
    mwOpen = name;
    mwMark();
    const count = info.players.length, left = info.players.filter(mwStillToCome).length;
    const what = medianViewMode === 'average' ? 'Season averages' : `${count} starters · ${left ? `${left} still to play` : 'final'}`;
    const label = `${name}: ${what}`;
    const pods = mwListHtml(info.players, medianViewMode);

    // Desktop: the popover sits right under its card, so it doesn't repeat
    // the name, score or margin -- one line, then the players.
    if (!mwOneColumn.matches) {
      let pop = document.getElementById('mw-pop');
      if (!pop) {
        document.body.insertAdjacentHTML('beforeend', '<div class="pop" id="mw-pop" role="dialog"></div>');
        pop = document.getElementById('mw-pop');
      }
      pop.setAttribute('aria-label', label);
      pop.innerHTML = `<div class="mwp-line"><span class="mwp-label">${what}</span>
        <span class="mwp-line-r"><span>${mwOtherTotal(info.t)}</span><button type="button" class="x" data-mw-close aria-label="Close">&times;</button></span></div>${pods}`;
      mwPlacePop();
      popTrackStart();
      if (!mwHeld) mwHeld = new Map([...document.querySelectorAll('#median-container .mb-card')].map((c, i) => [c.dataset.name, i]));
      return;
    }
    const list = `<div class="mwp-label">${what}</div>${pods}`;

    // Phone: the sheet steps through managers itself, in card order.
    const order = [...document.querySelectorAll('#median-container .mb-card.can')].map(c => c.dataset.name);
    const i = order.indexOf(name), prev = order[i - 1], next = order[i + 1];
    const nav = `<div class="mwp-nav">
      <button type="button" class="${prev ? '' : 'gone'}" data-mw-go="${prev || ''}">‹ ${prev || ''}</button>
      <button type="button" class="${next ? '' : 'gone'}" data-mw-go="${next || ''}">${next || ''} ›</button></div>`;
    let sheet = document.getElementById('mw-sheet');
    if (!sheet) {
      const still = animate ? '' : ' style="animation:none"';
      document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="mw-scrim" data-mw-close${still}></div>
        <div class="sheet" id="mw-sheet" role="dialog" aria-modal="true"${still}>
          <div class="sheet-grab" data-grab><span></span><button type="button" class="mwp-done" data-mw-close>Done</button></div>
          <div class="sheet-head" data-grab data-head></div>
          <div class="sheet-body" data-body></div></div>`);
      sheet = document.getElementById('mw-sheet');
    }
    sheet.setAttribute('aria-label', label);
    sheet.querySelector('[data-head]').innerHTML = mwHeadHtml(info.t, name);
    const body = sheet.querySelector('[data-body]');
    const keepScroll = sheet.dataset.name === name ? body.scrollTop : 0;
    body.innerHTML = list + nav;
    body.scrollTop = keepScroll;
    sheet.dataset.name = name;
  }

  function mwHide() {
    mwOpen = null;
    mwHeld = null;
    mwMark();
    ['mw-pop', 'mw-sheet', 'mw-scrim'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  }

  // The open card wears the gold outline on desktop, where it stays visible
  // beside its popover; on a phone the sheet covers it anyway.
  function mwMark() {
    document.querySelectorAll('#median-container .mb-card.can').forEach(c => {
      const on = c.dataset.name === mwOpen;
      c.classList.toggle('sel', on && !mwOneColumn.matches);
      c.setAttribute('aria-expanded', on);
    });
  }

  // Under the card, at least 360px wide and never off the side of the
  // screen, with the arrow on the card's center. Two passes, as on Game
  // Records: placing it can add a scrollbar, which shifts the card.
  function mwPlacePop() {
    const pop = document.getElementById('mw-pop');
    if (!pop) return;
    const card = mwOpen && mwCardEl(mwOpen);
    if (!card) { mwHide(); return; }
    for (let pass = 0; pass < 2; pass++) {
      const r = card.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      const w = Math.min(Math.max(r.width, 360), vw - 24);
      const left = Math.min(Math.max(r.left, 12), vw - w - 12);
      pop.style.width = w + 'px';
      pop.style.left = (left + scrollX) + 'px';
      pop.style.top = (r.bottom + scrollY + 10) + 'px';
      pop.style.setProperty('--arrow-x', (r.left + r.width / 2 - left) + 'px');
    }
  }

  // Both desktop popovers (this one and the median chart's) are placed from
  // where their anchor is at that moment, and a poll, a font or a late-loading
  // section can move the anchor afterwards. Rather than chase each cause, a
  // popover that is open is checked against its anchor every frame and put
  // back when it has drifted. The loop ends itself when neither is open.
  let popTrackRaf = 0;
  function popTrack() {
    popTrackRaf = 0;
    if (!document.getElementById('mw-pop') && !document.getElementById('mh-pop')) return;
    mwPlacePop();
    mhPlacePop();
    popTrackRaf = requestAnimationFrame(popTrack);
  }
  const popTrackStart = () => { if (!popTrackRaf) popTrackRaf = requestAnimationFrame(popTrack); };

  // Called after every rebuild of the cards (refresh or Current/Projected).
  // The hint under the title only shows while some card can actually open.
  function mwRefresh() {
    const hint = document.getElementById('mw-hint');
    if (hint) hint.hidden = !document.querySelector('#median-container .mb-card.can');
    const what = document.getElementById('mw-hint-what');
    if (what) what.textContent = medianViewMode === 'average' ? 'where its number comes from' : 'its starters';
    // The median label's sparkline is drawn into an empty 30px box by
    // mhRefresh, pushing every card below the label down. Draw it first, so
    // the popover is placed under its card where the card will stay: placed
    // before it, a popover on one of those cards sat 30px high until the
    // next re-place, and a ResizeObserver can't see it (the page is the same
    // size again by the next frame).
    mhRefresh();
    if (mwOpen) mwShow(mwOpen, false);
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-mw-close]')) { mwHide(); return; }
    const go = e.target.closest('[data-mw-go]');
    if (go) { if (go.dataset.mwGo) mwShow(go.dataset.mwGo, false); return; }
    // Desktop: a click anywhere but the popover or a card closes it.
    if (mwOpen && !mwOneColumn.matches && !e.target.closest('#mw-pop') && !e.target.closest('#median-container .mb-card.can')) mwHide();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && mwOpen) mwHide(); });
  addEventListener('resize', mwPlacePop);
  // The popover is placed from where its card is at that moment, and anything
  // above the card can change height afterwards (a roster opening in your
  // matchup, a late-loading section). So it is put back under its card
  // whenever the page's size changes. (The poll's own double layout is
  // handled where it happens, in renderMedianStatic.)
  if (window.ResizeObserver) {
    const mwRelayout = new ResizeObserver(() => mwPlacePop());
    mwRelayout.observe(document.body);
    mwRelayout.observe(document.getElementById('median-container'));
  }
  // Crossing 720px swaps sheet for popover: close whichever was open.
  mwOneColumn.addEventListener('change', mwHide);

  // ---------- Player game log ----------
  // Tap a starter in an open matchup: his season week by week -- points and
  // stat line for weeks played, opponent (or bye) and ESPN's projection for
  // the weeks ahead (the Worker's /player, worker/src/playerLog.js). The row
  // for the week on screen is drawn from the dashboard's own numbers, so it
  // stays as live as the card it was opened from.
  let plOpenId = null;
  const plLogs = new Map(); // "id:liveWeek" -> Promise of the log
  const PL_INJURY = { OUT: 'OUT', QUESTIONABLE: 'Q', DOUBTFUL: 'D', INJURY_RESERVE: 'IR', SUSPENSION: 'SUSP' };

  function plFind(id) {
    for (const m of (shownData && shownData.matchups) || []) {
      const p = [...(m.awayPlayers || []), ...(m.homePlayers || [])].find(x => x.id === id);
      if (p) return p;
    }
    return null;
  }

  const plLiveWeek = () => (liveData && (liveData.liveWeek || liveData.week)) || (shownData && (shownData.liveWeek || shownData.week)) || 1;

  // This season's log splits at the live week; a past season's (2019 on)
  // has every week played, so its "live week" is the one after its last.
  function plSource(id) {
    const past = Boolean(shownData && shownData.pastSeason);
    const last = past ? shownData.finalWeek : Math.max((shownData && shownData.finalWeek) || 17, plLiveWeek());
    const live = past ? last + 1 : plLiveWeek();
    const year = past ? shownData.year : leagueYear;
    return { key: `${year}:${id}:${live}`, url: `${WORKER_URL}/player?id=${id}&week=${live}&last=${last}${past ? `&year=${year}` : ''}` };
  }

  function plFetch(id) {
    const { key, url } = plSource(id);
    if (!plLogs.has(key)) {
      plLogs.set(key, fetch(url)
        .then(res => res.json())
        .then(d => { if (!d || !Array.isArray(d.weeks)) throw new Error((d && d.error) || 'No game log'); return d; })
        .catch(err => { plLogs.delete(key); throw err; }));
    }
    return plLogs.get(key);
  }

  const plOpp = r => `${r.home ? 'vs' : '@'} ${esc(r.opp || '')}`;
  function plDate(ms) {
    return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function plHeadHtml(p, log, closeBtn) {
    const name = (log && log.name) || (p && p.name) || '';
    const team = (log && log.team) || (p && p.game && p.game.team) || '';
    const inj = log && log.injury ? `<span class="pl-inj">${PL_INJURY[log.injury] || esc(log.injury)}</span>` : '';
    const pos = (log && log.position) || (p && p.slot) || '';
    const sub = log
      ? [pos, log.games ? `${fmtScore(log.avg)} a game` : '', `${log.games} game${log.games === 1 ? '' : 's'} played`].filter(Boolean).join(' · ')
      : pos;
    return `<div class="pl-head">
      <div style="min-width:0">
        <div class="pl-name"><span>${esc(name)}</span>${team ? `<span class="team-tag">${esc(team)}</span>` : ''}${inj}</div>
        <div class="pl-sub">${esc(sub)}</div>
      </div>
      ${log ? `<div class="pl-total"><b>${fmtScore(log.total)}</b><span>Season pts</span></div>` : ''}
      ${closeBtn || ''}
    </div>`;
  }

  // Each week as { w, kind, value, ... }: kind is past, cur, fut, dnp or bye.
  function plWeeks(log, p) {
    const cur = (shownData && shownData.week) || log.liveWeek;
    return log.weeks.map(r => {
      const row = { ...r };
      if (r.bye) row.kind = 'bye';
      else if (r.w === cur) {
        row.kind = 'cur';
        if (p) {
          const st = playerState(p);
          row.pts = p.livePoints !== null && p.livePoints !== undefined ? p.livePoints : null;
          row.proj = p.projectedPoints;
          row.line = p.statLine || '';
          row.gline = p.game ? playerGameLine(p, st) : null;
          row.state = st;
        }
      } else if (r.w === log.liveWeek && typeof r.pts === 'number' && !r.dnp) row.kind = 'past'; // this week, seen from a past one
      else if (r.w >= log.liveWeek) row.kind = 'fut';
      else if (r.dnp || typeof r.pts !== 'number') row.kind = 'dnp';
      else row.kind = 'past';
      // A bar shows points once there are any, else the projection.
      const started = row.kind === 'cur' && row.state && row.state !== 'pre' && typeof row.pts === 'number';
      row.barFut = row.kind === 'fut' || (row.kind === 'cur' && !started && !(row.w < log.liveWeek));
      row.value = row.kind === 'past' ? row.pts
        : row.kind === 'fut' ? (row.proj || 0)
        : row.kind === 'cur' ? (row.barFut ? (row.proj || 0) : (row.pts || 0))
        : 0;
      return row;
    });
  }

  function plBarsHtml(rows) {
    const max = Math.max(1, ...rows.map(r => r.value || 0));
    return `<div class="pl-bars" role="img" aria-label="Points by week">${rows.map(r => {
        const h = r.kind === 'bye' || r.kind === 'dnp' ? 2 : Math.max(2, Math.round(((r.value || 0) / max) * 56));
        const what = r.kind === 'bye' ? 'bye' : r.kind === 'dnp' ? 'did not play' : `${fmtScore(r.value)}${r.barFut ? ' projected' : ''}`;
        const cls = [r.barFut ? 'fut' : '', r.kind === 'cur' ? 'cur' : '', r.kind === 'bye' ? 'bye' : '', r.kind === 'dnp' ? 'dnp' : ''].filter(Boolean).join(' ');
        return `<button type="button" class="pl-bar ${cls}" data-pl-wk="${r.w}" title="Week ${r.w}: ${what}" aria-label="Week ${r.w}: ${what}"><i style="height:${h}px"></i><span>${r.w}</span></button>`;
      }).join('')}</div>
      ${rows.some(r => r.barFut) ? '<div class="pl-key"><span><i></i>Scored</span><span><i class="fut"></i>Projected</span></div>' : ''}`;
  }

  function plRowHtml(r) {
    const head = `<span class="pl-wk">Wk<b>${r.w}</b></span>`;
    if (r.kind === 'bye') return `<div class="pl-row bye" data-pl-row="${r.w}">${head}<div class="pl-opp">BYE</div><div></div></div>`;
    let mid, pts;
    if (r.kind === 'cur') {
      const opp = r.gline || `${plOpp(r)}${r.date ? ` <em>· ${plDate(r.date)}</em>` : ''}`;
      mid = `<div class="pl-opp">${opp}</div>${r.line ? `<div class="pl-line">${esc(r.line)}</div>` : ''}`;
      pts = typeof r.pts === 'number'
        ? `<b>${fmtScore(r.pts)}</b>${typeof r.proj === 'number' ? `<span>proj ${fmtScore(r.proj)}</span>` : ''}`
        : `<b>${typeof r.proj === 'number' ? fmtScore(r.proj) : '–'}</b><span>proj</span>`;
    } else if (r.kind === 'fut') {
      mid = `<div class="pl-opp">${plOpp(r)} <em>· ${r.date ? plDate(r.date) : 'TBD'}</em></div>`;
      pts = `<b>${typeof r.proj === 'number' ? fmtScore(r.proj) : '–'}</b><span>proj</span>`;
    } else {
      mid = `<div class="pl-opp">${plOpp(r)}</div><div class="pl-line">${r.kind === 'dnp' ? 'Did not play' : esc(r.line || '')}</div>`;
      pts = `<b>${r.kind === 'dnp' ? '–' : fmtScore(r.pts)}</b>${typeof r.proj === 'number' && r.kind !== 'dnp' ? `<span>proj ${fmtScore(r.proj)}</span>` : ''}`;
    }
    const cls = r.kind === 'cur' ? 'cur' : r.kind === 'fut' ? 'fut' : r.kind === 'dnp' ? 'dim' : '';
    return `<div class="pl-row ${cls}" data-pl-row="${r.w}">${head}<div style="min-width:0">${mid}</div><div class="pl-pts">${pts}</div></div>`;
  }

  function plBodyHtml(log, p) {
    const rows = plWeeks(log, p);
    let list = '', aheadShown = false;
    rows.forEach(r => {
      // One divider where the projections start.
      if (!aheadShown && r.kind === 'fut') {
        list += '<div class="pl-div">Ahead · projected</div>';
        aheadShown = true;
      }
      list += plRowHtml(r);
    });
    return plBarsHtml(rows) + `<div class="pl-list">${list}</div>`;
  }

  // On desktop the tapped player keeps a gold outline beside his popover.
  function plMark() {
    document.querySelectorAll('.mu-pc.pl-on').forEach(el => el.classList.remove('pl-on'));
    if (plOpenId && !mwOneColumn.matches) {
      const cell = document.querySelector(`.mu-pc[data-pid="${plOpenId}"]`);
      if (cell) cell.classList.add('pl-on');
    }
  }

  // Fills whichever panel is open: the log, or a loading/error line.
  function plRender(log, msg) {
    const p = plFind(plOpenId);
    const body = log ? plBodyHtml(log, p) : `<div class="pl-msg">${msg || 'Loading game log…'}</div>`;
    const pop = document.getElementById('pl-pop');
    if (pop) {
      pop.innerHTML = plHeadHtml(p, log, '<button type="button" class="x pl-x" data-pl-close aria-label="Close">&times;</button>') + body;
      plPlace();
      return;
    }
    const sheet = document.getElementById('pl-sheet');
    if (!sheet) return;
    sheet.querySelector('[data-head]').innerHTML = plHeadHtml(p, log);
    const b = sheet.querySelector('[data-body]');
    const keep = b.scrollTop;
    b.innerHTML = body;
    b.scrollTop = keep;
  }

  function plOpen(id) {
    mwHide();
    if (mhIsOpen) mhClose();
    plHide();
    plOpenId = id;
    const p = plFind(id);
    const label = esc(`${(p && p.name) || 'Player'}: game log`);
    if (!mwOneColumn.matches) {
      document.body.insertAdjacentHTML('beforeend', `<div class="pop" id="pl-pop" role="dialog" aria-label="${label}"></div>`);
    } else {
      document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="pl-scrim" data-pl-close></div>
        <div class="sheet" id="pl-sheet" role="dialog" aria-modal="true" aria-label="${label}">
          <div class="sheet-grab" data-grab><span></span><button type="button" class="mwp-done" data-pl-close>Done</button></div>
          <div class="sheet-head" data-grab data-head></div>
          <div class="sheet-body" data-body></div></div>`);
    }
    plMark();
    plRender(null);
    plFetch(id)
      .then(log => {
        if (plOpenId !== id) return;
        plRender(log);
        plScrollTo((shownData && shownData.week) || log.liveWeek, false);
      })
      .catch(() => { if (plOpenId === id) plRender(null, 'Couldn’t load this game log. Try again in a minute.'); });
  }

  function plHide() {
    plOpenId = null;
    plMark();
    ['pl-pop', 'pl-sheet', 'pl-scrim'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  }

  // The sheet opens with the week on screen near the top of its list (the
  // weeks before it are a scroll up); a tapped bar brings its row up and
  // flashes it.
  function plScrollTo(week, flash) {
    const panel = document.getElementById('pl-sheet') || document.getElementById('pl-pop');
    const row = panel && panel.querySelector(`[data-pl-row="${week}"]`);
    if (!row) return;
    const body = panel.querySelector('[data-body]');
    if (body) {
      const top = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
      // Opening: the bars stay in view unless the row would start below the
      // sheet's fold; then it comes up to just under the middle.
      const target = flash ? top - 60 : (top + row.offsetHeight > body.clientHeight ? top - body.clientHeight * 0.45 : 0);
      body.scrollTo({ top: Math.max(0, target), behavior: flash && !mwReduceMotion ? 'smooth' : 'auto' });
    } else if (flash) {
      row.scrollIntoView({ block: 'nearest', behavior: mwReduceMotion ? 'auto' : 'smooth' });
    }
    if (flash) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }

  // Under the tapped player, 400-460px wide, never off the side of the
  // screen, arrow on the player.
  function plPlace() {
    const pop = document.getElementById('pl-pop');
    if (!pop) return;
    const cell = plOpenId && document.querySelector(`.mu-pc[data-pid="${plOpenId}"]`);
    if (!cell) { plHide(); return; }
    for (let pass = 0; pass < 2; pass++) {
      const r = cell.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      const w = Math.min(Math.max(r.width, 400), 460, vw - 24);
      const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 12), vw - w - 12);
      pop.style.width = w + 'px';
      pop.style.left = (left + scrollX) + 'px';
      pop.style.top = (r.bottom + scrollY + 10) + 'px';
      pop.style.setProperty('--arrow-x', (r.left + r.width / 2 - left) + 'px');
    }
  }

  // After every dashboard render: the open log takes the new numbers, and
  // closes if its player is no longer on screen (another week).
  function plRefresh() {
    if (!plOpenId) return;
    if (!plFind(plOpenId)) { plHide(); return; }
    plMark();
    const log = plLogs.get(plSource(plOpenId).key);
    if (log) log.then(l => { if (plOpenId === l.id) plRender(l); }).catch(() => {});
    else plPlace();
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-pl-close]')) { plHide(); return; }
    const bar = e.target.closest('[data-pl-wk]');
    if (bar) { plScrollTo(Number(bar.dataset.plWk), true); return; }
    // Desktop: a click anywhere but the popover or a player closes it.
    if (plOpenId && !mwOneColumn.matches && !e.target.closest('#pl-pop') && !e.target.closest('.mu-pc[data-pid]')) plHide();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && plOpenId) { plHide(); return; }
    const cell = (e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.mu-pc[data-pid]');
    if (cell) { e.preventDefault(); plOpen(Number(cell.dataset.pid)); }
  });
  addEventListener('resize', plPlace);
  mwOneColumn.addEventListener('change', plHide);

  // ---------- Median Watch: the projected median over the week ----------
  // The Worker's scheduled run saves the projected median and every team's
  // projection (10 minutes apart during games, hourly otherwise); this
  // charts them, plus the live poll as the newest point. A sparkline sits
  // in the median label; tapping it opens the full chart, where any number
  // of managers -- none by default -- can be drawn against the median.
  let mhHistory = null, mhFetchedAt = 0, mhFetchedFor = null, mhIsOpen = false, mhResizeT;
  let mhSel = new Set();
  try { mhSel = new Set(JSON.parse(localStorage.getItem('mhManagers') || '[]')); } catch (e) {}
  const mhSave = () => { try { localStorage.setItem('mhManagers', JSON.stringify([...mhSel])); } catch (e) {} };

  function mhLoad() {
    // A past week's chart never changes; the live one is polled.
    const archived = Boolean(lastMedianData && lastMedianData.archived);
    // Snapshots only started in 2026, week 5.
    if (lastMedianData && lastMedianData.pastSeason) { mhHistory = null; mhFetchedFor = null; return; }
    const want = archived ? dashWeek : 'live';
    if (want === mhFetchedFor && (archived || Date.now() - mhFetchedAt < 4 * 60 * 1000)) return;
    mhFetchedAt = Date.now();
    mhFetchedFor = want;
    const week = dashWeek;
    fetch(WORKER_URL + '/median-history' + (archived ? `?week=${week}` : ''), { cache: 'no-store' })
      .then(res => res.json())
      .then(d => {
        if (!d || !Array.isArray(d.points) || week !== dashWeek) return;
        const had = mhHas();
        mhHistory = d;
        // The card was built before the history arrived: swap the plain
        // label for the sparkline version in place.
        if (!had && lastMedianData && mhHas()) {
          const el = document.querySelector('#median-container .median-split-label');
          if (el) el.outerHTML = medianSplitHtml(medianViewMode, mwMedian(medianViewMode), el.id || undefined);
        }
        mhRefresh();
      })
      .catch(() => {});
  }

  // Saved snapshots for the week on screen, then the live poll if it's newer.
  function mhSeries() {
    const pts = mhHistory && mhHistory.week === dashWeek ? mhHistory.points.slice() : [];
    if (lastMedianData && lastMedianTeams && !lastMedianData.archived) {
      const t = Math.floor(Date.parse(lastMedianData.updatedAt) / 1000);
      if (t && (!pts.length || t > pts[pts.length - 1].t + 30)) {
        const p = {}, c = {};
        let live = 0;
        lastMedianTeams.forEach(x => { p[medianTeamName(x)] = x.projected; c[medianTeamName(x)] = x.current; live += x.inPlay || 0; });
        pts.push({ t, pm: lastMedianData.projectedMedian, cm: lastMedianData.currentMedian, live, p, c });
      }
    }
    return pts;
  }

  // What the median chart is showing: the projected median (also a past
  // week's, which has no current history), the current one, or nothing for
  // Average mode. A snapshot from before current totals were kept still
  // has the current median (cm), just no team lines.
  const mhMetric = () => ((lastMedianData && lastMedianData.archived) || weekFinal || medianViewMode === 'projected' ? 'projected'
    : medianViewMode === 'current' ? 'current' : null);
  const mhPts = metric => (metric === 'current' ? mhSeries().filter(p => typeof p.cm === 'number') : mhSeries());
  const mhMed = (p, metric) => (metric === 'current' ? p.cm : p.pm);
  const mhVal = (p, n, metric) => (metric === 'current' ? (p.c || {})[n] : p.p[n]);
  const mhHas = () => { const m = mhMetric(); return Boolean(m) && mhPts(m).length >= 2; };

  function medianSplitHtml(mode, medianValue, id) {
    const idAttr = id ? ` id="${id}"` : '';
    const label = lastMedianData && lastMedianData.archived ? 'Median' : weekFinal ? 'Final Median' : MW_MODES[mode].label;
    // A past week's card shows final scores, but its chart (the projected
    // median through that week) opens from the label all the same.
    if (!mhHas()) {
      return `<div class="median-split-label"${idAttr}>${label} <b>${fmtScore(medianValue)}</b></div>`;
    }
    return `<button type="button" class="median-split-label" data-mh-open${idAttr} aria-expanded="${mhIsOpen}" aria-label="${label} ${fmtScore(medianValue)}, open its chart for the week">${label} <b>${fmtScore(medianValue)}</b><span class="mh-chev" aria-hidden="true">›</span><span class="mh-spark" id="mh-spark"></span></button>`;
  }

  const mhFmtTime = t => new Date(t * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const mhDay = t => new Date(t * 1000).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  const mhSigned = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);

  // Game time gets its real width; a stretch with nobody playing shrinks to
  // a twelfth (capped at 30 minutes' worth), or Friday and Saturday would
  // take up more of the chart than Sunday does. A segment with a live end
  // only counts as game time up to the 20 minutes snapshots can be apart
  // during games: the rest is the gap before the first kickoff or after
  // the last whistle (Sunday night to Monday night, say).
  const MH_LIVE_GAP = 1200;
  function mhXs(pts) {
    const xs = [0], lw = [0];
    for (let i = 1; i < pts.length; i++) {
      const dt = Math.max(0, pts[i].t - pts[i - 1].t);
      const ld = pts[i].live > 0 || pts[i - 1].live > 0 ? Math.min(dt, MH_LIVE_GAP) : 0;
      lw.push(ld);
      xs.push(xs[i - 1] + ld + Math.min((dt - ld) / 12, 1800));
    }
    xs.live = lw;
    return xs;
  }

  function mhEl(tag, attrs, parent) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function mhDraw(host, compact) {
    if (!host) return;
    host.innerHTML = '';
    const metric = mhMetric() || 'projected';
    const med = p => mhMed(p, metric), val = (p, n) => mhVal(p, n, metric);
    const pts = mhPts(metric);
    if (pts.length < 2) return;
    const sel = compact ? [] : (lastMedianTeams || []).map(medianTeamName).filter(n => mhSel.has(n));
    const W = Math.max(120, host.clientWidth), H = compact ? 30 : 220;
    const pad = compact ? { l: 3, r: 3, t: 4, b: 4 } : { l: 28, r: sel.length ? 62 : 44, t: 8, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const xs = mhXs(pts), xMax = xs[xs.length - 1] || 1;
    let lo = Infinity, hi = -Infinity;
    pts.forEach(p => {
      lo = Math.min(lo, med(p)); hi = Math.max(hi, med(p));
      sel.forEach(n => { const v = val(p, n); if (typeof v === 'number') { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    });
    const padY = Math.max((hi - lo) * 0.1, 0.5); lo -= padY; hi += padY;
    const X = i => pad.l + xs[i] / xMax * iw;
    const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
    const svg = mhEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, host);

    // Shade the stretches with games on: from a live point forward, or
    // into one from the idle gap before it.
    for (let i = 1; i < pts.length; i++) {
      const lw = xs.live[i] / xMax * iw;
      if (!lw) continue;
      const x0 = pts[i - 1].live > 0 ? X(i - 1) : X(i) - lw;
      mhEl('rect', { x: x0, y: pad.t, width: lw + 0.5, height: ih, style: 'fill:rgba(255,255,255,0.035)' }, svg);
    }

    if (!compact) {
      const span = hi - lo, step = span > 40 ? 20 : span > 20 ? 10 : span > 8 ? 5 : span > 3 ? 2 : 1;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        mhEl('line', { x1: pad.l, x2: pad.l + iw, y1: Y(v), y2: Y(v), style: 'stroke:var(--line)' }, svg);
        mhEl('text', { x: pad.l - 6, y: Y(v) + 3, 'text-anchor': 'end', 'font-size': 9, style: 'fill:var(--text-dim);font-variant-numeric:tabular-nums' }, svg).textContent = v;
      }
      // A day label at the first point of each day (Eastern), skipped when
      // a short stretch would put two on top of each other.
      let lastX = -Infinity, prevDay = null;
      pts.forEach((p, i) => {
        const d = mhDay(p.t);
        if (d === prevDay) return;
        prevDay = d;
        const x = X(i);
        if (i > 0) mhEl('line', { x1: x, x2: x, y1: pad.t, y2: pad.t + ih, style: 'stroke:var(--line);stroke-dasharray:2 3' }, svg);
        if (x - lastX < 26) return;
        lastX = x;
        mhEl('text', { x: x + 2, y: H - 6, 'font-size': 9, 'font-weight': 600, style: 'fill:var(--text-dim)' }, svg).textContent = d;
      });
      // Where the week started.
      mhEl('line', { x1: pad.l, x2: pad.l + iw, y1: Y(med(pts[0])), y2: Y(med(pts[0])), style: 'stroke:var(--gold-dim);stroke-dasharray:2 4' }, svg);
    }

    const path = f => pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(f(p)).toFixed(1)}`).join(' ');

    // Managers: green while above the median, red while below.
    sel.forEach(n => {
      for (let i = 1; i < pts.length; i++) {
        const a = val(pts[i - 1], n), b = val(pts[i], n);
        if (typeof a !== 'number' || typeof b !== 'number') continue;
        const above = (a - med(pts[i - 1])) + (b - med(pts[i])) >= 0;
        mhEl('line', { x1: X(i - 1), y1: Y(a), x2: X(i), y2: Y(b), style: `stroke:var(--${above ? 'turf' : 'loss'});stroke-width:1.3;stroke-linecap:round;opacity:0.85` }, svg);
      }
    });

    if (!compact && !sel.length) {
      const g = mhEl('linearGradient', { id: 'mh-fill', x1: 0, x2: 0, y1: 0, y2: 1 }, mhEl('defs', {}, svg));
      mhEl('stop', { offset: 0, style: 'stop-color:var(--gold);stop-opacity:0.16' }, g);
      mhEl('stop', { offset: 1, style: 'stop-color:var(--gold);stop-opacity:0' }, g);
      mhEl('path', { d: path(p => med(p)) + ` L${X(pts.length - 1)} ${pad.t + ih} L${X(0)} ${pad.t + ih} Z`, fill: 'url(#mh-fill)' }, svg);
    }
    mhEl('path', { d: path(p => med(p)), style: `fill:none;stroke:var(--gold);stroke-width:${compact ? 1.5 : 2};stroke-linejoin:round;stroke-linecap:round` }, svg);

    const li = pts.length - 1, last = pts[li];
    if (last.live > 0) mhEl('circle', { cx: X(li), cy: Y(med(last)), r: 2.5, class: 'mh-pulse', style: 'fill:var(--gold)' }, svg);
    mhEl('circle', { cx: X(li), cy: Y(med(last)), r: compact ? 2.5 : 3.5, style: 'fill:var(--gold);stroke:var(--surface);stroke-width:1.5' }, svg);
    if (compact) return;

    // End labels: the median's value, then each manager's name, nudged
    // apart so none overlap.
    const labels = [{ y: Y(med(last)), text: fmtScore(med(last)), color: 'var(--gold)', bold: true }];
    sel.forEach(n => { const v = val(last, n); if (typeof v === 'number') labels.push({ y: Y(v), text: n, color: `var(--${v >= med(last) ? 'turf' : 'loss'})` }); });
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 11);
    const over = labels[labels.length - 1].y - (pad.t + ih + 4);
    if (over > 0) labels.forEach(l => { l.y -= over; });
    labels.forEach(l => {
      mhEl('text', { x: X(li) + 7, y: l.y + 3.5, 'font-size': l.bold ? 11 : 9.5, 'font-weight': l.bold ? 700 : 600, style: `fill:${l.color};font-variant-numeric:tabular-nums${l.bold ? ';font-family:var(--scoreboard)' : ''}` }, svg).textContent = l.text;
    });

    // Scrub: crosshair plus a readout of every line at that moment.
    const cross = mhEl('line', { y1: pad.t, y2: pad.t + ih, style: 'stroke:var(--text-dim);opacity:0' }, svg);
    const dot = mhEl('circle', { r: 3.5, style: 'fill:var(--gold);stroke:var(--surface);stroke-width:1.5;opacity:0' }, svg);
    const tip = document.createElement('div');
    tip.className = 'mh-tip';
    tip.hidden = true;
    host.appendChild(tip);
    const hide = () => { cross.style.opacity = 0; dot.style.opacity = 0; tip.hidden = true; };
    const move = e => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width * W;
      let best = 0;
      pts.forEach((p, i) => { if (Math.abs(X(i) - px) < Math.abs(X(best) - px)) best = i; });
      const p = pts[best], x = X(best);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.opacity = 0.6;
      dot.setAttribute('cx', x); dot.setAttribute('cy', Y(med(p))); dot.style.opacity = 1;
      const rows = sel.filter(n => typeof val(p, n) === 'number').sort((a, b) => val(p, b) - val(p, a)).map(n => {
        const v = val(p, n);
        return `<div class="r"><span>${n}</span><span><b>${fmtScore(v)}</b> <span style="color:var(--${v >= med(p) ? 'turf' : 'loss'})">${mhSigned(v - med(p))}</span></span></div>`;
      }).join('');
      tip.innerHTML = `<div class="t">${mhFmtTime(p.t)}</div><div class="r m"><span>Median</span><b>${fmtScore(med(p))}</b></div>${rows}`;
      tip.hidden = false;
      const hostW = host.clientWidth, tw = tip.offsetWidth, sx = x / W * hostW;
      tip.style.left = (sx > hostW / 2 ? Math.max(0, sx - tw - 10) : Math.min(hostW - tw, sx + 10)) + 'px';
    };
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointercancel', hide);
  }

  function mhHeadHtml() {
    const metric = mhMetric() || 'projected';
    const pts = mhPts(metric);
    const first = pts[0], last = pts[pts.length - 1];
    const d = mhMed(last, metric) - mhMed(first, metric);
    return `<div class="mwp-head">
      <div style="min-width:0"><div class="mwp-name">${metric === 'current' ? 'Current' : 'Projected'} Median</div>
        <div class="mwp-sub">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(2)} since ${mhFmtTime(first.t)}</div></div>
      <div class="mwp-score" style="color:var(--gold)">${fmtScore(mhMed(last, metric))}</div>
    </div>`;
  }

  function mhChipsHtml() {
    const key = mhMetric() === 'current' ? 'current' : 'projected';
    const names = (lastMedianTeams || []).slice().sort((a, b) => b[key] - a[key]).map(medianTeamName);
    const on = names.filter(n => mhSel.has(n)).length;
    return `<div class="mh-mgr-head"><span class="mwp-label">Managers</span>
        <span class="mh-allnone"><button type="button" data-mh-all ${on === names.length ? 'disabled' : ''}>All</button><button type="button" data-mh-none ${on ? '' : 'disabled'}>None</button></span></div>
      <div class="mh-chips">${names.map(n => `<button type="button" class="mh-chip${mhSel.has(n) ? ' on' : ''}" data-mh-m="${n}" aria-pressed="${mhSel.has(n)}">${n}</button>`).join('')}</div>`;
  }

  const mhAnchor = () => document.querySelector('#median-container button.median-split-label');

  function mhOpen() {
    if (!mhHas()) return;
    mwHide();
    mhIsOpen = true;
    if (!mwOneColumn.matches) {
      document.body.insertAdjacentHTML('beforeend', '<div class="pop" id="mh-pop" role="dialog" aria-label="Median this week"></div>');
    } else {
      document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="mh-scrim" data-mh-close></div>
        <div class="sheet" id="mh-sheet" role="dialog" aria-modal="true" aria-label="Median this week">
          <div class="sheet-grab" data-grab><span></span><button type="button" class="mwp-done" data-mh-close>Done</button></div>
          <div class="sheet-head" data-grab data-head></div>
          <div class="sheet-body" data-body></div></div>`);
    }
    mhRender();
  }

  function mhClose() {
    mhIsOpen = false;
    ['mh-pop', 'mh-sheet', 'mh-scrim'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
    const a = mhAnchor();
    if (a) a.setAttribute('aria-expanded', 'false');
  }

  // Fills whichever panel is open; the sheet keeps its scroll position.
  function mhRender() {
    const a = mhAnchor();
    if (!a || !mhHas()) { mhClose(); return; }
    a.setAttribute('aria-expanded', 'true');
    const pop = document.getElementById('mh-pop'), sheet = document.getElementById('mh-sheet');
    if (pop) {
      pop.innerHTML = `<div class="mwp-line" style="justify-content:flex-end;margin-bottom:0"><span class="mwp-line-r"><button type="button" class="x" data-mh-close aria-label="Close">&times;</button></span></div>
        ${mhHeadHtml()}<div class="mh-chart" id="mh-chart"></div>${mhChipsHtml()}`;
      mhPlacePop();
      popTrackStart();
    } else if (sheet) {
      sheet.querySelector('[data-head]').innerHTML = mhHeadHtml();
      const body = sheet.querySelector('[data-body]');
      const keep = body.scrollTop;
      body.innerHTML = `<div class="mh-chart" id="mh-chart"></div>${mhChipsHtml()}`;
      body.scrollTop = keep;
    }
    mhDraw(document.getElementById('mh-chart'), false);
  }

  // Under the median label, up to 560px wide, never off the side of the screen.
  function mhPlacePop() {
    const pop = document.getElementById('mh-pop'), a = mhAnchor();
    if (!pop || !a) return;
    for (let pass = 0; pass < 2; pass++) {
      const r = a.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      const w = Math.min(560, vw - 24);
      const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 12), vw - w - 12);
      pop.style.width = w + 'px';
      pop.style.left = (left + scrollX) + 'px';
      pop.style.top = (r.bottom + scrollY + 10) + 'px';
      pop.style.setProperty('--arrow-x', (r.left + r.width / 2 - left) + 'px');
    }
  }

  // After every card rebuild (and when new history lands).
  function mhRefresh() {
    mhDraw(document.getElementById('mh-spark'), true);
    if (mhIsOpen) mhRender();
    flDrawAll();
    // The sparkline can arrive after the cards (history loads on its own), and
    // it moves everything under it, so an open Median Watch popover goes back
    // under its card.
    mwPlacePop();
  }

  // ---------- Flow: one matchup's projections through the week ----------
  // Site audit III #7. Both sides' projected totals from the snapshots
  // Median Watch charts (mhSeries, so the live poll is the newest point and
  // idle stretches shrink the same way), left side gold and right side
  // blue as on Head to Head, the projected median dashed behind them.
  // Your matchup carries it on the card; every other one at the top of its
  // open roster. The cards are drawn as HTML first, so each chart is a
  // placeholder filled in by flDrawAll() once it's on the page.
  const FL_B = '#7AAEDB';
  function flowHtml(m) {
    if (!m.awayManager || !m.homeManager || (shownData && shownData.pastSeason)) return '';
    return `<div class="fl-wrap" data-fl="${encodeURIComponent(matchupKey(m))}" hidden>
        <div class="fl-top"><div class="fl-h">Flow</div><div class="sup-seg fl-seg" role="group" aria-label="Flow shows" hidden><button type="button" data-fl-m="projected">Projected</button><button type="button" data-fl-m="current">Current</button></div></div><div class="fl-chart"></div><div class="fl-key"></div><div class="fl-swing" hidden></div></div>`;
  }
  function flDrawAll() {
    const ms = (shownData && shownData.matchups) || [];
    document.querySelectorAll('.fl-wrap[data-fl]').forEach(wrap => {
      const key = decodeURIComponent(wrap.dataset.fl);
      flDraw(wrap, ms.find(x => matchupKey(x) === key));
    });
  }
  function flDraw(wrap, m) {
    m = meLeft(m);
    const A = m && m.awayManager, B = m && m.homeManager;
    const has = metric => (m ? mhPts(metric).filter(p => typeof mhVal(p, A, metric) === 'number' && typeof mhVal(p, B, metric) === 'number') : []);
    const projPts = has('projected'), curPts = has('current');
    // Each matchup remembers its own choice; Current needs snapshots that
    // kept the teams' current totals, so older weeks only offer Projected.
    const metric = flMode.get(wrap.dataset.fl) === 'current' && curPts.length >= 2 ? 'current' : 'projected';
    const pts = metric === 'current' ? curPts : projPts;
    wrap.hidden = pts.length < 2;
    if (wrap.hidden) return;
    const seg = wrap.querySelector('.fl-seg');
    seg.hidden = !(projPts.length >= 2 && curPts.length >= 2);
    seg.querySelectorAll('button').forEach(btn => { const on = btn.dataset.flM === metric; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on); });
    const val = (p, n) => mhVal(p, n, metric), md = p => mhMed(p, metric);
    const host = wrap.querySelector('.fl-chart');
    host.innerHTML = '';
    // Playoff weeks have no median to play against.
    const withMedian = !isPlayoffWeek(shownData);
    const W = Math.max(160, host.clientWidth), H = host.clientHeight || 150;
    const pad = { l: 28, r: 6, t: 8, b: 20 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const xs = mhXs(pts), xMax = xs[xs.length - 1] || 1;
    let lo = Infinity, hi = -Infinity;
    pts.forEach(p => [val(p, A), val(p, B), withMedian ? md(p) : null].forEach(v => {
      if (typeof v === 'number') { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }));
    const padY = Math.max((hi - lo) * 0.08, 1); lo -= padY; hi += padY;
    const X = i => pad.l + xs[i] / xMax * iw;
    const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
    const svg = mhEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, host);

    const span = hi - lo, step = span > 80 ? 20 : span > 40 ? 10 : span > 16 ? 5 : 2;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      mhEl('line', { x1: pad.l, x2: pad.l + iw, y1: Y(v), y2: Y(v), style: 'stroke:var(--line)' }, svg);
      mhEl('text', { x: pad.l - 6, y: Y(v) + 3, 'text-anchor': 'end', 'font-size': 9, style: 'fill:var(--text-dim);font-variant-numeric:tabular-nums' }, svg).textContent = v;
    }
    let lastX = -Infinity, prevDay = null;
    pts.forEach((p, i) => {
      const d = mhDay(p.t);
      if (d === prevDay) return;
      prevDay = d;
      const x = X(i);
      if (i > 0) mhEl('line', { x1: x, x2: x, y1: pad.t, y2: pad.t + ih, style: 'stroke:var(--line);stroke-dasharray:2 3' }, svg);
      if (x - lastX < 26) return;
      lastX = x;
      mhEl('text', { x: x + 2, y: H - 5, 'font-size': 9, 'font-weight': 600, style: 'fill:var(--text-dim)' }, svg).textContent = d;
    });

    const path = f => pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(f(p)).toFixed(1)}`).join(' ');
    const line = 'fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round';
    if (withMedian) mhEl('path', { d: path(p => md(p)), style: 'fill:none;stroke:rgba(245,245,243,0.42);stroke-width:1.3;stroke-dasharray:4 3' }, svg);
    mhEl('path', { d: path(p => val(p, B)), style: `${line};stroke:${FL_B}` }, svg);
    mhEl('path', { d: path(p => val(p, A)), style: `${line};stroke:var(--gold)` }, svg);

    // The biggest single jump either side made, ringed on its line.
    let best = null;
    for (let i = 1; i < pts.length; i++) [A, B].forEach(who => {
      const d = val(pts[i], who) - val(pts[i - 1], who);
      if (!best || Math.abs(d) > Math.abs(best.d)) best = { i, who, d };
    });
    if (best && Math.abs(best.d) < 3) best = null;
    const colorOf = who => (who === A ? 'var(--gold)' : FL_B);
    if (best) mhEl('circle', { cx: X(best.i), cy: Y(val(pts[best.i], best.who)), r: 4.5, style: `fill:none;stroke:${colorOf(best.who)};stroke-width:1.5` }, svg);

    const li = pts.length - 1, last = pts[li];
    [[B, FL_B], [A, 'var(--gold)']].forEach(([who, c]) => {
      if (last.live > 0) mhEl('circle', { cx: X(li), cy: Y(val(last, who)), r: 2.5, class: 'fl-pulse', style: `fill:${c}` }, svg);
      mhEl('circle', { cx: X(li), cy: Y(val(last, who)), r: 3.5, style: `fill:${c};stroke:var(--surface);stroke-width:1.5` }, svg);
    });

    wrap.querySelector('.fl-key').innerHTML = `<span class="a">${esc(A)} ${fmtScore(val(last, A))}</span><span class="b">${esc(B)} ${fmtScore(val(last, B))}</span>`
      + (withMedian ? `<span class="md"><i></i>Median ${fmtScore(md(last))}</span>` : '') + `<span class="note">${metric}</span>`;

    // What the biggest jump was, from the Feed when it saw it. A row only
    // gets the blame if it moved the projection at least half as far as the
    // jump did: a catch that was called back a minute later, beside a lineup
    // change at halftime, explains none of it. (A projection note is a lineup
    // move or injury news, and says which.)
    const swing = wrap.querySelector('.fl-swing');
    swing.hidden = !best;
    if (best) {
      const t0 = pts[best.i - 1].t - 60, t1 = pts[best.i].t + 60;
      const moved = e => (e.k === 'p' || typeof e.pa !== 'number' || typeof e.pb !== 'number' ? e.d : e.pb - e.pa);
      const ev = metric === 'current' ? null : feedFor(dashWeek).filter(e => e.m === best.who && e.t / 1000 > t0 && e.t / 1000 <= t1)
        .sort((a, b) => Math.abs(moved(b)) - Math.abs(moved(a)))[0];
      const explains = ev && Math.abs(moved(ev)) >= Math.abs(best.d) / 2 && Math.sign(moved(ev)) === Math.sign(best.d);
      const when = explains ? `<b>${esc(mhDay(ev.t / 1000))} ${esc(fdTime(ev.t))}</b>` : '';
      const reasons = explains && ev.k === 'p' ? (ev.nt || []).filter(x => x.a).slice(0, 3).map(x => esc(x.t)).join(', ') : '';
      swing.innerHTML = explains && ev.k === 'p'
        ? `${when} ${esc(ev.n)} moved ${esc(best.who)}’s projection ${mhSigned(best.d)}.${reasons ? ' ' + reasons + '.' : ''}`
        : explains
        ? `${when} ${esc(ev.n)}’s ${esc(feedWhat(ev))} moved ${esc(best.who)}’s projection ${mhSigned(best.d)}.`
        : `<b>Biggest swing</b> ${esc(best.who)}’s ${metric === 'current' ? 'score' : 'projection'} ${mhSigned(best.d)}, ${esc(mhFmtTime(pts[best.i].t))}.`;
    }

    // Scrub: crosshair and every line's value at that moment.
    const cross = mhEl('line', { y1: pad.t, y2: pad.t + ih, style: 'stroke:var(--text-dim);opacity:0' }, svg);
    const tip = document.createElement('div');
    tip.className = 'mh-tip';
    tip.hidden = true;
    host.appendChild(tip);
    const hide = () => { cross.style.opacity = 0; tip.hidden = true; };
    const move = e => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width * W;
      let k = 0;
      pts.forEach((p, i) => { if (Math.abs(X(i) - px) < Math.abs(X(k) - px)) k = i; });
      const p = pts[k], x = X(k);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.opacity = 0.6;
      tip.innerHTML = `<div class="t">${mhFmtTime(p.t)}</div>`
        + `<div class="r a"><span>${esc(A)}</span><b>${fmtScore(val(p, A))}</b></div>`
        + `<div class="r b"><span>${esc(B)}</span><b>${fmtScore(val(p, B))}</b></div>`
        + (withMedian ? `<div class="r md"><span>Median</span><b>${fmtScore(md(p))}</b></div>` : '');
      tip.hidden = false;
      const hostW = host.clientWidth, tw = tip.offsetWidth, sx = x / W * hostW;
      tip.style.left = (sx > hostW / 2 ? Math.max(0, sx - tw - 10) : Math.min(hostW - tw, sx + 10)) + 'px';
    };
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointercancel', hide);
  }
  const flMode = new Map();
  document.addEventListener('click', e => {
    const btn = e.target.closest('.fl-seg [data-fl-m]');
    if (!btn) return;
    const wrap = btn.closest('.fl-wrap');
    flMode.set(wrap.dataset.fl, btn.dataset.flM);
    const key = decodeURIComponent(wrap.dataset.fl);
    flDraw(wrap, ((shownData && shownData.matchups) || []).find(x => matchupKey(x) === key));
  });
  let flResizeT;
  addEventListener('resize', () => { clearTimeout(flResizeT); flResizeT = setTimeout(flDrawAll, 150); });

  // ---------- The Feed's big plays, for the Flow captions ----------
  // The Feed is its own page (feed.html); the dashboard only needs the
  // week's changes of more than 3 points to say what a swing was, so it
  // asks for just those (big=1), new rows only, at most once a minute.
  let feed = { key: null, events: [], maxId: 0, at: 0, busy: false, missing: false };
  const fdTime = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const feedFor = week => (feed.key === `${dashYear}:${week}` ? feed.events : []);

  function feedLoad() {
    const data = shownData;
    if (!data || data.pastSeason) return;
    const key = `${dashYear}:${dashWeek}`;
    if (feed.key !== key) feed = { key, events: [], maxId: 0, at: 0, busy: false, missing: feed.missing };
    // A Worker without the route answers with the whole dashboard, so that
    // is asked once only; a finished week's rows never change once read.
    if (feed.busy || feed.missing || Date.now() - feed.at < 60 * 1000 || (feed.at && data.archived)) return;
    const want = feed, week = dashWeek;
    want.busy = true;
    want.at = Date.now();
    fetch(`${WORKER_URL}/feed?week=${week}&since=${want.maxId}&big=1`, { cache: 'no-store' })
      .then(res => res.json())
      .then(d => {
        if (d && !Array.isArray(d.events)) { feed.missing = true; return; }
        const evs = d && d.week === week ? d.events : [];
        evs.forEach(e => { if (e.id > want.maxId) { want.events.push(e); want.maxId = e.id; } });
        if (evs.length && feed === want) { flDrawAll(); if (catchup && shownData) renderStatusLine(shownData); }
      })
      .catch(() => {})
      .finally(() => { want.busy = false; });
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-mh-close]')) { mhClose(); return; }
    if (e.target.closest('[data-mh-open]')) { if (mhIsOpen) mhClose(); else mhOpen(); return; }
    const chip = e.target.closest('[data-mh-m]');
    const all = e.target.closest('[data-mh-all]'), none = e.target.closest('[data-mh-none]');
    if (chip || all || none) {
      const names = (lastMedianTeams || []).map(medianTeamName);
      if (chip) { const n = chip.dataset.mhM; if (mhSel.has(n)) mhSel.delete(n); else mhSel.add(n); }
      if (all) names.forEach(n => mhSel.add(n));
      if (none) mhSel.clear();
      mhSave();
      document.querySelectorAll('[data-mh-m]').forEach(b => { const on = mhSel.has(b.dataset.mhM); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      const on = names.filter(n => mhSel.has(n)).length;
      document.querySelectorAll('[data-mh-all]').forEach(b => { b.disabled = on === names.length; });
      document.querySelectorAll('[data-mh-none]').forEach(b => { b.disabled = !on; });
      mhDraw(document.getElementById('mh-chart'), false);
      return;
    }
    // Desktop: a click anywhere but the popover closes it.
    if (mhIsOpen && !mwOneColumn.matches && !e.target.closest('#mh-pop')) mhClose();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && mhIsOpen) mhClose(); });
  addEventListener('resize', () => {
    mhPlacePop();
    clearTimeout(mhResizeT);
    mhResizeT = setTimeout(() => {
      mhDraw(document.getElementById('mh-spark'), true);
      if (mhIsOpen) mhDraw(document.getElementById('mh-chart'), false);
    }, 120);
  });
  mwOneColumn.addEventListener('change', mhClose);

  // Whether the Worker could read NFL game states this refresh; without that
  // every team would look finished, so status and locks stay hidden.
  let medianStatusKnown = false;
  // The live week once every starter is done (audit V #9): from Monday
  // night's last whistle until ESPN rolls the week over. Week in Review
  // already used the same test; Median Watch, Superlatives, the status line
  // and the matchups read this flag so none of them talk as if games were on.
  let weekFinal = false;
  const allStartersDone = data => {
    const teams = data.teams || [];
    return teams.some(t => (t.current || 0) > 0) && teams.every(t => !(t.remaining || 0) && !(t.inPlay || 0));
  };

  const SPREAD_MIN_GAP = 3; // px minimum breathing room between separate rows

  // A name's rendered height doesn't depend on how long it is (one line is
  // one line), so rather than guess at row padding/border/line-height and
  // get it wrong, briefly render one real 1-slot and one real 2-slot row
  // (invisible, off the layout flow) in the actual container and measure
  // them — height of an empty row, and how much each added slot costs.
  function measurePillHeights(container, chipStyle) {
    // Must probe with the SAME classes renderSpreadChart actually renders
    // with -- chipStyle's .slot-chip has its own box-shadow border but no
    // extra padding/gap (kept exactly height-neutral vs. plain .slot on
    // purpose), but probing with the wrong markup would still understate
    // real pill height if that ever changes, and the median tick (placed at
    // a cluster boundary) is computed from this same size.
    const probe = document.createElement('div');
    probe.className = 'name-row' + (chipStyle ? ' plain-wrap' : '');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    const slotCls = 'slot' + (chipStyle ? ' slot-chip' : '');
    probe.innerHTML = `<span class="${slotCls}">Xx</span>`;
    container.appendChild(probe);
    const singleHeight = probe.offsetHeight;
    probe.innerHTML = `<span class="${slotCls}">Xx</span><span class="${slotCls}">Xx</span>`;
    const slotHeight = probe.offsetHeight - singleHeight;
    container.removeChild(probe);
    return { singleHeight, slotHeight };
  }

  // Every row (single name or merged) renders at exactly the width of the
  // single longest name among this week's teams — measured for real
  // rather than guessed, so there's no leftover margin around shorter
  // names once that longest one is accounted for.
  function measureMaxRowWidth(container, names, chipStyle) {
    const probe = document.createElement('div');
    probe.className = 'name-row' + (chipStyle ? ' plain-wrap' : '');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    container.appendChild(probe);
    const slotCls = 'slot' + (chipStyle ? ' slot-chip' : '');
    let max = 0;
    for (const name of names) {
      probe.innerHTML = `<span class="${slotCls}">${name}</span>`;
      max = Math.max(max, probe.offsetWidth);
    }
    container.removeChild(probe);
    return max;
  }

  // Positions every team by its actual score along one axis (not by rank),
  // merging adjacent teams into a single taller row wherever they'd
  // otherwise visually collide, so distance on the page always means
  // distance in points instead of silently overlapping. Pure 0..plotSize
  // number-line math — used for the vertical axis, with "width" meaning
  // "size along the axis" (height, here) and pos 0 meaning the lowest score.
  function computeSpreadClusters(ascendingTeams, plotSize, singleSize, slotSize) {
    const scores = ascendingTeams.map(t => t.score);
    const min = scores[0];
    const max = scores[scores.length - 1];
    const idealPos = s => (max === min ? plotSize / 2 : ((s - min) / (max - min)) * plotSize);
    const sizeOf = c => singleSize + (c.members.length - 1) * slotSize;

    // Pass 1: greedy merge based on each team's ideal (unclamped) position.
    const clusters = [];
    for (const t of ascendingTeams) {
      const pos = idealPos(t.score);
      const prev = clusters[clusters.length - 1];
      if (prev) {
        const requiredGap = sizeOf(prev) / 2 + singleSize / 2 + SPREAD_MIN_GAP;
        if (pos - prev.pos < requiredGap) {
          prev.members.push(t);
          prev.pos = (prev.pos * (prev.members.length - 1) + pos) / prev.members.length;
          continue;
        }
      }
      clusters.push({ members: [t], pos });
    }

    // A cluster's own half-size can push it past the plot's edge even
    // though its center (pos) is a valid in-range position — e.g. several
    // teams tied at the very lowest score merge into a row centered at
    // pos=0, and the centering transform then hangs half that row off the
    // edge of the card entirely. Clamp the first/last cluster inward by
    // their own half-size before spacing the rest off of them.
    if (clusters.length) {
      const first = clusters[0];
      first.pos = Math.max(first.pos, sizeOf(first) / 2);
    }

    // Pass 2: push clusters apart low-to-high so a merge that grew a row
    // can't then make it overlap its neighbor.
    for (let i = 1; i < clusters.length; i++) {
      const prevC = clusters[i - 1], curC = clusters[i];
      const requiredGap = sizeOf(prevC) / 2 + sizeOf(curC) / 2 + SPREAD_MIN_GAP;
      if (curC.pos - prevC.pos < requiredGap) curC.pos = prevC.pos + requiredGap;
    }

    if (clusters.length) {
      const last = clusters[clusters.length - 1];
      last.pos = Math.min(last.pos, plotSize - sizeOf(last) / 2);
    }

    // Pass 3: that clamp can pull a tall top row down onto the one under
    // it (Week 8 2026: five managers merged at the top hid Joe G behind
    // Ben), so push apart high-to-low the same way.
    for (let i = clusters.length - 2; i >= 0; i--) {
      const hiC = clusters[i + 1], loC = clusters[i];
      const requiredGap = sizeOf(loC) / 2 + sizeOf(hiC) / 2 + SPREAD_MIN_GAP;
      if (hiC.pos - loC.pos < requiredGap) loC.pos = hiC.pos - requiredGap;
    }
    clusters.forEach(c => { c.size = sizeOf(c); });
    return clusters;
  }

  // The median tick's position comes from where the rows actually
  // rendered (post edge-clamping above), not from the raw linear score
  // scale — otherwise a cluster shifted to avoid spilling off the card
  // could end up visually on the wrong side of a tick placed purely by
  // score, even though every one of its members is genuinely below (or
  // above) the median.
  function findMedianTickPos(clusters, median, plotSize, isBelow = m => m.score < median) {
    for (const c of clusters) {
      const belowCount = c.members.filter(isBelow).length;
      if (belowCount > 0 && belowCount < c.members.length) {
        // Straddles the median — tick lines up with this row's own
        // below/above color split, not just its center.
        return (c.pos - c.size / 2) + (belowCount / c.members.length) * c.size;
      }
    }
    let belowEdge = 0, aboveEdge = plotSize;
    for (const c of clusters) {
      if (c.members.every(isBelow)) belowEdge = Math.max(belowEdge, c.pos + c.size / 2);
      else aboveEdge = Math.min(aboveEdge, c.pos - c.size / 2);
    }
    return (belowEdge + aboveEdge) / 2;
  }

  function renderSpreadChart(elId, ascendingTeams, median, zones, chipStyle) {
    const el = document.getElementById(elId);
    if (!el || ascendingTeams.length < 2) return;
    const plotSize = el.clientHeight || 220;
    const { singleHeight, slotHeight } = measurePillHeights(el, chipStyle);
    const rowWidth = measureMaxRowWidth(el, ascendingTeams.map(t => t.name), chipStyle) + 24;
    const clusters = computeSpreadClusters(ascendingTeams, plotSize, singleHeight, slotHeight);
    // Highest score renders at the top, so a cluster's axis position (0 =
    // lowest score) maps to "100% minus its share of the plot" for `top`.
    const toTopPct = pos => 100 - (pos / plotSize) * 100;
    const RED = 'rgba(192,87,75,0.28)';
    const GREEN = 'rgba(76,154,107,0.28)';

    let html = '';
    const medianPct = toTopPct(findMedianTickPos(clusters, median, plotSize));
    if (zones) {
      if (zones.up !== null) {
        const yUp = toTopPct(findMedianTickPos(clusters, median, plotSize, m => m.score <= zones.up));
        html += `<div class="zone up" style="top:0; height:${yUp}%;"></div>`;
      }
      if (zones.down !== null) {
        const yDn = toTopPct(findMedianTickPos(clusters, median, plotSize, m => m.score < zones.down));
        html += `<div class="zone dn" style="top:${yDn}%; bottom:0;"></div>`;
      }
    }
    html += '<div class="axis"></div>';
    html += `<div class="median-tick${chipStyle ? ' slim' : ''}" style="top:${medianPct}%;"></div>`;

    clusters.forEach(c => {
      const belowCount = c.members.filter(m => m.score < median).length;
      const aboveCount = c.members.length - belowCount;
      let background, borderColor, splitFill = '';
      if (belowCount === 0) {
        background = `linear-gradient(${GREEN}, ${GREEN})`;
        borderColor = 'var(--turf-dim)';
      } else if (aboveCount === 0) {
        background = `linear-gradient(${RED}, ${RED})`;
        borderColor = 'rgba(192,87,75,0.5)';
      } else {
        // Straddles the median — split proportional to how many members
        // are on each side (1 below + 1 above = an even half/half row).
        // Two solid-color layers, each with only its OWN touching corners
        // rounded, rather than one hard-stop linear-gradient relying on the
        // row's border-radius to clip it -- that showed a thin sliver of
        // the wrong color right at the row's outer top/bottom edges, far
        // from the actual split line (confirmed by swapping in a plain
        // solid color, which eliminated it -- a gradient/border-radius
        // rendering quirk, not a logic bug). "Bottom" so the below/red
        // share sits at the bottom, matching low-scores-at-the-bottom. Each
        // layer also carries its own colored border on its 3 outer sides
        // (not the shared edge, which the gold median tick already marks),
        // so the outline is split green/red too instead of one flat neutral
        // border around the whole row.
        background = 'none';
        borderColor = 'transparent';
        const redPct = (belowCount / c.members.length) * 100;
        const greenPct = 100 - redPct;
        splitFill = `<div style="position:absolute;left:0;right:0;bottom:0;height:${redPct}%;background:${RED};border:1px solid rgba(192,87,75,0.5);border-top:none;border-radius:0 0 4px 4px;"></div><div style="position:absolute;left:0;right:0;top:0;height:${greenPct}%;background:${GREEN};border:1px solid var(--turf-dim);border-bottom:none;border-radius:4px 4px 0 0;"></div>`;
      }
      const slots = c.members
        .slice()
        .sort((a, b) => b.score - a.score) // highest first = rendered on top
        .map(m => `<span class="slot${chipStyle ? ' slot-chip' : ''} ${m.score >= median ? 'above' : 'below'}${m.statusKnown ? (m.locked ? ' locked' : '') + (m.done ? ' final' : '') + (m.inPlay ? ' live' : '') : ''}" data-name="${m.name}">${m.name}</span>`)
        .join('');
      html += chipStyle
        ? `<div class="name-row plain-wrap" style="top:${toTopPct(c.pos)}%; width:${rowWidth}px;">${slots}</div>`
        : `<div class="name-row" style="top:${toTopPct(c.pos)}%; width:${rowWidth}px; background-image:${background}; border-color:${borderColor};">${splitFill}${slots}</div>`;
    });

    const lowest = ascendingTeams[0], highest = ascendingTeams[ascendingTeams.length - 1];
    html += `<div class="endcap-score low">${fmtScore(lowest.score)}</div>`;
    html += `<div class="endcap-score high">${fmtScore(highest.score)}</div>`;
    el.innerHTML = html;
  }

  // Splits teams by rank (not by literal distance from the median value) so
  // it always yields an even above/below split — 6-and-6 in a 12-team
  // league — even if a couple of scores happen to tie exactly at the median.
  function computeMedianRows(teamsSorted, medianValue, scoreKey) {
    const half = Math.floor(teamsSorted.length / 2);
    const known = medianStatusKnown;
    const withScore = teamsSorted.map(t => ({
      name: medianTeamName(t),
      score: t[scoreKey],
      cur: t.current,
      remaining: t.remaining || 0,
      inPlay: t.inPlay || 0,
      statusKnown: known,
      done: known && !(t.remaining || 0) && !(t.inPlay || 0),
    }));

    // Locks are decided from real (current) scores on both cards. Scores only
    // ever go up, and fantasy points have no cap, so:
    //  - a team is locked ABOVE once at least half the league is finished and
    //    already scoring below its current score (only finished teams are
    //    certain to stay below it; unfinished ones could still climb past);
    //  - a FINISHED team is locked BELOW once at least half the league is
    //    already scoring above it (finished or not, they can't drop back).
    // The zone lines are drawn on the Current strip only, where the axis is
    // in real scores. The lower line applies to a team that has finished.
    let zones = null;
    if (known) {
      const finished = withScore.filter(m => m.done).map(m => m.cur);
      const upLine = finished.length >= half ? [...finished].sort((a, b) => a - b)[half - 1] : null;
      // Also requires a finished team to exist -- with nobody done yet
      // (e.g. before Thursday kickoff), no team can be locked below this
      // line regardless of its numeric value, so it shouldn't draw.
      const downLine = finished.length > 0 && withScore.length > half
        ? withScore.map(m => m.cur).sort((a, b) => b - a)[half - 1]
        : null;
      withScore.forEach(m => {
        m.lockedAbove = upLine !== null && m.cur > upLine;
        m.lockedBelow = m.done && downLine !== null && m.cur < downLine;
        m.locked = m.lockedAbove || m.lockedBelow;
      });
      if (upLine !== null || downLine !== null) zones = { up: upLine, down: downLine };
    }
    const sorted = withScore.slice().sort((a, b) => b.score - a.score);
    // Held places (mwHeld): within a half, the cards that were there keep their
    // order and anyone who just crossed over goes last.
    const held = list => mwHeld ? list.slice().sort((a, b) => (mwHeld.has(a.name) ? mwHeld.get(a.name) : 99) - (mwHeld.has(b.name) ? mwHeld.get(b.name) : 99)) : list;
    return { above: held(sorted.slice(0, half)), below: held(sorted.slice(sorted.length - half)), all: sorted, zones };
  }

  // The header Live's foldable cards share (see .lv-head): title, a dim line
  // under it (the summary while folded), any tools, then the fold button.
  function lvFoldBtn(attr, open, title) {
    return `<button type="button" class="lv-fold" ${attr} data-noshot aria-expanded="${open}" aria-label="${open ? 'Fold' : 'Show'} ${title}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
  }
  function lvHead(title, sub, attr, open, tools = '', subCls = '') {
    return `<div class="lv-head"><div class="lv-ht"><div class="lv-title">${title}</div>${sub ? `<span class="lv-sub${subCls ? ' ' + subCls : ''}">${sub}</span>` : ''}</div><div class="lv-tools">${tools}${lvFoldBtn(attr, open, title)}</div></div>`;
  }
  // A summary's parts, which wrap only between each other.
  const lvBits = bits => bits.filter(Boolean).map(b => `<span class="lv-b">${b}</span>`).join(' · ');
  // Median Watch folds to its median and line, remembered on this phone.
  const MW_FOLD = 'rl-mw-min';
  let mwFoldMem = false; // where storage is blocked, it holds for this visit
  function mwFolded() { try { const v = localStorage.getItem(MW_FOLD); if (v !== null) return v === '1'; } catch (e) {} return mwFoldMem; }
  document.getElementById('median-container').addEventListener('click', e => {
    const folded = mwFolded();
    if (!e.target.closest('[data-mw-fold]') && !(folded && e.target.closest('.median-card-header'))) return;
    mwFoldMem = !folded;
    try { localStorage.setItem(MW_FOLD, folded ? '0' : '1'); } catch (err) {}
    mwHide();
    if (lastMedianTeams) renderMedianStatic(medianViewMode);
  });

  // ---------- Median Watch: unified Current/Projected toggle card ----------
  // Remembered per-browser across real page reloads (not just the in-memory
  // periodic refresh, which already preserves it since medianViewMode just
  // isn't reset). Defaults to 'projected' the first time, same as before,
  // and falls back to it if localStorage is blocked/unavailable or holds
  // something unexpected.
  let medianViewMode = 'projected';
  let mwLiveMode = null; // the live week's mode, kept while a past week shows
  try {
    const saved = localStorage.getItem('medianViewMode');
    if (saved === 'current' || saved === 'projected' || saved === 'average') medianViewMode = saved;
  } catch (e) {}
  // Average mode counts each starter's season average (see averageValue()
  // in worker/src/dashboard.js) where Projected counts ESPN's projection.
  const MW_MODES = {
    current: { key: 'currentMedian', label: 'Current Median' },
    projected: { key: 'projectedMedian', label: 'Projected Median' },
    average: { key: 'averageMedian', label: 'Average Median' },
  };
  const mwMedian = (mode, data = lastMedianData) => data[MW_MODES[mode].key];
  const mwToggleHtml = mode => `<div class="sup-seg" id="median-toggle-seg">
      ${[['average', 'Average'], ['current', 'Current'], ['projected', 'Projected']].map(([k, l]) => `<button data-mode="${k}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>`;
  let lastMedianTeams = null, lastMedianData = null;
  const mwSlug = name => 'mw-' + name.replace(/[^a-zA-Z0-9]/g, '-');

  function tagMedianTransitionNames() {
    document.querySelectorAll('#median-above .mb-card, #median-below .mb-card').forEach(el => {
      el.style.viewTransitionName = 'card-' + mwSlug(el.dataset.name);
    });
    document.querySelectorAll('#median-chart .slot').forEach(el => {
      el.style.viewTransitionName = 'chart-' + mwSlug(el.dataset.name);
    });
  }

  // Re-skins each already-positioned chip-style cluster back into one
  // shared pill (today's merged look) by reading its composition straight
  // off the DOM -- no re-layout, nothing moves, only the per-chip borders
  // dissolve away (see the .slot/.name-row transitions in the CSS).
  function settleMedianToMergedPills() {
    const RED = 'rgba(192,87,75,0.28)', GREEN = 'rgba(76,154,107,0.28)';
    document.querySelectorAll('#median-chart .name-row.plain-wrap').forEach(row => {
      const slots = Array.from(row.querySelectorAll('.slot'));
      const belowCount = slots.filter(s => s.classList.contains('below')).length;
      const aboveCount = slots.length - belowCount;
      row.querySelectorAll(':scope > .split-fill').forEach(f => f.remove());
      let background, borderColor;
      if (belowCount === 0) { background = `linear-gradient(${GREEN}, ${GREEN})`; borderColor = 'var(--turf-dim)'; }
      else if (aboveCount === 0) { background = `linear-gradient(${RED}, ${RED})`; borderColor = 'rgba(192,87,75,0.5)'; }
      else {
        background = 'none';
        borderColor = 'transparent';
        const redPct = (belowCount / slots.length) * 100;
        const greenPct = 100 - redPct;
        const redFill = document.createElement('div');
        redFill.className = 'split-fill';
        redFill.style.cssText = `position:absolute;left:0;right:0;bottom:0;height:${redPct}%;background:${RED};border:1px solid rgba(192,87,75,0.5);border-top:none;border-radius:0 0 4px 4px;`;
        const greenFill = document.createElement('div');
        greenFill.className = 'split-fill';
        greenFill.style.cssText = `position:absolute;left:0;right:0;top:0;height:${greenPct}%;background:${GREEN};border:1px solid var(--turf-dim);border-bottom:none;border-radius:4px 4px 0 0;`;
        row.prepend(greenFill);
        row.prepend(redFill);
      }
      row.style.backgroundImage = background;
      row.style.borderColor = borderColor;
      row.classList.remove('plain-wrap');
      slots.forEach(s => s.classList.remove('slot-chip'));
    });
    const tick = document.querySelector('#median-chart .median-tick');
    if (tick) tick.classList.remove('slim');
  }

  function tickMwNumber(el, from, to, format = v => v.toFixed(2)) {
    if (!el) return;
    const duration = 680;
    const fromV = Number(from), toV = Number(to);
    el.textContent = format(fromV);
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(fromV + (toV - fromV) * eased);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // The lock-line values, shown under the median label rather than beside
  // the strip's dashed lines (see .median-lock-line).
  function mwLockLineHtml(zones) {
    if (!zones) return '';
    const parts = [];
    if (zones.up !== null) parts.push(`<span class="up">Lock above<b>${fmtScore(zones.up)}</b></span>`);
    if (zones.down !== null) parts.push(`<span class="dn">Lock below<b>${fmtScore(zones.down)}</b></span>`);
    return `<div class="median-lock-line">${parts.join('<span class="sep">\u00b7</span>')}</div>`;
  }

  function medianPendingBodyHtml() {
    // Named for the opener's day, so a Friday or Christmas opener doesn't
    // still read "Thursday Night".
    const day = getFirstKickoff().toLocaleDateString('en-US', { weekday: 'long' });
    const label = day === 'Thursday' ? 'Thursday Night' : day;
    return `<div class="median-pending"><div class="pending-headline" id="kickoff-countdown">\u2014</div><div class="pending-sub">Until ${label} Kickoff</div></div>`;
  }

  // Used for the initial load and every periodic refresh (new data, same or
  // different mode) -- rebuilds the whole card fresh with no animation at
  // all, straight to the normal merged-pill look. Toggling mode is the only
  // thing that animates (see applyMedianUpdate below); a 2-minute data
  // refresh landing mid-animation would be an awkward collision otherwise.
  function renderMedianStatic(mode) {
    const currentHasStarted = lastMedianTeams.some(t => t.current > 0);
    // A past week's three modes are all its final scores: no toggle.
    // A finished live week says so where the switch was; the strip and the
    // median's chart for the week stay as they are.
    const toggleHtml = lastMedianData && lastMedianData.archived || weekFinal ? '' : mwToggleHtml(mode);
    const finalChip = weekFinal && !(lastMedianData && lastMedianData.archived) ? '<span class="mw-final">Final</span>' : '';
    // Folded: just the median and its line for the week, with where you
    // stand under the title.
    const folded = mwFolded();
    let bodyHtml, rows = null, medianValue = null, sub = '';
    if (mode === 'current' && !currentHasStarted) {
      bodyHtml = medianPendingBodyHtml();
    } else if (folded) {
      medianValue = mwMedian(mode);
      bodyHtml = medianSplitHtml(mode, medianValue);
      const mine = lastMedianTeams.find(t => isMe(medianTeamName(t)));
      if (mine && typeof mine[mode] === 'number') {
        const d = mine[mode] - medianValue;
        sub = `<span class="lv-sub">You're <b class="${d >= 0 ? 'up' : 'dn'}">${fmtScore(Math.abs(d))}</b> ${d >= 0 ? 'above' : 'below'} at ${fmtScore(mine[mode])}</span>`;
      }
    } else {
      medianValue = mwMedian(mode);
      rows = computeMedianRows(lastMedianTeams, medianValue, mode);
      bodyHtml = `
        <div class="card-body">
          <div>
            <div id="median-above">${mwGridHtml(rows.above, 'turf', medianValue)}</div>
            ${medianSplitHtml(mode, medianValue)}${mwLockLineHtml(rows.zones)}
            <div id="median-below">${mwGridHtml(rows.below, 'loss', medianValue)}</div>
          </div>
          <div class="spread-col" id="median-spreadcol" style="width:88px;">
            <div class="vplot" id="median-chart"></div>
          </div>
        </div>`;
    }
    if (folded && mwOpen) mwHide();
    document.getElementById('median-container').innerHTML = `
      <div class="median-card${folded ? ' lv-folded' : ''}">
        <div class="median-card-header">
          <div class="lv-ht"><div class="lv-title">Median Watch</div>
            ${folded ? sub : `<span class="mw-hint" id="mw-hint" hidden><span class="click">Click</span><span class="tap">Tap</span> a card to see <span id="mw-hint-what"></span></span>`}</div>
          ${folded ? '' : toggleHtml}
          <div class="lv-tools">${finalChip}${lvFoldBtn('data-mw-fold', !folded, 'Median Watch')}</div>
        </div>
        <div id="median-body">${bodyHtml}</div>
      </div>`;
    if (rows) {
      renderSpreadChart('median-chart', rows.all.slice().reverse(), medianValue, rows.zones);
      // Every card/chart element needs a view-transition-name BEFORE a
      // toggle starts, not just after one -- the browser's View Transition
      // snapshots whatever names are already in the DOM at the moment
      // startViewTransition is called, to know what to morph FROM. Without
      // this, the very first toggle click has nothing tagged yet (this
      // static path never used to tag anything), so nothing can slide --
      // it just falls back to an instant swap, and only looks right from
      // the SECOND click on, once a prior toggle has tagged things.
      tagMedianTransitionNames();
      // The chart measures pill size/width via JS (measurePillHeights/
      // measureMaxRowWidth), using whatever font is active at that instant
      // -- but the page's custom fonts load async (display=swap), so a
      // cold first load can measure against the fallback font before the
      // real one swaps in, sizing the chart slightly wrong. The rest of the
      // card reflows automatically when the font arrives (that's just
      // CSS), but this chart's pill geometry is locked into whatever was
      // measured and won't. Re-measuring once fonts are confirmed loaded
      // fixes the mis-sized first paint -- and since that resolves well
      // before a human can click the toggle, it also keeps the first
      // toggle's View Transition "old" snapshot correctly sized instead of
      // animating from the wrong geometry.
      if (document.fonts && document.fonts.ready) {
        const mode = medianViewMode;
        document.fonts.ready.then(() => {
          if (medianViewMode === mode) {
            renderSpreadChart('median-chart', rows.all.slice().reverse(), medianValue, rows.zones);
            tagMedianTransitionNames();
            // This pass is taller than the first, which moves the cards, and an
            // open popover was placed under the card where the first pass left
            // it. (A ResizeObserver can't catch it: the page is back to its old
            // size by the time of the next frame.)
            mwPlacePop();
          }
        });
      }
    }
    updateKickoffCountdown();
    mwRefresh();
  }

  // ---------- Stat of the Moment ----------
  // A single hero fact under Median Watch, re-rolled on every data refresh
  // (loadDashboard runs every 15 seconds, so a poll only re-rolls it once
  // STAT_REROLL_MS has passed; a manual reload always does). Always shows the manager, not the team name, per request.
  //
  // Deliberately never comments on an in-progress matchup (closest
  // game/blowout/upset watch used to, and reading "up by 2.5 right now"
  // next to "but was given only a 30% chance to win" read as flatly
  // contradictory mid-game, since win probability here is closer to a
  // pregame number than a true live-updating one) -- every fact here is
  // either season-to-date (current year, from the live Worker data,
  // through completed weeks only) or full career history (all time, from
  // docs/data/franchise.json, fetched once below). Neither source can
  // produce a claim that's still in flux.
  //
  // ~20 current-year templates + ~20 all-time templates, several of which
  // produce one fact per qualifying manager (every active streak, every
  // manager's nemesis/favorite rivalry, every worst bench mistake) rather
  // than a single league winner -- across a 14-manager franchise that's
  // comfortably 100+ distinct facts that could appear here, even though
  // only whichever are true right now are in the pool on a given refresh.
  // Several are deliberately played for laughs (Paper Champion, Human
  // Victory Cigar, rivalry nemesis, worst bench mistake) per request.
  function who(t) { return (t && (t.manager || t.name)) || 'Someone'; }
  function hi(x) { return `<b>${x}</b>`; }

  let franchiseData = null;
  rlData('franchise')
    .then(d => {
      franchiseData = d;
      // Only render here if the main dashboard data has already arrived
      // and rendered once (loadDashboard calls this itself too, every
      // cycle) -- franchise.json is a small static file that often
      // resolves well before the live Worker fetch, so without this
      // guard the League Lore card could appear and pick its first fact
      // before the rest of the page (matchups, standings) has loaded,
      // drawing attention to itself mid-load instead of appearing in
      // step with everything else.
      if (standingsData) renderStatOfMoment();
    })
    .catch(() => {});

  // ---------- Game history (data/league.json) ----------
  // Every finished game since 2015, by manager name -- the names the Worker
  // reports as each team's manager. Read by the matchup cards' series line,
  // Week in Review and the points race.
  // The first dashboard render waits for it (it's a small static file that
  // usually lands before the live Worker fetch), so those parts appear with
  // the page instead of popping in one poll later. Without it, they're left out.
  // Also every past season's team names, lengths and rules, for the week
  // picker's past seasons (see "Past seasons" below).
  let leagueGames = null, leagueYear = null, leagueSeasons = [], leagueSettings = {}, medianEraYear = 2025;
  const leagueReady = rlData('league')
    .then(d => {
      leagueGames = d.games.map(g => ({ year: g[0], week: g[1], type: g[2], p1: g[3], p2: g[4], s1: g[5], s2: g[6], winner: g[7], median: g[9] }));
      leagueYear = Math.max(...d.seasons.map(s => s.year));
      leagueSeasons = d.seasons || [];
      leagueSettings = d.settings || {};
      if (d.median_era_start_year) medianEraYear = d.median_era_start_year;
    })
    .catch(() => {})
    // Player records (Record Watch): static like league.json, so the first
    // render waits for them too; without them only those lines are left out.
    .then(() => fetch('data/lineups/records.json', { cache: 'no-cache' }).then(res => (res.ok ? res.json() : null)).then(d => { rwPlayers = d; }).catch(() => {}));

  // The season on screen: this one, or a past one from the week picker.
  let dashYear = null;
  const shownYear = () => dashYear || leagueYear;

  // The season on screen's finished regular-season games for one week (byes have no p2).
  const weekGames = week => (leagueGames || []).filter(g => g.year === shownYear() && g.week === week && g.type === 'Reg' && g.p2);
  // Every week before `week` is in league.json. It's refreshed from a hand-
  // kept Game Tracker, so it can trail the Worker by a week; anything built
  // week by week is left out rather than shown with a week missing.
  const historyThrough = week => {
    if (!leagueGames) return false;
    for (let w = 1; w < week; w++) if (!weekGames(w).length) return false;
    return true;
  };

  // Head-to-head series between two managers before this week, playoffs
  // included -- the same games Head to Head counts.
  function seriesFor(a, b, week) {
    if (!leagueGames || !a || !b) return null;
    const games = leagueGames.filter(g => g.p2 && ((g.p1 === a && g.p2 === b) || (g.p1 === b && g.p2 === a))
      && (g.winner === a || g.winner === b) && (g.year < shownYear() || (g.year === shownYear() && g.week < week)));
    const last = games.reduce((m, g) => (!m || g.year > m.year || (g.year === m.year && g.week > m.week) ? g : m), null);
    // Who won each meeting, oldest first, from `a`'s side (the matchup card's
    // "You're 14-4 vs Jared" line reads the streak and the last five off it).
    const form = games.slice().sort((x, y) => x.year - y.year || x.week - y.week).map(g => (g.winner === a ? 'W' : 'L'));
    return { a: games.filter(g => g.winner === a).length, b: games.filter(g => g.winner === b).length, last, form };
  }

  // Lineup Check (site audit III #6): on your own card, the starters who
  // can't score this week. lineup-check.js holds the rules and the window
  // (Thursday morning to the last kickoff); the rows below only draw them.
  const LC_TAGS = { bye: 'Bye', out: 'Out', zero: 'Questionable · 0 proj' };
  // ---------- Lineup holes (audit VIII #3) ----------
  // Lineup Check from the moment the week's lineups are up, with the fix:
  // a benched player who can fill the spot, else the best free agents at it
  // by last week's points. Rosters and free agents come from the Worker's
  // /roster (cached there an hour), read once a week when there's a hole.
  const holesOf = players => (shownYear() === leagueYear && shownData ? LineupCheck.problems(players, shownData, Date.now(), { anyDay: true }) : []);
  const HOLE_TEXT = { bye: 'is on bye', out: 'is out', zero: 'projects 0' };
  const ELIG = { QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'], 'RB/WR/TE': ['RB', 'WR', 'TE'], 'D/ST': ['D/ST'], K: ['K'] };
  let rosterInfo = null, rosterWeek = 0;
  function needRoster() {
    const d = shownData;
    if (!d || d.archived || !d.week || rosterWeek === d.week) return;
    rosterWeek = d.week;
    fetch(`${WORKER_URL}/roster?week=${Math.max(1, d.week - 1)}`).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.rosters) return;
      rosterInfo = j;
      document.querySelectorAll('[data-lc-fix]').forEach(el => { el.textContent = fixText(el.dataset.mgr, el.dataset.name, el.dataset.slot); });
      if (shownData) { renderWaivers(shownData); renderStatusLine(shownData); }
    }).catch(() => { rosterWeek = 0; });
  }
  // The bench players who can fill it, else the free agents ([] while /roster loads).
  function fillers(mgr, name, slot) {
    const R = rosterInfo;
    if (!R || !R.rosters) return null;
    const ro = R.rosters[mgr] || [];
    const self = ro.find(p => p.n === name);
    const elig = ELIG[slot] || (self ? [self.pos] : []);
    const wk = shownData && shownData.week;
    const plays = tm => !R.byes || R.byes[tm] !== wk;
    const bench = ro.filter(p => p.slot === 'BE' && elig.includes(p.pos) && plays(p.tm));
    const fa = ((R.fa && R.fa.players) || []).filter(p => elig.includes(p.pos) && plays(p.tm)).slice(0, 2);
    return { bench, fa };
  }
  function fixText(mgr, name, slot) {
    const f = fillers(mgr, name, slot);
    if (!f) return '';
    if (f.bench.length) return `On your bench: ${f.bench.slice(0, 2).map(p => p.n).join(' or ')}.`;
    if (f.fa.length) return `Nobody on your bench for it. On waivers: ${f.fa.map(p => `${p.n} (${p.tm}, ${Number(p.pts).toFixed(1)} last week)`).join(', ')}.`;
    return 'Nobody on your bench for it.';
  }
  // Other teams' holes, under their names on the pregame scoreboard.
  function holeTag(players) {
    const h = holesOf(players);
    return h.length ? `<b class="psb-hole">${esc(h.map(x => `${lastName(x.player.name)} ${x.kind === 'bye' ? 'on bye' : x.kind === 'out' ? 'out' : 'proj 0'}`).join(', '))}</b>` : '';
  }
  function lineupHtml(m) {
    if (shownYear() !== leagueYear || !shownData) return '';
    const players = isMe(m.awayManager) ? m.awayPlayers : m.homePlayers;
    const mgr = isMe(m.awayManager) ? m.awayManager : m.homeManager;
    const items = holesOf(players);
    if (!items.length) return '';
    needRoster();
    // Fix in ESPN (audit V #15): ESPN's app claims /football/team, so this
    // opens your own team in the ESPN Fantasy app.
    const teamId = isMe(m.awayManager) ? m.awayId : m.homeId;
    const fix = teamId ? `<a class="mu-espn" href="${esc(espnUrl('team', { seasonId: leagueYear, teamId }))}" target="_blank" rel="noopener"><i>ESPN</i>Fix in ESPN</a>` : '';
    return `<div class="mu-lineup">${items.map(({ player, kind }) => `<div class="mu-lc-line">
        <span class="mu-lc-slot">${esc(player.slot)}</span><span class="mu-lc-name">${esc(player.name)}</span><span class="mu-lc-tag">${LC_TAGS[kind]}</span>
      </div><div class="mu-lc-fix" data-lc-fix data-mgr="${esc(mgr)}" data-name="${esc(player.name)}" data-slot="${esc(player.slot)}">${esc(fixText(mgr, player.name, player.slot))}</div>`).join('')}${fix}</div>`;
  }

  // Record Watch (site audit III #14): the matchup cards' gold box when a
  // game is on pace for, or has just set, one of Game Records' records --
  // record-watch.js holds the rules (the Worker's notification uses the same
  // file). The history is rebuilt when league.json or the player records
  // arrive; player records are a nice-to-have and load on their own.
  let rwBook = null, rwFor = null, rwPlayers = null;
  const RW_LINES = 4;
  function recordHtml(m) {
    if (!leagueGames || shownYear() !== leagueYear) return '';
    if (!rwBook || rwFor !== leagueGames || rwBook.players !== rwPlayers) {
      rwBook = { book: RecordWatch.build(leagueGames, rwPlayers), players: rwPlayers };
      rwFor = leagueGames;
    }
    const items = RecordWatch.evaluate(rwBook.book, RecordWatch.fromMatchup(m, leagueYear, dashWeek, medianStatusKnown));
    if (!items.length) return '';
    return `<div class="mu-record">${items.slice(0, RW_LINES).map(it => {
      const [who, verb, val, tail] = it.parts;
      return `<div class="mu-rec-line"><b>${esc(who)}</b> ${verb} <b class="gold">${val}</b>${esc(tail)}<span>${esc(it.sub)}</span></div>`;
    }).join('')}</div>`;
  }

  function weekScores(week) {
    const m = new Map();
    weekGames(week).forEach(g => { m.set(g.p1, g.s1); m.set(g.p2, g.s2); });
    return m;
  }

  // ---------- Current Parlay highlight ----------
  // Same Worker, same /parlay-stats endpoint parlay-results.html itself
  // reads -- see that page's own fetch for the full shape (players, weeks,
  // live). Polled on its own 2-minute cycle, independent of the main
  // dashboard fetch above, matching how parlay-results.html keeps its own
  // live scores fresh.
  //
  // Same first-load guard as franchise.json above: until the main
  // dashboard has rendered once, just store the data -- loadDashboard
  // renders this card itself, so it appears in step with the rest of the
  // page instead of popping in alone while everything else is loading.
  let parlayData = null;
  let parlayLoadAt = 0;
  function loadParlayHighlight() {
    parlayLoadAt = Date.now();
    return fetch(WORKER_URL + '/parlay-stats', { cache: 'no-store' })
      .then(res => res.json())
      .then(d => {
        parlayData = d;
        if (!standingsData) return;
        renderParlayHighlight();
        renderStatOfMoment();
      })
      .catch(() => {});
  }
  // Same rule as the main poll: hidden tabs skip it, and coming back
  // catches up right away if the last fetch is stale.
  const PARLAY_POLL_MS = 120000;
  loadParlayHighlight();
  setInterval(() => { if (!document.hidden) loadParlayHighlight(); }, PARLAY_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - parlayLoadAt >= PARLAY_POLL_MS) loadParlayHighlight();
  });

  const PARLAY_TOTAL_BET_TYPES = new Set(['Total Points', 'Total Goals', 'Total Rounds']);
  function parlayBetType(p) { return String(p.pick || '').split(':')[0].trim(); }
  function parlayIsTotalBet(p) { return PARLAY_TOTAL_BET_TYPES.has(parlayBetType(p)); }
  const PARLAY_PROP_STAT_UNITS = {
    'Anytime TD': ['TD', 'TDs'], 'Passing TD': ['Pass TD', 'Pass TDs'],
    'Passing Yards': ['Pass Yd', 'Pass Yds'], 'Receiving Yards': ['Rec Yd', 'Rec Yds'], 'Total Yards': ['Yd', 'Yds'],
    'Receptions': ['Rec', 'Rec'], 'Interceptions': ['INT', 'INTs'], 'Home Runs': ['HR', 'HRs'], 'Player Points': ['Pt', 'Pts'],
  };
  // Mirrors parlay-results.html's own liveText -- a totals bet shows the
  // combined score (the thing actually being bet on), everything else the
  // raw score; a prop leads with its tracked stat ("0 TDs · 17-14 · Halftime").
  function parlayLiveText(entry, p) {
    // entry.detail is ESPN's own phrase for where the game stands right now
    // ("Top 1st" for baseball, "4:32 - 2nd Quarter" for football), already
    // correct per sport -- falls back to the old quarter/clock guess only
    // if ESPN didn't supply one.
    const state = entry.detail ? ` · ${entry.detail}` : (entry.period ? ` · Q${entry.period} ${entry.clock || ''}`.trim() : '');
    const a = Math.round(entry.team_score), b = Math.round(entry.opponent_score);
    if (entry.kind !== 'team') {
      const n = entry.stat % 1 === 0 ? entry.stat : entry.stat.toFixed(1);
      const [one, many] = PARLAY_PROP_STAT_UNITS[parlayBetType(p)] || ['', ''];
      const stat = `${n} ${entry.stat === 1 ? one : many}`.trim();
      return entry.team_score == null ? stat : `${stat} · ${a}-${b}${state}`;
    }
    return `${parlayIsTotalBet(p) ? a + b : `${a}-${b}`}${state}`;
  }

  function renderParlayHighlight() {
    const container = document.getElementById('parlay-highlight-container');
    if (!container || !parlayData) return;
    const weeks = parlayData.weeks || [];
    if (!weeks.length) { container.innerHTML = ''; return; }
    const week = weeks[weeks.length - 1];
    const players = parlayData.players || [];
    const legs = players.filter(p => week.picks[p]).map(p => [p, week.picks[p]])
      .sort((a, b) => (a[1].gametime || '9999').localeCompare(b[1].gametime || '9999'));
    if (!legs.length) { container.innerHTML = ''; return; }

    // The Parlay Results hero in small (audit XI #7): the payout and the
    // chance to cash, a pip per leg in game order (gold once it hits, red
    // once it misses, the next one outlined), and the leg that's live or
    // next. A dead week says who sank it and what it would have paid.
    const wins = legs.filter(([, p]) => p.result === 'Win').length;
    const pending = legs.filter(([, p]) => p.result === 'Pending');
    const live = parlayData.live || {};
    const liveKey = name => `${week.year}:${week.week}:${name}`;
    const result = week.final && week.final.result;
    const status = result === 'Loss' ? 'Dead' : result === 'Win' ? 'Hit' : 'Alive';
    const statusTone = result === 'Loss' ? 'loss' : result === 'Win' ? 'turf' : 'gold';
    const dec = o => 1 + (o > 0 ? o / 100 : 100 / -o);
    const nextLeg = pending.find(([name]) => live[liveKey(name)]) || pending[0];
    const nextI = status === 'Alive' && nextLeg ? legs.indexOf(nextLeg) : -1;
    const day = iso => (iso ? PARLAY_DAYS[new Date(iso).getDay()] : '');
    const pips = legs.map(([name, p], i) => {
      const cls = [p.result === 'Win' ? 'hit' : p.result === 'Loss' ? 'miss' : i === nextI ? 'next' : '', isMe(name) ? 'mine' : ''].filter(Boolean).join(' ');
      return `<i class="${cls}" title="${esc(name)}">${esc(monogram(name))}</i>`;
    }).join('');
    const days = legs.map(([, p]) => `<span>${day(p.gametime)}</span>`).join('');
    const pay = fmtMoney(week.final && week.final.payout);
    let top = '', line = '';
    if (status === 'Dead') {
      const killer = legs.find(([, p]) => p.result === 'Loss');
      top = `<div><div class="ph-k">Would have paid</div><div class="ph-pay dim">${pay}</div></div>
        <div class="pr-chance"><div class="k">Killed by</div><div class="v loss">${esc(killer ? killer[0] : (week.killed_by || []).join(' & '))}</div></div>`;
      if (killer) line = `<b>${esc(killer[0])}</b> · ${esc(String(killer[1].pick || '').replace(/^[^:]+:\s*/, ''))} · leg ${legs.indexOf(killer) + 1} of ${legs.length}${week.sacko ? ` · Sacko: <b>${esc(week.sacko)}</b>` : ''}`;
    } else if (status === 'Hit') {
      top = `<div><div class="ph-k">Paid</div><div class="ph-pay">${pay}</div></div><div class="pr-chance"><div class="k">Legs hit</div><div class="v">${wins} of ${legs.length}</div></div>`;
      if (week.final && week.final.split) line = `Split <b>${fmtMoney(week.final.split)}</b> each`;
    } else {
      const priced = pending.length && pending.every(([, p]) => typeof p.odds === 'number');
      const dLeft = pending.reduce((t, [, p]) => t * dec(p.odds), 1);
      top = `<div><div class="ph-k">Payout</div><div class="ph-pay">${pay}</div></div>${priced ? `<div class="pr-chance"><div class="k">Chance to cash</div><div class="v">1 in ${Math.round(dLeft).toLocaleString()}</div></div>` : ''}`;
      if (nextLeg) {
        const [name, p] = nextLeg, entry = live[liveKey(name)];
        line = entry ? `<span class="ph-live"><span class="dot"></span>Live</span> <b>${esc(name)}</b> · ${esc(parlayLiveText(entry, p))}`
          : `Next: <b>${esc(name)}</b> · ${esc(parlayBetType(p))} · ${esc(fmtKickoff(p.gametime))}${typeof p.odds === 'number' ? ` · <b>${Math.round(100 / dec(p.odds))}%</b> by the odds` : ''}`;
      }
    }
    // A real link (site audit II #21), not a div with a click handler, so a
    // keyboard can reach it and a long press offers Open in New Tab.
    container.innerHTML = `
      <a class="parlay-highlight" href="parlay-results.html">
        <div class="ph-head">
          <div class="ph-title">Current Parlay</div>
          <span class="badge ${statusTone}">${status === 'Alive' ? `Alive · ${wins} of ${legs.length}` : status}</span>
        </div>
        <div class="pr-top">${top}</div>
        <div class="pr-pips" style="--n:${legs.length}" role="img" aria-label="${wins} of ${legs.length} legs hit">${pips}</div>
        <div class="pr-days" style="--n:${legs.length}" aria-hidden="true">${days}</div>
        ${line ? `<div class="pr-line ph-line"><span>${line}</span></div>` : ''}
      </a>`;
  }

  // Facts League Lore can pull from the same current-week parlay data the
  // highlight card above renders -- a different voice (a passing aside, not
  // a live status readout), so it's kept out of the pool the highlight card
  // itself would duplicate (nothing here just restates which leg is live).
  function currentParlayFacts(data) {
    const weeks = data.weeks || [];
    if (!weeks.length) return [];
    const week = weeks[weeks.length - 1];
    const picks = Object.keys(week.picks || {});
    if (!picks.length) return [];
    const remaining = picks.filter(name => week.picks[name].result === 'Pending').length;
    const result = week.final && week.final.result;
    const facts = [];
    const add = (cond, text) => { if (cond) facts.push(text); };

    add(result === 'Loss' && week.killed_by && week.killed_by.length,
      `${hi(week.killed_by.join(' & '))} killed this week's parlay, what a dick.`);
    add(result === 'Win', `This week's parlay hit for ${hi(fmtMoney(week.final.payout))}.`);
    add(result !== 'Win' && result !== 'Loss' && remaining > 0,
      `The current parlay is still alive with ${hi(remaining)} leg${remaining === 1 ? '' : 's'} remaining.`);
    return facts;
  }

  function currentYearFacts(data) {
    const teams = data.teams || [];
    if (!teams.length) return [];
    const facts = [];
    const add = (cond, text) => { if (cond) facts.push(text); };

    // teams[] already arrives ranked best-record-first, same assumption
    // Current Standings relies on.
    const byPF = [...teams].sort((a, b) => (b.pointsFor || 0) - (a.pointsFor || 0));
    const byPA = [...teams].sort((a, b) => (b.pointsAgainst || 0) - (a.pointsAgainst || 0));
    const byDiff = [...teams].sort((a, b) =>
      ((b.pointsFor || 0) - (b.pointsAgainst || 0)) - ((a.pointsFor || 0) - (a.pointsAgainst || 0)));
    const byOdds = teams.filter(t => typeof t.playoffPct === 'number').sort((a, b) => (b.playoffPct || 0) - (a.playoffPct || 0));

    add(byPF[0], `${who(byPF[0])} leads the league with ${hi(fmtScore(byPF[0] && byPF[0].pointsFor))} points for this year.`);
    add(byPF.length > 1, `${who(byPF[byPF.length - 1])} has the league's fewest points for this year, just ${hi(fmtScore(byPF[byPF.length - 1] && byPF[byPF.length - 1].pointsFor))}.`);
    add(byPA[0], `${who(byPA[0])} has allowed more points than anyone this year, ${hi(fmtScore(byPA[0] && byPA[0].pointsAgainst))} against.`);
    add(byPA.length > 1, `${who(byPA[byPA.length - 1])} has the league's stingiest schedule this year, allowing just ${hi(fmtScore(byPA[byPA.length - 1] && byPA[byPA.length - 1].pointsAgainst))}.`);
    add(teams[0], `${who(teams[0])} owns the league's best record this year at ${hi(teams[0] && teams[0].record)}.`);
    add(teams.length > 1, `${who(teams[teams.length - 1])} is holding down the league cellar this year at ${hi(teams[teams.length - 1] && teams[teams.length - 1].record)}.`);
    add(byDiff[0], `${who(byDiff[0])} has the league's best point differential this year at ${hi('+' + fmtScore((byDiff[0].pointsFor || 0) - (byDiff[0].pointsAgainst || 0)))}.`);
    add(byDiff.length > 1, `${who(byDiff[byDiff.length - 1])} has the league's worst point differential this year at ${hi(fmtScore((byDiff[byDiff.length - 1].pointsFor || 0) - (byDiff[byDiff.length - 1].pointsAgainst || 0)))}.`);
    add(byOdds[0], `${who(byOdds[0])} has the best playoff odds in the league right now at ${hi(RaceSim.pct(byOdds[0] && byOdds[0].playoffPct))}.`);
    add(byOdds.length > 1, `${who(byOdds[byOdds.length - 1])} has the longest playoff odds in the league right now, just ${hi(RaceSim.pct(byOdds[byOdds.length - 1] && byOdds[byOdds.length - 1].playoffPct))}.`);

    const ptc = data.playoffTeamCount || 0;
    add(ptc > 0 && teams[ptc - 1], `${who(teams[ptc - 1])} is clinging to the final playoff spot, at #${ptc}.`);
    add(ptc > 0 && teams[ptc], `${who(teams[ptc])} is first team out of the playoff picture right now.`);

    const pfRank = new Map(byPF.map((t, i) => [t.name, i]));
    add(teams[0] && pfRank.get(teams[0].name) >= 3,
      `${who(teams[0])} has the league's best record this year without even cracking the points-for top 3 -- a certified Paper Champion.`);
    const unlucky = teams.slice(Math.ceil(teams.length / 2)).find(t => pfRank.get(t.name) < 3);
    add(unlucky, `${who(unlucky)} is stuck in the bottom half of the standings despite a top-3 points-for total -- snake-bitten doesn't begin to cover it.`);
    add(byPF.length, `${who(byPF[byPF.length - 1])} has quietly put up the league's fewest points all year -- the Human Victory Cigar.`);

    const h = data.priorSeasonHigh;
    add(h && h.score, `${(h && (h.manager || h.team)) || ''} set this year's high score to beat, ${hi(fmtScore(h && h.score))} in Week ${h && h.week}.`);

    return facts;
  }

  // Past members no longer in the league -- individual career stats about
  // them personally are stale/irrelevant trivia at this point, but a
  // *current* manager's good head-to-head record against one of them is
  // still fair game (that's the current manager's stat, not theirs), per
  // request.
  const PAST_MEMBERS = new Set(['Chappy', 'Corey']);

  function allTimeFacts(franchise) {
    const allPlayers = (franchise && franchise.players) || [];
    if (!allPlayers.length) return [];
    const players = allPlayers.filter(p => !PAST_MEMBERS.has(p.name));
    const facts = [];
    const add = (cond, text) => { if (cond) facts.push(text); };
    const maxBy = (arr, f) => arr.reduce((a, b) => (a === null || f(b) > f(a) ? b : a), null);
    const minBy = (arr, f) => arr.reduce((a, b) => (a === null || f(b) < f(a) ? b : a), null);
    // maxBy picks one winner even when several managers share the top value,
    // which turned a three-way tie into "X, more than anyone". Use this for
    // any fact that claims a record: it returns the value and everyone at it.
    const topTied = (arr, f) => {
      if (!arr.length) return { value: null, names: [] };
      const value = Math.max(...arr.map(f));
      return { value, names: arr.filter(p => f(p) === value).map(p => p.name) };
    };
    const nameList = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    const has = (p, f) => typeof f(p) === 'number';
    // season_history includes the season in progress (final_standing 0,
    // live reg_standing) -- leave it out of any career average or record.
    const completedSeasons = p => (p.season_history || []).filter(s => s.final_standing !== 0 && typeof s.reg_standing === 'number');
    // Fisher-Yates-ish: good enough for "pick a handful at random" on a
    // list this small, not used anywhere order-sensitive.
    const sampleUpTo = (arr, n) => arr.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, x]) => x);

    const withChamps = players.filter(p => has(p, p => p.career && p.career.standings && p.career.standings.championships));
    const champTop = topTied(withChamps, p => p.career.standings.championships);
    add(champTop.value > 0, champTop.names.length > 1
      ? `${nameList(champTop.names)} are tied for the most championships in league history with ${hi(champTop.value)}.`
      : `${champTop.names[0]} has the most championships in league history with ${hi(champTop.value)}.`);

    const withWinPct = players.filter(p => has(p, p => p.career && p.career.win_rates && p.career.win_rates.reg_pct));
    const bestWinPct = maxBy(withWinPct, p => p.career.win_rates.reg_pct);
    const worstWinPct = minBy(withWinPct, p => p.career.win_rates.reg_pct);
    add(bestWinPct, `${bestWinPct && bestWinPct.name} has the best all-time regular season win rate at ${hi(fmtPct(bestWinPct && bestWinPct.career.win_rates.reg_pct))}.`);
    add(worstWinPct, `${worstWinPct && worstWinPct.name} has the worst all-time regular season win rate at ${hi(fmtPct(worstWinPct && worstWinPct.career.win_rates.reg_pct))}.`);

    const withTotalPF = players.filter(p => has(p, p => p.career && p.career.points && p.career.points.total_pf));
    const topTotalPF = maxBy(withTotalPF, p => p.career.points.total_pf);
    add(topTotalPF, `${topTotalPF && topTotalPF.name} has scored more career points than anyone in league history, ${hi(fmtScore(topTotalPF && topTotalPF.career.points.total_pf))}.`);

    const withHigh = players.filter(p => has(p, p => p.extremes && p.extremes.highest_score));
    const topHigh = maxBy(withHigh, p => p.extremes.highest_score);
    add(topHigh, `${topHigh && topHigh.name} owns the single-week scoring record in league history, ${hi(fmtScore(topHigh && topHigh.extremes.highest_score))}.`);
    const withLow = players.filter(p => has(p, p => p.extremes && p.extremes.lowest_score));
    const lowLow = topTied(withLow, p => -p.extremes.lowest_score);
    add(lowLow.names.length, lowLow.names.length > 1
      ? `${nameList(lowLow.names)} share the lowest single-week score in league history, just ${hi(fmtScore(-lowLow.value))}.`
      : `${lowLow.names[0]} is responsible for the lowest single-week score in league history, just ${hi(fmtScore(-lowLow.value))}.`);

    // Weekly highs, lows and the median bubble, every regular-season week
    // since 2015 (weeklyFinishes in page-common.js, the tally Franchise's
    // Weekly tab shows). Needs league.json, which the first render waits for.
    if (leagueGames) {
      const wf = weeklyFinishes(leagueGames);
      const pool = new Set(players.map(p => p.name));
      [
        ['high', (n, v) => `${n} has posted the week's top score ${v} times, more than anyone.`, (n, v) => `${n} are tied for the most weekly high scores, ${v} each.`],
        ['low', (n, v) => `${n} has posted the week's lowest score ${v} times, more than anyone.`, (n, v) => `${n} are tied for the most weekly low scores, ${v} each.`],
        ['bubW', (n, v) => `${n} has squeaked past the weekly median ${v} times, more than anyone.`, (n, v) => `${n} are tied for the most bubble wins, squeaking past the weekly median ${v} times each.`],
        ['bubL', (n, v) => `${n} has missed the weekly median by one spot ${v} times, more than anyone.`, (n, v) => `${n} are tied for the most bubble losses, missing the weekly median by one spot ${v} times each.`],
        // Site audit II #30 and #34: the median against the matchup, and
        // the extremes of a manager's own scoring.
        ['stolen', (n, v) => `${n} has stolen ${v} wins while scoring below the weekly median, more than anyone.`, (n, v) => `${n} are tied for the most wins stolen below the weekly median, ${v} each.`],
        ['robbed', (n, v) => `${n} has been robbed ${v} times, losing while scoring above the weekly median, more than anyone.`, (n, v) => `${n} are tied for the most losses while scoring above the weekly median, ${v} each.`],
        ['boom', (n, v) => `${n} has had ${v} weeks of ${BOOM_PTS} or more, more than anyone.`, (n, v) => `${n} are tied for the most ${BOOM_PTS}-point weeks, ${v} each.`],
        ['bust', (n, v) => `${n} has had ${v} weeks under ${BUST_PTS}, more than anyone.`, (n, v) => `${n} are tied for the most weeks under ${BUST_PTS}, ${v} each.`],
      ].forEach(([key, one, tied]) => {
        const top = weeklyLeaders(wf, key, pool);
        add(top.names.length, top.names.length > 1 ? tied(nameList(top.names), hi(top.value)) : one(top.names[0], hi(top.value)));
      });
      // Swing: the standard deviation of weekly scores, to one decimal so a
      // tie is a real tie. Two seasons' worth of weeks before anyone counts.
      const swings = [...wf.by].filter(([n, t]) => pool.has(n) && t.weeks >= 26).map(([n, t]) => [n, Math.round(t.sd * 10) / 10]);
      if (swings.length) {
        const hiSd = Math.max(...swings.map(x => x[1])), loSd = Math.min(...swings.map(x => x[1]));
        const at = v => swings.filter(x => x[1] === v).map(x => x[0]);
        const wide = at(hiSd), steady = at(loSd);
        add(true, wide.length > 1
          ? `${nameList(wide)} are tied for the league's wildest scoring, swinging ${hi(hiSd.toFixed(1))} points from their own average in a typical week.`
          : `${wide[0]} has the league's wildest scoring, swinging ${hi(hiSd.toFixed(1))} points from their own average in a typical week.`);
        add(true, steady.length > 1
          ? `${nameList(steady)} are tied for the league's steadiest scoring, a typical week landing within ${hi(loSd.toFixed(1))} points of their own average.`
          : `${steady[0]} has the league's steadiest scoring, a typical week landing within ${hi(loSd.toFixed(1))} points of their own average.`);
      }
    }

    const withWinMargin = players.filter(p => has(p, p => p.extremes && p.extremes.biggest_win_margin));
    const topWinMargin = maxBy(withWinMargin, p => p.extremes.biggest_win_margin);
    add(topWinMargin, `${topWinMargin && topWinMargin.name} is behind the biggest single-game blowout in league history, a ${hi(fmtScore(topWinMargin && topWinMargin.extremes.biggest_win_margin))}-point win.`);
    const withLossMargin = players.filter(p => has(p, p => p.extremes && p.extremes.biggest_loss_margin));
    const topLossMargin = maxBy(withLossMargin, p => p.extremes.biggest_loss_margin);
    add(topLossMargin, `${topLossMargin && topLossMargin.name} is on the wrong end of the worst beatdown in league history, a ${hi(fmtScore(topLossMargin && topLossMargin.extremes.biggest_loss_margin))}-point loss.`);

    // Two streak rules, both real, and they disagree (Kris's 12 with median
    // games vs Flanders/Chad/Collin's 10 head-to-head). Every streak fact
    // names its rule, matching League History's "Head-to-Head" / "With
    // Median" tabs, so the card never contradicts that page.
    const STREAK_RULES = [
      { key: 'head_to_head', label: 'head-to-head' },
      { key: 'combined', label: 'with median games' },
    ];
    STREAK_RULES.forEach(({ key, label }) => {
      [['longest_win', 'winning'], ['longest_loss', 'losing']].forEach(([field, kind]) => {
        const withStreak = players.filter(p => has(p, p => p.streaks && p.streaks[key] && p.streaks[key][field]));
        const top = topTied(withStreak, p => p.streaks[key][field]);
        add(top.value > 0, top.names.length > 1
          ? `${nameList(top.names)} are tied for the league's longest ${kind} streak ever, ${label}, at ${hi(top.value)} games.`
          : `${top.names[0]} holds the league's longest ${kind} streak ever, ${label}, at ${hi(top.value)} games.`);
      });
    });

    const withSackos = players.filter(p => has(p, p => p.weekly_sackos));
    const topSackos = maxBy(withSackos, p => p.weekly_sackos);
    add(topSackos && topSackos.weekly_sackos > 0, `${topSackos && topSackos.name} has taken home the most weekly Sacko awards in league history, ${hi(topSackos && topSackos.weekly_sackos)}.`);
    const withSeasonSackos = players.filter(p => has(p, p => p.career && p.career.standings && p.career.standings.sackos));
    const sackoTop = topTied(withSeasonSackos, p => p.career.standings.sackos);
    add(sackoTop.value > 0, sackoTop.names.length > 1
      ? `${nameList(sackoTop.names)} are all tied for the most league Sackos with ${hi(sackoTop.value)}.`
      : `${sackoTop.names[0]} has finished the full season as Sacko ${hi(sackoTop.value)} time${sackoTop.value === 1 ? '' : 's'}, more than anyone.`);

    // has() takes the value itself, not a true/false test -- passing it a
    // `typeof x === 'number'` check made these pools silently empty.
    const withMoney = players.filter(p => has(p, p => p.money && p.money.net_result));
    const moneyUp = topTied(withMoney, p => p.money.net_result);
    const moneyDown = topTied(withMoney, p => -p.money.net_result);
    add(moneyUp.value > 0, moneyUp.names.length > 1
      ? `${nameList(moneyUp.names)} are tied for the most money up in league history, ${hi(fmtMoney(moneyUp.value))} each.`
      : `${moneyUp.names[0]} is up the most money in league history, ${hi(fmtMoney(moneyUp.value))}.`);
    add(moneyDown.value > 0, moneyDown.names.length > 1
      ? `${nameList(moneyDown.names)} are tied for the most money down in league history, ${hi(fmtMoney(moneyDown.value))} each.`
      : `${moneyDown.names[0]} is down the most money in league history, ${hi(fmtMoney(moneyDown.value))}.`);

    const withEff = players.filter(p => has(p, p => p.efficiency && p.efficiency.career_pct));
    const topEff = maxBy(withEff, p => p.efficiency.career_pct);
    add(topEff, `${topEff && topEff.name} sets the best lineups in the league, starting their optimal roster ${hi(fmtPct(topEff && topEff.efficiency.career_pct))} of the time.`);
    const withBenchLoss = players.filter(p => has(p, p => p.efficiency && p.efficiency.points_left_on_bench));
    const topBenchLoss = maxBy(withBenchLoss, p => p.efficiency.points_left_on_bench);
    add(topBenchLoss, `${topBenchLoss && topBenchLoss.name} has left more points on the bench than anyone in league history, ${hi(fmtScore(topBenchLoss && topBenchLoss.efficiency.points_left_on_bench))}.`);

    const withAllPlay = players.filter(p => has(p, p => p.all_play && p.all_play.pct));
    const topAllPlay = maxBy(withAllPlay, p => p.all_play.pct);
    add(topAllPlay, `${topAllPlay && topAllPlay.name} would have the league's best record if everyone played everyone every week, at ${hi(fmtPct(topAllPlay && topAllPlay.all_play.pct))}.`);

    // Schedule luck: actual win rate minus all-play win rate, rounded so
    // float noise can't split a real tie.
    const luck = p => (p.all_play && typeof p.all_play.pct === 'number' && p.career && typeof p.career.win_rates.reg_pct === 'number')
      ? Math.round((p.career.win_rates.reg_pct - p.all_play.pct) * 10) / 10 : null;
    const withLuck = players.filter(p => has(p, luck));
    const unlucky = topTied(withLuck, p => -luck(p));
    const lucky = topTied(withLuck, luck);
    add(unlucky.value > 0, unlucky.names.length > 1
      ? `${nameList(unlucky.names)} are tied as the league's unluckiest managers, each winning ${hi(fmtPct(unlucky.value))} less often than their all-play record says they should.`
      : `${unlucky.names[0]} has been the league's unluckiest manager, winning ${hi(fmtPct(unlucky.value))} less often than their all-play record says they should.`);
    add(lucky.value > 0, lucky.names.length > 1
      ? `${nameList(lucky.names)} are tied as the league's luckiest managers, each winning ${hi(fmtPct(lucky.value))} more often than their all-play record says they should.`
      : `${lucky.names[0]} has been the league's luckiest manager, winning ${hi(fmtPct(lucky.value))} more often than their all-play record says they should.`);

    // Record against the weekly median game alone -- the same career figure
    // as League History's Vs Median ranking, in-progress season included.
    // Ranked by win rate; the record is only quoted for a tie when every
    // tied manager has the same one.
    const withMedian = players.filter(p => has(p, p => p.career && p.career.median && p.career.median.pct));
    const medRec = p => `${p.career.median.wins}-${p.career.median.losses}`;
    const medianFact = (top, best) => {
      if (!top.names.length) return;
      const tied = withMedian.filter(p => top.names.includes(p.name));
      const pct = fmtPct(best ? top.value : -top.value);
      const sameRec = tied.every(p => medRec(p) === medRec(tied[0]));
      const word = best ? 'best' : 'worst';
      add(true, tied.length > 1
        ? `${nameList(top.names)} are tied for the ${word} record against the weekly median, ${sameRec ? `${hi(medRec(tied[0]))} (${pct}) each` : hi(pct)}.`
        : `${tied[0].name} has the ${word} record against the weekly median, ${hi(medRec(tied[0]))} (${pct}).`);
    };
    medianFact(topTied(withMedian, p => p.career.median.pct), true);
    medianFact(topTied(withMedian, p => -p.career.median.pct), false);

    // ----- More single-league-record facts, to keep the rivalry facts
    // below from dominating the pool just by sheer per-manager volume. -----
    const withPlayoffApps = players.filter(p => has(p, p => p.career && p.career.standings && p.career.standings.playoff_appearances));
    const topPlayoffApps = maxBy(withPlayoffApps, p => p.career.standings.playoff_appearances);
    add(topPlayoffApps, `${topPlayoffApps && topPlayoffApps.name} has made the playoffs more times than anyone in league history, ${hi(topPlayoffApps && topPlayoffApps.career.standings.playoff_appearances)} times.`);

    const withChampApps = players.filter(p => has(p, p => p.career && p.career.standings && p.career.standings.champ_appearances));
    const topChampApps = maxBy(withChampApps, p => p.career.standings.champ_appearances);
    const champsOf = p => (p.career && p.career.standings && p.career.standings.championships) || 0;
    add(topChampApps && topChampApps.career.standings.champ_appearances > champsOf(topChampApps),
      `${topChampApps && topChampApps.name} has made the championship game ${hi(topChampApps && topChampApps.career.standings.champ_appearances)} times but only won it ${hi(champsOf(topChampApps))} -- the league's resident bridesmaid.`);

    // ----- Funny: founding members with no championship. Computed live
    // off founded_year (the league's actual inaugural year) rather than
    // hand-listed, so it can't go stale if someone on it finally wins one
    // -- excludes past members same as everything else above (also
    // specifically excludes Chappy per request, though he's already
    // covered by that same exclusion). -----
    const foundingYear = Math.min(...allPlayers.map(p => p.founded_year).filter(y => typeof y === 'number'));
    const neverWonFounders = players.filter(p => p.founded_year === foundingYear && champsOf(p) === 0);
    add(neverWonFounders.length > 0,
      `Look at all these founding members that have never won a ship: ${hi(neverWonFounders.map(p => p.name).join(', '))}.`);

    // career.standings.best/worst_regular_finish count the season in
    // progress (Jon's "best 2" was a Week 3 rank), so finishes come from
    // completed seasons only.
    const finishes = p => completedSeasons(p).map(s => s.reg_standing);
    const withFinishes = players.filter(p => finishes(p).length);
    // Regular-season championship = finishing the regular season #1.
    const regTitles = p => finishes(p).filter(n => n === 1).length;
    const regChamps = withFinishes.filter(p => regTitles(p) > 0).map(p => p.name);
    const regNever = withFinishes.filter(p => regTitles(p) === 0).map(p => p.name);
    add(regChamps.length, regChamps.length > 1
      ? `${hi(nameList(regChamps))} have all won a regular-season championship.`
      : `${hi(regChamps[0])} is the only manager to win a regular-season championship.`);
    add(regNever.length, regNever.length > 1
      ? `${hi(nameList(regNever))} have never won a regular-season championship.`
      : `${hi(regNever[0])} is the only manager who has never won a regular-season championship.`);
    // Only a record once someone has more than one -- at 1 apiece it's the
    // "have all won" fact above again.
    const regTop = topTied(withFinishes, regTitles);
    add(regTop.value > 1, regTop.names.length > 1
      ? `${nameList(regTop.names)} are tied for the most regular-season championships, finishing #1 ${hi(regTop.value)} times each.`
      : `${regTop.names[0]} has the most regular-season championships, finishing #1 ${hi(regTop.value)} times.`);
    const worstFinishTop = topTied(withFinishes, p => Math.max(...finishes(p)));
    add(worstFinishTop.names.length, worstFinishTop.names.length > 1
      ? `${nameList(worstFinishTop.names)} have all finished dead last in the regular season, ${hi('#' + worstFinishTop.value)}.`
      : `${worstFinishTop.names[0]} has finished dead last in the regular season, ${hi('#' + worstFinishTop.value)}, worse than anyone else ever has.`);

    const withByes = players.filter(p => has(p, p => p.career && p.career.standings && p.career.standings.byes));
    const topByes = maxBy(withByes, p => p.career.standings.byes);
    add(topByes && topByes.career.standings.byes > 0, `${topByes && topByes.name} has earned more first-round playoff byes than anyone, ${hi(topByes && topByes.career.standings.byes)}.`);

    const withBlowoutWins = players.filter(p => has(p, p => p.extremes && p.extremes.blowout_wins));
    const topBlowoutWins = maxBy(withBlowoutWins, p => p.extremes.blowout_wins);
    add(topBlowoutWins, `${topBlowoutWins && topBlowoutWins.name} has racked up more blowout wins than anyone in league history, ${hi(topBlowoutWins && topBlowoutWins.extremes.blowout_wins)}.`);
    const withBlowoutLosses = players.filter(p => has(p, p => p.extremes && p.extremes.blowout_losses));
    const topBlowoutLosses = maxBy(withBlowoutLosses, p => p.extremes.blowout_losses);
    add(topBlowoutLosses, `${topBlowoutLosses && topBlowoutLosses.name} has been blown out more than anyone in league history, ${hi(topBlowoutLosses && topBlowoutLosses.extremes.blowout_losses)} times.`);
    const withCloseWins = players.filter(p => has(p, p => p.extremes && p.extremes.close_wins));
    const topCloseWins = maxBy(withCloseWins, p => p.extremes.close_wins);
    add(topCloseWins, `${topCloseWins && topCloseWins.name} has won more nail-biters than anyone in league history, ${hi(topCloseWins && topCloseWins.extremes.close_wins)} close wins.`);
    const withCloseLosses = players.filter(p => has(p, p => p.extremes && p.extremes.close_losses));
    const topCloseLosses = maxBy(withCloseLosses, p => p.extremes.close_losses);
    add(topCloseLosses, `${topCloseLosses && topCloseLosses.name} has lost more heartbreakers than anyone in league history, ${hi(topCloseLosses && topCloseLosses.extremes.close_losses)} close losses.`);
    const withLowMargin = players.filter(p => has(p, p => p.extremes && p.extremes.lowest_win_margin));
    const lowMargin = topTied(withLowMargin, p => -p.extremes.lowest_win_margin);
    add(lowMargin.names.length, lowMargin.names.length > 1
      ? `${nameList(lowMargin.names)} share the closest win margin in league history, just ${hi(fmtScore(-lowMargin.value))} points.`
      : `${lowMargin.names[0]} is responsible for the closest win margin in league history, just ${hi(fmtScore(-lowMargin.value))} points.`);

    const withPerfect = players.filter(p => has(p, p => p.efficiency && p.efficiency.perfect_lineups));
    const topPerfect = maxBy(withPerfect, p => p.efficiency.perfect_lineups);
    add(topPerfect && topPerfect.efficiency.perfect_lineups > 0, `${topPerfect && topPerfect.name} has started the perfect optimal lineup ${hi(topPerfect && topPerfect.efficiency.perfect_lineups)} times, more than anyone.`);
    const withWorstGame = players.filter(p => has(p, p => p.efficiency && p.efficiency.worst_game && p.efficiency.worst_game.diff));
    const topWorstGame = maxBy(withWorstGame, p => p.efficiency.worst_game.diff);
    if (topWorstGame) {
      const wg = topWorstGame.efficiency.worst_game;
      add(true, `In ${wg.year} Week ${wg.week}, ${topWorstGame.name} scored ${hi(fmtScore(wg.actual))} with an optimal lineup of ${fmtScore(wg.optimal)} on the bench -- the worst lineup-setting week in league history.`);
    }

    const withMoves = players.filter(p => has(p, p => p.moves && p.moves.total));
    const topMoves = maxBy(withMoves, p => p.moves.total);
    add(topMoves, `${topMoves && topMoves.name} has made more roster moves than anyone in league history, ${hi(topMoves && topMoves.moves.total)}.`);
    const fewestMoves = minBy(withMoves, p => p.moves.total);
    add(fewestMoves, `${fewestMoves && fewestMoves.name} has set the roster and mostly left it alone, just ${hi(fewestMoves && fewestMoves.moves.total)} moves in league history.`);

    const withDraftPos = players.filter(p => has(p, p => p.draft && p.draft.avg_position));
    const worstDraftPos = maxBy(withDraftPos, p => p.draft.avg_position);
    add(worstDraftPos, `${worstDraftPos && worstDraftPos.name} has the league's lowest average draft position, ${hi(fmtScore(worstDraftPos && worstDraftPos.draft.avg_position))}.`);
    const bestDraftPos = minBy(withDraftPos, p => p.draft.avg_position);
    add(bestDraftPos, `${bestDraftPos && bestDraftPos.name} has the league's highest average draft position, ${hi(fmtScore(bestDraftPos && bestDraftPos.draft.avg_position))}.`);

    // ----- Per-manager: active streak (career-spanning, from completed
    // games only -- not tied to anything still in progress). -----
    // One fact per rule, labelled like the record facts above: Kris can be
    // W4 head-to-head while his matchup card (ESPN, median included) says L1.
    // When both rules give the same run, say so once instead of twice.
    const streakText = (name, cur, label) => cur > 0
      ? `${name} is riding a ${hi(cur + '-game')} winning streak, ${label}.`
      : `${name} is mired in a ${hi(Math.abs(cur) + '-game')} losing streak, ${label}.`;
    players.forEach(p => {
      const h2h = p.streaks && p.streaks.head_to_head && p.streaks.head_to_head.current;
      const both = p.streaks && p.streaks.combined && p.streaks.combined.current;
      const h2hOk = typeof h2h === 'number' && Math.abs(h2h) >= 3;
      const bothOk = typeof both === 'number' && Math.abs(both) >= 3;
      if (h2hOk && bothOk && h2h === both) { add(true, streakText(p.name, h2h, 'with or without median games')); return; }
      add(h2hOk, h2hOk && streakText(p.name, h2h, 'head-to-head'));
      add(bothOk, bothOk && streakText(p.name, both, 'with median games'));
    });

    // ----- Per-manager: rivalries (the funny "who owns who" ones). Capped
    // to a random handful rather than every qualifying pair -- with 12+
    // managers these were crowding out everything else in the pool.
    // Nemesis (an opponent beating this manager) is skipped when that
    // opponent is a past member -- that direction makes the past member
    // look good, the one case request explicitly didn't want. Favorite
    // opponent (this manager dominating someone) is kept either way,
    // since the subject is always a current manager and a past-member
    // opponent there just means "made them look bad", which was fine. -----
    // Matches the franchise page's own "Who's Your Daddy"/"Who's Your
    // Bitch" rivalry framing -- nem.wins/losses are p's own (losing)
    // record against nem.opponent, so p is the one who's getting owned
    // here; fav.wins/losses are p's own (winning) record against
    // fav.opponent, so p is the daddy there. Previous wording attributed
    // the record to the wrong side of the matchup (said the opponent was
    // "leading" a score that was actually p's own losing record).
    const rivalryFacts = [];
    players.forEach(p => {
      const nem = p.rivalries && p.rivalries.nemesis;
      if (nem && nem.opponent && !PAST_MEMBERS.has(nem.opponent) && (nem.wins + nem.losses) >= 4) {
        rivalryFacts.push(`${p.name} is ${nem.opponent}'s bitch, losing their head-to-head series ${hi(`${nem.wins}-${nem.losses}`)} (${fmtPct(nem.win_pct)}).`);
      }
      const fav = p.rivalries && p.rivalries.favorite_opponent;
      if (fav && fav.opponent && (fav.wins + fav.losses) >= 4) {
        rivalryFacts.push(`${p.name} is ${fav.opponent}'s Daddy, leading their head-to-head series ${hi(`${fav.wins}-${fav.losses}`)} (${fmtPct(fav.win_pct)}).`);
      }
    });
    facts.push(...sampleUpTo(rivalryFacts, 6));

    // ----- Power Index: same composite overview.html computes (titles
    // 35% / win% 25% / PPG 15% / efficiency 15% / net earnings 10%, each
    // normalized 0-100 across the roster; a manager missing a component
    // has it skipped and the rest reweighted rather than zeroed). -----
    const PI_WEIGHTS = { titles: 35, win: 25, ppg: 15, eff: 15, earn: 10 };
    const piBase = players.map(p => ({
      name: p.name,
      titles: (p.career && p.career.standings && p.career.standings.championships) || 0,
      win: (p.career && p.career.win_rates && p.career.win_rates.reg_pct) ?? null,
      ppg: (p.career && p.career.points && p.career.points.avg_pf) ?? null,
      eff: (p.efficiency && p.efficiency.career_pct) ?? null,
      earn: (p.money && p.money.net_result) ?? null,
    }));
    const piNorm = {};
    Object.keys(PI_WEIGHTS).forEach(key => {
      const vals = piBase.map(r => r[key]).filter(v => v != null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      piNorm[key] = v => (v == null ? null : (hi === lo ? 100 : (v - lo) / (hi - lo) * 100));
    });
    const piScores = piBase.map(r => {
      const parts = Object.keys(PI_WEIGHTS).map(key => [key, piNorm[key](r[key])]).filter(([, v]) => v != null);
      const totalW = parts.reduce((a, [key]) => a + PI_WEIGHTS[key], 0);
      const score = totalW ? parts.reduce((a, [key, v]) => a + v * PI_WEIGHTS[key], 0) / totalW : 0;
      return { name: r.name, score };
    }).sort((a, b) => b.score - a.score);
    add(piScores[0], `${piScores[0] && piScores[0].name} has the league's best all-time Power Index, a composite of titles, win rate, scoring, efficiency, and earnings, at ${hi(fmtScore(piScores[0] && piScores[0].score))}.`);

    // ----- Clutch Factor: playoff win% minus regular-season win%, same
    // formula as overview.html/franchise.html, only for managers with at
    // least one playoff game. -----
    const clutch = players.map(p => {
      const r = p.career && p.career.record, wr = p.career && p.career.win_rates;
      if (!r || !wr || (r.playoff_w || 0) + (r.playoff_l || 0) === 0 || wr.reg_pct == null || wr.playoff_pct == null) return null;
      return { name: p.name, delta: wr.playoff_pct - wr.reg_pct };
    }).filter(Boolean);
    const mostClutch = maxBy(clutch, c => c.delta);
    const leastClutch = minBy(clutch, c => c.delta);
    // The delta is a difference of two percentages, so it's percentage
    // points, and "higher"/"lower" already carry the sign.
    const pctPts = d => `${Math.abs(d).toFixed(1)} percentage points`;
    add(mostClutch && mostClutch.delta > 0, `${mostClutch && mostClutch.name} turns it up in the playoffs, with a win rate ${hi(pctPts(mostClutch && mostClutch.delta))} higher than in the regular season.`);
    add(leastClutch && leastClutch.delta < 0, `${leastClutch && leastClutch.name} folds in the playoffs, with a win rate ${hi(pctPts(leastClutch && leastClutch.delta))} lower than in the regular season.`);

    // ----- Average regular-season finish, across every completed season
    // (the current season's rank is a weekly snapshot and would make the
    // leader change hands every week). Rounded to the 2 decimals shown so
    // float noise can't split a visible tie. -----
    const avgFinish = withFinishes.map(p => {
      const f = finishes(p);
      return { name: p.name, avg: Math.round(f.reduce((a, n) => a + n, 0) / f.length * 100) / 100 };
    });
    const bestAvg = topTied(avgFinish, a => -a.avg);
    const worstAvg = topTied(avgFinish, a => a.avg);
    add(bestAvg.names.length, bestAvg.names.length > 1
      ? `${nameList(bestAvg.names)} are tied for the league's best average regular-season finish, ${hi(fmtScore(-bestAvg.value))}.`
      : `${bestAvg.names[0]} has the league's best average regular-season finish, ${hi(fmtScore(-bestAvg.value))}.`);
    add(worstAvg.names.length, worstAvg.names.length > 1
      ? `${nameList(worstAvg.names)} are tied for the league's worst average regular-season finish, ${hi(fmtScore(worstAvg.value))}.`
      : `${worstAvg.names[0]} has the league's worst average regular-season finish, ${hi(fmtScore(worstAvg.value))}.`);

    // ----- More money: gross earnings and parlay volume (net_result,
    // above, already covers up/down -- these are different cuts of it). -----
    const withEarnings = players.filter(p => has(p, p => p.money && p.money.total_earnings));
    const topEarnings = maxBy(withEarnings, p => p.money.total_earnings);
    add(topEarnings, `${topEarnings && topEarnings.name} has won more money than anyone in league history, ${hi(fmtMoney(topEarnings && topEarnings.money.total_earnings))}, before dues.`);
    const withParlays = players.filter(p => has(p, p => p.money && p.money.parlays_purchased));
    const topParlays = maxBy(withParlays, p => p.money.parlays_purchased);
    add(topParlays && topParlays.money.parlays_purchased > 0, `${topParlays && topParlays.name} has spent more on parlays than anyone in league history, ${hi(fmtMoney(topParlays && topParlays.money.parlays_purchased))}.`);

    return facts;
  }

  // A couple of flat, data-free inside jokes in the rotation, per request.
  // Rolled separately at a flat 10% rather than being mixed into the same
  // pool as the real stats -- with 70+ real facts, an easter egg sitting
  // in that same pool would show up far less than 10% of the time.
  // The built-in list lives in lore-eggs.js; a commissioner's saved list
  // from the Lore desk (audit X #18, GET /site-info) replaces it, and a
  // pinned line shows every time until its day passes.
  let EASTER_EGG_FACTS = LORE_EGGS.slice(), LORE_PIN = null;
  function loreFromSite(lore) {
    if (!lore) return;
    if (Array.isArray(lore.eggs) && lore.eggs.length) EASTER_EGG_FACTS = lore.eggs;
    LORE_PIN = lore.pin || null;
    statRolledAt = 0;
    renderStatOfMoment(false);
  }
  const EASTER_EGG_CHANCE = 0.10;
  // Rolled separately from EASTER_EGG_FACTS, at its own flat 1%, same
  // reasoning -- this fills in a random manager dynamically (any current
  // manager with zero championships), so it can't live as a static string
  // in that array, but mixing its ~6 generated instances into the ~75-ish
  // main stat pool made it show up far more often than intended.
  const DBZ_CHANCE = 0.01;
  function dbzFact(franchise) {
    const players = ((franchise && franchise.players) || []).filter(p => !PAST_MEMBERS.has(p.name));
    const neverWon = players.filter(p => !(p.career && p.career.standings && p.career.standings.championships > 0));
    if (!neverWon.length) return null;
    const p = neverWon[Math.floor(Math.random() * neverWon.length)];
    return `Will ${p.name} ever win a ship? Find out next time on Dragon Ball Z.`;
  }

  // Easter eggs only (site audit VI #15): a commissioner's switch in You ›
  // Settings (nav.js, rl-lore-eggs on this phone). Honored only while signed
  // in as a commissioner, so signing out turns it off. The card then shows
  // every egg in order, plus one Dragon Ball Z line per current manager
  // without a title, with ‹ › to flip through them. Nobody else gets buttons.
  const loreEggsOnly = () => {
    try { return isCommissioner(getAuth()) && localStorage.getItem('rl-lore-eggs') === '1'; } catch (e) { return false; }
  };
  function eggDeck() {
    const players = ((franchiseData && franchiseData.players) || []).filter(p => !PAST_MEMBERS.has(p.name));
    const neverWon = players.filter(p => !(p.career && p.career.standings && p.career.standings.championships > 0));
    return [
      ...EASTER_EGG_FACTS.map(text => ({ text, egg: true })),
      ...neverWon.map(p => ({ text: `Will ${p.name} ever win a ship? Find out next time on Dragon Ball Z.`, egg: false })),
    ];
  }
  let eggAt = 0;
  function renderEggs(container) {
    const deck = eggDeck();
    eggAt = ((eggAt % deck.length) + deck.length) % deck.length;
    const f = deck[eggAt];
    const arrow = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    container.innerHTML = `
      <div class="stat-moment">
        <div class="stat-moment-head"><span class="stat-moment-eyebrow">Lore me daddy</span><span class="stat-moment-chip">Eggs only</span></div>
        <div class="stat-moment-box${f.egg ? ' egg' : ''}"><div class="stat-moment-text">${f.text}</div></div>
        <div class="stat-moment-nav">
          <button type="button" class="stat-moment-step" data-egg="-1" aria-label="Previous">${arrow('m15 6-6 6 6 6')}</button>
          <span class="stat-moment-count">${eggAt + 1} of ${deck.length}</span>
          <button type="button" class="stat-moment-step" data-egg="1" aria-label="Next">${arrow('m9 6 6 6-6 6')}</button>
        </div>
      </div>`;
    container.querySelectorAll('[data-egg]').forEach(b => b.addEventListener('click', () => {
      eggAt += Number(b.dataset.egg);
      renderEggs(container);
      const again = container.querySelector(`[data-egg="${b.dataset.egg}"]`);
      if (again) again.focus({ preventScroll: true });
    }));
  }

  const STAT_REROLL_MS = 2 * 60 * 1000;
  let statRolledAt = 0, statEggMode = null;
  // `poll`: from the live refresh, which keeps the current fact until
  // STAT_REROLL_MS is up instead of flipping it every 15 seconds. Turning
  // easter eggs only on or off redraws at once.
  function renderStatOfMoment(poll) {
    const container = document.getElementById('stat-of-moment-container');
    if (!container) return;
    const eggs = loreEggsOnly();
    const switched = eggs !== statEggMode;
    statEggMode = eggs;
    if (eggs) {
      // The poll leaves it alone, so a fact never changes under you.
      if (switched || !poll || !container.innerHTML.trim()) renderEggs(container);
      return;
    }
    if (!switched && poll && container.innerHTML.trim() && Date.now() - statRolledAt < STAT_REROLL_MS) return;
    statRolledAt = Date.now();
    // A pinned line (the Lore desk) is the fact until its day passes.
    if (LORE_PIN) {
      container.innerHTML = `<div class="stat-moment"><div class="stat-moment-eyebrow">League Lore</div><div class="stat-moment-box egg"><div class="stat-moment-text">${LORE_PIN}</div></div></div>`;
      return;
    }
    const data = standingsData;
    let text, isEgg = false;
    const roll = Math.random();
    const dbz = roll >= EASTER_EGG_CHANCE && roll < EASTER_EGG_CHANCE + DBZ_CHANCE ? dbzFact(franchiseData) : null;
    if (roll < EASTER_EGG_CHANCE) {
      text = EASTER_EGG_FACTS[Math.floor(Math.random() * EASTER_EGG_FACTS.length)];
      isEgg = true;
    } else if (dbz) {
      text = dbz;
    } else {
      const facts = [
        ...(data ? currentYearFacts(data) : []),
        ...allTimeFacts(franchiseData),
        ...(parlayData ? currentParlayFacts(parlayData) : []),
      ];
      if (!facts.length) { container.innerHTML = ''; return; }
      text = facts[Math.floor(Math.random() * facts.length)];
    }
    // Independent roll from the body text above -- "Lore me daddy" can
    // land on any stat/joke, not just its own slot.
    const heading = Math.random() < EASTER_EGG_CHANCE ? 'Lore me daddy' : 'League Lore';
    container.innerHTML = `
      <div class="stat-moment">
        <div class="stat-moment-eyebrow">${heading}</div>
        <div class="stat-moment-box${isEgg ? ' egg' : ''}"><div class="stat-moment-text">${text}</div></div>
      </div>`;
  }

  // ---------- Week in Review (site audit 28; audit V #1, #2) ----------
  // Between the last Monday night game and Thursday's kickoff the rest of
  // the dashboard is a frozen Sunday, so a recap of the finished week leads
  // the page. Two sources, whichever is current:
  //   - this week from the Worker, once every starter on every team is done
  //     (Monday night, before ESPN rolls the week over);
  //   - last week from league.json, once the new week is up but nobody has
  //     scored yet (and only when league.json has that week), until
  //     Thursday at 12 AM Eastern, when the new week takes over the page.
  // Add ?recap to the URL to show the latest finished week at any time.
  const FORCE_RECAP = /[?&]recap\b/.test(location.search);
  // Thursday through Sunday, Eastern: last week's recap is put away.
  const recapOver = () => ['Thu', 'Fri', 'Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()));

  function recapWeek(data) {
    const week = data.week || 1;
    const teams = data.teams || [];
    const matchups = data.matchups || [];
    const scored = teams.some(t => (t.current || 0) > 0);
    const allDone = medianStatusKnown && scored && teams.every(t => !(t.remaining || 0) && !(t.inPlay || 0));
    if (allDone && matchups.length) {
      return {
        week,
        // bracket: the Worker's name for a playoff game ('Cons', 'Sacko', ...).
        games: matchups.map(m => ({ a: m.awayManager || m.awayName, b: m.homeManager || m.homeName, sa: parseFloat(m.awayScore) || 0, sb: parseFloat(m.homeScore) || 0, ba: m.awayBest, bb: m.homeBest, type: m.bracket || null })),
      };
    }
    if ((scored || recapOver()) && !FORCE_RECAP) return null;
    for (let w = week - 1; w >= 1; w--) {
      const gs = weekGames(w);
      if (gs.length) {
        return { week: w, median: gs[0].median, games: gs.map(g => ({ a: g.p1, b: g.p2, sa: g.s1, sb: g.s2 })) };
      }
      if (!FORCE_RECAP) break;
    }
    return null;
  }

  // Each team's best possible lineup (the Worker's awayBest/homeBest), for
  // "Left the win on the bench". The live path carries it; a week read from
  // league.json borrows the Worker's rebuild of that week (the week
  // stepper's own cache) and renders again once it's in.
  const recapBestByWeek = new Map(); // week -> { manager: best } | null while loading
  function recapBest(rw) {
    const fromGames = list => {
      const out = {};
      list.forEach(g => {
        if (typeof g.ba === 'number') out[g.a] = g.ba;
        if (typeof g.bb === 'number') out[g.b] = g.bb;
      });
      return Object.keys(out).length ? out : null;
    };
    const live = fromGames(rw.games);
    if (live || !leagueYear) return live;
    if (!recapBestByWeek.has(rw.week)) {
      recapBestByWeek.set(rw.week, null);
      const key = `${leagueYear}:${rw.week}`;
      if (!pastWeeks.has(key)) {
        pastWeeks.set(key, fetchCurrentSeasonWeek(rw.week).catch(err => { pastWeeks.delete(key); throw err; }));
      }
      pastWeeks.get(key)
        .then(d => {
          const best = fromGames((d.matchups || []).map(m => ({ a: m.awayManager || m.awayName, b: m.homeManager || m.homeName, ba: m.awayBest, bb: m.homeBest })));
          if (best) { recapBestByWeek.set(rw.week, best); renderRecap(); }
        })
        .catch(() => {});
    }
    return recapBestByWeek.get(rw.week);
  }

  // ---------- The card (audit V #1, #2) ----------
  // The week on one line, then the other awards as rows. Each row award
  // comes with its opposite (blowout / closest, luckiest / unluckiest,
  // perfect lineup / left the win on the bench), and a pair only shows when
  // both halves exist, so desktop's two columns never end half empty. Any
  // award can carry one line of context from league.json, shown only when
  // it says something: a best since another season, a top three for the
  // season, a top ten all time.
  const RC_DOT = '<circle cx="{x}" cy="{y}" r="1.2" fill="currentColor" stroke="none"/>';
  const RC_ICONS = {
    blowout: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    closest: '<path d="M12 4v16M5 20h14M6 8h12"/><path d="m6 8-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0z"/>',
    luck: '<rect x="4" y="4" width="16" height="16" rx="3.5"/>' + [[9, 9], [15, 9], [12, 12], [9, 15], [15, 15]].map(([x, y]) => RC_DOT.replace('{x}', x).replace('{y}', y)).join(''),
    perfect: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    bench: '<path d="M4 10h16M6 10v8M18 10v8M4 14h16"/><path d="M7 10V6h10v4"/>',
  };
  // typeTile()'s tile (page-common.js), with the recap's own glyphs.
  const rcTile = (kind, bad) => `<span class="type-tile${bad ? ' loss' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24" ${TILE_STROKE}>${RC_ICONS[kind]}</svg></span>`;
  // The weekly Sacko's money rule (generate_franchise_data_d1.py): from 2025
  // the week's lowest scorer pays, at most 3 times a season; past that it
  // falls to the next-lowest.
  const SACKO_FROM = 2025, SACKO_CAP = 3;
  const rcNth = (n, word) => (n === 1 ? word[0].toUpperCase() + word.slice(1) : `${ordinal(n)}-${word}`);
  const plainNames = list => (list.length > 1 ? `${list.slice(0, -1).map(x => x.name).join(', ')} & ${list[list.length - 1].name}` : list[0].name);

  function renderRecap() {
    const section = document.getElementById('recap-section');
    const rw = standingsData && recapWeek(standingsData);
    if (!rw || !rw.games.length) { section.hidden = true; section.innerHTML = ''; return; }
    const r2 = v => Math.round(v * 100) / 100;
    const year = (standingsData && standingsData.year) || leagueYear;
    const regWeeks = (standingsData && standingsData.regularSeasonWeeks) || (leagueSettings[year] || {}).reg_weeks || 0;
    const playoff = Boolean(standingsData && standingsData.playoffWeek) || (regWeeks > 0 && rw.week > regWeeks);
    const bestBy = recapBest(rw) || {};
    // Each game's type (a consolation game counts for highs, never for
    // lows): league.json's copy of this week when it has one, else the
    // Worker's playoff label (bracket). league.json's copy also keeps the
    // history below from counting the week twice.
    const known = (leagueGames || []).filter(g => g.year === year && g.week === rw.week && g.p2);
    const typeOf = game => {
      const g = known.find(x => (x.p1 === game.a && x.p2 === game.b) || (x.p1 === game.b && x.p2 === game.a));
      return g ? g.type : game.type || (playoff ? '' : 'Reg');
    };
    const sides = rw.games.flatMap(g => {
      const type = typeOf(g);
      return [
        { name: g.a, score: g.sa, opp: g.b, oppScore: g.sb, best: bestBy[g.a], type },
        { name: g.b, score: g.sb, opp: g.a, oppScore: g.sa, best: bestBy[g.b], type },
      ];
    });
    const sorted = sides.map(s => s.score).sort((x, y) => x - y);
    const mid = sorted.length / 2;
    // A playoff week has no median game, and neither did any week before 2025.
    const median = playoff || year < medianEraYear ? null : typeof rw.median === 'number' ? rw.median
      : sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
    const others = sides.length - 1;
    const result = s => (s.score > s.oppScore ? `def. ${esc(s.opp)}` : s.score < s.oppScore ? `lost to ${esc(s.opp)}` : `tied ${esc(s.opp)}`);
    // Every manager at the top value, never just the first (League Lore's
    // tie rule); a line about one holder is only spelled out for one.
    const tops = (list, f) => {
      if (!list.length) return [];
      const best = Math.max(...list.map(x => r2(f(x))));
      return list.filter(x => r2(f(x)) === best);
    };
    const nameOf = n => (isMe(n) ? `<span class="rc-you">${esc(n)}</span>` : esc(n));
    const who = list => {
      const n = list.map(x => nameOf(x.name));
      return n.length > 1 ? `${n.slice(0, -1).join(', ')} &amp; ${n[n.length - 1]}` : n[0];
    };
    const tie = (list, line) => (list.length > 1 ? `${list.length}-way tie` : line(list[0]));
    const beatN = s => sides.filter(o => o !== s && o.score < s.score).length;
    const wins = sides.filter(s => s.score > s.oppScore).map(s => ({ ...s, margin: s.score - s.oppScore, beat: beatN(s) }));
    const losses = sides.filter(s => s.score < s.oppScore).map(s => ({ ...s, margin: s.oppScore - s.score, beat: beatN(s) }));
    // Consolation games count for highs, never for lows, and like Game
    // Records the margins leave them out: a lineup nobody set can make a
    // blowout, a close game or a lucky win out of nothing.
    const counts = s => s.type !== 'Cons';
    const high = tops(sides, s => s.score);
    const lowPool = sides.filter(counts);
    const low = tops(lowPool, s => -s.score);
    const blowout = tops(wins.filter(counts), s => s.margin);
    const closest = tops(wins.filter(counts), s => -s.margin);
    // The win with the score that would have beaten the fewest teams, and
    // the loss with the score that would have beaten the most. The count is
    // what's shared in a tie, so it's the value.
    const lucky = tops(wins.filter(counts), s => -s.beat);
    const unlucky = tops(losses, s => s.beat);
    const made = median === null ? [] : tops(sides.filter(s => s.score > median), s => -s.score);
    const missed = median === null ? [] : tops(sides.filter(s => s.score < median), s => s.score);

    // History for the context lines: league.json, plus this week until it's in.
    const games = (leagueGames || [])
      .filter(g => typeof g.s1 === 'number' && (!g.p2 || typeof g.s2 === 'number') && g.winner !== 'In Progress')
      .concat(known.length ? [] : rw.games.map(g => ({ year, week: rw.week, type: typeOf(g), p1: g.a, p2: g.b, s1: g.sa, s2: g.sb, median })));
    const isThisWeek = g => g.year === year && g.week === rw.week;
    const isBefore = g => g.year < year || (g.year === year && g.week < rw.week);
    const ctx = {};

    // Top score: a best since an earlier season, or the season's high.
    if (high.length === 1) {
      const t = high[0], mine = [];
      games.forEach(g => {
        if (!g.p2 || isThisWeek(g)) return;
        if (g.p1 === t.name) mine.push({ y: g.year, w: g.week, s: g.s1 });
        else if (g.p2 === t.name) mine.push({ y: g.year, w: g.week, s: g.s2 });
      });
      const higher = mine.filter(x => r2(x.s) > r2(t.score));
      const ever = mine.length > 0 && !higher.length;
      const parts = [];
      if (ever) parts.push(`${t.name}’s best score ever`);
      else if (higher.length) {
        const last = higher.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.w > a.w) ? b : a));
        if (last.y < year) parts.push(`${t.name}’s best since ${last.y} Week ${last.w}`);
      }
      const season = games.filter(g => g.year === year && g.p2).flatMap(g => [g.s1, g.s2]);
      if (!ever && rw.week >= 3 && r2(t.score) >= r2(Math.max(...season))) parts.push(parts.length ? 'season high' : `Highest score of ${year}`);
      ctx.top = parts.join(' · ');
    }

    // The weekly Sacko: the lowest scorer unless they've hit the cap.
    let lowLabel = 'Low score';
    if (!playoff && year >= SACKO_FROM && low.length) {
      const count = {}, weeks = new Map();
      games.forEach(g => {
        if (g.year !== year || !isBefore(g)) return;
        if (!weeks.has(g.week)) weeks.set(g.week, []);
        weeks.get(g.week).push([g.p1, g.s1]);
        if (g.p2) weeks.get(g.week).push([g.p2, g.s2]);
      });
      [...weeks.keys()].sort((a, b) => a - b).forEach(w => {
        const pays = weeks.get(w).slice().sort((x, y) => x[1] - y[1]).find(([m]) => (count[m] || 0) < SACKO_CAP);
        if (pays) count[pays[0]] = (count[pays[0]] || 0) + 1;
      });
      const payer = lowPool.slice().sort((x, y) => x.score - y.score).find(s => (count[s.name] || 0) < SACKO_CAP);
      if (payer && low.includes(payer)) {
        lowLabel = 'Sacko';
        const n = (count[payer.name] || 0) + 1;
        if (low.length === 1) ctx.low = `${payer.name}’s ${n === 1 ? 'first' : ordinal(n)} weekly Sacko of ${year}`;
      } else if (payer) {
        ctx.low = `${plainNames(low)} ${low.length > 1 ? 'are' : 'is'} capped at ${SACKO_CAP} Sackos, so ${payer.name} takes this one`;
      }
    }

    // Margins, ranked the Game Records way (no consolation games): all time
    // first, then this season once it's four weeks old.
    const margins = games.filter(g => g.p2 && g.type !== 'Cons').map(g => Math.abs(g.s1 - g.s2));
    const seasonMargins = games.filter(g => g.p2 && g.year === year && g.type === 'Reg').map(g => Math.abs(g.s1 - g.s2));
    const marginCtx = (m, biggest) => {
      const better = x => (biggest ? r2(x) > r2(m) : r2(x) < r2(m));
      const word = biggest ? 'biggest' : 'closest', what = biggest ? 'margin' : 'game';
      const all = 1 + margins.filter(better).length;
      if (all <= 10) return `${rcNth(all, word)} ${what} in league history`;
      if (playoff || rw.week < 4) return '';
      const inSeason = 1 + seasonMargins.filter(better).length;
      return inSeason <= 3 ? `${rcNth(inSeason, word)} ${what} of ${year}` : '';
    };
    if (blowout.length === 1) ctx.blowout = marginCtx(blowout[0].margin, true);
    if (closest.length === 1) ctx.closest = marginCtx(closest[0].margin, false);

    // The median call: this week's nearest miss against every earlier week's
    // since median games began.
    if (made.length && missed.length && year >= medianEraYear) {
      const d = Math.min(made[0].score - median, median - missed[0].score);
      const nearest = new Map();
      games.forEach(g => {
        if (g.type !== 'Reg' || g.year < medianEraYear || typeof g.median !== 'number' || !isBefore(g)) return;
        const k = `${g.year}:${g.week}`;
        const v = Math.min(Math.abs(g.s1 - g.median), g.p2 ? Math.abs(g.s2 - g.median) : Infinity);
        nearest.set(k, Math.min(nearest.has(k) ? nearest.get(k) : Infinity, v));
      });
      const rank = 1 + [...nearest.values()].filter(v => r2(v) < r2(d)).length;
      if (nearest.size >= 5 && rank <= 3) {
        ctx.median = rank === 1 ? `Closest median call since median games began in ${medianEraYear}` : `${ordinal(rank)}-closest median call since ${medianEraYear}`;
      }
    }

    // The storyline under the title: the longest head-to-head streak this
    // week ended or stretched to 4+. League History's rule: every game with
    // an opponent, across seasons, a tie a loss for both (franchise.json).
    // Not ESPN's streak on the matchup cards, which counts median games.
    const streakIn = m => {
      const gs = games.filter(g => g.p2 && (g.p1 === m || g.p2 === m) && isBefore(g)).sort((a, b) => a.year - b.year || a.week - b.week);
      let n = 0, won = null;
      for (let i = gs.length - 1; i >= 0; i--) {
        const g = gs[i], w = g.p1 === m ? g.s1 > g.s2 : g.s2 > g.s1;
        if (won === null) won = w;
        else if (w !== won) break;
        n++;
      }
      return won ? n : -n;
    };
    const stories = [];
    rw.games.forEach(g => {
      if (r2(g.sa) === r2(g.sb)) return;
      const [w, l] = g.sa > g.sb ? [g.a, g.b] : [g.b, g.a];
      const ws = streakIn(w), ls = streakIn(l);
      if (ls >= 4 && ws <= -4) stories.push([Math.max(ls, -ws) + 0.5, `${w} snapped a ${-ws}-game losing streak by ending ${l}’s ${ls}-game win streak.`]);
      else if (ls >= 4) stories.push([ls + 0.5, `${w} ended ${l}’s ${ls}-game win streak.`]);
      else if (ws <= -4) stories.push([-ws + 0.5, `${w} snapped a ${-ws}-game losing streak.`]);
      if (ws >= 3) stories.push([ws + 1, `${w} has won ${ws + 1} straight.`]);
      if (ls <= -3) stories.push([-ls + 1, `${l} has lost ${-ls + 1} straight.`]);
    });
    const story = stories.sort((x, y) => y[0] - x[0])[0];

    // ---- the rows
    const row = (kind, cap, list, sub, value, bad, note) => `<div class="rc-row">${rcTile(kind, bad)}<div class="rc-txt"><span class="rc-cap">${cap}</span><span class="rc-holder">${who(list)}</span>${sub ? `<span class="rc-sub">${sub}</span>` : ''}${note ? `<span class="rc-ctx">${esc(note)}</span>` : ''}</div><span class="rc-val${bad ? ' loss' : ''}">${value}</span></div>`;
    const rows = [];
    if (blowout.length && closest.length) {
      rows.push(row('blowout', 'Biggest blowout', blowout, tie(blowout, s => `over ${esc(s.opp)}`), '+' + fmtScore(blowout[0].margin), false, ctx.blowout));
      rows.push(row('closest', 'Closest game', closest, tie(closest, s => `over ${esc(s.opp)}`), '+' + fmtScore(closest[0].margin), false, ctx.closest));
    }
    if (lucky.length && unlucky.length) {
      rows.push(row('luck', 'Luckiest win', lucky, 'teams outscored, and won', `${lucky[0].beat} of ${others}`));
      rows.push(row('luck', 'Unluckiest loss', unlucky, 'teams outscored, and lost', `${unlucky[0].beat} of ${others}`, true));
    }
    // Lineup calls, once every team's best lineup is in (recapBest).
    if (sides.every(s => typeof s.best === 'number')) {
      const perfect = sides.filter(s => r2(s.best) <= r2(s.score));
      const bestPct = tops(sides, s => s.score / s.best);
      // Losers whose best lineup would have beaten what their opponent
      // scored, most points left first.
      const benched = losses.filter(s => r2(s.best) > r2(s.oppScore)).sort((x, y) => (y.best - y.score) - (x.best - x.score));
      const mostLeft = tops(sides, s => s.best - s.score);
      const lineup = perfect.length
        ? row('perfect', 'Perfect lineup', perfect, 'started their best lineup', perfect.length === 1 ? fmtScore(perfect[0].score) : `${perfect.length} of ${sides.length}`)
        : row('perfect', 'Best lineup call', bestPct, tie(bestPct, s => `${fmtScore(s.score)} of a possible ${fmtScore(s.best)}`), `${Math.round(bestPct[0].score / bestPct[0].best * 1000) / 10}%`);
      let bench = '';
      if (benched.length) {
        const t = benched[0];
        bench = row('bench', 'Left the win on the bench', benched,
          benched.length > 1 ? `${esc(t.name)} left the most, ${fmtScore(t.best - t.score)} points` : `best lineup ${fmtScore(t.best)} vs ${esc(t.opp)}’s ${fmtScore(t.oppScore)}`,
          `${benched.length} of ${losses.length}`, true);
      } else if (r2(mostLeft[0].best - mostLeft[0].score) > 0) {
        bench = row('bench', 'Most left on the bench', mostLeft, tie(mostLeft, s => `${s.score > s.oppScore ? 'won' : 'lost'} anyway`), fmtScore(mostLeft[0].best - mostLeft[0].score), true);
      }
      if (bench) rows.push(lineup, bench);
    }

    // ---- the strip: Sacko and top score at the ends, a dot per team
    const end = (cls, label, list, line) => (list.length ? `<div class="rc-end ${cls}"><span class="rc-end-l">${label}</span><span class="rc-end-v">${fmtScore(list[0].score)}</span><span class="rc-end-n">${who(list)}${list.length === 1 ? `<em> · ${result(list[0])}</em>` : ''}</span>${line ? `<span class="rc-ctx">${esc(line)}</span>` : ''}</div>` : '<div></div>');
    const byScore = sides.slice().sort((x, y) => x.score - y.score);
    const dots = byScore.map(s => `<span class="rc-dot${median === null ? '' : s.score > median ? ' up' : ' dn'}${isMe(s.name) ? ' you' : ''}${s.type === 'Cons' ? ' cons' : ''}" data-x="${s.score}" title="${esc(s.name)} ${fmtScore(s.score)}">${esc(monogram(s.name))}</span>`).join('');
    const plotLabel = `Week ${rw.week} scores, high to low: ${byScore.slice().reverse().map(s => `${s.name} ${fmtScore(s.score)}`).join(', ')}${median === null ? '' : `. Median ${fmtScore(median)}`}.`;
    const note = made.length && missed.length
      ? `<div class="rc-note"><span><b>${who(made)}</b> made it by <b class="up">+${fmtScore(made[0].score - median)}</b></span><span><b>${who(missed)}</b> missed by <b class="dn">−${fmtScore(median - missed[0].score)}</b></span></div>${ctx.median ? `<span class="rc-ctx">${esc(ctx.median)}</span>` : ''}`
      : sides.some(s => s.type === 'Cons') ? '<div class="rc-note">Faded dots are consolation games: they count for highs, never for lows.</div>' : '';
    // Folds to its header and a one-line summary (audit VIII #4). It starts
    // folded on Wednesday, when everyone has seen it, and open before then;
    // the fold button's choice holds for that week on this phone.
    const title = `Week ${rw.week} in Review`;
    const folded = recapFolded(rw.week);
    if (folded) {
      const bits = [high.length ? `Top score ${who(high)} ${fmtScore(high[0].score)}` : '', low.length ? `${esc(lowLabel)} ${who(low)} ${fmtScore(low[0].score)}` : '', closest.length ? `Closest ${who(closest)} by ${fmtScore(closest[0].margin)}` : ''];
      section.innerHTML = `<div class="recap-card lv-folded">${lvHead(title, lvBits(bits), 'data-recap-fold', false)}</div>`;
      section.hidden = false;
      section.dataset.week = rw.week;
      return;
    }
    // No median chip in the header: the dashed line carries it.
    section.innerHTML = `
      <div class="recap-card">
        ${lvHead(title, story ? esc(story[1]) : '', 'data-recap-fold', true, `${playoff ? '<span class="badge dim">Playoffs</span>' : ''}<button type="button" class="share-btn" data-recap-share>Share</button>`, 'rc-dek')}
        <div class="rc-strip">
          <div class="rc-ends">${end('lo', lowLabel, low, ctx.low)}${end('hi', 'Top score', high, ctx.top)}</div>
          <div class="rc-plot" role="img" aria-label="${esc(plotLabel)}">
            <span class="rc-axis"></span>
            ${median === null ? '' : `<span class="rc-med" data-x="${median}"></span><span class="rc-medl" data-x="${median}">Median ${fmtScore(median)}</span>`}
            ${dots}
          </div>
          ${note}
        </div>
        ${rows.length ? `<div class="rc-rows">${rows.join('')}</div>` : ''}
      </div>`;
    section.hidden = false;
    section.dataset.week = rw.week;
    layoutRecapStrip();
  }
  // Share the week (audit V #14): the card as a picture for the group chat.
  const recapShot = RLShare.make({
    nodes: () => [document.querySelector('#recap-section .recap-card')],
    eyebrow: () => `Retirement League · ${(standingsData && standingsData.year) || leagueYear}`,
    name: () => `week-${document.getElementById('recap-section').dataset.week || ''}-in-review.png`,
  });
  document.getElementById('recap-section').addEventListener('click', e => {
    const b = e.target.closest('[data-recap-share]');
    if (b) recapShot.share(b);
    if (e.target.closest('[data-recap-fold]') || e.target.closest('.lv-folded .lv-head')) {
      const wk = document.getElementById('recap-section').dataset.week || '';
      recapFoldMem = `${wk}:${recapFolded(wk) ? 0 : 1}`;
      try { localStorage.setItem(RECAP_FOLD, recapFoldMem); } catch (err) {}
      renderRecap();
    }
  });
  // "week:1" folded, "week:0" open; another week goes back to the default.
  const RECAP_FOLD = 'rl-recap-fold';
  let recapFoldMem = '';
  function recapFolded(week) {
    if (FORCE_RECAP) return false;
    let v = recapFoldMem;
    try { v = localStorage.getItem(RECAP_FOLD) || v; } catch (e) {}
    const [w, f] = String(v).split(':');
    if (w === String(week)) return f === '1';
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()) === 'Wed';
  }

  // Places the strip's dots by score, stacking any that would touch
  // alternately above and below the line, so a crowd at the median stays
  // short. Runs after each render and whenever the card changes width.
  let rcPlotWidth = 0;
  function layoutRecapStrip() {
    const plot = document.querySelector('#recap-section .rc-plot');
    const W = plot ? plot.clientWidth : 0;
    if (!W) return;
    rcPlotWidth = W;
    const dots = [...plot.querySelectorAll('.rc-dot')];
    const xs = dots.map(d => +d.dataset.x);
    // D is the dots' clearance; S is the row pitch, wider than a 24px dot so
    // the median's dashed line shows in the gaps of a stack at the median.
    const lo = Math.min(...xs), hi = Math.max(...xs), pad = 14, D = 25, S = 31;
    const X = v => pad + (v - lo) / ((hi - lo) || 1) * (W - 2 * pad);
    const placed = [];
    dots.forEach(d => {
      const x = X(+d.dataset.x);
      let y = 0;
      for (let k = 0; k < 24; k++) {
        const c = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * S;
        if (placed.every(p => Math.hypot(p.x - x, p.y - c) >= D - 1)) { y = c; break; }
      }
      placed.push({ x, y, d });
    });
    const up = Math.max(0, ...placed.map(p => -p.y)), down = Math.max(0, ...placed.map(p => p.y));
    const axis = up + 16;
    plot.style.setProperty('--h', `${axis + down + (plot.querySelector('.rc-medl') ? 34 : 16)}px`);
    plot.style.setProperty('--ay', `${axis}px`);
    placed.forEach(p => { p.d.style.left = `${p.x}px`; p.d.style.top = `${axis + p.y}px`; });
    plot.querySelectorAll('.rc-med').forEach(e => { e.style.left = `${X(+e.dataset.x)}px`; });
    plot.querySelectorAll('.rc-medl').forEach(e => {
      const w = e.offsetWidth, x = X(+e.dataset.x);
      e.style.left = `${Math.min(W - w / 2, Math.max(w / 2, x))}px`;
    });
  }
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const plot = document.querySelector('#recap-section .rc-plot');
      if (plot && plot.clientWidth !== rcPlotWidth) layoutRecapStrip();
    }).observe(document.getElementById('recap-section'));
  }

  // Toggle-click path only -- assumes renderMedianStatic has already built
  // the card shell at least once, and only touches the inner list/chart
  // pieces + the toggle buttons' active state, same architecture the lab
  // concept used.
  function setMedianViewMode(mode) {
    medianViewMode = mode;
    try { localStorage.setItem('medianViewMode', mode); } catch (e) {}
  }
  function applyMedianUpdate(mode) {
    const oldMode = medianViewMode;
    setMedianViewMode(mode);
    document.querySelectorAll('#median-toggle-seg button').forEach(btn => btn.classList.toggle('on', btn.dataset.mode === mode));
    const currentHasStarted = lastMedianTeams.some(t => t.current > 0);
    if (mode === 'current' && !currentHasStarted) {
      document.getElementById('median-body').innerHTML = medianPendingBodyHtml();
      updateKickoffCountdown();
      mwRefresh();
      return;
    }
    const medianValue = mwMedian(mode);
    mwHeld = null; // a new mode ranks them anew; the popover re-holds below, in mwRefresh
    const rows = computeMedianRows(lastMedianTeams, medianValue, mode);
    document.getElementById('median-body').innerHTML = `
      <div class="card-body">
        <div>
          <div id="median-above"></div>
          ${medianSplitHtml(mode, medianValue, 'median-split')}${mwLockLineHtml(rows.zones)}
          <div id="median-below"></div>
        </div>
        <div class="spread-col" id="median-spreadcol" style="width:88px;">
          <div class="vplot" id="median-chart"></div>
        </div>
      </div>`;
    document.getElementById('median-above').innerHTML = mwGridHtml(rows.above, 'turf', medianValue);
    document.getElementById('median-below').innerHTML = mwGridHtml(rows.below, 'loss', medianValue);
    renderSpreadChart('median-chart', rows.all.slice().reverse(), medianValue, rows.zones, true);
    tagMedianTransitionNames();

    if (oldMode && oldMode !== mode) {
      const oldMedianValue = mwMedian(oldMode);
      document.querySelectorAll('#median-above .mb-card, #median-below .mb-card').forEach(card => {
        const t = lastMedianTeams.find(x => medianTeamName(x) === card.dataset.name);
        if (!t) return;
        tickMwNumber(card.querySelector('.mw-score'), t[oldMode], t[mode]);
        tickMwNumber(card.querySelector('.mw-margin'), t[oldMode] - oldMedianValue, t[mode] - medianValue, fmtMwMargin);
      });
      const splitValueEl = document.querySelector('#median-split b');
      if (splitValueEl) tickMwNumber(splitValueEl, oldMedianValue, medianValue);
      const oldRows = computeMedianRows(lastMedianTeams, oldMedianValue, oldMode);
      const lowEl = document.querySelector('#median-chart .endcap-score.low');
      const highEl = document.querySelector('#median-chart .endcap-score.high');
      if (lowEl) tickMwNumber(lowEl, oldRows.all[oldRows.all.length - 1].score, rows.all[rows.all.length - 1].score);
      if (highEl) tickMwNumber(highEl, oldRows.all[0].score, rows.all[0].score);
    }
    mwRefresh();
  }

  const mwReduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function handleMedianToggle(mode) {
    if (mode === medianViewMode || !lastMedianTeams) return;
    if (document.startViewTransition && !mwReduceMotion) {
      // Jumps in Safari, like Season So Far's (see its click handler).
      document.getElementById('median-toggle-seg')?.toggleAttribute('data-glide-jump', SAFARI);
      const vt = document.startViewTransition(() => applyMedianUpdate(mode));
      vt.finished.then(settleMedianToMergedPills).catch(() => {});
    } else {
      applyMedianUpdate(mode);
    }
  }
  document.getElementById('median-container').addEventListener('click', e => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) { handleMedianToggle(btn.dataset.mode); return; }
    if (e.target.closest('a.mgr')) return;
    const card = e.target.closest('.mb-card.can');
    if (card) { if (mwOpen === card.dataset.name) mwHide(); else mwShow(card.dataset.name, true); }
  });
  document.getElementById('median-container').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('a.mgr')) return;
    const card = e.target.closest('.mb-card.can');
    if (!card) return;
    e.preventDefault();
    if (mwOpen === card.dataset.name) mwHide(); else mwShow(card.dataset.name, true);
  });

  // The first starter's kickoff is when this week's scores actually start
  // moving off 0.00, so that's what the pending card counts down to. The
  // Worker sends each starter's real game time, which covers viewers outside
  // Eastern time and openers that aren't Thursday at 8:15 (Week 1's
  // international game, a Christmas game). Thursday 8:15 PM local is only
  // the fallback for when no starter has a game time.
  function getFirstKickoff() {
    let first = null;
    for (const m of (lastMedianData && lastMedianData.matchups) || []) {
      for (const p of [...(m.awayPlayers || []), ...(m.homePlayers || [])]) {
        const d = p.game && p.game.date ? new Date(p.game.date) : null;
        if (d && !isNaN(d) && (!first || d < first)) first = d;
      }
    }
    return first || getNextThursdayKickoff();
  }

  function getNextThursdayKickoff() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(20, 15, 0, 0); // 8:15 PM local time
    target.setDate(now.getDate() + ((4 - now.getDay() + 7) % 7)); // 4 = Thursday
    if (target <= now) target.setDate(target.getDate() + 7);
    return target;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return 'Kickoff!';
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  // Re-looks-up the element each call (rather than caching a reference) so
  // it keeps working across loadDashboard() re-rendering the card every
  // couple minutes, and no-ops harmlessly once the season is underway and
  // the pending card (and this element) no longer exist.
  function updateKickoffCountdown() {
    const el = document.getElementById('kickoff-countdown');
    if (!el) return;
    el.textContent = formatCountdown(getFirstKickoff() - new Date());
  }

  // Shown for the Current Score card before Week 1 kicks off, when every
  // team is tied at 0.00 and an above/below split would be meaningless.

  function fmtPct(n) {
    const num = parseFloat(n);
    return isNaN(num) ? '—' : `${num.toFixed(1)}%`;
  }

  // The row's gold rank/green edge means "actually holds a playoff spot
  // right now" (rank <= however many the league sends teams to) — a
  // deterministic fact from standings position. The chip's color means
  // "current playoff odds >= 50%" — a separate, probability-based signal
  // that can disagree with raw rank (tiebreakers, remaining schedule).
  // Deliberately not the same threshold, so showing both is more
  // informative than picking just one.
  // Opening tag for a standings row: a link to the manager's Franchise page
  // when the Worker knows who they are (its names follow the same rules as
  // Franchise's), a plain row otherwise. The link names the manager
  // (franchise.html?m=Brad), so it can be opened in a new tab or shared.
  function lbRowTag(manager) {
    return manager ? `a href="${esc(pageLink('franchise.html', { m: manager }))}" data-rv="${esc(manager)}"` : 'div';
  }

  // The lines under a team's name: manager and record, then the schedule
  // left and playoff race marker (sosMark, raceMark in page-common.js) on a
  // line of their own, each part kept whole -- see .lb-parts.
  // `sos` is the schedule left (scheduleLeft in page-common.js, site audit
  // II #31) and `hard` whether it's among the league's toughest.
  function lbMeta(manager, record, race, sos, hard) {
    const line = parts => `<span class="lb-parts">${parts.join('')}</span>`;
    const second = sosMark(sos, hard) + raceMark(race);
    // Your Daddy / Your Bitch (rivals.js), in your ring color, after the record.
    const rv = typeof Rivals !== 'undefined' ? Rivals.pill(manager) : '';
    return `<div class="lb-meta">${line([manager ? `<span>${manager}</span>` : '', `<span>${record}</span>`, rv ? `<span class="rv-part">${rv}</span>` : ''])}${second ? line([second]) : ''}</div>`;
  }

  function renderLeaderboardRow(t, rank, playoffTeamCount, race, sos, hard) {
    const hasPlayoffPct = typeof t.playoffPct === 'number';
    const chipCls = hasPlayoffPct ? (t.playoffPct >= 50 ? 'high' : 'low') : '';
    const inPlayoffPosition = playoffTeamCount > 0 && rank <= playoffTeamCount;
    return `
      <${lbRowTag(t.manager)} class="lb-row${inPlayoffPosition ? ' playoff' : ''}${isMe(t.manager) ? ' me' : ''}" data-sf="${rank - 1}">
        <div class="lb-rank">${rank}</div>
        <div class="lb-identity">
          <div class="lb-name">${t.name}</div>
          ${lbMeta(t.manager, t.record, race, sos, hard)}
        </div>
        <div class="lb-stat"><div class="v">${fmtScore(t.pointsFor)}</div></div>
        <div class="lb-stat"><div class="v">${fmtScore(t.pointsAgainst)}</div></div>
        <div class="lb-playoff-chip ${chipCls}">${fmtPct(t.playoffPct)}</div>
      </${t.manager ? 'a' : 'div'}>`;
  }

  // ---------- Standings: through last week / + this week live / + this week projected ----------
  let standingsData = null;

  function renderLeaderboardHead(chipLabel) {
    return `
      <div class="lb-head" aria-hidden="true">
        <span class="lb-rank"></span><span class="lb-identity"></span>
        <span class="lb-stat">PF</span><span class="lb-stat">PA</span>
        <span class="lb-chip-col">${chipLabel}</span>
      </div>`;
  }

  // ---------- Season So Far: one Through / live / projected mode shared by
  // Superlatives and Standings. Defaults to "Through Week N-1" and is
  // remembered across refreshes (falls back quietly if storage is blocked).
  let seasonMode = 'through';
  try {
    const saved = localStorage.getItem('seasonViewMode');
    if (saved === 'through' || saved === 'live' || saved === 'proj') seasonMode = saved;
  } catch (e) {}

  // Before kickoff every team's live score is 0, so a "live" option would
  // just duplicate "through" -- skip it until someone's actually on the
  // board. Projections are available pre-kickoff too, so that one stays.
  function seasonModes(data) {
    const teams = data.teams || [];
    const week = data.week || 1;
    const hasPrior = week > 1 && teams.length > 0 && teams.every(t => t.prior);
    const started = teams.some(t => (t.current || 0) > 0);
    // A playoff week leaves the regular-season table as it ended.
    if (isPlayoffWeek(data)) return [['through', 'Regular season']];
    // A past week is over: before it, and after it.
    if (data.archived) {
      return [
        ...(hasPrior ? [['through', `Through Week ${week - 1}`]] : []),
        ['live', `Week ${week} final`],
      ];
    }
    // The live week, every game over (audit V #9): live and projected are
    // the same final numbers, so the cards open on them, named for what
    // they are, and there's nothing to switch between.
    if (weekFinal) return [['live', `Through Week ${week}`]];
    return [
      ...(hasPrior ? [['through', `Through Week ${week - 1}`]] : []),
      ...(started ? [['live', `Week ${week} live`]] : []),
      ['proj', `Week ${week} projected`],
    ];
  }

  // A remembered mode that isn't offered right now (e.g. "live" before
  // kickoff) shows the first option instead, without overwriting the saved pick.
  function activeSeasonMode() {
    const modes = standingsData ? seasonModes(standingsData) : [];
    return modes.some(([k]) => k === seasonMode) ? seasonMode : (modes[0] ? modes[0][0] : 'through');
  }

  function renderSeasonToggle() {
    if (!standingsData) return;
    const modes = seasonModes(standingsData);
    const active = activeSeasonMode();
    // One view only (a finished week, a playoff week): its name sits in the heading.
    document.getElementById('season-state').textContent = modes.length === 1 ? modes[0][1] : '';
    document.getElementById('season-toggle').innerHTML = modes.length > 1
      ? `<div class="sf-band"><div class="sup-seg">${modes.map(([k, l]) => `<button type="button" data-season="${k}" class="${k === active ? 'on' : ''}">${l}</button>`).join('')}</div></div>`
      : '';
  }

  function formatRecordParts(w, l, t) { return `${w}-${l}${t ? '-' + t : ''}`; }

  // Standings as they would look if the week ended with the given scores:
  // last weeks' results plus this week's head-to-head result and this week's
  // result against the median (top half of scores wins), points included.
  function projectStandings(data, mode) {
    const teams = data.teams || [];
    const scoreOf = t => (mode === 'proj' ? Math.max(t.projected || 0, t.current || 0) : (t.current || 0));
    const byName = new Map(teams.map(t => [t.name, t]));
    const oppByName = new Map();
    (data.matchups || []).forEach(m => {
      oppByName.set(m.homeName, m.awayName);
      oppByName.set(m.awayName, m.homeName);
    });
    const ranked = [...teams].sort((a, b) => scoreOf(b) - scoreOf(a));
    const half = Math.floor(ranked.length / 2);
    const medianWin = new Map(ranked.map((t, i) => [t.name, i < half]));
    return teams.map((t, i) => {
      const p = t.prior || { w: 0, l: 0, t: 0, pf: t.pointsFor, pa: t.pointsAgainst };
      const opp = byName.get(oppByName.get(t.name));
      const own = scoreOf(t);
      const oppScore = opp ? scoreOf(opp) : null;
      let w = p.w, l = p.l, ties = p.t;
      if (mode !== 'through') {
        if (oppScore !== null) { if (own > oppScore) w++; else if (own < oppScore) l++; else ties++; }
        // The median game, from the season the league started playing it.
        if (data.medianGames !== false) { if (medianWin.get(t.name)) w++; else l++; }
      }
      return {
        name: t.name, manager: t.manager, w, l, ties,
        pf: p.pf + (mode === 'through' ? 0 : own),
        pa: p.pa + (mode === 'through' || oppScore === null ? 0 : oppScore),
        espnRank: i + 1,
        playoffPct: t.playoffPct,
      };
    });
  }

  // The Playoff line goes after the last playoff spot (site audit 29). It
  // isn't named in the mode switch's view transition, so it holds still
  // while the rows glide past it.
  function withPlayoffLine(rowsHtml, spots) {
    return rowsHtml.map((h, i) => (spots > 0 && i === spots - 1 && rowsHtml.length > spots ? h + PLAYOFF_LINE : h)).join('');
  }

  function renderStandings() {
    const data = standingsData;
    if (!data) return;
    const teams = data.teams || [];
    const container = document.getElementById('leaderboard-container');
    // The table now lives on the Standings page; nothing to draw here.
    if (!container) return;
    const week = data.week || 1;
    const hasPrior = week > 1 && teams.length > 0 && teams.every(t => t.prior);
    const spots = data.playoffTeamCount || 0;
    // Every week is a head-to-head game plus a game against the median
    // (since the league started playing it).
    const totalGames = (data.medianGames === false ? 1 : 2) * (data.regularSeasonWeeks || 0);

    if (!hasPrior) {
      // Week 1: no earlier week to compare against, and no games yet for
      // a race to read.
      container.innerHTML = renderLeaderboardHead('Odds') + withPlayoffLine(teams.map((t, idx) => renderLeaderboardRow(t, idx + 1, spots)), spots);
      return;
    }

    const m = activeSeasonMode();

    // Schedule left: every opponent from this week on in Through mode; once
    // this week counts (live, projected), from next week.
    const aheadOf = new Map(teams.map(t => [t.manager, t.ahead || []]));
    const schedules = (list, recOf, skip) => {
      const sos = list.map(r => scheduleLeft((aheadOf.get(r.manager) || []).slice(skip), recOf));
      return { sos, hard: rankSchedules(sos) };
    };

    if (m === 'through') {
      const race = playoffRace(teams.map(t => t.prior), spots, totalGames);
      const priorOf = new Map(teams.map(t => [t.manager, t.prior]));
      const sc = schedules(teams, n => priorOf.get(n), 0);
      container.innerHTML = renderLeaderboardHead('Odds') + withPlayoffLine(teams.map((t, idx) => renderLeaderboardRow(t, idx + 1, spots, race && race[idx], sc.sos[idx], sc.hard[idx])), spots);
      return;
    }

    // Live and projected: the race as it would stand if the week ended so.
    const rows = projectStandings(data, m);
    const base = projectStandings(data, 'through');
    const baseRank = new Map([...base].sort((a, b) => b.w - a.w || b.pf - a.pf).map((r, i) => [r.name, i + 1]));
    const ordered = [...rows].sort((a, b) => b.w - a.w || b.pf - a.pf);
    const race = playoffRace(ordered.map(r => ({ w: r.w, l: r.l, t: r.ties })), spots, totalGames);
    const rowOf = new Map(ordered.map(r => [r.manager, { w: r.w, l: r.l, t: r.ties }]));
    const sc = schedules(ordered, n => rowOf.get(n), 1);
    container.innerHTML = renderLeaderboardHead('Move') + withPlayoffLine(ordered.map((r, i) => {
      const rank = i + 1;
      const move = baseRank.get(r.name) - rank;
      const chipCls = move > 0 ? 'high' : move < 0 ? 'low' : '';
      const chipText = move > 0 ? `▲ ${move}` : move < 0 ? `▼ ${-move}` : '–';
      const inPlayoffPosition = spots > 0 && rank <= spots;
      return `
      <${lbRowTag(r.manager)} class="lb-row ${inPlayoffPosition ? 'playoff' : ''}${isMe(r.manager) ? ' me' : ''}" data-sf="${r.espnRank - 1}">
        <div class="lb-rank">${rank}</div>
        <div class="lb-identity">
          <div class="lb-name">${r.name}</div>
          ${lbMeta(r.manager, formatRecordParts(r.w, r.l, r.ties), race && race[i], sc.sos[i], sc.hard[i])}
        </div>
        <div class="lb-stat"><div class="v">${fmtScore(r.pf)}</div></div>
        <div class="lb-stat"><div class="v">${fmtScore(r.pa)}</div></div>
        <div class="lb-playoff-chip ${chipCls}">${chipText}</div>
      </${r.manager ? 'a' : 'div'}>`;
    }), spots);
  }

  // Switching modes slides each standings row to its new rank while its PF
  // and PA count from the old values (site audit Motion A) -- the Median
  // Watch recipe: a view transition plus tickMwNumber. Rows carry data-sf,
  // their team's index in standingsData.teams, so a row keeps its identity
  // across modes. The Superlatives cards change height between modes, so
  // they and the Standings card are named too: the cards grow while the
  // panel below slides down with them, instead of the panel overlapping
  // cards that already jumped to their new size. Everything is named only
  // while this transition runs, so none of it gets lifted out of the page
  // during Median Watch's.
  // Safari's engine: desktop Safari, and every browser on an iPhone (CriOS
  // and friends). Chrome and Edge say Chrome/ in theirs.
  const SAFARI = /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent)
    || (/AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium|Edg\//.test(navigator.userAgent));

  function nameSeasonRows(on) {
    const card = document.querySelector('#season-section .standings-card');
    if (card) card.style.viewTransitionName = on ? 'sf-card' : '';
    const band = document.querySelector('#season-toggle .sf-band');
    if (band) band.style.viewTransitionName = on ? 'sf-toggle' : '';
    document.querySelectorAll('#accolades-container .accolade-card').forEach((c, i) => {
      c.style.viewTransitionName = on ? 'sf-acc-' + i : '';
    });
    document.querySelectorAll('#leaderboard-container .lb-row[data-sf]').forEach(row => {
      row.style.viewTransitionName = on ? 'sf-row-' + row.dataset.sf : '';
    });
  }
  function seasonRowValues() {
    const vals = new Map();
    document.querySelectorAll('#leaderboard-container .lb-row[data-sf]').forEach(row => {
      vals.set(row.dataset.sf, [...row.querySelectorAll('.lb-stat .v')].map(v => parseFloat(v.textContent)));
    });
    return vals;
  }

  // The pinned toggle (see #season-toggle in the CSS) needs the nav bar's
  // height to sit under it, and marks itself .stuck while pinned.
  (() => {
    const el = document.getElementById('season-toggle');
    let queued = false;
    const check = () => {
      queued = false;
      const bar = document.querySelector('.nav-bar');
      if (bar) document.documentElement.style.setProperty('--nav-h', bar.offsetHeight + 'px');
      const top = parseFloat(getComputedStyle(el).top) || 0;
      el.classList.toggle('stuck', window.scrollY > 0 && el.getBoundingClientRect().top <= top + 1);
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(check); } };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    queue();
  })();

  document.getElementById('season-toggle').addEventListener('click', e => {
    const b = e.target.closest('[data-season]');
    if (!b || b.dataset.season === activeSeasonMode()) return;
    seasonMode = b.dataset.season;
    try { localStorage.setItem('seasonViewMode', seasonMode); } catch (err) {}
    const apply = () => {
      renderSeasonToggle();
      renderStandings();
      renderSuperlatives();
    };
    if (!document.startViewTransition || mwReduceMotion) { apply(); return; }
    const was = seasonRowValues();
    // In Safari the gold jumps to the new choice instead of sliding
    // (data-glide-jump, see page-common.js): every way of sliding it during
    // this transition, pinned or not, dropped the pill or the whole toggle
    // on an iPhone. Same for Median Watch's toggle. Elsewhere it slides.
    const seasonTrack = document.querySelector('#season-toggle .sup-seg');
    if (seasonTrack) seasonTrack.toggleAttribute('data-glide-jump', SAFARI);
    nameSeasonRows(true);
    const vt = document.startViewTransition(() => {
      apply();
      nameSeasonRows(true);
      document.querySelectorAll('#leaderboard-container .lb-row[data-sf]').forEach(row => {
        const from = was.get(row.dataset.sf);
        if (!from) return;
        row.querySelectorAll('.lb-stat .v').forEach((v, j) => {
          const to = parseFloat(v.textContent);
          if (!isNaN(from[j]) && !isNaN(to) && Math.abs(to - from[j]) >= 0.005) tickMwNumber(v, from[j], to);
        });
      });
    });
    vt.finished.catch(() => {}).then(() => nameSeasonRows(false));
  });

  // Only ever called before any games have been scored this season --
  // renderSuperlatives below builds the real card itself once there's
  // data, via its own card() helper.
  function renderAccoladeCard(eyebrow) {
    return `
      <div class="accolade-card">
        <div class="acc-head"><div class="acc-title">${eyebrow}</div></div>
        <div class="acc-placeholder">Stats will appear once games get underway.</div>
      </div>`;
  }

  // ---------- Leader after each week (site audit 33) ----------
  // Inside Season Points Leader: one tile per week naming who led the
  // league in points after it, by how much, and over whom -- how the lead
  // was built, not just who has it. Counted over every team, not just the
  // four rows above, since the leader of an early week can be anyone.
  // Gold marks a week led by the leader this mode shows. In the live and
  // projected modes the last tile is this week, dashed. Past about five
  // weeks the strip scrolls on a phone, opening on the latest week.
  function leaderStripHtml(teams, leaderTeam, week, mode, fin) {
    if (!historyThrough(week) || teams.some(t => !t.manager)) return '';
    const live = mode !== 'through';
    const sums = new Map(teams.map(t => [t.manager, 0]));
    const tiles = [];
    const tile = (label, cls) => {
      const order = [...sums].sort((a, b) => b[1] - a[1]);
      const [first, second] = order;
      const tied = Math.round((first[1] - second[1]) * 100) === 0;
      const isLeader = !tied && first[0] === leaderTeam.manager;
      tiles.push(`<div class="ls-wk${isLeader ? ' on' : ''}${cls}">
          <div class="ls-l">${label}</div>
          <div class="ls-n">${tied ? 'Tied' : esc(first[0])}</div>
          <div class="ls-v">${tied ? fmtScore(first[1]) : '+' + fmtScore(first[1] - second[1])}</div>
          <div class="ls-s">${tied ? `${esc(first[0])} &amp; ${esc(second[0])}` : `over ${esc(second[0])}`}</div>
        </div>`);
    };
    for (let w = 1; w < week; w++) {
      const sc = weekScores(w);
      sums.forEach((v, k) => sums.set(k, v + (sc.get(k) || 0)));
      tile(`Week ${w}`, '');
    }
    if (live) {
      teams.forEach(t => sums.set(t.manager, sums.get(t.manager) + (mode === 'live' ? t.cur : t.proj)));
      // A finished week is a week like the others: no dashes.
      if (fin) tile(`Week ${week}`, '');
      else tile(`Wk ${week} ${mode === 'live' ? 'live' : 'proj'}`, ' now');
    }
    if (!tiles.length) return '';
    return `
      <div class="ls">
        <div class="cmp-head"><span>Leader after each week</span></div>
        <div class="ls-strip edge-fade">${tiles.join('')}</div>
      </div>`;
  }
  // Open every strip on its latest week. Again a frame later: the first
  // render can land before the section has a width to scroll within.
  function scrollStripsToEnd() {
    const go = () => document.querySelectorAll('#accolades-container .ls-strip').forEach(el => { el.scrollLeft = el.scrollWidth; });
    go();
    requestAnimationFrame(go);
  }

  // ---------- Superlatives: through last week / + this week live / + this week projected ----------
  let superlativesData = null;

  // What the two Superlatives pay (audit X #14), from Rule Changes' payouts.
  let SUP_PAY = null;
  fetch('data/rule-changes.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).then(rc => {
    const list = (rc && rc.current && rc.current.payouts) || [];
    const amt = re => { const x = list.find(p => re.test(p.label)); return x ? x.amount : 0; };
    SUP_PAY = { week: amt(/week/i), season: amt(/season/i), first: amt(/1st/i), second: amt(/2nd/i), third: amt(/3rd/i) };
    renderSuperlatives();
  }).catch(() => {});
  const supPrize = v => (v ? ` <span class="acc-prize">$${v}</span>` : '');

  function renderSuperlatives() {
    const data = superlativesData;
    if (!data) return;
    const container = document.getElementById('accolades-container');
    const teams = (data.teams || []).map(t => ({
      team: t.name,
      manager: t.manager,
      n: medianTeamName(t),
      prior: typeof t.priorPoints === 'number' ? t.priorPoints : (t.pointsFor || 0),
      cur: t.current || 0,
      proj: Math.max(t.projected || 0, t.current || 0),
    }));
    const week = data.week || 1;
    const prevHigh = data.priorSeasonHigh || null;
    const hasPrior = week > 1 && Boolean(prevHigh);

    // Nothing has been scored yet this season: keep the original placeholders.
    if (!hasPrior && !teams.some(t => t.cur > 0)) {
      container.innerHTML =
        renderAccoladeCard('Season High Score') +
        renderAccoladeCard('Season Points Leader');
      return;
    }

    // The shared Season So Far mode. "Through" needs the record as of last
    // week to show, so without one this card reads the live view instead.
    const shared = activeSeasonMode();
    const m = shared === 'through' && !hasPrior ? 'live' : shared;
    // Every game over: "live" is the week's final (audit V #9).
    const fin = weekFinal && m === 'live';

    const tag = (isNew, label) => !hasPrior || m === 'through' ? ''
      : (isNew ? `<span class="badge turf">${label}</span>` : '<span class="badge dim">Holding</span>');
    const card = (eyebrow, score, team, manager, meta, extra, tagHtml) => `
      <div class="accolade-card">
        <div class="acc-head">
          <div class="acc-title">${eyebrow}</div>
          ${tagHtml || ''}
        </div>
        <div class="acc-box">
          <div class="acc-box-row">
            <div class="acc-manager">${manager}</div>
            <div class="acc-score">${fmtScore(score)}</div>
          </div>
          <div class="acc-box-row">
            <div class="acc-team">${team}</div>
            <div class="acc-qualifier">${meta}</div>
          </div>
        </div>
        ${extra || ''}
      </div>`;

    // ----- Season High Score -----
    const recordScore = prevHigh ? prevHigh.score : 0;
    const bestCur = teams.reduce((a, t) => (!a || t.cur > a.cur ? t : a), null);
    const bestProj = teams.reduce((a, t) => (!a || t.proj > a.proj ? t : a), null);
    const liveBreaks = bestCur && bestCur.cur > recordScore;
    const projBreaks = bestProj && bestProj.proj > Math.max(recordScore, bestCur ? bestCur.cur : 0);
    let high;
    if (m === 'through' && prevHigh) high = { score: prevHigh.score, team: prevHigh.team, manager: prevHigh.manager, meta: `Week ${prevHigh.week}`, isNew: false };
    else if (m === 'proj' && projBreaks) high = { score: bestProj.proj, team: bestProj.team, manager: bestProj.manager, meta: `Week ${week} \u00b7 projected`, isNew: true };
    else if (liveBreaks) high = { score: bestCur.cur, team: bestCur.team, manager: bestCur.manager, meta: `Week ${week}${fin ? '' : ' \u00b7 live'}`, isNew: true };
    else if (prevHigh) high = { score: prevHigh.score, team: prevHigh.team, manager: prevHigh.manager, meta: `Week ${prevHigh.week}`, isNew: false };
    else high = { score: bestCur.cur, team: bestCur.team, manager: bestCur.manager, meta: `Week ${week}${fin ? '' : ' \u00b7 live'}`, isNew: true };

    // Shared helper for every comparison row below: maps a value to a 0-100%
    // position on an axis spanning [lo, hi] (padded 8%), so a row's markers
    // sit at their actual relative distance from each other and from any
    // reference line \u2014 not a proportional fill bar.
    const cmpScale = (lo, hi) => {
      const pad = (hi - lo) * 0.08 || 1;
      lo -= pad; hi += pad;
      return v => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    };

    let highExtra = '';
    if (m === 'through') {
      // Who it pays and who's closest (audit X #14), not how to switch views.
      const left = Math.max(0, (data.regularSeasonWeeks || 14) - (week - 1));
      highExtra = `<div class="sup-note">Set in Week ${prevHigh.week}${SUP_PAY && SUP_PAY.week ? `, the score to beat for the $${SUP_PAY.week}` : ''}.${left ? ` ${left} regular-season week${left === 1 ? '' : 's'} left to beat it.` : ''}</div>`;
    } else {
      const topTeams = [...teams].sort((a, b) => (m === 'proj' ? b.proj - a.proj : b.cur - a.cur)).slice(0, 3);
      const domainVals = topTeams.flatMap(r => [r.cur, r.proj]).concat(recordScore ? [recordScore] : []);
      const scale = cmpScale(Math.min(...domainVals), Math.max(...domainVals));
      const refPct = recordScore ? scale(recordScore) : null;
      const rows = topTeams.map((r, i) => {
        const curPct = scale(r.cur), projPct = scale(r.proj);
        const spanLo = Math.min(curPct, projPct), spanW = Math.abs(projPct - curPct);
        const activeVal = m === 'proj' ? r.proj : r.cur;
        const ref = refPct == null ? '' : `<div class="cmp-ref" style="left:${refPct}%"></div>${i === 0 ? `<div class="cmp-ref-label" style="left:${refPct}%">Record</div>` : ''}`;
        return `<div class="cmp-row">
          <div class="cmp-name">${r.n}</div>
          <div class="cmp-track">
            ${ref}
            ${spanW > 0.3 ? `<div class="cmp-link ${m === 'proj' ? 'on' : ''}" style="left:${spanLo}%;width:${spanW}%"></div>` : ''}
            <div class="cmp-dot ${m !== 'proj' ? 'now on' : 'now'}" style="left:${curPct}%"></div>
            ${spanW > 0.3 ? `<div class="cmp-dot ${m === 'proj' ? 'on' : ''}" style="left:${projPct}%"></div>` : ''}
          </div>
          <div class="cmp-val on">${fmtScore(activeVal)}</div>
        </div>`;
      }).join('');
      highExtra = `<div class="cmp-wrap"><div class="cmp-head"><span>Best this week</span><span>${recordScore ? 'vs record ' + fmtScore(recordScore) : ''}</span></div>${rows}</div>`;
    }

    // ----- Season Points Leader -----
    const total = r => r.prior + (m === 'through' ? 0 : m === 'live' ? r.cur : r.proj);
    const ranked = [...teams].sort((a, b) => total(b) - total(a));
    const throughLeader = [...teams].sort((a, b) => b.prior - a.prior)[0];
    const leader = ranked[0];
    const leaderChanged = hasPrior && m !== 'through' && leader.team !== throughLeader.team;
    const modeLabel = m === 'through' ? `Through Week ${week - 1}` : fin ? `Through Week ${week}` : m === 'live' ? `Through Week ${week} so far` : `Projected through Week ${week}`;
    const top4 = ranked.slice(0, 4);
    const domainVals2 = top4.flatMap(r => [r.prior, total(r)]);
    const scale2 = cmpScale(Math.min(...domainVals2), Math.max(...domainVals2));
    const leadRows = top4.map((r, i) => {
      const priorPct = scale2(r.prior), totalPct = scale2(total(r));
      const spanLo = Math.min(priorPct, totalPct), spanW = Math.abs(totalPct - priorPct);
      const delta = total(r) - r.prior;
      return `<div class="cmp-row">
        <div class="cmp-name">${r.n}</div>
        <div class="cmp-track">
          ${spanW > 0.3 ? `<div class="cmp-link ${i === 0 ? 'on' : ''}" style="left:${spanLo}%;width:${spanW}%"></div>` : ''}
          ${m !== 'through' && spanW > 0.3 ? `<div class="cmp-dot" style="left:${priorPct}%"></div>` : ''}
          <div class="cmp-dot now ${i === 0 ? 'on' : ''}" style="left:${totalPct}%"></div>
        </div>
        <div>
          <div class="cmp-val ${i === 0 ? 'on' : ''}">${fmtScore(total(r))}</div>
          ${m === 'through' ? '' : `<div class="cmp-delta">+${fmtScore(delta)}</div>`}
        </div>
      </div>`;
    }).join('');
    // The arrow reads "from where the bars start -> to where they end", so
    // it only belongs in live/projected mode; Through mode has no movement.
    // The pill above already says which view this is (audit XI #9).
    const leadCaption = m === 'through' ? ''
      : `${week > 1 ? 'Week ' + (week - 1) : 'Preseason'} \u2192 Week ${week}${fin ? '' : m === 'live' ? ' live' : ' projected'}`;
    const chaser = ranked[1];
    const leadExtra = `<div class="cmp-wrap"><div class="cmp-head"><span>${leadCaption}</span>${chaser ? `<span>${esc(chaser.manager || chaser.n)} is ${fmtScore(total(leader) - total(chaser))} back</span>` : ''}</div>${leadRows}</div>`
      + leaderStripHtml(teams, leader, week, m, fin);

    container.innerHTML =
      card('Season High Score' + supPrize(SUP_PAY && SUP_PAY.week), high.score, high.team, high.manager, high.meta, highExtra, tag(high.isNew, 'New record')) +
      card('Season Points Leader' + supPrize(SUP_PAY && SUP_PAY.season), total(leader), leader.team, leader.manager, '', leadExtra, tag(leaderChanged, 'New leader'));
    scrollStripsToEnd();
  }


  // Polling every 15 seconds matches the Worker's own cache: within it the
  // Worker returns its D1 copy instantly; only once it's expired does a
  // real ESPN fetch happen, so builds stay at one per 15s however many
  // tabs are open.
  const AUTO_REFRESH_MS = 15 * 1000;

  // ---------- Live refresh motion ----------
  // Every poll rebuilds the matchup cards and Median Watch from scratch, so
  // on its own a score just snaps to its new value. Instead, what each card
  // showed is read off the page before the rebuild, and afterwards every
  // number that moved counts up from it (tickMwNumber, the same tick the
  // Current/Projected toggle uses), a matchup score's gain floats off it,
  // and the odds bar, pips, player outlines and score colors are put back
  // to their old look for one frame so their CSS transitions run to the new
  // one. The status pill pops when it changes (VS -> Live -> Final).
  const muNum = el => (el ? parseFloat(el.textContent) : NaN);

  function captureMatchupState() {
    const state = new Map();
    document.querySelectorAll('.matchups .matchup-card').forEach(card => {
      const sides = ['away', 'home'].map(s => {
        const sc = card.querySelector(`.mu-side.${s} .mu-score`);
        return {
          score: muNum(sc && sc.querySelector('.mu-val')),
          cls: sc ? sc.className : '',
          pips: [...card.querySelectorAll(`.mu-pips-wrap.${s} .mu-pip`)].map(p => p.className),
        };
      });
      const odds = [...card.querySelectorAll('.mu-odds > span')].map(muNum);
      const bars = [...card.querySelectorAll('.mu-bar span')].map(b => b.style.flexGrow);
      const status = card.querySelector('.mu-status');
      const players = new Map([...card.querySelectorAll('.mu-pc[data-pn]')].map(pc =>
        [pc.dataset.pn, { pts: muNum(pc.querySelector('.mu-pts:not(.none)')), cls: pc.className }]));
      state.set(card.dataset.key, { sides, odds, bars, status: status ? status.className.replace(/\s*pop\b/, '') : '', players });
    });
    return state;
  }

  function animateMatchupRefresh(prev) {
    const olds = [], news = [];
    // Put an element's old class back for the frame before its new one, so
    // its color/background transition runs from old to new.
    const restyle = (el, from, to) => {
      if (from === to) return;
      olds.push(() => { el.className = from; });
      news.push(() => { el.className = to; });
    };
    document.querySelectorAll('.matchups .matchup-card').forEach(card => {
      const was = prev.get(card.dataset.key);
      if (!was) return;
      ['away', 'home'].forEach((s, i) => {
        const sc = card.querySelector(`.mu-side.${s} .mu-score`);
        if (!sc) return;
        const val = sc.querySelector('.mu-val');
        const from = was.sides[i].score, to = muNum(val);
        if (!isNaN(from) && !isNaN(to) && Math.abs(to - from) >= 0.005) {
          tickMwNumber(val, from, to);
          if (to > from) { val.classList.remove('glow'); void val.offsetWidth; val.classList.add('glow'); }
          const d = document.createElement('span');
          d.className = 'mu-delta' + (to < from ? ' down' : '');
          d.setAttribute('aria-hidden', 'true');
          d.textContent = (to > from ? '+' : '−') + Math.abs(to - from).toFixed(2);
          d.addEventListener('animationend', () => d.remove());
          sc.appendChild(d);
        }
        restyle(sc, was.sides[i].cls, sc.className);
        const pips = card.querySelectorAll(`.mu-pips-wrap.${s} .mu-pip`);
        if (pips.length === was.sides[i].pips.length) pips.forEach((p, j) => restyle(p, was.sides[i].pips[j], p.className));
      });
      // Odds: the percentages count and the bar's two halves slide.
      const oddsEls = card.querySelectorAll('.mu-odds > span');
      const bars = card.querySelectorAll('.mu-bar span');
      if (oddsEls.length === 2 && was.odds.length === 2) {
        oddsEls.forEach((el, j) => {
          const to = muNum(el);
          if (to !== was.odds[j]) tickMwNumber(el, was.odds[j], to, v => Math.round(v) + '%');
        });
        bars.forEach((b, j) => {
          const from = was.bars[j], to = b.style.flexGrow;
          if (from === to) return;
          olds.push(() => { b.style.flexGrow = from; });
          news.push(() => { b.style.flexGrow = to; });
        });
      }
      const status = card.querySelector('.mu-status');
      if (status && was.status && status.className !== was.status) {
        status.classList.add('pop');
        status.addEventListener('animationend', () => status.classList.remove('pop'), { once: true });
      }
      // The open roster: each player's points count and his outline fades
      // between not started / live / has the ball / done.
      if (card.classList.contains('expanded')) {
        card.querySelectorAll('.mu-pc[data-pn]').forEach(pc => {
          const p = was.players.get(pc.dataset.pn);
          if (!p) return;
          restyle(pc, p.cls, pc.className);
          const pts = pc.querySelector('.mu-pts:not(.none)'), to = muNum(pts);
          if (!isNaN(p.pts) && !isNaN(to) && Math.abs(to - p.pts) >= 0.005) tickMwNumber(pts, p.pts, to);
        });
      }
    });
    if (!olds.length) return;
    olds.forEach(f => f());
    void document.body.offsetWidth;
    news.forEach(f => f());
  }

  // Median Watch: each card's score and margin, and the median itself, count
  // from the last poll's numbers when the mode hasn't changed in between.
  function animateMedianRefresh(prevTeams, prevData) {
    if (!prevTeams || !prevData) return;
    const mode = medianViewMode;
    const oldMedian = mwMedian(mode, prevData), median = mwMedian(mode);
    const moved = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) >= 0.005;
    document.querySelectorAll('#median-above .mb-card, #median-below .mb-card').forEach(card => {
      const t = lastMedianTeams.find(x => medianTeamName(x) === card.dataset.name);
      const o = prevTeams.find(x => medianTeamName(x) === card.dataset.name);
      if (!t || !o) return;
      if (moved(o[mode], t[mode])) tickMwNumber(card.querySelector('.mw-score'), o[mode], t[mode]);
      if (moved(o[mode] - oldMedian, t[mode] - median)) {
        tickMwNumber(card.querySelector('.mw-margin'), o[mode] - oldMedian, t[mode] - median, fmtMwMargin);
      }
    });
    const splitValueEl = document.querySelector('#median-container .median-split-label b');
    if (splitValueEl && moved(oldMedian, median)) tickMwNumber(splitValueEl, oldMedian, median);
  }

  // Until a visitor has said which team is theirs (site audit II #36),
  // the top slot asks once. The ✕ hides the ask for good; the You button in
  // the bar opens the same sheet any time.
  const ME_ASK_KEY = 'rl-me-ask-hidden';
  function renderMePrompt(hasMine) {
    const section = document.getElementById('me-section');
    let hidden = false;
    try { hidden = !!localStorage.getItem(ME_ASK_KEY); } catch (e) {}
    const ask = !getMe() && !hidden;
    // Once this season's title game is in, your Season Wrapped (site audit
    // II #39) sits here, at the top of the page.
    const wrappedName = leagueGames && leagueGames.some(g => g.year === leagueYear && g.type === 'Champ')
      ? [...new Set(leagueGames.filter(g => g.year === leagueYear).flatMap(g => [g.p1, g.p2]))].find(n => isMe(n)) : null;
    const oldWrap = document.getElementById('me-wrapped');
    if (oldWrap) oldWrap.remove();
    if (wrappedName) {
      section.insertAdjacentHTML('afterbegin', `<a class="me-ask me-wrapped" id="me-wrapped" href="${esc(pageLink('wrapped.html', { m: wrappedName, year: leagueYear }))}">
          <span class="me-ask-go">Your ${leagueYear} Season Wrapped <span>Best week, worst lineup call, bubble luck and a picture for the chat.</span></span><span class="chev" aria-hidden="true">›</span>
        </a>`);
    }
    section.hidden = !hasMine && !ask && !wrappedName;
    const old = document.getElementById('me-ask');
    if (!ask) { if (old) old.remove(); return; }
    if (old) return;
    section.insertAdjacentHTML('afterbegin', `<div class="me-ask" id="me-ask">
        <button type="button" class="me-ask-go">Which team is yours? <span>Pick it once and your matchup comes first.</span></button>
        <button type="button" class="x" aria-label="Don't ask again">✕</button>
      </div>`);
    const el = document.getElementById('me-ask');
    el.querySelector('.me-ask-go').addEventListener('click', () => window.openYou && openYou());
    el.querySelector('.x').addEventListener('click', () => {
      try { localStorage.setItem(ME_ASK_KEY, '1'); } catch (e) {}
      el.remove();
      section.hidden = !document.getElementById('my-matchup').children.length && !document.getElementById('me-wrapped');
    });
  }
  // The status line: your place in the standings, the playoff line, your
  // odds and this week's opponent. Shown only on the live week and only once
  // you've picked your team. The ✕ remembers "year:week", so it comes back
  // when the next week starts and not before.
  const STATUS_KEY = 'rl-status-hidden';
  const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const recWL = r => String(r || '').split('-').map(Number);
  // ---------- On waivers (audit VIII #6) ----------
  // Tuesday to the week's first kickoff: last week's best free agent at each
  // spot, and who needs one (a starter projected 0 with nobody on the bench
  // for it). The minus folds it to its title, remembered on this phone.
  const WV_MIN = 'rl-waiver-min';
  function renderWaivers(data) {
    const el = document.getElementById('waiver-section');
    if (!el) return;
    const first = data && Date.parse(data.firstKickoff);
    if (!data || data.archived || isPlayoffWeek(data) || shownYear() !== leagueYear || !(first > Date.now())) { el.hidden = true; el.innerHTML = ''; return; }
    needRoster();
    const R = rosterInfo;
    if (!R || !R.fa || !R.fa.players || !R.fa.players.length) { el.hidden = true; el.innerHTML = ''; return; }
    const wk = data.week;
    const plays = tm => !R.byes || R.byes[tm] !== wk;
    // Who needs one: every team's holes the bench can't cover.
    const need = {};
    (data.matchups || []).forEach(m => [[m.awayManager, m.awayPlayers], [m.homeManager, m.homePlayers]].forEach(([mgr, ps]) => {
      holesOf(ps).forEach(({ player }) => {
        const f = fillers(mgr, player.name, player.slot);
        if (f && f.bench.length) return;
        const self = (R.rosters[mgr] || []).find(p => p.n === player.name);
        const pos = self ? self.pos : player.slot;
        (need[pos] = need[pos] || []).push(mgr);
      });
    }));
    const rows = ['QB', 'RB', 'WR', 'TE'].map(pos => {
      const list = R.fa.players.filter(p => p.pos === pos && plays(p.tm));
      return list.length ? { pos, top: list[0], next: list[1], need: need[pos] || [] } : null;
    }).filter(Boolean).sort((a, b) => (b.need.length > 0) - (a.need.length > 0));
    if (!rows.length) { el.hidden = true; el.innerHTML = ''; return; }
    let min = false;
    try { min = localStorage.getItem(WV_MIN) === '1'; } catch (e) {}
    const whoNeeds = list => list.map(n => (isMe(n) ? 'you' : esc(n))).join(', ');
    const lead = rows[0];
    const summary = lead.need.length ? `<b>${esc(lead.top.n)}</b> (${lead.pos}) is the pick for ${whoNeeds(lead.need)}` : `<b>${esc(lead.top.n)}</b> leads at ${lead.pos} with ${Number(lead.top.pts).toFixed(1)}`;
    const body = rows.map(r => `<div class="wv-row"><span class="wv-pos ${r.pos}">${r.pos}</span><div style="min-width:0"><div class="wv-n">${esc(r.top.n)} <span>${esc(r.top.tm)}</span></div>
        <div class="wv-s">${r.need.length ? `Needed by <b>${whoNeeds(r.need)}</b>` : r.next ? `Next: ${esc(r.next.n)} ${Number(r.next.pts).toFixed(1)}` : ''}</div></div><span class="wv-v">${Number(r.top.pts).toFixed(1)}</span></div>`).join('');
    el.innerHTML = `<div class="glass wv-card${min ? ' lv-folded' : ''}">${lvHead('On waivers', min ? summary : `Week ${R.fa.week || wk - 1} points`, 'data-wv-min', !min)}
      ${min ? '' : `<div class="wv-body"><div class="item">${body}</div>
        <div class="wv-acts"><a href="${esc(espnUrl('players/add', {}))}" target="_blank" rel="noopener">Waiver wire in ESPN</a><a class="plain" href="roster.html">Your Roster</a></div></div>`}</div>`;
    el.hidden = false;
  }
  document.getElementById('waiver-section').addEventListener('click', e => {
    if (!e.target.closest('[data-wv-min]') && !e.target.closest('.lv-folded .lv-head')) return;
    let min = false;
    try { min = localStorage.getItem(WV_MIN) === '1'; localStorage.setItem(WV_MIN, min ? '0' : '1'); } catch (err) {}
    if (shownData) renderWaivers(shownData);
  });

  function renderStatusLine(data) {
    const el = document.getElementById('status-section');
    const teams = data.teams || [];
    const t = getMe() && !data.archived && !data.playoffWeek && data.week ? teams.find(x => x.manager && isMe(x.manager)) : null;
    catchupTick(data, t);
    if (t && renderCatchUp(el, data, t)) return;
    // A starter projected 0 takes the line until it's fixed (audit VIII #3).
    const myMu = t && (data.matchups || []).find(m => isMe(m.awayManager) || isMe(m.homeManager));
    const myHoles = myMu ? holesOf(isMe(myMu.awayManager) ? myMu.awayPlayers : myMu.homePlayers) : [];
    if (myHoles.length) {
      const h = myHoles[0], more = myHoles.length - 1;
      needRoster();
      el.innerHTML = `<div class="st-line st-warn"><span class="st-mono" aria-hidden="true">!</span>
        <p class="st-text"><b>${esc(h.player.name)} ${HOLE_TEXT[h.kind]}.</b> ${more ? `And ${more} more in your lineup. ` : `Your ${esc(h.player.slot)} projects 0. `}${esc(fixText(t.manager, h.player.name, h.player.slot))}</p>
        <button type="button" class="st-go" data-st-go>Fix</button></div>`;
      el.hidden = false;
      return;
    }
    // A playoff week says what this game means for you (audit XI #17).
    if (t && isPlayoffWeek(data) && renderPlayoffLine(el, data, t)) return;
    const key = `${data.year || leagueYear}:${data.week}`;
    let hidden = false;
    try { hidden = localStorage.getItem(STATUS_KEY) === key; } catch (e) {}
    if (!hidden && renderYourWeek(el, data, t, key)) return;
    if (!t || hidden || typeof t.standing !== 'number') { el.hidden = true; el.innerHTML = ''; return; }
    // "You're 8th at 4-6, 1 game back of the playoff line, with a 38% shot at the
    // playoffs. Up next: Jared." Each clause is left out when its number isn't there.
    // Once every game is over, ESPN's record and rank are still last week's
    // until it rolls the week over, so they get this week's results added
    // (as Superlatives' final view does), and "up next" is next week's
    // opponent (audit V #16).
    const after = weekFinal ? standingsAfter(data) : null;
    const recOf = x => (after && after.get(x.manager) ? after.get(x.manager).rec : x.record);
    const rankOf = x => (after && after.get(x.manager) ? after.get(x.manager).rank : x.standing);
    let line = '';
    const spots = data.playoffTeamCount || 0;
    const order = teams.filter(x => typeof x.standing === 'number').sort((a, b) => rankOf(a) - rankOf(b));
    if (spots && order.length > spots) {
      // Games from the last playoff spot, or the first spot out; a game is a win more or a loss fewer.
      const [w, l] = recWL(recOf(t));
      const edge = recWL(recOf(order[rankOf(t) > spots ? spots - 1 : spots]));
      const gb = rankOf(t) > spots ? ((edge[0] - w) + (l - edge[1])) / 2 : ((w - edge[0]) + (edge[1] - l)) / 2;
      const n = gb % 1 ? gb.toFixed(1) : String(gb);
      line = `, ${n} ${gb === 1 ? 'game' : 'games'} ${rankOf(t) > spots ? 'back of' : 'up on'} the playoff line`;
    }
    const odds = t.clinch === 'e' ? ', and out of the playoff race' : t.clinch ? `, and ${t.clinch === 'z' ? 'sure of a bye' : 'in the playoffs'}`
      : typeof t.playoffPct === 'number' ? `, with a <b>${RaceSim.pct(t.playoffPct)}</b> shot at the playoffs` : '';
    const mu = (data.matchups || []).find(m => isMe(m.awayManager) || isMe(m.homeManager));
    const opp = weekFinal ? (t.ahead || [])[1] : mu && (isMe(mu.awayManager) ? mu.homeManager : mu.awayManager);
    // Up next goes to your card (audit VIII #4), this week's opponent only.
    const next = opp ? ` Up next: ${weekFinal ? `<b>${esc(opp)}</b>` : `<button type="button" class="st-next" data-st-go>${esc(opp)} ›</button>`}.` : '';
    el.innerHTML = `<div class="st-line"><span class="st-mono">${esc(monogram(t.manager))}</span>
      <p class="st-text">You're <b>${ordinal(rankOf(t))} at ${esc(recOf(t))}</b>${line}${odds}.${next}</p>
      <button type="button" class="st-x" aria-label="Hide until next week">✕</button></div>`;
    el.dataset.key = key;
    el.hidden = false;
  }
  // The table once this week counts (Superlatives' final view): manager ->
  // { rec, rank, w, l, pf }, by wins then points.
  function standingsAfter(data) {
    const rows = projectStandings(data, 'live').sort((a, b) => b.w - a.w || b.pf - a.pf);
    return new Map(rows.map((r, i) => [r.manager, { rec: formatRecordParts(r.w, r.l, r.ties), rank: i + 1, w: r.w, l: r.l, pf: r.pf }]));
  }

  // ---------- Your week (audit V #12, #13) ----------
  // From the last whistle of the week until ESPN rolls it over, the status
  // line's place holds a card about you: the result, what it did to your
  // record, place and playoff odds (the site's own sim, run without and with
  // this week), and who's next, with the series and what a win or a loss
  // would do to your odds. The card is kept, so after the rollover it stays
  // up until the next week's first kickoff. The first time you see a result
  // it plays once: the scores count up, the result stamps in, and a gold
  // sweep crosses the card when you had the week's top score.
  const YW_KEY = 'rl-your-week', YW_SEEN = 'rl-your-week-seen';
  let ywMemo = null;
  const ywLogo = name => {
    const p = franchiseData && franchiseData.players.find(x => x.name === name);
    return (p && p.current_team_logo) || '';
  };
  function yourWeekModel(data, t) {
    // Polls bring the same final numbers every 15 seconds; the sims run once.
    const memoKey = [data.year, data.week, t.manager, data.currentMedian, ...(data.teams || []).map(x => x.current)].join('|');
    if (ywMemo && ywMemo.k === memoKey) return ywMemo.m;
    const m = (data.matchups || []).find(x => isMe(x.awayManager) || isMe(x.homeManager));
    const inp = typeof RaceSim !== 'undefined' && RaceSim.inputs(data);
    if (!m || !inp) return null;
    const away = isMe(m.awayManager);
    const my = parseFloat(away ? m.awayScore : m.homeScore) || 0, th = parseFloat(away ? m.homeScore : m.awayScore) || 0;
    const players = (away ? m.awayPlayers : m.homePlayers) || [];
    const proj = players.reduce((s, p) => s + (p.projectedPoints || 0), 0);
    const teams = data.teams || [];
    const top = my >= Math.max(...teams.map(x => x.current || 0));
    const median = data.medianGames === false ? null : data.currentMedian;
    // Odds after this week (with the win/lose split for next week), and
    // before it: the same payload with this week's games unplayed.
    const after = RaceSim.simulate(inp, RaceSim.RUNS, null, true);
    const binp = RaceSim.inputs(Object.assign({}, data, { matchups: [] }));
    const before = binp ? RaceSim.simulate(binp, RaceSim.RUNS) : null;
    const table = standingsAfter(data);
    const me = table.get(t.manager);
    const prior = t.prior || {};
    const oppName = (t.ahead || [])[1] || null;
    const ot = oppName && teams.find(x => x.manager === oppName);
    let next = null;
    if (ot) {
      const s = seriesFor(t.manager, oppName, data.week + 1);
      let run = 0, runBy = null;
      if (s && s.form.length) {
        const k = s.form[s.form.length - 1];
        for (let i = s.form.length - 1; i >= 0 && s.form[i] === k; i--) run++;
        runBy = k === 'W' ? t.manager : oppName;
      }
      const o = table.get(oppName) || {};
      next = {
        name: oppName, team: ot.name, rec: o.rec || ot.record, rank: o.rank || ot.standing,
        series: s ? [s.a, s.b] : null, run, runBy,
        ifWin: after[t.manager] && after[t.manager].ifWin, ifLoss: after[t.manager] && after[t.manager].ifLoss,
      };
    }
    const model = {
      year: data.year || leagueYear, week: data.week, me: t.manager, opp: away ? m.homeManager : m.awayManager,
      my, th, top, median, proj: proj ? my - proj : null,
      rec: me ? me.rec : t.record, recBefore: formatRecordParts(prior.w || 0, prior.l || 0, prior.t || 0),
      rank: me ? me.rank : t.standing, rankBefore: t.standing,
      odds: after[t.manager] ? after[t.manager].po : null, oddsBefore: before && before[t.manager] ? before[t.manager].po : null,
      next,
    };
    ywMemo = { k: memoKey, m: model };
    return model;
  }
  function yourWeekHtml(y, play) {
    const res = y.my > y.th ? 'Won' : y.my < y.th ? 'Lost' : 'Tied';
    const tags = [];
    if (y.top) tags.push('<span class="yw-tag">Top score of the week</span>');
    if (typeof y.median === 'number') tags.push(`<span class="yw-tag${y.my > y.median ? '' : ' n'}">${y.my > y.median ? 'Beat' : 'Missed'} the median by ${fmtScore(Math.abs(y.my - y.median))}</span>`);
    if (typeof y.proj === 'number') tags.push(`<span class="yw-tag n">${cuSigned(y.proj)} vs projection</span>`);
    // "▲ from 4-6": green up, red down, "no change" in grey.
    const move = (better, same, from) => (same ? '<span>no change</span>' : `<b class="${better ? '' : 'dn'}">${better ? '▲' : '▼'} from ${from}</b>`);
    const [w1, l1] = recWL(y.rec), [w0, l0] = recWL(y.recBefore);
    const oddsR = v => Math.round(v);
    const mv = (label, val, sub) => `<div class="yw-mv"><div class="l">${label}</div><div class="v">${val}</div><div class="f">${sub}</div></div>`;
    const moves = [
      mv('Record', esc(y.rec), move(w1 - l1 >= w0 - l0, y.rec === y.recBefore, esc(y.recBefore))),
      typeof y.rank === 'number' ? mv('Standing', ordinal(y.rank), move(y.rank < y.rankBefore, y.rank === y.rankBefore, ordinal(y.rankBefore || y.rank))) : '',
      typeof y.odds === 'number' ? mv('Playoff odds', RaceSim.pct(y.odds), typeof y.oddsBefore === 'number' ? move(oddsR(y.odds) > oddsR(y.oddsBefore), oddsR(y.odds) === oddsR(y.oddsBefore), RaceSim.pct(y.oddsBefore)) : '') : '',
    ].join('');
    let nextHtml = '';
    const n = y.next;
    if (n) {
      const ser = !n.series ? '' : n.series[0] === n.series[1] ? (n.series[0] ? `Tied <b>${n.series[0]}-${n.series[1]}</b>` : 'First meeting')
        : n.series[0] > n.series[1] ? `You lead <b>${n.series[0]}-${n.series[1]}</b>` : `${esc(n.name)} leads <b>${n.series[1]}-${n.series[0]}</b>`;
      const run = n.run > 1 ? ` · ${n.runBy === y.me ? 'you' : esc(n.runBy)} won the last ${n.run}` : '';
      const logo = ywLogo(n.name);
      const pct = v => (typeof v === 'number' ? RaceSim.pct(v) : '—');
      nextHtml = `<a class="yw-next" href="${esc(pageLink('head-to-head.html', { a: y.me, b: n.name }))}">
          <div class="r1"><span class="k">Up next · Week ${y.week + 1}</span><span class="ser">${ser}${run}</span></div>
          <div class="opp"><span class="yw-lg">${logo ? `<img src="${esc(logo)}" alt="">` : esc(monogram(n.name))}</span><div><b>${esc(n.name)}</b><span>${esc(n.rec)}${n.rank ? ` · ${ordinal(n.rank)}` : ''} · ${esc(n.team)}</span></div></div>
          ${typeof n.ifWin === 'number' || typeof n.ifLoss === 'number' ? `<div class="stakes"><div class="stake w"><span>If you win</span><b>${pct(n.ifWin)}</b></div><div class="stake l"><span>If you lose</span><b>${pct(n.ifLoss)}</b></div></div>` : ''}
        </a>`;
    }
    const sc = v => `<span data-count="${v}">${fmtScore(v)}</span>`;
    return `<div class="yw${play ? ' play' : ''}${play && y.top ? ' top' : ''}">
        <div class="yw-sweep" aria-hidden="true"></div>
        <div class="yw-h"><b>Your Week ${y.week}</b><span class="yw-res${res === 'Lost' ? ' l' : res === 'Tied' ? ' t' : ''}">${res}</span><button type="button" class="st-x" aria-label="Hide until next week">✕</button></div>
        <div class="yw-body"><div>
          <div class="yw-score"><div class="s mine"><b>${esc(y.me)}</b>${sc(y.my)}</div><span class="d">–</span><div class="s r"><b>${esc(y.opp)}</b>${sc(y.th)}</div></div>
          ${tags.length ? `<div class="yw-tags">${tags.join('')}</div>` : ''}
          <div class="yw-moves">${moves}</div>
        </div><div>${nextHtml}</div></div>
      </div>`;
  }
  function ywCountUp(root) {
    root.querySelectorAll('[data-count]').forEach(el => {
      const to = Number(el.dataset.count), t0 = performance.now(), dur = 950;
      const step = now => {
        const p = Math.min(1, (now - t0) / dur);
        el.textContent = fmtScore(to * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  function renderYourWeek(el, data, t, key) {
    if (!getMe() || data.archived || data.pastSeason || isPlayoffWeek(data) || data !== liveData) return false;
    let y = null;
    if (weekFinal && t) {
      y = yourWeekModel(data, t);
      if (y) { try { localStorage.setItem(YW_KEY, JSON.stringify(y)); } catch (e) {} }
    } else if (!(data.teams || []).some(x => (x.current || 0) > 0)) {
      // After the rollover, until the first kickoff: the card from last week.
      try { y = JSON.parse(localStorage.getItem(YW_KEY) || 'null'); } catch (e) {}
      if (!y || y.year !== (data.year || leagueYear) || y.week !== data.week - 1 || !isMe(y.me)) y = null;
    }
    if (!y) return false;
    const seenKey = `${y.year}:${y.week}:${y.me}`;
    let seen = false;
    try { seen = localStorage.getItem(YW_SEEN) === seenKey; } catch (e) {}
    const play = !seen && !mwReduceMotion && !document.hidden;
    // A poll redraws the same card in place without replaying it.
    const html = yourWeekHtml(y, false);
    if (el.dataset.yw !== html || play || !el.querySelector('.yw')) {
      el.innerHTML = yourWeekHtml(y, play);
      el.dataset.yw = html;
      if (play) ywCountUp(el);
    }
    if (!seen && !document.hidden) { try { localStorage.setItem(YW_SEEN, seenKey); } catch (e) {} }
    el.dataset.key = key;
    el.hidden = false;
    return true;
  }

  // ---------- Catch me up (audit IV #9) ----------
  // Every look at the live week leaves a snapshot behind (your score, your
  // opponent's, the median, and when). Come back to games in progress after
  // 20 minutes or more and the status line's place shows what changed since:
  // the scores then and now, the median, and the four biggest plays of your
  // matchup (the Feed's big plays, feedLoad). Got it puts the status line back,
  // and so do the games ending. The first look after an app launch reads the
  // snapshot from localStorage; one after the tab was hidden reads the last
  // one in memory (a hidden tab doesn't poll).
  const SEEN_KEY = 'rl-live-seen', AWAY_MS = 20 * 60 * 1000;
  let catchup = null, lastSnap = null, snapFor = null;
  const gamesOn = data => {
    const ms = data.matchups || [];
    return ms.length > 0 && !ms.every(matchupDecided) && (data.teams || []).some(t => (t.current || 0) > 0);
  };
  function liveSnap(data, t) {
    const m = (data.matchups || []).find(x => isMe(x.awayManager) || isMe(x.homeManager));
    if (!m || !t) return null;
    const away = isMe(m.awayManager);
    return {
      at: Date.now(), ts: Date.parse(data.updatedAt) || Date.now(), key: `${data.year || leagueYear}:${data.week}`, me: t.manager,
      opp: away ? m.homeManager : m.awayManager, my: Number(away ? m.awayScore : m.homeScore) || 0, theirs: Number(away ? m.homeScore : m.awayScore) || 0,
      median: Number(data.currentMedian) || 0,
    };
  }
  function catchupTick(data, t) {
    if (data !== liveData || data === snapFor || data.archived || data.pastSeason || !t) return;
    snapFor = data;
    const snap = liveSnap(data, t);
    if (!snap) return;
    let before = lastSnap;
    if (!before) { try { before = JSON.parse(localStorage.getItem(SEEN_KEY)); } catch (e) {} }
    if (before && before.key === snap.key && before.me === snap.me && snap.at - before.at >= AWAY_MS && gamesOn(data)) catchup = { snap: before, dismissed: false };
    if (!gamesOn(data)) catchup = null;
    // Only a look at the screen counts as having looked.
    if (!document.hidden) {
      lastSnap = snap;
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(snap)); } catch (e) {}
    }
  }
  const cuSigned = n => (n < 0 ? '\u2212' : '+') + Math.abs(n).toFixed(2);
  function renderCatchUp(el, data, t) {
    if (!catchup || catchup.dismissed || data !== liveData || !gamesOn(data)) return false;
    const was = catchup.snap, now = liveSnap(data, t);
    if (!now || now.key !== was.key) return false;
    const plays = feedFor(data.week).filter(e => e.k !== 'p' && e.t > was.ts && (e.m === now.me || e.m === now.opp))
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    if (Math.abs(now.my - was.my) < 0.005 && Math.abs(now.theirs - was.theirs) < 0.005 && !plays.length) return false;
    const lead = now.my - now.theirs;
    const chip = Math.abs(lead) < 0.005 ? 'Tied' : `You ${lead > 0 ? 'lead' : 'trail'} by ${Math.abs(lead).toFixed(2)}`;
    const row = (label, sub, from, to, cls) => `<div class="cu-row"><span class="n">${label}${sub ? `<small>${sub}</small>` : ''}</span><span class="from">${fmtScore(from)} \u2192</span><span><span class="to ${cls}">${fmtScore(to)}</span><span class="d">${cuSigned(to - from)}</span></span></div>`;
    const above = now.my - now.median;
    const medianRow = isPlayoffWeek(data) ? '' : row('Median', `you\u2019re ${fmtScore(Math.abs(above))} ${above >= 0 ? 'above' : 'below'} it`, was.median, now.median, 'dim');
    el.innerHTML = `<div class="cu glass">
      <div class="cu-h"><b>Since you looked at ${esc(fdTime(was.ts))}</b><span class="cu-chip">${chip}</span></div>
      <div class="cu-lines">${row(`You \u00b7 ${esc(now.me)}`, '', was.my, now.my, 'mine')}${row(esc(now.opp), '', was.theirs, now.theirs, '')}${medianRow}</div>
      ${plays.length ? `<div class="cu-plays">${plays.slice(0, 4).map(e => {
        const what = feedWhat(e);
        return `<div class="cu-play${e.m === now.me ? ' mine' : ''}${e.d >= 6 && /TD/.test(what) ? ' td' : ''}"><span class="t">${esc(fdTime(e.t))}</span><span class="w"><b>${esc(e.n)}</b><span>${esc(what)} \u00b7 ${e.m === now.me ? 'yours' : esc(e.m) + '\u2019s'}</span></span><span class="p">${cuSigned(e.d)}</span></div>`;
      }).join('')}</div>` : ''}
      <div class="cu-foot">${plays.length ? `<a class="cu-more" href="feed.html">${plays.length > 4 ? `All ${plays.length} big plays` : 'Open the Feed'} \u203a</a>` : '<span></span>'}<button type="button" class="cu-got">Got it</button></div>
    </div>`;
    el.dataset.key = '';
    el.hidden = false;
    return true;
  }
  // "Fix" and "Up next" land on your card, clear of the folded title bar.
  function goToMyCard() {
    const c = document.querySelector('.matchup-card.me');
    if (!c) return;
    window.scrollTo({ top: c.getBoundingClientRect().top + window.scrollY - 76, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  document.getElementById('status-section').addEventListener('click', e => {
    if (e.target.closest('[data-st-go]')) { goToMyCard(); return; }
    if (e.target.closest('.cu-got')) {
      if (catchup) catchup.dismissed = true;
      if (shownData) renderStatusLine(shownData);
      return;
    }
    if (!e.target.closest('.st-x')) return;
    const el = document.getElementById('status-section');
    // The time lets You > Settings > Hidden cards tell this week's closing from an old one.
    try { localStorage.setItem(STATUS_KEY, el.dataset.key || ''); localStorage.setItem(STATUS_KEY + '-at', String(Date.now())); } catch (err) {}
    el.hidden = true;
    el.innerHTML = '';
  });
  // Picking (or changing) your team redraws from the numbers already here.
  let lastDashboardData = null;
  // liveData: the Worker's latest live answer. shownData: whatever is on
  // screen -- the live week, or a past one picked with the week stepper.
  let liveData = null, shownData = null;
  window.addEventListener('rl-me', () => { if (shownData) renderDashboard(shownData, false, true); });
  // The standings tags need the head-to-head history, which lands on its own.
  Rivals.ready().then(book => { if (book && standingsData) renderStandings(); });
  window.addEventListener('rl-settings', () => { if (shownData) renderDashboard(shownData, false, true); });

  // ---------- Week picker and stepper ----------
  // Any week of any season. ‹ › step one week at a time, across seasons;
  // the title opens a picker with every season and its weeks.
  //   - This season's finished weeks: the Worker rebuilds them (/?week=N)
  //     the way the live dashboard looked once they were over.
  //   - Past seasons: built here from league.json and data/lineups/<year>.json
  //     (see "Past seasons" below), with less detail the further back:
  //     2019 on has rosters with stat lines and game logs, 2017-2018 rosters
  //     with points only, 2015-2016 scores only.
  // view === null is the live week. The address keeps ?year=&week= so a
  // past week can be shared or reloaded.
  let view = null; // { year, week }
  const pastWeeks = new Map(); // "year:week" -> Promise of that week's dashboard
  const liveWeekNow = () => (liveData && (liveData.liveWeek || liveData.week)) || 0;
  const viewKey = v => (v ? `${v.year}:${v.week}` : 'live');

  // Weeks a season has: this one up to the live week, a past one all of them.
  function seasonWeekCount(year) {
    if (year === leagueYear) return liveWeekNow();
    return Math.max(0, ...(leagueGames || []).filter(g => g.year === year).map(g => g.week));
  }
  function seasonYears() {
    return [...new Set((leagueGames || []).map(g => g.year))].concat(leagueYear || []).filter((y, i, a) => a.indexOf(y) === i).sort((a, b) => b - a);
  }
  // Every week there is to show, oldest first.
  const onScreen = () => view || { year: leagueYear, week: liveWeekNow() };

  // ---------- What the week is doing (audit IX #1) ----------
  // From every starter's game: games on now and starters in them, else the
  // day that finished and the next kickoff, else the first kickoff.
  function weekState(data) {
    const games = new Map();
    let playing = 0;
    for (const m of data.matchups || []) {
      playing += (parseInt(m.awayInPlay, 10) || 0) + (parseInt(m.homeInPlay, 10) || 0);
      for (const s of ['away', 'home']) for (const p of m[s + 'Players'] || []) {
        const g = p.game;
        if (g && g.date) games.set([g.team, g.opponent].sort().join('-') + g.date, g);
      }
    }
    const all = [...games.values()];
    const live = all.filter(g => g.state === 'in').length;
    const tz = { timeZone: 'America/New_York' };
    const day = ms => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', ...tz });
    const at = ms => `${day(ms)} ${new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...tz }).replace(':00', '')}`;
    const pre = all.filter(g => g.state === 'pre').map(g => Date.parse(g.date)).sort((a, b) => a - b);
    const post = all.filter(g => g.state === 'post').map(g => Date.parse(g.date)).sort((a, b) => b - a);
    if (weekFinal) return { html: '<b>Final</b>', text: 'Final' };
    if (live) return { live: true, html: `<b>${live} game${live === 1 ? '' : 's'} live</b> · ${playing} starter${playing === 1 ? '' : 's'} playing`, text: `${live} game${live === 1 ? '' : 's'} live` };
    if (post.length && pre.length) return { html: `<b>${day(post[0])} final</b> · ${at(pre[0])} next`, text: `${at(pre[0])} next` };
    if (pre.length) return { html: `First kickoff ${at(pre[0])}`, text: `Kickoff ${at(pre[0])}` };
    return { html: 'Updated', text: '' };
  }

  // ---------- Your matchup, in the folded bar and as toasts (audit IX #3, #11) ----------
  // nav.js asks rlFoldScore() for the bar; Live and Feed both answer.
  // rlLiveMine tells the tab bar whether your starters are on the field.
  // Between polls, the biggest gain in your matchup since the last one
  // gets a toast naming the player.
  let foldMu = null, liveLogos = {}, lastPts = null;
  teamLogos().then(l => { liveLogos = l; });
  window.rlFoldScore = () => foldMu;
  function foldAndToast(data, archived) {
    const mu = (data.matchups || []).find(m => isMe(m.awayManager) || isMe(m.homeManager));
    if (!mu) { foldMu = null; lastPts = null; window.dispatchEvent(new CustomEvent('rl-fold')); return; }
    const s = isMe(mu.awayManager) ? 'away' : 'home', o = s === 'away' ? 'home' : 'away';
    const done = archived || matchupDecided(mu);
    const inPlay = (parseInt(mu[s + 'InPlay'], 10) || 0) + (parseInt(mu[o + 'InPlay'], 10) || 0);
    const n2 = v => (Number(v) || 0).toFixed(2);
    foldMu = { me: mu[s + 'Manager'], opp: mu[o + 'Manager'], meScore: n2(mu[s + 'Score']), oppScore: n2(mu[o + 'Score']),
      meProj: done ? '' : n2(mu[s + 'Projected']), oppProj: done ? '' : n2(mu[o + 'Projected']),
      pct: done ? null : mu[s + 'WinProbability'], live: !done && inPlay > 0,
      line: done ? (mu[s + 'Score'] > mu[o + 'Score'] ? 'Final · you won' : 'Final · you lost') : `Week ${data.week} · ${weekState(data).text}` };
    window.dispatchEvent(new CustomEvent('rl-fold'));
    if (archived) { lastPts = null; return; }
    if (window.rlLiveMine) rlLiveMine((parseInt(mu[s + 'InPlay'], 10) || 0) > 0);
    const pts = new Map();
    for (const side of [s, o]) for (const p of mu[side + 'Players'] || []) pts.set(p.name, { pts: Number(p.livePoints) || 0, who: mu[side + 'Manager'] });
    if (lastPts && lastPts.key === mu[s + 'Manager'] + mu[o + 'Manager']) {
      let best = null;
      pts.forEach((v, name) => { const was = lastPts.pts.get(name); const d = was ? v.pts - was.pts : 0; if (d >= 0.5 && (!best || d > best.d)) best = { name, d, who: v.who }; });
      if (best) playToast(`${avatarHtml(best.who, liveLogos, isMe(best.who) ? 'ring' : 'ringw')}<span>${esc(best.name)} <b>+${best.d.toFixed(2)}</b></span>`);
    }
    lastPts = { key: mu[s + 'Manager'] + mu[o + 'Manager'], pts };
  }

  // The week chip names the week on screen (and its season, when it isn't this one).
  function renderWeekStep() {
    const chip = document.getElementById('wk-title');
    const live = liveWeekNow();
    if (!live || !leagueGames) { chip.hidden = true; return; }
    const at = onScreen();
    chip.hidden = false;
    document.getElementById('wk-chip-t').textContent = `${at.year !== leagueYear ? at.year + ' · ' : ''}Week ${at.week}`;
    chip.setAttribute('aria-label', `Week ${at.week}${at.year !== leagueYear ? ', ' + at.year : ''}: pick a week`);
  }

  function setViewParams(v) {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('week');
      url.searchParams.delete('year');
      if (v) {
        if (v.year !== leagueYear) url.searchParams.set('year', v.year);
        url.searchParams.set('week', v.week);
      }
      history.replaceState(history.state, '', url);
    } catch (e) {}
  }

  function fetchCurrentSeasonWeek(week) {
    return fetch(`${WORKER_URL}/?week=${week}`)
      .then(res => res.json())
      .then(d => { if (!d || !d.teams || !d.archived) throw new Error((d && d.error) || 'No data for that week'); return d; });
  }

  function showView(year, week) {
    const live = liveWeekNow();
    if (!live) return;
    plHide();
    mwHide();
    wpHide();
    const isLive = year === leagueYear && week >= live;
    if (isLive || !(week >= 1 && week <= seasonWeekCount(year))) {
      view = null;
      setViewParams(null);
      document.body.classList.remove('wk-loading');
      renderDashboard(liveData, false, true);
      return;
    }
    view = { year, week };
    const key = viewKey(view);
    setViewParams(view);
    renderWeekStep();
    if (!pastWeeks.has(key)) {
      const p = year === leagueYear ? fetchCurrentSeasonWeek(week) : pastSeasonWeek(year, week);
      pastWeeks.set(key, p.catch(err => { pastWeeks.delete(key); throw err; }));
    }
    document.body.classList.add('wk-loading');
    pastWeeks.get(key)
      .then(d => {
        if (viewKey(view) !== key) return;
        document.body.classList.remove('wk-loading');
        renderDashboard(d, false, true);
        scrollTo({ top: 0, behavior: 'auto' });
      })
      .catch(() => {
        if (viewKey(view) !== key) return;
        document.body.classList.remove('wk-loading');
        view = null;
        setViewParams(null);
        renderWeekStep();
        alertWeek(`Couldn’t load ${year === leagueYear ? '' : year + ' '}Week ${week}. Try again in a minute.`);
      });
  }

  // A one-line note under the header when a week fails to load.
  function alertWeek(text) {
    let el = document.getElementById('wk-note');
    if (!el) {
      document.querySelector('header').insertAdjacentHTML('beforeend', '<div id="wk-note" class="loading-row" style="color:var(--loss);margin:-14px 0 18px" role="status"></div>');
      el = document.getElementById('wk-note');
    }
    el.textContent = text;
    clearTimeout(alertWeek.t);
    alertWeek.t = setTimeout(() => el.remove(), 5000);
  }

  // ?year=&week= on arrival opens that week once the live one says what's past.
  const requested = (() => {
    const q = new URLSearchParams(location.search);
    const week = parseInt(q.get('week'), 10);
    return week ? { year: parseInt(q.get('year'), 10) || null, week } : null;
  })();
  let viewRequested = requested;
  function openRequestedWeek() {
    if (!viewRequested) return;
    const r = viewRequested;
    viewRequested = null;
    const year = r.year || leagueYear;
    if (year === leagueYear && r.week >= liveWeekNow()) setViewParams(null);
    else showView(year, r.week);
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-wk-live]')) showView(leagueYear, liveWeekNow());
  });

  // ---------- The week picker panel ----------
  // A sheet on a phone, a popover under the title on desktop: the seasons
  // as a row of chips, then the chosen season's weeks, regular season and
  // playoffs apart. It opens on the season on screen.
  let wpYear = null;

  function wpDetail(year) {
    if (year < 2017) return 'Scores only: ESPN kept no lineups before 2017.';
    if (year < 2019) return 'Rosters with points; no stat lines before 2019.';
    return '';
  }

  function wpBodyHtml() {
    const at = onScreen();
    const years = seasonYears();
    const year = wpYear || at.year;
    const count = seasonWeekCount(year);
    const reg = year === leagueYear ? Math.min(count, (leagueSettings[year] || {}).reg_weeks || count) : ((leagueSettings[year] || {}).reg_weeks || count);
    const live = liveWeekNow();
    const weekBtn = w => {
      const on = at.year === year && at.week === w;
      const isLive = year === leagueYear && w === live;
      return `<button type="button" class="wp-wk${on ? ' on' : ''}" data-wp-week="${w}" aria-pressed="${on}"${isLive ? ' aria-label="Week ' + w + ', live"' : ''}>${w}${isLive ? '<i class="wp-live" aria-hidden="true"></i>' : ''}</button>`;
    };
    const range = (a, b) => { const o = []; for (let w = a; w <= b; w++) o.push(weekBtn(w)); return o.join(''); };
    const note = wpDetail(year);
    const yearsHtml = `<div class="wp-years edge-fade" role="group" aria-label="Season">${years.map(y => `<button type="button" class="wp-yr${y === year ? ' on' : ''}" data-wp-year="${y}" aria-pressed="${y === year}">${y}</button>`).join('')}</div>
      ${note ? `<div class="wp-note">${note}</div>` : ''}`;
    // Your season, newest week first (audit IX #2): who you played, the
    // score, and the matchup and median results. Without a team picked, or
    // for a season you weren't in, the plain grid of weeks.
    const me = getMe();
    const mine = me ? (leagueGames || []).filter(g => g.year === year && (g.p1 === me || g.p2 === me)) : [];
    if (mine.length || (me && year === leagueYear)) {
      const rows = [];
      for (let w = count; w >= 1; w--) {
        const on = at.year === year && at.week === w;
        const g = mine.find(x => x.week === w);
        const tag = w > reg ? (g && GAME_LABELS[g.type]) || 'Playoffs' : '';
        let opp = '', sub = '', pips = '';
        if (g) {
          const mineS = g.p1 === me ? g.s1 : g.s2, theirs = g.p1 === me ? g.s2 : g.s1;
          opp = g.p2 ? `vs ${esc(g.p1 === me ? g.p2 : g.p1)}` : 'Median only';
          sub = `${mineS.toFixed(2)}–${theirs.toFixed(2)}${year >= medianEraYear && g.median && w <= reg ? ` · median ${Number(g.median).toFixed(2)}` : ''}`;
          pips = `<i class="${g.winner === me ? 'w' : 'l'}">${g.winner === me ? 'W' : 'L'}</i>${year >= medianEraYear && g.median && w <= reg ? `<i class="${mineS > g.median ? 'w' : 'l'}">${mineS > g.median ? 'W' : 'L'}</i>` : ''}`;
        } else if (year === leagueYear && w === live && liveData) {
          const m = (liveData.matchups || []).find(x => isMe(x.awayManager) || isMe(x.homeManager));
          if (m) {
            const s = isMe(m.awayManager) ? 'away' : 'home', o = s === 'away' ? 'home' : 'away';
            opp = `vs ${esc(m[o + 'Manager'])}`;
            sub = `${(Number(m[s + 'Score']) || 0).toFixed(2)}–${(Number(m[o + 'Score']) || 0).toFixed(2)} · ${Math.round(m[s + 'WinProbability'])}% to win`;
            pips = !weekFinal && weekState(liveData).live ? '<i class="live" aria-label="Games on now"></i>' : '';
          }
        }
        if (!opp) { opp = 'No game'; sub = w > reg ? 'Out of the playoffs' : ''; }
        rows.push(`<button type="button" class="wkr${on ? ' on' : ''}" data-wp-week="${w}" aria-pressed="${on}"><span class="wkr-n">Wk ${w}<small>${year === leagueYear && w === live ? 'This week' : tag || (g ? (g.winner === me ? 'Won' : 'Lost') : '')}</small></span><span class="wkr-o">${opp}${sub ? `<span>${sub}</span>` : ''}</span><span class="wkr-r">${pips}</span></button>`);
      }
      return `${yearsHtml}<div class="wkr-cap" style="margin-top:12px"><span>${esc(me)}${year >= medianEraYear ? '' : ''}</span><span>${year >= medianEraYear ? 'Matchup · Median' : 'Result'}</span></div><div class="wkr-list">${rows.join('')}</div>`;
    }
    return `
      ${yearsHtml}
      <div class="wp-label">Regular season</div>
      <div class="wp-grid">${range(1, Math.min(reg, count))}</div>
      ${count > reg ? `<div class="wp-label">Playoffs</div><div class="wp-grid">${range(reg + 1, count)}</div>` : ''}`;
  }

  function wpRender() {
    const body = document.querySelector('#wp-sheet [data-body], #wp-pop [data-body]');
    if (!body) return;
    body.innerHTML = wpBodyHtml();
    // The chosen season's chip scrolled into view.
    const chip = body.querySelector('.wp-yr.on');
    const track = body.querySelector('.wp-years');
    if (chip && track) track.scrollLeft = chip.offsetLeft - track.clientWidth / 2 + chip.offsetWidth / 2;
    wpPlace();
  }

  function wpOpen() {
    if (!liveWeekNow() || !leagueGames) return;
    mwHide();
    plHide();
    if (mhIsOpen) mhClose();
    wpHide();
    wpYear = onScreen().year;
    if (!mwOneColumn.matches) {
      document.body.insertAdjacentHTML('beforeend', `<div class="pop" id="wp-pop" role="dialog" aria-label="Pick a week">
        <div class="wp-top"><span class="mwp-label">Pick a week</span><button type="button" class="x" data-wp-close aria-label="Close">&times;</button></div>
        <div data-body></div></div>`);
    } else {
      document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="wp-scrim" data-wp-close></div>
        <div class="sheet" id="wp-sheet" role="dialog" aria-modal="true" aria-label="Pick a week">
          <div class="sheet-grab" data-grab><span></span><button type="button" class="mwp-done" data-wp-close>Done</button></div>
          <div class="sheet-head" data-grab><div class="mwp-label wp-head">Pick a week</div></div>
          <div class="sheet-body" data-body></div></div>`);
    }
    document.getElementById('wk-title').setAttribute('aria-expanded', 'true');
    document.body.classList.add('wp-open');
    wpRender();
  }

  function wpHide() {
    ['wp-pop', 'wp-sheet', 'wp-scrim'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
    const t = document.getElementById('wk-title');
    if (t) t.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('wp-open');
  }

  // Under the title, never off the side of the screen.
  function wpPlace() {
    const pop = document.getElementById('wp-pop');
    if (!pop) return;
    const r = document.getElementById('wk-title').getBoundingClientRect(), vw = document.documentElement.clientWidth;
    const w = Math.min(420, vw - 24);
    const left = Math.min(Math.max(r.left, 12), vw - w - 12);
    pop.style.width = w + 'px';
    pop.style.left = (left + scrollX) + 'px';
    pop.style.top = (r.bottom + scrollY + 12) + 'px';
    pop.style.setProperty('--arrow-x', Math.min(r.left + 40, r.right - 20) - left + 'px');
  }

  document.querySelectorAll('[data-wp-open]').forEach(b => b.addEventListener('click', () => {
    if (document.getElementById('wp-pop') || document.getElementById('wp-sheet')) wpHide(); else wpOpen();
  }));
  document.addEventListener('click', e => {
    if (e.target.closest('[data-wp-close]')) { wpHide(); return; }
    const yr = e.target.closest('[data-wp-year]');
    if (yr) { wpYear = Number(yr.dataset.wpYear); wpRender(); return; }
    const wk = e.target.closest('[data-wp-week]');
    if (wk) { const y = wpYear || onScreen().year; wpHide(); showView(y, Number(wk.dataset.wpWeek)); return; }
    if (document.getElementById('wp-pop') && !e.target.closest('#wp-pop') && !e.target.closest('[data-wp-open]')) wpHide();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') wpHide(); });
  addEventListener('resize', wpPlace);
  mwOneColumn.addEventListener('change', wpHide);

  // ---------- Past seasons ----------
  // A past season's week, in the same shape the Worker sends, built from
  // league.json (every game, the week's median, each season's team names
  // and rules) and that season's lineups file. Records count the median
  // game only from the season the league started playing it.
  const seasonLineups = new Map(); // year -> Promise of data/lineups/<year>.json (or null)
  const GAME_LABELS = { Play: 'Playoffs', Champ: 'Championship', '3rd': '3rd place', '5th': '5th place', Cons: 'Consolation', Sacko: 'Sacko' };
  const ROSTER_BENCH = new Set(['BE', 'IR']);

  function lineupsFor(year) {
    if (year < 2017) return Promise.resolve(null);
    if (!seasonLineups.has(year)) {
      seasonLineups.set(year, fetch(`data/lineups/${year}.json`, { cache: 'no-cache' })
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null));
    }
    return seasonLineups.get(year);
  }

  function pastSeasonWeek(year, week) {
    return lineupsFor(year).then(lu => buildSeasonWeek(year, week, lu));
  }

  function buildSeasonWeek(year, week, lu) {
    const r2 = v => Math.round(v * 100) / 100;
    const settings = leagueSettings[year] || leagueSettings[String(year)] || {};
    const games = leagueGames.filter(g => g.year === year);
    const lastWeek = Math.max(...games.map(g => g.week));
    const regWeeks = settings.reg_weeks || lastWeek;
    const playoffWeek = week > regWeeks;
    const medianGames = year >= medianEraYear;
    const rows = leagueSeasons.filter(s => s.year === year);
    const teamOf = new Map(rows.map(s => [s.player, s.team || s.player]));
    const managers = rows.map(s => s.player);

    // Regular-season records over weeks before `upTo`.
    const recordsBefore = upTo => {
      const out = new Map(managers.map(m => [m, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
      const get = m => { if (!out.has(m)) out.set(m, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }); return out.get(m); };
      games.filter(g => g.type === 'Reg' && g.p2 && g.week < upTo && g.week <= regWeeks).forEach(g => {
        [[g.p1, g.s1, g.s2], [g.p2, g.s2, g.s1]].forEach(([m, own, opp]) => {
          const r = get(m);
          r.pf += own; r.pa += opp;
          if (own > opp) r.w++; else if (own < opp) r.l++; else r.t++;
          if (medianGames && typeof g.median === 'number') {
            if (own > g.median) r.w++; else if (own < g.median) r.l++;
          }
        });
      });
      out.forEach(r => { r.pf = r2(r.pf); r.pa = r2(r.pa); });
      return out;
    };
    const fmtRec = r => `${r.w}-${r.l}${r.t ? '-' + r.t : ''}`;
    const before = recordsBefore(playoffWeek ? regWeeks + 1 : week);
    const after = recordsBefore(playoffWeek ? regWeeks + 1 : week + 1);

    const wkGames = games.filter(g => g.week === week && g.p2 && g.type !== 'Bye');
    const scoreOf = new Map();
    wkGames.forEach(g => { scoreOf.set(g.p1, g.s1); scoreOf.set(g.p2, g.s2); });

    const roster = m => {
      const list = lu && lu.weeks && lu.weeks[String(week)] && lu.weeks[String(week)][m];
      if (!list) return [];
      const starters = list.filter(p => !ROSTER_BENCH.has(p[2]));
      // 2017 has no projections at all: none shown rather than all zeros.
      const hasProj = starters.some(p => p[4] > 0);
      return starters.map(p => ({
        id: p[6] || null,
        name: p[0],
        team: p[1] || '',
        slot: p[2] === 'RB/WR/TE' ? 'FLEX' : p[2],
        livePoints: p[3],
        projectedPoints: hasProj ? p[4] : null,
        statLine: p[5] || '',
        game: null,
        done: true,
      }));
    };

    const priorPointsOf = m => r2(games.filter(g => g.week < week && g.p2).reduce((sum, g) => sum + (g.p1 === m ? g.s1 : g.p2 === m ? g.s2 : 0), 0));
    const aheadOf = m => games
      .filter(g => g.type === 'Reg' && g.p2 && g.week >= week && g.week <= regWeeks && (g.p1 === m || g.p2 === m))
      .sort((a, b) => a.week - b.week)
      .map(g => (g.p1 === m ? g.p2 : g.p1));
    const regRank = new Map(rows.map(s => [s.player, s.reg_rank || 99]));

    const teams = managers
      .map(m => {
        const p = before.get(m), a = after.get(m);
        const score = scoreOf.has(m) ? scoreOf.get(m) : 0;
        return {
          name: teamOf.get(m), manager: m, record: fmtRec(a),
          current: score, projected: score, average: score,
          remaining: 0, inPlay: 0,
          priorPoints: priorPointsOf(m),
          prior: { w: p.w, l: p.l, t: p.t, pf: p.pf, pa: p.pa },
          ahead: aheadOf(m),
          pointsFor: a.pf, pointsAgainst: a.pa, playoffPct: null,
        };
      })
      .sort((x, y) => (playoffWeek
        ? regRank.get(x.manager) - regRank.get(y.manager)
        : y.prior.w - x.prior.w || y.prior.pf - x.prior.pf || after.get(y.manager).w - after.get(x.manager).w))
      .map((t, i) => ({ ...t, standing: i + 1 }));
    const teamBy = new Map(teams.map(t => [t.manager, t]));

    const matchups = wkGames.map(g => ({
      awayName: teamOf.get(g.p1) || g.p1, awayManager: g.p1, awayRecord: (teamBy.get(g.p1) || {}).record || '', awayStreak: null,
      awayScore: g.s1, awayProjected: g.s1, awayWinProbability: null, awayRemaining: 0, awayInPlay: 0,
      homeName: teamOf.get(g.p2) || g.p2, homeManager: g.p2, homeRecord: (teamBy.get(g.p2) || {}).record || '', homeStreak: null,
      homeScore: g.s2, homeProjected: g.s2, homeWinProbability: null, homeRemaining: 0, homeInPlay: 0,
      awayPlayers: roster(g.p1), homePlayers: roster(g.p2),
      label: g.type === 'Reg' ? '' : (GAME_LABELS[g.type] || ''),
    }));

    const sorted = [...scoreOf.values()].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const computed = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0;
    const reg = wkGames.find(g => g.type === 'Reg' && typeof g.median === 'number');
    const median = r2(reg ? reg.median : computed);

    let high = null;
    games.filter(g => g.week < week && g.p2).forEach(g => {
      [[g.p1, g.s1], [g.p2, g.s2]].forEach(([m, s]) => { if (!high || s > high.score) high = { team: teamOf.get(m), manager: m, week: g.week, score: s }; });
    });

    return {
      updatedAt: null,
      year, week,
      finalWeek: lastWeek,
      archived: true,
      pastSeason: true,
      playoffWeek,
      medianGames,
      currentMedian: median, projectedMedian: median, averageMedian: median,
      playoffTeamCount: settings.playoff_teams || 0,
      regularSeasonWeeks: regWeeks,
      medianStatusKnown: true,
      teams,
      matchups,
      priorSeasonHigh: high,
    };
  }

  let dashboardShown = false, riseStartedAt = 0;
  function loadDashboard() {
    return Promise.all([fetch(WORKER_URL, { cache: 'no-store' }).then(res => res.json()), leagueReady])
      .then(([data]) => {
        if (!data.teams) throw new Error(data.error || 'Empty response from Worker');
        RaceSim.apply(data);
        liveData = data;
        if (view === null) renderDashboard(data, true);
        else { lastDashboardData = data; renderWeekStep(); }
        openRequestedWeek();
      })
      .catch(err => {
        console.error('Dashboard error:', err);
        if (dashboardShown) return;
        document.getElementById('matchups-container').innerHTML = '<div class="loading-row" style="color:var(--loss);">Error loading league data.</div>';
      });
  }

  // Instant opens (site audit II #38): the service worker (sw.js) keeps the
  // Worker's last answer, so the page paints those numbers straight away
  // and the fresh poll then counts every one of them up to where it is now,
  // like any other refresh. Only a copy from the last day: older than that
  // it's another week's games. The Updated stamp says how old it is.
  function paintFromCache() {
    if (!('caches' in window)) return Promise.resolve();
    return caches.match(WORKER_URL, { ignoreVary: true })
      .then(res => (res ? res.json() : null))
      .then(data => {
        if (!data || !data.teams || dashboardShown) return;
        if (!(Date.now() - new Date(data.updatedAt).getTime() < 864e5)) return;
        RaceSim.apply(data);
        return leagueReady.then(() => { if (!dashboardShown && view === null) renderDashboard(data, false); });
      })
      .catch(() => {});
  }

  // `still`: no refresh motion -- a week switch or a re-render of the same
  // numbers, not a poll bringing new ones.
  function renderDashboard(data, fresh, still) {
        if (!data.teams) throw new Error(data.error || 'Empty response from Worker');
        if (fresh) lastDashboardData = data;
        else if (!lastDashboardData) lastDashboardData = data;
        shownData = data;
        const archived = Boolean(data.archived);
        dashYear = data.year || leagueYear;
        // WebKit (Safari, every iPhone browser) moves the page when the
        // matchup cards are swapped out below, even for identical HTML --
        // up past the pinned Season So Far toggle, or with its scroll
        // anchoring on, down to the bottom. A refresh puts it back.
        const keepY = dashboardShown ? window.scrollY : null;
        const holdScroll = () => {
          if (keepY !== null && window.scrollY !== keepY) window.scrollTo({ top: keepY, behavior: 'instant' });
        };

        const teams = data.teams || [];
        dashWeek = data.week || 1;
        // Fully final matchups (nobody left to play, nobody in play, on
        // either side) sink to the bottom, but only ever move there once —
        // live and not-yet-started matchups keep their original relative
        // order instead of continuously reshuffling every poll.
        // Set before the matchups are sorted below: matchupDecided reads it.
        medianStatusKnown = Boolean(data.medianStatusKnown) && teams.every(t => typeof t.remaining === 'number');
        weekFinal = !archived && !data.pastSeason && medianStatusKnown && allStartersDone(data);
        const matchups = (data.matchups || [])
          .map((m, i) => ({ m, i, final: matchupDecided(m) }))
          .sort((a, b) => (a.final === b.final ? a.i - b.i : a.final ? 1 : -1))
          .map(({ m }) => m);

        // A refresh after the first animates from what was on screen
        // (see "Live refresh motion" above); the first load has its own rise.
        const animate = dashboardShown && !mwReduceMotion && !still;

        // The line over the title names the season when it isn't this one.
        // The title is the tab's name; the week is the chip under it.
        // The folding title bar's short name (nav.js headerTools).
        document.querySelector('header h1').dataset.fold = data.week ? `${data.year && data.year !== leagueYear ? data.year + ' · ' : ''}Week ${data.week}` : 'Live';
        // Playoff weeks have no median to watch.
        // No median game in the playoffs (the Worker doesn't flag the week: isPlayoffWeek reads it).
        document.getElementById('median-container').style.display = isPlayoffWeek(data) ? 'none' : '';
        document.getElementById('matchups-h').textContent = archived ? 'Matchups' : "This week's matchups";
        // A past week's numbers are final, so the parlay and Lore cards
        // (both about right now) step aside.
        document.querySelector('.lore-row').style.display = archived ? 'none' : '';
        const updatedEl = document.getElementById('updated-at');
        if (archived) {
          const live = (liveData && liveData.week) || data.liveWeek;
          document.getElementById('updated-label').innerHTML = '<b>Final</b> ·';
          updatedEl.parentElement.classList.remove('live');
          updatedEl.innerHTML = `<button type="button" class="wk-live" data-wk-live>Week ${live} is live ›</button>`;
        } else {
          // The status line says what state the week is in (audit V #5, #9):
          // Final once every starter is done, a red dot while games are on.
          const ws = weekState(data);
          const on = !weekFinal && !!ws.live;
          document.getElementById('updated-label').innerHTML = ws.html;
          updatedEl.parentElement.classList.toggle('live', on);
          // The time only once it's a few minutes old (audit IX #1).
          const stale = data.updatedAt && Date.now() - Date.parse(data.updatedAt) > 3 * 60 * 1000;
          const updatedText = stale ? `· updated ${formatUpdated(data.updatedAt)}` : '';
          if (animate && updatedEl.textContent !== updatedText) {
            updatedEl.classList.add('flash');
            setTimeout(() => updatedEl.classList.remove('flash'), 60);
          }
          updatedEl.textContent = updatedText;
        }
        renderWeekStep();
        foldAndToast(data, archived);

        // Yours (getMe in page-common.js) leads the matchups, ringed -- or
        // the whole page, with the You sheet's meTop setting on.
        const prevMatchups = animate ? captureMatchupState() : null;
        const mine = matchups.find(m => isMe(m.awayManager) || isMe(m.homeManager));
        // Before kickoff your matchup is a preview (audit VI #7), where your
        // card goes: at the top with the You sheet's setting on, else leading
        // the matchups.
        const pre = m => !archived && !weekFinal && matchupPregame(m);
        const minePre = Boolean(mine && pre(mine));
        // What the week is worth and who to root for (audit VII #2, #3), for
        // the preview card and the pregame scoreboard; their sims run after paint.
        rootNow = mine && (minePre || matchups.some(m => m !== mine && pre(m)))
          ? rootFor(data, isMe(mine.awayManager) ? mine.awayManager : mine.homeManager) : null;
        // What rides on each game (audit XI #16); the most first.
        stakesNow = archived ? null : stakesFor(data);
        const mineCard = m => (minePre && m === mine ? renderPreviewCard(m) : renderMatchupCard(m));
        const onTop = Boolean(mine && getSettings().meTop);
        const rest = matchups.filter(m => m !== mine);
        if (stakesNow) rest.sort((x, y) => stakeRank(x) - stakeRank(y));
        const ordered = onTop ? rest : mine ? [mine, ...rest] : matchups;
        document.getElementById('my-matchup').innerHTML = onTop ? mineCard(mine) : '';
        renderMePrompt(onTop);
        renderStatusLine(data);
        renderBracketStrip(data);
        renderWaivers(data);
        // Finished games other than yours fold into one scoreboard (audit V
        // #10); a card folds only once its game is decided.
        const folded = ordered.filter(m => m !== mine && matchupDecided(m));
        // Not kicked off yet: a projected scoreboard row each (audit VI #8).
        const preRows = ordered.filter(m => m !== mine && pre(m));
        // Started, but none of its games on right now (audit X #7): one line.
        const waitRows = ordered.filter(m => m !== mine && !archived && !weekFinal && !folded.includes(m) && !preRows.includes(m) && matchupWaiting(m));
        const cards = ordered.filter(m => !folded.includes(m) && !preRows.includes(m) && !waitRows.includes(m));
        document.getElementById('matchups-container').innerHTML =
          ordered.length ? cards.map(mineCard).join('') + boardHtml(ordered.filter(m => waitRows.includes(m) || preRows.includes(m))) + scoreboardHtml(folded) : '<div class="loading-row">No matchups found.</div>';
        const done = matchups.filter(matchupDecided).length;
        document.getElementById('matchups-state').textContent = done && done === matchups.length ? `${done} final` : done ? `${done} of ${matchups.length} final` : '';
        holdScroll();
        if (prevMatchups) animateMatchupRefresh(prevMatchups);

        markClippedNames(document);

        standingsData = data;
        renderRecap();
        renderSeasonToggle();
        renderStandings();

        // Before games kick off every team sits at 0.00 — an above/below split
        // on current score would be meaningless then, so Current mode shows
        // a "kickoff hasn't happened yet" placeholder instead (handled
        // inside renderMedianStatic/applyMedianUpdate). Projected always
        // renders normally, pregame or not.
        const prevMedianTeams = lastMedianTeams, prevMedianData = lastMedianData;
        lastMedianTeams = teams;
        lastMedianData = data;
        // A past week shows its final scores (Current), without touching the
        // saved pick, which comes back with the live week.
        // So does a finished live week, where all three modes are the same number.
        if (archived || weekFinal) { if (!mwLiveMode) mwLiveMode = medianViewMode; medianViewMode = 'current'; }
        else if (mwLiveMode) { medianViewMode = mwLiveMode; mwLiveMode = null; }
        renderMedianStatic(medianViewMode);
        if (animate) animateMedianRefresh(prevMedianTeams, prevMedianData);
        mhLoad();
        flDrawAll();
        feedLoad();
        renderParlayHighlight();
        renderStatOfMoment(true);

        superlativesData = data;
        renderSuperlatives();
        document.getElementById('season-section').hidden = false;
        plRefresh();
        holdScroll();

        // First load: the skeleton has just been swapped out, so bring the
        // real cards up in reading order. The parlay card's skeleton is
        // cleared by hand when its own fetch hasn't landed yet --
        // renderParlayHighlight leaves the container alone until it has.
        // A refresh paints twice (cached copy, then the live answer a moment
        // later), and the second render swaps the median and matchup cards
        // out from under the entrance -- so for as long as it's running,
        // the new cards join it instead of appearing at once next to
        // League Lore, the one card that isn't rebuilt.
        const RISE_MS = 500 + 8 * 90;
        const riseCards = () => riseIn(document.querySelectorAll('#recap-section:not([hidden]), #me-section:not([hidden]), #median-container > :not(.sr-only), .lore-row > div > *, #matchups-container > *, #season-section'), 8, performance.now() - riseStartedAt);
        if (!dashboardShown) {
          dashboardShown = true;
          if (!parlayData) document.getElementById('parlay-highlight-container').innerHTML = '';
          riseStartedAt = performance.now();
          riseCards();
        } else if (performance.now() - riseStartedAt < RISE_MS) {
          riseCards();
        }
  }

  // Delegated once — click a card to expand/collapse its roster. The
  // expanded state itself lives in expandedMatchups (checked at render
  // time), so this just needs to flip the class on the clicked element and
  // keep that Set in sync for the next re-render.
  // A decided card's Share button (share.js): the card with its roster open,
  // drawn on the tap. Found again by its key at that moment, since a poll may
  // have swapped the cards.
  let shotKey = '';
  const matchupShot = RLShare.make({
    nodes: () => [[...document.querySelectorAll('.matchup-card')].find(c => c.dataset.key === shotKey)],
    eyebrow: () => `Retirement League · ${dashYear} · Week ${dashWeek}`,
    name: () => `week-${dashWeek}-${shotKey ? decodeURIComponent(shotKey).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'matchup'}.png`,
    prep: wrap => { const c = wrap.querySelector('.matchup-card'); if (c) c.classList.add('expanded'); },
  });
  // ---------- The scoreboard (audit V #10) ----------
  // One row per finished game: both managers, both scores, the winner's
  // gold. A tap opens that game's full card under its row, and it stays
  // open through polls.
  const sbOpen = new Set();
  function scoreboardHtml(list) {
    if (!list.length) return '';
    return `<div class="sb glass">${list.map(m => {
      const key = matchupKey(m);
      const as = parseFloat(m.awayScore) || 0, hs = parseFloat(m.homeScore) || 0;
      const open = sbOpen.has(key);
      const name = (mgr, team) => esc(mgr || team);
      return `<button type="button" class="sb-row" data-sb="${encodeURIComponent(key)}" aria-expanded="${open}">
          <span class="n${as > hs ? ' w' : ''}">${muLogoHtml(m.awayManager)}<span>${name(m.awayManager, m.awayName)}</span></span>
          <span class="v${as > hs ? ' w' : ''}">${fmtScore(as)}</span><span class="dash">–</span><span class="v${hs > as ? ' w' : ''}">${fmtScore(hs)}</span>
          <span class="n r${hs > as ? ' w' : ''}"><span>${name(m.homeManager, m.homeName)}</span>${muLogoHtml(m.homeManager)}</span>
          <span class="chev" aria-hidden="true"></span>
        </button>${open ? `<div class="sb-open">${renderMatchupCard(m)}</div>` : ''}`;
    }).join('')}</div>`;
  }

  // ---------- The ⋯ sheet (audit V #8, #15) ----------
  // ESPN's app claims fantasy.espn.com/football/fantasycast on an iPhone, so
  // Open in ESPN lands on the ESPN Fantasy app's view of this matchup (or
  // the website without the app).
  const ESPN_LEAGUE = 58101;
  const espnUrl = (path, params) => `https://fantasy.espn.com/football/${path}?${new URLSearchParams(Object.assign({ leagueId: ESPN_LEAGUE }, params))}`;
  const MORE_IC = {
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    vs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.7-3.2 2.9-4.9 5.5-4.9s4.8 1.7 5.5 4.9"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.6 14.3c2.3.1 4.2 1.6 4.9 4.7"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    chev: '<svg viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l4 4-4 4"/></svg>',
  };
  function closeMore() {
    document.getElementById('more-sheet')?.remove();
    document.getElementById('more-scrim')?.remove();
  }
  function openMore(card) {
    closeMore();
    const key = card.dataset.key;
    const m = ((shownData && shownData.matchups) || []).find(x => encodeURIComponent(matchupKey(x)) === key);
    if (!m) return;
    // You first, the way the card reads (meLeft, audit VII #1).
    const v = meLeft(m);
    const a = v.awayManager || v.awayName, b = v.homeManager || v.homeName;
    const decided = card.classList.contains('done');
    const year = (shownData && shownData.year) || leagueYear;
    const mineId = isMe(m.homeManager) ? m.homeId : m.awayId;
    // Only seasons ESPN still serves to the league page: this one.
    const espn = year === leagueYear && (m.awayId || m.homeId)
      ? espnUrl('fantasycast', { seasonId: year, matchupPeriodId: dashWeek, teamId: mineId || m.awayId }) : '';
    const state = decided ? 'Final' : (parseInt(m.awayInPlay, 10) || 0) + (parseInt(m.homeInPlay, 10) || 0) ? 'Live' : 'This week';
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="more-scrim"></div>
      <div class="sheet more-sheet" id="more-sheet" role="dialog" aria-modal="true" aria-label="${esc(a)} vs ${esc(b)}" tabindex="-1">
        <div class="sheet-grab"><span></span></div>
        <div class="sheet-body">
          <div class="more-h">${muLogoHtml(v.awayManager)}<div><b>${esc(a)} vs ${esc(b)}</b><span>Week ${dashWeek} · ${state}</span></div></div>
          <div class="more-list">
            <button type="button" class="more-it" data-act="share"><i>${MORE_IC.share}</i><span><b>Share a picture</b><small>${decided ? 'The final' : 'This matchup as it stands'}, ready for the group chat</small></span><em></em></button>
            ${espn ? `<a class="more-it" href="${esc(espn)}" target="_blank" rel="noopener"><i class="espn">ESPN</i><span><b>Open in ESPN</b><small>Fantasycast for this matchup, in the ESPN app</small></span><em>${MORE_IC.out}</em></a>` : ''}
            ${m.awayManager && m.homeManager ? `<a class="more-it" href="${esc(pageLink('head-to-head.html', { a, b }))}"><i>${MORE_IC.vs}</i><span><b>Head to Head</b><small>${esc(a)} vs ${esc(b)}, every game</small></span><em>${MORE_IC.chev}</em></a>` : ''}
          </div>
          <button type="button" class="more-cancel">Cancel</button>
        </div>
      </div>`);
    const sheet = document.getElementById('more-sheet');
    document.getElementById('more-scrim').addEventListener('click', closeMore);
    sheet.querySelector('.more-cancel').addEventListener('click', closeMore);
    sheet.querySelector('[data-act="share"]').addEventListener('click', () => {
      shotKey = key;
      closeMore();
      matchupShot.share(null);
    });
    sheet.addEventListener('keydown', e => { if (e.key === 'Escape') closeMore(); });
    sheet.focus({ preventScroll: true });
  }
  const onMatchupClick = (e) => {
    const pt = e.target.closest('[data-pretab]');
    if (pt) {
      const k = pt.dataset.pretab, card = pt.closest('.matchup-card');
      try { localStorage.setItem(PRE_TAB, k); } catch (err) {}
      card.querySelectorAll('[data-pretab]').forEach(b => { const on = b === pt; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      card.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== k; });
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) { openMore(more.closest('.matchup-card')); return; }
    const sb = e.target.closest('.sb-row');
    if (sb) {
      const key = decodeURIComponent(sb.dataset.sb);
      const m = ((shownData && shownData.matchups) || []).find(x => matchupKey(x) === key);
      const open = !sbOpen.has(key);
      if (open) sbOpen.add(key); else sbOpen.delete(key);
      sb.setAttribute('aria-expanded', open);
      const next = sb.nextElementSibling;
      if (next && next.classList.contains('sb-open')) next.remove();
      if (open && m) {
        sb.insertAdjacentHTML('afterend', `<div class="sb-open">${renderMatchupCard(m)}</div>`);
        flDrawAll();
      }
      return;
    }
    // The series line is a link to Head to Head on this pair instead, and
    // a tap on the Flow chart reads it.
    if (e.target.closest('.mu-series') || e.target.closest('.fl-wrap') || e.target.closest('.mu-espn')) return;
    const card = e.target.closest('.matchup-card');
    if (!card) return;
    // An open card's starters open their game logs instead of closing it.
    const cell = card.classList.contains('expanded') && e.target.closest('.mu-pc[data-pid]');
    if (cell) { plOpen(Number(cell.dataset.pid)); return; }
    const key = decodeURIComponent(card.dataset.key);
    if (expandedMatchups.has(key)) expandedMatchups.delete(key);
    else expandedMatchups.add(key);
    card.classList.toggle('expanded');
    markClippedNames(card);
  };
  document.getElementById('matchups-container').addEventListener('click', onMatchupClick);
  document.getElementById('my-matchup').addEventListener('click', onMatchupClick);

  // Roster names hard-clip at the team badge; flag the ones that actually
  // overflow so CSS can fade their last few px. Collapsed rosters are
  // display:none (nothing to measure), so this also runs on expand, and on
  // resize/font load since either can change what fits.
  function markClippedNames(root) {
    root.querySelectorAll('.matchup-card.expanded .name-text').forEach(el => {
      el.classList.toggle('clipped', el.scrollWidth > el.clientWidth);
    });
  }
  let clipResizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(clipResizeTimer);
    clipResizeTimer = setTimeout(() => markClippedNames(document), 150);
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => markClippedNames(document));
  }

  // Background tabs don't poll (each poll costs Worker/KV quota); coming
  // back to the tab refreshes right away if the data is stale.
  let lastLoadAt = 0;
  // The footer's pace is set once the first load says whether a game is on
  // (audit XI #4), not only on the first 15-second tick.
  const loadDashboardTracked = () => { lastLoadAt = Date.now(); return Promise.resolve(loadDashboard()).then(r => { setRefreshNote(pace()); return r; }); };
  // Pull to refresh (page-common.js) polls instead of reloading, so open
  // matchup cards stay open.
  window.pageRefresh = () => Promise.all([loadDashboardTracked(), typeof loadParlayHighlight === 'function' ? loadParlayHighlight() : null]);
  paintFromCache();
  loadDashboardTracked();
  // Fast only around games (audit X #27): the ticker runs every 15
  // seconds, and loads when the last load is older than this week's pace.
  const pace = () => {
    const d = shownData;
    if (!d || d.archived) return POLL_SLOW;
    return pollMs((d.matchups || []).flatMap(m => [...(m.awayPlayers || []), ...(m.homePlayers || [])]).map(p => p.game).filter(Boolean));
  };
  setInterval(() => {
    const ms = pace();
    setRefreshNote(ms);
    if (!document.hidden && Date.now() - lastLoadAt >= ms - 500) loadDashboardTracked();
  }, AUTO_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastLoadAt >= Math.min(pace(), AUTO_REFRESH_MS)) loadDashboardTracked();
  });
  // Ticks the countdown between data refreshes so it counts down smoothly
  // rather than jumping only once every AUTO_REFRESH_MS.
  setInterval(updateKickoffCountdown, 60 * 1000);
