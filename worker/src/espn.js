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
