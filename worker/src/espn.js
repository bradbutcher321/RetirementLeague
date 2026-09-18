/**
 * Raw ESPN Fantasy Football API calls, mirroring exactly what the vendored
 * espn_api Python library (espn_api/requests/espn_requests.py,
 * espn_api/base_league.py) does — same endpoints, same query params, same
 * response field paths — so this Worker's output matches what
 * update_page_and_sheets.py has always produced, without needing Python or
 * that library at all.
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

/** Full league fetch: standings, records, points, playoff odds, team/owner
 * info, and (via the `schedule` array) every team's actual score for every
 * week played so far — everything except the current week's live/projected
 * score, which needs the separate box-score call below. */
export async function fetchLeague(env) {
  const url = buildUrl(leagueEndpoint(env.ESPN_YEAR, env.ESPN_LEAGUE_ID), {
    view: ["mTeam", "mRoster", "mMatchup", "mSettings", "mStandings"],
  });
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

/** ESPN's public (unauthenticated) sports scoreboard API — game score,
 * quarter, clock, and offense possession for every NFL game in a week.
 * Separate host/API from the private fantasy endpoints above, so no
 * cookie is sent. Its team ids are numerically identical to the fantasy
 * API's proTeamId (e.g. Miami is 15 in both), so callers can join the two
 * directly with no translation table. */
export async function fetchNflScoreboard(env, week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&year=${env.ESPN_YEAR}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`NFL scoreboard request failed (${res.status})`);
  return res.json();
}

/** `scheduleSettings.matchupPeriods` is {matchupId: [week, week, ...]} —
 * finds which matchup period a given week belongs to. */
export function findMatchupPeriod(matchupPeriodsObj, week) {
  for (const [matchupId, weeks] of Object.entries(matchupPeriodsObj || {})) {
    if (weeks.includes(week)) return parseInt(matchupId, 10);
  }
  return null;
}
