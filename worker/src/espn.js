/**
 * Raw ESPN Fantasy Football API calls, mirroring exactly what the vendored
 * espn_api Python library (espn_api/requests/espn_requests.py,
 * espn_api/base_league.py) does — same endpoints, same query params, same
 * response field paths — so this Worker produces what the Python pipeline it
 * replaced always did, without needing Python or that library at all.
 */

const FANTASY_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

function leagueEndpoint(year, leagueId) {
  return `${FANTASY_BASE}/seasons/${year}/segments/0/leagues/${leagueId}`;
}

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
}

async function espnGet(url, env, extraHeaders) {
  const res = await fetch(url, {
    headers: {
      // requests' `cookies=` param sends this same Cookie header under the
      // hood — SWID's braces need to stay in the value as ESPN issued them.
      Cookie: `espn_s2=${env.ESPN_S2}; SWID=${env.ESPN_SWID}`,
      Accept: "application/json",
      ...(extraHeaders || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ESPN request failed (${res.status}) for ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** One read of the league endpoint with the given views and, optionally,
 * ESPN's x-fantasy-filter (the draft board's player pool uses both). */
export async function espnLeagueGet(env, params, filter) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), params);
  return espnGet(url, env, filter ? { "x-fantasy-filter": JSON.stringify(filter) } : undefined);
}

/** Cheapest authenticated call (just the league's settings), for the daily
 * health check -- throws like any other ESPN call when the cookies are bad. */
export async function pingEspn(env) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), { view: "mSettings" });
  const data = await espnGet(url, env);
  if (!data || !data.settings) throw new Error("ESPN request failed (200): no settings in the response");
}

/** Full league fetch: standings, records, points, playoff odds, team/owner
 * info, and (via the `schedule` array) every team's actual score for every
 * week played so far — everything except the current week's live/projected
 * score, which needs the separate box-score call below. Rosters are their
 * own call (fetchRosters): that one view is about 80% of the download and
 * only feeds the season averages, which change once a week. */
export async function fetchLeague(env) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), {
    view: ["mTeam", "mMatchup", "mSettings", "mStandings"],
  });
  return espnGet(url, env);
}

/** Every team's roster with each player's season stat lines. */
export async function fetchRosters(env) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), { view: "mRoster" });
  return espnGet(url, env);
}

/** Current week's box scores (live/projected scores + full rosters for the
 * "players remaining" count). `matchupPeriod` must be the matchup period
 * that contains `week` — see findMatchupPeriod(). */
export async function fetchBoxScores(env, week, matchupPeriod) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), {
    view: ["mMatchupScore", "mScoreboard"],
    scoringPeriodId: week,
  });
  const filter = { schedule: { filterMatchupPeriodIds: { value: [matchupPeriod] } } };
  return espnGet(url, env, { "x-fantasy-filter": JSON.stringify(filter) });
}

/** ESPN's public (unauthenticated) NFL scoreboard — game score, quarter,
 * clock, and offense possession for every game in a week. Deliberately
 * *not* site.api.espn.com/apis/site/v2/... (the "normal" public sports
 * API): that host's WAF returns a 403 to every request from a deployed
 * Worker (confirmed live — identical request succeeds from a local curl,
 * fails from Cloudflare's IPs), with no header combination found that
 * changes that. cdn.espn.com's core scoreboard page-data endpoint returns
 * the same event/competition shape (one level deeper, under
 * content.sbData) and isn't behind that block. Its team ids are still
 * numerically identical to the fantasy API's proTeamId (e.g. Miami is 15
 * in both), so callers can join the two directly with no translation
 * table. */
export async function fetchNflScoreboard(env, week) {
  const url = `https://cdn.espn.com/core/nfl/scoreboard?xhr=1&year=${env.ESPN_YEAR}&week=${week}&seasontype=2`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NFL scoreboard request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.content?.sbData || null;
}

/** `scheduleSettings.matchupPeriods` is {matchupId: [week, week, ...]} —
 * finds which matchup period a given week belongs to. */
export function findMatchupPeriod(matchupPeriodsObj, week) {
  for (const [matchupId, weeks] of Object.entries(matchupPeriodsObj || {})) {
    if (weeks.includes(week)) return parseInt(matchupId, 10);
  }
  return null;
}

/** Players' full current-season lines: one stat row per NFL week played
 * (actual points and every stat category, keyed to that week's game by
 * `externalId`), plus the season totals. The same view and filter the
 * espn_api library's player_info() uses. */
export async function fetchPlayerCards(env, playerIds) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), { view: "kona_playercard" });
  const filter = {
    players: {
      filterIds: { value: playerIds },
      filterStatsForTopScoringPeriodIds: { value: 18, additionalValue: [`00${env.ESPN_YEAR}`, `10${env.ESPN_YEAR}`] },
    },
  };
  return espnGet(url, env, { "x-fantasy-filter": JSON.stringify(filter) });
}

/** Players' projection for one future week. ESPN only hands out a week's
 * projection when asked for that week by scoringPeriodId, one week per
 * request (no filter combination was found that returns them all). */
export async function fetchPlayerWeek(env, playerIds, week) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), { view: "kona_player_info", scoringPeriodId: week });
  const filter = { players: { filterIds: { value: playerIds } } };
  return espnGet(url, env, { "x-fantasy-filter": JSON.stringify(filter) });
}

/** Every NFL team's schedule for the season: each week's game (id, home
 * and away team ids, kickoff) and its bye week. */
export async function fetchProSchedules(env) {
  const url = buildUrl(`${FANTASY_BASE}/seasons/${env.ESPN_YEAR}`, { view: "proTeamSchedules_wl" });
  return espnGet(url, env);
}
