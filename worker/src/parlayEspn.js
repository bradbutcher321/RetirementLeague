/**
 * ESPN's scoreboards, game summaries and player search, for grading parlay
 * legs and showing them live -- a port of espn_gametime_lookup.py (site
 * audit X #26). The Python read site.web.api.espn.com, which answers GitHub's
 * servers but refuses Cloudflare's; from here site.api.espn.com is the one
 * that answers (measured 2026-11-13), same paths, same JSON. A game summary
 * also falls back to cdn.espn.com's game page, which carries the same body.
 *
 * New in the port: a leg entered on Parlay Legs carries ESPN's event id
 * (game_id), so its game is read straight from that event's summary, with
 * no scoreboard search. Legs without one (entered on the commissioner's
 * whole-week save) are found the Python's way: by sport, date and names.
 *
 * Every function makes its own fetches through one per-run cache (ctx), so
 * twelve legs on four games cost four summaries.
 */
const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.espn.com/",
};

export const SPORT_ESPN_PATHS = {
  NFL: ["football/nfl"],
  NCAAF: ["football/college-football"],
  NBA: ["basketball/nba"],
  NCAAM: ["basketball/mens-college-basketball"],
  NHL: ["hockey/nhl"],
  MLB: ["baseball/mlb"],
  UFC: ["mma/ufc"],
  "Womens Tennis": ["tennis/wta"],
  Futbol: [
    "soccer/eng.1", "soccer/uefa.champions", "soccer/esp.1", "soccer/usa.1", "soccer/ger.1", "soccer/ita.1", "soccer/uefa.europa",
    "soccer/fra.1", "soccer/nor.1", "soccer/eng.2", "soccer/fifa.friendly", "soccer/fifa.worldq.uefa", "soccer/uefa.nations",
    "soccer/por.1", "soccer/ned.1", "soccer/sco.1", "soccer/tur.1", "soccer/bra.1", "soccer/arg.1", "soccer/mex.1",
    "soccer/conmebol.libertadores", "soccer/uefa.europa.conf", "soccer/fifa.worldq.conmebol",
  ],
};
// cdn.espn.com's game page, for a summary site.api won't give.
const CDN_CORE = { "football/nfl": "nfl", "football/college-football": "college-football", "basketball/nba": "nba", "basketball/mens-college-basketball": "mens-college-basketball", "hockey/nhl": "nhl", "baseball/mlb": "mlb" };
export const INDIVIDUAL_SPORTS = new Set(["UFC"]);
const FULL_GROUP_BY_PATH = { "football/college-football": [80, 200], "basketball/mens-college-basketball": [50, 300] };

const TEAM_NICKNAMES = {
  bucs: "buccaneers", buccs: "buccaneers", pats: "patriots", jags: "jaguars", preds: "predators", "man u": "man united",
  wv: "west virginia", cavs: "cavaliers", tt: "texas tech", rosenberg: "rosenborg", "miss st": "mississippi state",
  mizzou: "missouri", usf: "south florida", vols: "tennessee", dawgs: "georgia", zags: "gonzaga", jmu: "james madison",
  fau: "florida atlantic", fiu: "florida international", ecu: "east carolina", hoyas: "georgetown",
};
const NFL_TEAM_IDS = {
  "Arizona Cardinals": 22, "Atlanta Falcons": 1, "Baltimore Ravens": 33, "Buffalo Bills": 2, "Carolina Panthers": 29, "Chicago Bears": 3,
  "Cincinnati Bengals": 4, "Cleveland Browns": 5, "Dallas Cowboys": 6, "Denver Broncos": 7, "Detroit Lions": 8, "Green Bay Packers": 9,
  "Houston Texans": 34, "Indianapolis Colts": 11, "Jacksonville Jaguars": 30, "Kansas City Chiefs": 12, "Las Vegas Raiders": 13,
  "Los Angeles Chargers": 24, "Los Angeles Rams": 14, "Miami Dolphins": 15, "Minnesota Vikings": 16, "New England Patriots": 17,
  "New Orleans Saints": 18, "New York Giants": 19, "New York Jets": 20, "Philadelphia Eagles": 21, "Pittsburgh Steelers": 23,
  "San Francisco 49ers": 25, "Seattle Seahawks": 26, "Tampa Bay Buccaneers": 27, "Tennessee Titans": 10, "Washington Commanders": 28,
};
const BET_TYPE_SPORTS = {
  "Anytime TD": ["NFL", "NCAAF"], "Passing TD": ["NFL", "NCAAF"], "Passing Yards": ["NFL", "NCAAF"], "Receiving Yards": ["NFL", "NCAAF"],
  Receptions: ["NFL", "NCAAF"], Interceptions: ["NFL", "NCAAF"], "Total Yards": ["NFL", "NCAAF"], "Player Points": ["NBA", "NCAAM"], "Home Runs": ["MLB"],
};
const NICKNAME_TO_FORMAL = {
  matt: "matthew", mike: "michael", chris: "christopher", nick: "nicholas", josh: "joshua", sam: "samuel", alex: "alexander", will: "william",
  tom: "thomas", tommy: "thomas", bob: "robert", bobby: "robert", rob: "robert", dan: "daniel", danny: "daniel", ben: "benjamin",
  zach: "zachary", zack: "zachary", joe: "joseph", joey: "joseph", charlie: "charles", chuck: "charles", nate: "nathaniel",
  andy: "andrew", steve: "steven", jon: "jonathan", jim: "james", jimmy: "james", jack: "john", ed: "edward", eddie: "edward",
  tony: "anthony", greg: "gregory", pat: "patrick", ken: "kenneth", larry: "lawrence", ron: "ronald", rich: "richard", ricky: "richard",
  dave: "david", abe: "abraham", vlad: "vladimir",
};
export const PROP_STAT_SPECS = {
  "Anytime TD": [["TD", "rushing"], ["TD", "receiving"], ["TD", "kickReturns"], ["TD", "puntReturns"]],
  "Passing TD": [["TD", "passing"]],
  "Passing Yards": [["YDS", "passing"]],
  "Receiving Yards": [["YDS", "receiving"]],
  Receptions: [["REC", "receiving"]],
  Interceptions: [["INT", "passing"]],
  "Total Yards": [["YDS", "rushing"], ["YDS", "receiving"]],
  "Player Points": [["PTS", null]],
  "Home Runs": [["HR", "AB"]],
};

export const toNum = (v) => { const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : null; };

// ---------- Fetching ----------
export function newCtx() { return { boards: new Map(), summaries: new Map(), search: new Map(), rosters: new Map(), fetches: 0 }; }
async function getJSON(ctx, url, headers = HEADERS) {
  for (let i = 0; i < 2; i++) {
    try {
      ctx.fetches++;
      const r = await fetch(url, { headers });
      if (r.ok) { const t = await r.text(); if (t) return JSON.parse(t); }
    } catch { /* try again once */ }
  }
  return null;
}
export async function fetchScoreboard(ctx, path, ymd) {
  const key = `${path}|${ymd}`;
  if (!ctx.boards.has(key)) {
    let url = `${SITE}/${path}/scoreboard?dates=${ymd}`;
    const g = FULL_GROUP_BY_PATH[path];
    if (g) url += `&groups=${g[0]}&limit=${g[1]}`;
    ctx.boards.set(key, getJSON(ctx, url));
  }
  return ctx.boards.get(key);
}
export async function fetchSummary(ctx, path, id) {
  const key = `${path}|${id}`;
  if (!ctx.summaries.has(key)) {
    ctx.summaries.set(key, (async () => {
      const s = await getJSON(ctx, `${SITE}/${path}/summary?event=${encodeURIComponent(id)}`);
      if (s && s.header) return s;
      const core = CDN_CORE[path];
      if (!core) return s;
      const c = await getJSON(ctx, `https://cdn.espn.com/core/${core}/game?xhr=1&gameId=${encodeURIComponent(id)}`, { Accept: "application/json" });
      return (c && c.gamepackageJSON) || s;
    })());
  }
  return ctx.summaries.get(key);
}

// ---------- Names ----------
export const fold = (t) => String(t || "").trim().toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
export const foldName = (n) => fold(n).replace(/[^a-z0-9 ]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();
function nicknameVariant(name) {
  const parts = String(name).trim().split(/\s+/);
  if (!parts[0]) return null;
  const formal = NICKNAME_TO_FORMAL[parts[0].toLowerCase()];
  return formal ? `${formal[0].toUpperCase()}${formal.slice(1)} ${parts.slice(1).join(" ")}`.trim() : null;
}
export function teamMatchRank(candidate, team) {
  candidate = fold(candidate);
  if (!candidate || !team) return 0;
  const exact = new Set(["shortDisplayName", "displayName", "name", "location", "abbreviation"].map((f) => fold(team[f] || "")));
  const cands = new Set([candidate]);
  if (TEAM_NICKNAMES[candidate]) cands.add(TEAM_NICKNAMES[candidate]);
  if ([...cands].some((c) => exact.has(c))) return 3;
  const loose = (x) => x.replace(/[^a-z0-9 ]/g, "");
  const le = new Set([...exact].map(loose));
  if ([...cands].some((c) => le.has(loose(c)))) return 2;
  const display = fold(team.displayName || "");
  return [...cands].some((c) => display.includes(c)) ? 1 : 0;
}
/** "2026-09-27T17:00Z" -> "2026-09-27T13:00:00" (naive Eastern). */
export function toEasternIso(espnDate) {
  const d = new Date(espnDate);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00`;
}
const kickoffMatches = (event, gametime) => !!event.date && toEasternIso(event.date).slice(0, 16) === String(gametime).slice(0, 16);
function canonicalName(team, competitor) {
  const name = team.shortDisplayName || team.displayName || "";
  const rank = ((competitor && competitor.curatedRank) || {}).current;
  return rank && rank <= 25 ? `#${rank} ${name}`.trim() : name;
}
const ymdOf = (gametime) => (/^\d{4}-\d\d-\d\d/.test(gametime || "") ? gametime.slice(0, 10).replace(/-/g, "") : null);
const stripRank = (t) => String(t || "").replace(/^#\d+\s*/, "");
const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] > b[i]) return 1; if (a[i] < b[i]) return -1; } return 0; };

// ---------- Finding the game ----------
/** The ESPN event for a team-vs-opponent game on the leg's date: [event, teamC, oppC] or null. */
export async function findEvent(ctx, team, opponent, sport, gametime) {
  team = stripRank(team); opponent = stripRank(opponent);
  const ymd = ymdOf(gametime);
  if (!team || !opponent || !sport || !ymd) return null;
  let best = null, bestKey = null;
  for (const path of SPORT_ESPN_PATHS[sport] || []) {
    const data = await fetchScoreboard(ctx, path, ymd);
    for (const event of (data && data.events) || []) {
      const comp = (event.competitions || [])[0];
      const cs = (comp && comp.competitors) || [];
      if (cs.length !== 2 || !cs[0].team || !cs[1].team) continue;
      for (const [tc, oc] of [[cs[0], cs[1]], [cs[1], cs[0]]]) {
        const a = teamMatchRank(team, tc.team), b = teamMatchRank(opponent, oc.team);
        if (!a || !b) continue;
        const key = [Math.min(a, b), a + b, kickoffMatches(event, gametime) ? 1 : 0];
        if (!bestKey || cmpTuple(key, bestKey) > 0) { best = [event, tc, oc, path]; bestKey = key; }
      }
    }
  }
  return best;
}
async function findEventForTeam(ctx, team, sport, gametime) {
  team = stripRank(team);
  const ymd = ymdOf(gametime);
  if (!team || !sport || !ymd) return null;
  let best = null, bestKey = null;
  for (const path of SPORT_ESPN_PATHS[sport] || []) {
    const data = await fetchScoreboard(ctx, path, ymd);
    for (const event of (data && data.events) || []) {
      for (const c of ((event.competitions || [])[0] || {}).competitors || []) {
        const rank = teamMatchRank(team, c.team || {});
        if (!rank) continue;
        const key = [rank, kickoffMatches(event, gametime) ? 1 : 0];
        if (!bestKey || cmpTuple(key, bestKey) > 0) { best = [event, c, path]; bestKey = key; }
      }
    }
  }
  return best;
}
/** A leg with ESPN's event id: [comp, teamC, oppC, summary] from that game's summary, or null. */
export async function eventById(ctx, sport, id, team, opponent) {
  for (const path of SPORT_ESPN_PATHS[sport] || []) {
    const s = await fetchSummary(ctx, path, id);
    const comp = s && s.header && (s.header.competitions || [])[0];
    if (!comp || (comp.competitors || []).length !== 2) continue;
    const [c0, c1] = comp.competitors;
    if (!team) return [comp, c0, c1, s, path];
    const r = (tc, oc) => Math.min(teamMatchRank(stripRank(team), tc.team || {}), opponent ? teamMatchRank(stripRank(opponent), oc.team || {}) : 3);
    const a = r(c0, c1), b = r(c1, c0);
    if (!a && !b) return null; // the id isn't this game: let the caller search
    return a >= b ? [comp, c0, c1, s, path] : [comp, c1, c0, s, path];
  }
  return null;
}

export function gameState(comp, teamC, oppC) {
  const status = comp.status || {}, type = status.type || {};
  return {
    state: type.state, completed: !!type.completed, period: status.period ?? null, clock: status.displayClock ?? null,
    detail: type.shortDetail || type.detail || null, team_score: toNum(teamC.score), opponent_score: toNum(oppC.score),
  };
}
const lineValue = (l) => toNum(l.value ?? l.displayValue);
export function halfScores(teamC, oppC) {
  const half = (c) => { const ls = c.linescores || []; if (ls.length < 2) return null; const v = ls.slice(0, 2).map(lineValue); return v.some((x) => x == null) ? null : v[0] + v[1]; };
  const a = half(teamC), b = half(oppC);
  return a == null || b == null ? null : [a, b];
}

// ---------- Individual sports (UFC) ----------
export async function findIndividual(ctx, nameA, nameB, sport, gametime) {
  const ymd = ymdOf(gametime);
  if (!nameA || !nameB || !sport || !ymd) return null;
  const matches = (cand, ath) => {
    cand = foldName(cand);
    if (!cand) return false;
    const fields = new Set(["fullName", "displayName", "shortName"].map((f) => foldName(ath[f] || "")));
    return fields.has(cand) || foldName(ath.fullName || "").includes(cand);
  };
  for (const path of SPORT_ESPN_PATHS[sport] || []) {
    const data = await fetchScoreboard(ctx, path, ymd);
    for (const event of (data && data.events) || []) {
      for (const comp of event.competitions || []) {
        const cs = comp.competitors || [];
        if (cs.length !== 2 || cs.some((c) => !c.athlete)) continue;
        if (matches(nameA, cs[0].athlete) && matches(nameB, cs[1].athlete)) return [comp, cs[0], cs[1]];
        if (matches(nameA, cs[1].athlete) && matches(nameB, cs[0].athlete)) return [comp, cs[1], cs[0]];
      }
    }
  }
  return null;
}

// ---------- Player props ----------
async function searchPlayer(ctx, name) {
  if (!ctx.search.has(name)) {
    ctx.search.set(name, (async () => {
      const d = await getJSON(ctx, "https://site.api.espn.com/apis/search/v2?query=" + encodeURIComponent(name));
      const hits = [];
      for (const g of (d && d.results) || []) if (g.type === "player") for (const c of g.contents || []) hits.push({ name: c.displayName, sport: c.description, team: c.subtitle });
      return hits;
    })());
  }
  return ctx.search.get(name);
}
async function onNflRoster(ctx, player, teamName) {
  const id = NFL_TEAM_IDS[teamName];
  if (id == null) return false;
  if (!ctx.rosters.has(id)) {
    ctx.rosters.set(id, getJSON(ctx, `${SITE}/football/nfl/teams/${id}/roster`).then((d) => d ? new Set((d.athletes || []).flatMap((g) => (g.items || []).map((a) => foldName(a.fullName || "")))) : null));
  }
  const names = await ctx.rosters.get(id);
  return names == null ? true : names.has(foldName(player));
}
/** [team, sport] for a player, or [null, null] when ESPN's search can't say for sure. */
export async function findPlayerTeam(ctx, player, betType) {
  let hits = await searchPlayer(ctx, player);
  let exact = hits.filter((h) => foldName(h.name || "") === foldName(player));
  if (!exact.length) {
    const v = nicknameVariant(player);
    if (v) exact = (await searchPlayer(ctx, v)).filter((h) => foldName(h.name || "") === foldName(v));
  }
  hits = exact.length ? exact : hits;
  if (!hits.length) return [null, null];
  const plausible = BET_TYPE_SPORTS[betType];
  if (plausible) { const f = hits.filter((h) => plausible.includes(h.sport)); if (f.length) hits = f; }
  const key = (h) => `${h.sport}\u0000${h.team}`;
  let distinct = [...new Map(hits.filter((h) => h.sport && h.team).map((h) => [key(h), [h.sport, h.team]])).values()];
  if (distinct.length !== 1) {
    const nfl = distinct.filter((d) => d[0] === "NFL");
    if (nfl.length > 1) {
      const ok = [];
      for (const d of nfl) if (await onNflRoster(ctx, player, d[1])) ok.push(d);
      distinct = distinct.filter((d) => d[0] !== "NFL").concat(ok);
    }
    if (distinct.length === 1) return [distinct[0][1], SPORT_ESPN_PATHS[distinct[0][0]] ? distinct[0][0] : null];
    const sports = new Set(distinct.map((d) => d[0]));
    if (sports.size === 2 && sports.has("NFL") && sports.has("NCAAF")) {
      const only = distinct.filter((d) => d[0] === "NFL");
      if (only.length === 1) return [only[0][1], "NFL"];
    }
    return [null, null];
  }
  return [distinct[0][1], SPORT_ESPN_PATHS[distinct[0][0]] ? distinct[0][0] : null];
}
const groupMatchesHint = (g, hint) => hint == null || g.name === hint || (g.labels || []).includes(hint);
/** One team's box-score block: [total, found] for the player (found false = not on it). */
export function readPropStat(block, player, betType) {
  const targets = new Set([foldName(player)]);
  const v = nicknameVariant(player);
  if (v) targets.add(foldName(v));
  let found = false;
  const statValue = (g, label) => {
    const labels = g.labels || [], idx = labels.indexOf(label);
    if (idx < 0) return null;
    for (const a of g.athletes || []) {
      if (!targets.has(foldName((a.athlete || {}).displayName || ""))) continue;
      found = true;
      const st = a.stats || [];
      return idx < st.length ? toNum(st[idx]) : null;
    }
    return null;
  };
  let total = 0;
  for (const [label, hint] of PROP_STAT_SPECS[betType] || []) {
    let groups = (block.statistics || []).filter((g) => (g.labels || []).includes(label));
    const hinted = groups.filter((g) => groupMatchesHint(g, hint));
    if (hinted.length) groups = hinted;
    let value = null;
    for (const g of groups) { const x = statValue(g, label); if (x != null) { value = x; break; } }
    if (value != null) total += value;
  }
  if (!found) {
    found = (block.statistics || []).some((g) => (g.athletes || []).some((a) => targets.has(foldName((a.athlete || {}).displayName || ""))));
    if (!found) return [null, false];
  }
  return [Math.round(total * 100) / 100, true];
}
/** Every box-score block of a summary that has the player: [[total, block], ...]. */
export function propFromSummary(summary, player, betType) {
  const out = [];
  for (const block of ((summary && summary.boxscore) || {}).players || []) {
    const [total, found] = readPropStat(block, player, betType);
    if (found) out.push([total, block]);
  }
  return out;
}
/** A prop's game and running stat: { comp, teamC, oppC, total, found } or null. */
export async function locateProp(ctx, player, betType, sport, gametime, requireFinal, gameId) {
  // Parlay Legs saved the game's id: read that one game.
  if (gameId) {
    const hit = await eventById(ctx, sport, gameId);
    if (hit) {
      const [comp, c0, c1, s] = hit;
      const done = ((comp.status || {}).type || {}).completed;
      const found = propFromSummary(s, player, betType);
      const blockTeam = found.length === 1 ? ((found[0][1].team || {}).abbreviation) : null;
      const teamC = blockTeam ? [c0, c1].find((c) => (c.team || {}).abbreviation === blockTeam) || c0 : c0;
      const oppC = teamC === c0 ? c1 : c0;
      if (found.length === 1 && (!requireFinal || done)) return { comp, teamC, oppC, total: found[0][0], found: true };
      return { comp, teamC, oppC, total: null, found: false };
    }
  }
  // The Python's two tiers: the search-resolved team's game, then every game that day.
  const [team, resolved] = await findPlayerTeam(ctx, player, betType);
  let fallback = null;
  if (team) {
    const ev = await findEventForTeam(ctx, team, resolved || sport, gametime);
    if (ev) {
      const [event, teamC, path] = ev;
      const comp = event.competitions[0];
      const oppC = comp.competitors.find((c) => c !== teamC);
      fallback = { comp, teamC, oppC, total: null, found: false };
      if (!requireFinal || ((comp.status || {}).type || {}).completed) {
        const s = await fetchSummary(ctx, path, event.id);
        const block = (((s && s.boxscore) || {}).players || []).find((b) => (b.team || {}).abbreviation === (teamC.team || {}).abbreviation);
        if (block) { const [total, found] = readPropStat(block, player, betType); if (found) return { comp, teamC, oppC, total, found: true }; }
      }
    }
  }
  const ymd = ymdOf(gametime);
  const hits = [];
  for (const path of ymd ? SPORT_ESPN_PATHS[sport] || [] : []) {
    const data = await fetchScoreboard(ctx, path, ymd);
    for (const event of (data && data.events) || []) {
      const comp = (event.competitions || [])[0] || {};
      if (requireFinal && !((comp.status || {}).type || {}).completed) continue;
      const s = await fetchSummary(ctx, path, event.id);
      for (const [total, block] of propFromSummary(s, player, betType)) {
        const teamC = (comp.competitors || []).find((c) => (c.team || {}).abbreviation === (block.team || {}).abbreviation);
        hits.push({ comp, teamC, oppC: (comp.competitors || []).find((c) => c !== teamC), total, found: true });
      }
    }
  }
  if (hits.length === 1) return hits[0];
  return fallback;
}
export const abbrevOf = (c) => ((c && c.team) || {}).abbreviation || canonicalName((c && c.team) || {}, c || {});
