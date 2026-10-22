/* Parlay Legs' note parser and game finder (site audit II #11).
 *
 * Ported from the desktop entry tool's Python parser and game-time search,
 * both removed since picks are only entered on the site, with the same
 * "flag, don't guess" rules. Grading still resolves a prop player's team in
 * Python (find_player_team in espn_gametime_lookup.py), so a fix to player
 * matching belongs in both.
 *
 * ESPN's site API answers any origin, so this runs in the browser: every
 * leg is looked up while you look at the preview, nothing waits on an
 * Action. Scoreboards are cached for the visit, so editing one line only
 * re-checks that leg. */
(() => {
  // ---------- Note parser (parlay_note_parser.py) ----------
  const ALIAS = {
    'ml': 'Money Line', 'money line': 'Money Line',
    'spread': 'Spread', 'alt spread': 'Alt Spread', '1st half spread': '1st Half Spread',
    'anytime td': 'Anytime TD',
    'total points': 'Total Points', 'total goals': 'Total Goals', 'total rounds': 'Total Rounds',
    'receiving yards': 'Receiving Yards', 'receiving yds': 'Receiving Yards', 'rec yards': 'Receiving Yards',
    'rec yds': 'Receiving Yards',
    'passing td': 'Passing TD', 'pass td': 'Passing TD',
    'passing yards': 'Passing Yards', 'passing yds': 'Passing Yards', 'pass yards': 'Passing Yards',
    'pass yds': 'Passing Yards',
    'receptions': 'Receptions', 'recs': 'Receptions',
    'total yards': 'Total Yards',
    'home runs': 'Home Runs', 'hrs': 'Home Runs',
    'player points': 'Player Points', 'points': 'Player Points',
    'interceptions': 'Interceptions', 'ints': 'Interceptions',
    'coin toss': 'Coin Toss',
  };
  const TEAM_LINE_VS = new Set(['Spread', 'Alt Spread', '1st Half Spread']);
  const VS_ONLY = new Set(['Money Line']);
  const TOTAL_VS = new Set(['Total Points', 'Total Goals', 'Total Rounds']);
  const PLAYER_OU = new Set(['Receiving Yards', 'Passing TD', 'Home Runs', 'Player Points',
    'Interceptions', 'Total Yards', 'Receptions', 'Passing Yards']);
  const PLAYER_ONLY = new Set(['Anytime TD', 'Coin Toss']);

  const RE = {
    teamLineVs: /^(.+?)\s+([+-]\d+(?:\.\d+)?)\s+vs\.?\s+(.+)$/i,
    lineTeamVs: /^([+-]\d+(?:\.\d+)?)\s+(.+?)\s+vs\.?\s+(.+)$/i,
    teamVsTeam: /^(.+?)\s+vs\.?\s+(.+)$/i,
    ouTeams: /^(o|u|over|under)\.?\s*(\.?\d+(?:\.\d+)?)\s+(.+?)\s+vs\.?\s+(.+)$/i,
    ouPlayer: /^(o|u|over|under)\.?\s*(\.?\d+(?:\.\d+)?)\s+(.+)$/i,
    playerOuRev: /^(.+?)\s+(o|u|over|under)\.?\s*(\.?\d+(?:\.\d+)?)$/i,
    odds: /^(.*?)\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*\)\s*$/,
    yearWeek: /^(\d{4})\s+week\s+(\d+):?\s*$/i,
    keyRest: /^([^:]+):\s*(.+)$/,
  };
  const SIDE = { o: 'Over', over: 'Over', u: 'Under', under: 'Under' };
  const HEADER_SKIP = new Set(['legs due', 'max odds']);

  const num = t => {
    const s = String(t).trim().replace(/[,\s]/g, '');
    if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    return parseFloat(s);
  };
  const money = t => num(String(t).replace(/\$/g, ''));

  function betDetails(bt, d) {
    const r = { team: '', opponent: '', player_prop: '', line: '', side: '' };
    let m;
    d = d.trim();
    if (TEAM_LINE_VS.has(bt)) {
      if ((m = d.match(RE.teamLineVs))) return [{ ...r, team: m[1].trim(), line: m[2], opponent: m[3].trim() }, true];
      if ((m = d.match(RE.lineTeamVs))) return [{ ...r, line: m[1], team: m[2].trim(), opponent: m[3].trim() }, true];
      if ((m = d.match(RE.teamVsTeam))) return [{ ...r, team: m[1].trim(), opponent: m[2].trim() }, false];
      return [r, false];
    }
    if (VS_ONLY.has(bt)) {
      return (m = d.match(RE.teamVsTeam)) ? [{ ...r, team: m[1].trim(), opponent: m[2].trim() }, true] : [r, false];
    }
    if (TOTAL_VS.has(bt)) {
      return (m = d.match(RE.ouTeams))
        ? [{ ...r, side: SIDE[m[1].toLowerCase()], line: m[2], team: m[3].trim(), opponent: m[4].trim() }, true]
        : [r, false];
    }
    if (PLAYER_OU.has(bt)) {
      if ((m = d.match(RE.ouPlayer))) return [{ ...r, side: SIDE[m[1].toLowerCase()], line: m[2], player_prop: m[3].trim() }, true];
      if ((m = d.match(RE.playerOuRev))) return [{ ...r, player_prop: m[1].trim(), side: SIDE[m[2].toLowerCase()], line: m[3] }, true];
      return [r, false];
    }
    if (PLAYER_ONLY.has(bt)) return [{ ...r, player_prop: d }, true];
    return [r, false];
  }

  /** { picks: {player: {...}}, final: {odds, payout, year, week, sacko},
   *  unmatched: [lines] }. Each pick also carries `why` when ok is false. */
  function parse(text, players) {
    const picks = {};
    const final = { odds: null, payout: null, year: null, week: null, sacko: null };
    const unmatched = [];
    const who = t => players.find(p => p.toLowerCase() === t.trim().toLowerCase()) || null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let m = line.match(RE.yearWeek);
      if (m) { final.year = m[1]; final.week = m[2]; continue; }
      m = line.match(RE.keyRest);
      if (!m) { unmatched.push(line); continue; }
      const key = m[1].trim(), rest = m[2].trim(), kl = key.toLowerCase();
      if (HEADER_SKIP.has(kl)) continue;
      if (kl === 'sacko') { final.sacko = who(rest) || rest; continue; }
      if (kl === 'final odds') { final.odds = num(rest); continue; }
      if (kl === 'final payout') { final.payout = money(rest); continue; }
      const player = who(key);
      if (!player) { unmatched.push(line); continue; }
      const m2 = rest.match(RE.keyRest);
      if (!m2) { unmatched.push(line); continue; }
      const btRaw = m2[1].trim(), bt = ALIAS[btRaw.toLowerCase()] || null;
      const om = m2[2].trim().match(RE.odds);
      const details = om ? om[1].trim() : m2[2].trim();
      const odds = om ? num(om[2]) : null;
      if (!bt) {
        picks[player] = { bet_type: btRaw, team: '', opponent: '', player_prop: '', line: '', side: '',
          odds, details, raw_line: line, ok: false, why: `"${btRaw}" isn't a bet type the sheet knows` };
        continue;
      }
      const [parsed, ok] = betDetails(bt, details);
      const why = !ok ? "Couldn't split the bet" : odds == null ? 'No odds on this line' : '';
      picks[player] = { bet_type: bt, ...parsed, odds, details, raw_line: line, ok: ok && odds != null, why };
    }
    return { picks, final, unmatched };
  }

  // ---------- Game finder (espn_gametime_lookup.py) ----------
  const API = 'https://site.web.api.espn.com/apis';
  // Same order as SPORT_ESPN_PATHS: a team pick is tried sport by sport,
  // so an NFL game is found without ever loading the soccer leagues.
  const SPORT_PATHS = {
    NFL: ['football/nfl'],
    NCAAF: ['football/college-football'],
    NBA: ['basketball/nba'],
    NCAAM: ['basketball/mens-college-basketball'],
    NHL: ['hockey/nhl'],
    MLB: ['baseball/mlb'],
    UFC: ['mma/ufc'],
    'Womens Tennis': ['tennis/wta'],
    Futbol: ['soccer/eng.1', 'soccer/uefa.champions', 'soccer/esp.1', 'soccer/usa.1', 'soccer/ger.1',
      'soccer/ita.1', 'soccer/uefa.europa', 'soccer/fra.1', 'soccer/nor.1', 'soccer/eng.2',
      'soccer/fifa.friendly', 'soccer/fifa.worldq.uefa', 'soccer/uefa.nations', 'soccer/por.1',
      'soccer/ned.1', 'soccer/sco.1', 'soccer/tur.1', 'soccer/bra.1', 'soccer/arg.1', 'soccer/mex.1',
      'soccer/conmebol.libertadores', 'soccer/uefa.europa.conf', 'soccer/fifa.worldq.conmebol'],
  };
  // The sheet's Sport dropdown, for a game typed in by hand.
  const SPORTS = ['NFL', 'NCAAF', 'NBA', 'NCAAM', 'NHL', 'MLB', 'Futbol', 'UFC', 'Boxing', 'Womens Tennis'];
  const FULL_GROUP = {
    'football/college-football': [80, 200],
    'basketball/mens-college-basketball': [50, 300],
  };
  const TEAM_NICKNAMES = {
    bucs: 'buccaneers', buccs: 'buccaneers', pats: 'patriots', jags: 'jaguars', preds: 'predators',
    'man u': 'man united', wv: 'west virginia', cavs: 'cavaliers', tt: 'texas tech', rosenberg: 'rosenborg',
    'miss st': 'mississippi state', mizzou: 'missouri', usf: 'south florida', vols: 'tennessee',
    dawgs: 'georgia', zags: 'gonzaga', jmu: 'james madison', fau: 'florida atlantic',
    fiu: 'florida international', ecu: 'east carolina', hoyas: 'georgetown',
  };
  const NFL_TEAM_IDS = {
    'Arizona Cardinals': 22, 'Atlanta Falcons': 1, 'Baltimore Ravens': 33, 'Buffalo Bills': 2,
    'Carolina Panthers': 29, 'Chicago Bears': 3, 'Cincinnati Bengals': 4, 'Cleveland Browns': 5,
    'Dallas Cowboys': 6, 'Denver Broncos': 7, 'Detroit Lions': 8, 'Green Bay Packers': 9,
    'Houston Texans': 34, 'Indianapolis Colts': 11, 'Jacksonville Jaguars': 30, 'Kansas City Chiefs': 12,
    'Las Vegas Raiders': 13, 'Los Angeles Chargers': 24, 'Los Angeles Rams': 14, 'Miami Dolphins': 15,
    'Minnesota Vikings': 16, 'New England Patriots': 17, 'New Orleans Saints': 18, 'New York Giants': 19,
    'New York Jets': 20, 'Philadelphia Eagles': 21, 'Pittsburgh Steelers': 23, 'San Francisco 49ers': 25,
    'Seattle Seahawks': 26, 'Tampa Bay Buccaneers': 27, 'Tennessee Titans': 10, 'Washington Commanders': 28,
  };
  const BET_TYPE_SPORTS = {
    'Anytime TD': ['NFL', 'NCAAF'], 'Passing TD': ['NFL', 'NCAAF'], 'Passing Yards': ['NFL', 'NCAAF'],
    'Receiving Yards': ['NFL', 'NCAAF'], 'Receptions': ['NFL', 'NCAAF'], 'Interceptions': ['NFL', 'NCAAF'],
    'Total Yards': ['NFL', 'NCAAF'], 'Player Points': ['NBA', 'NCAAM'], 'Home Runs': ['MLB'],
  };
  const NICKNAME_TO_FORMAL = {
    matt: 'matthew', mike: 'michael', chris: 'christopher', nick: 'nicholas', josh: 'joshua', sam: 'samuel',
    alex: 'alexander', will: 'william', tom: 'thomas', tommy: 'thomas', bob: 'robert', bobby: 'robert',
    rob: 'robert', dan: 'daniel', danny: 'daniel', ben: 'benjamin', zach: 'zachary', zack: 'zachary',
    joe: 'joseph', joey: 'joseph', charlie: 'charles', chuck: 'charles', nate: 'nathaniel', andy: 'andrew',
    steve: 'steven', jon: 'jonathan', jim: 'james', jimmy: 'james', jack: 'john', ed: 'edward',
    eddie: 'edward', tony: 'anthony', greg: 'gregory', pat: 'patrick', ken: 'kenneth', larry: 'lawrence',
    ron: 'ronald', rich: 'richard', ricky: 'richard', dave: 'david', abe: 'abraham', vlad: 'vladimir',
  };

  const fold = s => String(s || '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const foldName = s => fold(s).replace(/[^a-z0-9 ]/g, '').replace(/\s+(jr|sr|ii|iii|iv)$/, '').trim();
  const loose = s => s.replace(/[^a-z0-9 ]/g, '');
  const stripRank = s => String(s || '').replace(/^#\d+\s*/, '');

  function teamMatches(candidate, t) {
    candidate = fold(candidate);
    if (!candidate || !t) return false;
    const exact = new Set(['shortDisplayName', 'displayName', 'name', 'location', 'abbreviation'].map(f => fold(t[f])));
    const cands = [candidate];
    if (TEAM_NICKNAMES[candidate]) cands.push(TEAM_NICKNAMES[candidate]);
    if (cands.some(c => exact.has(c))) return true;
    const looseExact = new Set([...exact].map(loose));
    if (cands.some(c => looseExact.has(loose(c)))) return true;
    const display = fold(t.displayName);
    return cands.some(c => display.includes(c));
  }

  function canonical(t, c) {
    const name = t.shortDisplayName || t.displayName || '';
    const rank = c.curatedRank && c.curatedRank.current;
    return rank && rank <= 25 ? `#${rank} ${name}`.trim() : name;
  }

  // ESPN's UTC kickoff as the sheet's naive Eastern "YYYY-MM-DDTHH:MM:00".
  const EASTERN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function easternIso(date) {
    const p = Object.fromEntries(EASTERN.formatToParts(date).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00`;
  }

  /** Thursday through Monday, as YYYYMMDD: the one in progress on Thu-Mon,
   *  else the coming one, in Eastern time. */
  function windowDays(now = new Date()) {
    const [y, m, d] = easternIso(now).slice(0, 10).split('-').map(Number);
    const today = new Date(Date.UTC(y, m - 1, d));
    const since = (today.getUTCDay() + 7 - 4) % 7; // days since Thursday
    const thu = new Date(today);
    thu.setUTCDate(today.getUTCDate() + (since <= 4 ? -since : 7 - since));
    return [0, 1, 2, 3, 4].map(i => {
      const x = new Date(thu);
      x.setUTCDate(thu.getUTCDate() + i);
      return x.toISOString().slice(0, 10).replace(/-/g, '');
    });
  }

  // Eight requests at a time, each tried three times. A miss that was ESPN
  // failing (not answering, rate-limiting) is reported as `failed`, so the
  // page can say "try again" rather than "no such game". Failures aren't
  // cached; answers are.
  const cache = new Map();
  const waiting = [];
  let running = 0;
  function slot(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        running++;
        fn().then(resolve, reject).finally(() => { running--; if (waiting.length) waiting.shift()(); });
      };
      if (running < 8) go(); else waiting.push(go);
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function getJson(url) {
    if (cache.has(url)) return cache.get(url);
    const p = slot(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch(url);
          if (res.ok) return { ok: true, data: await res.json() };
          if (res.status === 400 || res.status === 404) return { ok: true, data: null };
        } catch { /* network hiccup: try again */ }
        if (i < 2) await sleep([1500, 4000][i]);
      }
      return { ok: false, data: null };
    });
    cache.set(url, p);
    p.then(r => { if (!r.ok) cache.delete(url); });
    return p;
  }

  function scoreboard(path, day) {
    let url = `${API}/site/v2/sports/${path}/scoreboard?dates=${day}`;
    if (FULL_GROUP[path]) url += `&groups=${FULL_GROUP[path][0]}&limit=${FULL_GROUP[path][1]}`;
    return getJson(url);
  }

  // Every (day, path) board for a sport, day by day like the Python loop.
  async function boards(sport, days) {
    const paths = SPORT_PATHS[sport] || [];
    const all = await Promise.all(days.flatMap(day => paths.map(path => scoreboard(path, day).then(r => ({ ...r, path, day })))));
    return all;
  }

  const gameOf = ev => {
    try {
      const comp = ev.competitions[0];
      return comp && comp.competitors ? comp : null;
    } catch { return null; }
  };

  /** A team pick: {gametime, sport, team, opponent, matchup} or
   *  {failed}. Both teams must match, unless only one side matches and it
   *  matches exactly one game in the window (a misspelled opponent). */
  async function findTeamGame(team, opponent, days) {
    team = stripRank(team);
    opponent = stripRank(opponent);
    const partial = [];
    let failed = false;
    for (const sport of Object.keys(SPORT_PATHS)) {
      for (const b of await boards(sport, days)) {
        if (!b.ok) { failed = true; continue; }
        for (const ev of (b.data && b.data.events) || []) {
          const comp = gameOf(ev);
          if (!comp || comp.competitors.length !== 2 || !comp.date) continue;
          const [c0, c1] = comp.competitors;
          const t0 = c0.team, t1 = c1.team;
          if (!t0 || !t1) continue;
          const tt0 = teamMatches(team, t0), tt1 = teamMatches(team, t1);
          const ot0 = teamMatches(opponent, t0), ot1 = teamMatches(opponent, t1);
          const hit = (a, ac, o, oc) => ({ gametime: easternIso(new Date(comp.date)), sport,
            team: canonical(a, ac), opponent: canonical(o, oc) });
          if (tt0 && ot1) return hit(t0, c0, t1, c1);
          if (tt1 && ot0) return hit(t1, c1, t0, c0);
          if (tt0 || ot1) partial.push(hit(t0, c0, t1, c1));
          else if (tt1 || ot0) partial.push(hit(t1, c1, t0, c0));
        }
      }
    }
    // One side misspelled ("Gaytors") is fine if the other side has
    // exactly one game all window.
    if (partial.length === 1) return partial[0];
    return { failed, partial: partial.length };
  }

  async function searchPlayer(name) {
    const r = await getJson(`${API}/search/v2?query=${encodeURIComponent(name)}`);
    const hits = [];
    for (const g of (r.data && r.data.results) || []) {
      if (g.type !== 'player') continue;
      for (const c of g.contents || []) hits.push({ name: c.displayName, sport: c.description, team: c.subtitle });
    }
    return { ok: r.ok, hits };
  }

  async function onNflRoster(player, teamName) {
    const id = NFL_TEAM_IDS[teamName];
    if (id == null) return false;
    const r = await getJson(`${API}/site/v2/sports/football/nfl/teams/${id}/roster`);
    if (!r.ok || !r.data) return true; // can't check: don't drop it
    const names = new Set((r.data.athletes || []).flatMap(g => (g.items || []).map(a => foldName(a.fullName))));
    return names.has(foldName(player));
  }

  /** {team, sport} for a player-prop pick, or {failed|ambiguous}
   *  (find_player_team). */
  async function findPlayerTeam(player, betType) {
    let { ok, hits } = await searchPlayer(player);
    let exact = hits.filter(h => foldName(h.name) === foldName(player));
    if (!exact.length) {
      const parts = player.trim().split(/\s+/);
      const formal = NICKNAME_TO_FORMAL[(parts[0] || '').toLowerCase()];
      if (formal) {
        const variant = [formal[0].toUpperCase() + formal.slice(1), ...parts.slice(1)].join(' ');
        const v = await searchPlayer(variant);
        ok = ok && v.ok;
        exact = v.hits.filter(h => foldName(h.name) === foldName(variant));
      }
    }
    hits = exact.length ? exact : hits;
    if (!hits.length) return { failed: !ok };
    const plausible = BET_TYPE_SPORTS[betType];
    if (plausible) {
      const narrowed = hits.filter(h => plausible.includes(h.sport));
      if (narrowed.length) hits = narrowed;
    }
    const key = h => `${h.sport}\u0000${h.team}`;
    let distinct = [...new Map(hits.filter(h => h.sport && h.team).map(h => [key(h), h])).values()];
    const pick = h => SPORT_PATHS[h.sport] ? { team: h.team, sport: h.sport } : { unsupported: h.sport };
    if (distinct.length === 1) return pick(distinct[0]);
    const nfl = distinct.filter(h => h.sport === 'NFL');
    if (nfl.length > 1) {
      const verified = [];
      for (const h of nfl) if (await onNflRoster(player, h.team)) verified.push(h);
      distinct = distinct.filter(h => h.sport !== 'NFL').concat(verified);
    }
    if (distinct.length === 1) return pick(distinct[0]);
    const sports = new Set(distinct.map(h => h.sport));
    if (sports.size === 2 && sports.has('NFL') && sports.has('NCAAF')) {
      const only = distinct.filter(h => h.sport === 'NFL');
      if (only.length === 1) return pick(only[0]);
    }
    return { ambiguous: distinct.length > 1 };
  }

  /** The player's team's game in the window. */
  async function findTeamOnly(team, sport, days) {
    team = stripRank(team);
    let failed = false;
    for (const b of await boards(sport, days)) {
      if (!b.ok) { failed = true; continue; }
      for (const ev of (b.data && b.data.events) || []) {
        const comp = gameOf(ev);
        if (!comp || !comp.date) continue;
        const own = comp.competitors.find(c => teamMatches(team, c.team));
        if (!own) continue;
        const other = comp.competitors.find(c => c !== own);
        return { gametime: easternIso(new Date(comp.date)), sport,
          matchup: other && other.team ? `${canonical(own.team, own)} vs. ${canonical(other.team, other)}` : canonical(own.team, own) };
      }
    }
    return { failed };
  }

  /** One parsed pick -> {found: true, gametime, sport, team?, opponent?,
   *  matchup?} or {found: false, why}. */
  async function findGame(pick, days = windowDays()) {
    if (pick.team && pick.opponent) {
      const g = await findTeamGame(pick.team, pick.opponent, days);
      if (g.gametime) return { found: true, ...g };
      return { found: false, why: g.failed ? "ESPN didn't answer. Try again in a minute."
        : g.partial ? `No ${pick.team} vs. ${pick.opponent} game. ${g.partial} games have one of them` : 'No game for either team Thu–Mon' };
    }
    if (pick.player_prop) {
      const who = await findPlayerTeam(pick.player_prop, pick.bet_type);
      if (who.unsupported) return { found: false, why: `ESPN lists ${pick.player_prop} under ${who.unsupported}, which it has no scoreboard for` };
      if (!who.team) return { found: false, why: who.failed ? "ESPN didn't answer. Try again in a minute."
        : who.ambiguous ? `More than one ${pick.player_prop} on ESPN` : `No player named ${pick.player_prop} on ESPN` };
      const g = await findTeamOnly(who.team, who.sport, days);
      if (g.gametime) return { found: true, ...g };
      return { found: false, why: g.failed ? "ESPN didn't answer. Try again in a minute." : `${who.team} has no game Thu–Mon` };
    }
    return { found: false, why: 'Nothing to look up' };
  }

  window.ParlayNote = { parse, findGame, windowDays, SPORTS };
})();
