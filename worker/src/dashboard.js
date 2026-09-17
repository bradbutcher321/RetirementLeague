/**
 * Builds the full Live Dashboard payload directly from ESPN — the Worker
 * equivalent of update_page_and_sheets.py's main(), minus the Google Sheets
 * step entirely. Two deliberate simplifications from the Python version,
 * both narrow edge cases:
 *
 *   1. A roster player's pro team is read from the top-level `proTeamId`
 *      only, not cross-checked against that week's stats entries. The
 *      Python code does that extra check to handle a player traded
 *      *during* a past week being looked up later — irrelevant here since
 *      this only ever looks at the current, live week.
 *   2. If ESPN hasn't started returning live projected scores yet for a
 *      matchup (pre-kickoff), projected is reported as 0 instead of being
 *      recomputed by summing each starter's individual projection. That
 *      per-player figure requires parsing ESPN's full stats array, which
 *      isn't needed for anything else here. In practice this only affects
 *      the brief window before Thursday kickoff, when the page already
 *      shows the countdown card instead of real numbers anyway.
 */
import { fetchLeague, fetchBoxScores, fetchProSchedule, findMatchupPeriod } from "./espn.js";
import { buildManagerNames } from "./managerNames.js";

const BENCH_SLOTS = new Set([20, 21]); // BE, IR — see espn_api football/constant.py POSITION_MAP
const GAME_GRACE_MS = 3 * 60 * 60 * 1000; // matches espn_api BoxPlayer: game counted "played" 3h after kickoff

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatRecord(wins, losses, ties) {
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function parseTeam(data) {
  const overall = data.record?.overall || {};
  const wins = overall.wins || 0;
  const losses = overall.losses || 0;
  const ties = overall.ties || 0;
  let name = data.name || "Unknown";
  if (name === "Unknown") name = `${data.location || "Unknown"} ${data.nickname || "Unknown"}`;
  return {
    teamId: data.id,
    name,
    wins,
    losses,
    ties,
    record: formatRecord(wins, losses, ties),
    pointsFor: overall.pointsFor || 0,
    pointsAgainst: round2(overall.pointsAgainst || 0),
    playoffPct: (data.currentSimulationResults?.playoffPct || 0) * 100,
    standing: data.playoffSeed || data.rankFinal || data.rankCalculatedFinal || 999,
    ownerIds: data.owners || [],
  };
}

/** One team's actual score per week, in week order, straight from the
 * league-wide schedule array (mMatchup view) — same source
 * Team._fetch_schedule reads in the Python library. */
function teamScoresByWeek(schedule, teamId) {
  const scores = [];
  for (const matchup of schedule) {
    const home = matchup.home || {};
    const away = matchup.away || {};
    const homeId = home.teamId ?? -1;
    const awayId = away.teamId ?? -1;
    if (teamId === homeId || teamId === awayId) {
      const side = teamId === homeId ? home : away;
      scores.push(typeof side.totalPoints === "number" ? side.totalPoints : null);
    }
  }
  return scores;
}

function findWeeklyHigh(teamsRaw, schedule, currentWeek) {
  let best = { teamId: null, week: null, score: -1 };
  for (const t of teamsRaw) {
    const scores = teamScoresByWeek(schedule, t.teamId).slice(0, currentWeek);
    scores.forEach((score, idx) => {
      if (score !== null && score > best.score) {
        best = { teamId: t.teamId, week: idx + 1, score };
      }
    });
  }
  return best;
}

function parseBoxSide(sideData) {
  if (!sideData || !sideData.teamId) return null;
  let score, projected;
  if ("totalPointsLive" in sideData) {
    score = round2(sideData.totalPointsLive);
    projected = typeof sideData.totalProjectedPointsLive === "number" ? round2(sideData.totalProjectedPointsLive) : 0;
  } else {
    score = round2(sideData.totalPoints);
    projected = 0; // see file header — pre-live-scoring fallback simplification
  }
  const entries = sideData.rosterForCurrentScoringPeriod?.entries || [];
  return { teamId: sideData.teamId, score, projected, entries };
}

function countRemaining(entries, proSchedule, nowMs) {
  let remaining = 0;
  for (const entry of entries) {
    if (BENCH_SLOTS.has(entry.lineupSlotId)) continue;
    const player = entry.playerPoolEntry?.player || entry.player || {};
    const sched = proSchedule[player.proTeamId];
    const gameStarted = sched ? nowMs > sched.date + GAME_GRACE_MS : true; // no game this week (bye) = not "remaining"
    if (!gameStarted) remaining++;
  }
  return remaining;
}

export async function buildDashboard(env) {
  const league = await fetchLeague(env);

  const currentWeek = Math.min(league.scoringPeriodId, league.status.finalScoringPeriod);
  const matchupPeriodsObj = league.settings?.scheduleSettings?.matchupPeriods || {};
  const matchupPeriod = findMatchupPeriod(matchupPeriodsObj, currentWeek) ?? league.status.currentMatchupPeriod;

  const membersById = new Map((league.members || []).map((m) => [m.id, m]));
  const teamsRaw = (league.teams || []).map((t) => {
    const parsed = parseTeam(t);
    parsed.owners = parsed.ownerIds.map((id) => membersById.get(id)).filter(Boolean);
    return parsed;
  });
  const teamsById = new Map(teamsRaw.map((t) => [t.teamId, t]));
  const managerNames = buildManagerNames(teamsRaw);

  const [boxData, proSchedule] = await Promise.all([
    fetchBoxScores(env, currentWeek, matchupPeriod),
    fetchProSchedule(env, currentWeek),
  ]);

  const now = Date.now();
  const currentScores = [];
  const projectedScores = [];
  const teamCurrentById = new Map(); // teamId -> { current, projected }
  const matchups = [];

  for (const boxMatchup of boxData.schedule || []) {
    const home = parseBoxSide(boxMatchup.home);
    const away = parseBoxSide(boxMatchup.away);
    if (!home && !away) continue;

    if (home) {
      currentScores.push(home.score);
      projectedScores.push(home.projected);
      teamCurrentById.set(home.teamId, { current: home.score, projected: home.projected });
    }
    if (away) {
      currentScores.push(away.score);
      projectedScores.push(away.projected);
      teamCurrentById.set(away.teamId, { current: away.score, projected: away.projected });
    }
    if (!home || !away) continue; // bye week — no matchup card to show

    const homeTeam = teamsById.get(home.teamId);
    const awayTeam = teamsById.get(away.teamId);
    matchups.push({
      awayName: awayTeam?.name || "",
      awayManager: managerNames.get(away.teamId) || "",
      awayRecord: awayTeam?.record || "",
      awayScore: away.score,
      awayProjected: away.projected,
      awayRemaining: countRemaining(away.entries, proSchedule, now),
      homeName: homeTeam?.name || "",
      homeManager: managerNames.get(home.teamId) || "",
      homeRecord: homeTeam?.record || "",
      homeScore: home.score,
      homeProjected: home.projected,
      homeRemaining: countRemaining(home.entries, proSchedule, now),
    });
  }

  const teams = teamsRaw
    .map((t) => {
      const live = teamCurrentById.get(t.teamId) || { current: 0, projected: 0 };
      return {
        name: t.name,
        manager: managerNames.get(t.teamId) || "",
        record: t.record,
        current: live.current,
        projected: live.projected,
        standing: t.standing,
        pointsFor: round2(t.pointsFor),
        pointsAgainst: t.pointsAgainst,
        playoffPct: t.playoffPct,
      };
    })
    .sort((a, b) => a.standing - b.standing);

  const currentMedian = currentScores.length ? round2(median(currentScores)) : 0;
  const projectedMedian = projectedScores.length ? round2(median(projectedScores)) : 0;

  const weeklyHigh = findWeeklyHigh(teamsRaw, league.schedule || [], currentWeek);
  const seasonLeaderTeam = teamsRaw.reduce((best, t) => (t.pointsFor > (best?.pointsFor ?? -1) ? t : best), null);

  const seasonStarted = weeklyHigh.score > 0;
  const seasonPointsStarted = (seasonLeaderTeam?.pointsFor || 0) > 0;
  const anyPlayoffData = teamsRaw.some((t) => t.playoffPct);

  return {
    updatedAt: new Date().toISOString(),
    week: currentWeek,
    currentMedian,
    projectedMedian,
    teams: teams.map((t) => ({ ...t, playoffPct: anyPlayoffData ? round2(t.playoffPct) : null })),
    matchups,
    weeklyHigh: seasonStarted
      ? {
          team: teamsById.get(weeklyHigh.teamId)?.name || "",
          manager: managerNames.get(weeklyHigh.teamId) || "",
          week: weeklyHigh.week,
          score: round2(weeklyHigh.score),
        }
      : null,
    seasonLeader: seasonPointsStarted
      ? {
          team: seasonLeaderTeam.name,
          manager: managerNames.get(seasonLeaderTeam.teamId) || "",
          points: round2(seasonLeaderTeam.pointsFor),
        }
      : null,
  };
}
