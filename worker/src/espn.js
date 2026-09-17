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

function seasonEndpoint(year) {
  return `${FANTASY_BASE}/seasons/${year}`;
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

/** Maps NFL proTeamId -> { opponentId, date (epoch ms) } for the given
 * week, used to tell whether a player's real-world game has started yet. A
 * team with no entry that week is on a bye. */
export async function fetchProSchedule(env, week) {
  const url = buildUrl(seasonEndpoint(env.ESPN_YEAR), { view: "proTeamSchedules_wl" });
  const data = await espnGet(url, env);
  const proTeams = data?.settings?.proTeams || [];
  const schedule = {};
  for (const team of proTeams) {
    if (team.id === 0) continue;
    const games = (team.proGamesByScoringPeriod || {})[String(week)];
    if (games && games.length) {
      const g = games[0];
      schedule[team.id] =
        team.id === g.awayProTeamId
          ? { opponentId: g.homeProTeamId, date: g.date }
          : { opponentId: g.awayProTeamId, date: g.date };
    }
  }
  return schedule;
}

/** `scheduleSettings.matchupPeriods` is {matchupId: [week, week, ...]} —
 * finds which matchup period a given week belongs to. */
export function findMatchupPeriod(matchupPeriodsObj, week) {
  for (const [matchupId, weeks] of Object.entries(matchupPeriodsObj || {})) {
    if (weeks.includes(week)) return parseInt(matchupId, 10);
  }
  return null;
}
