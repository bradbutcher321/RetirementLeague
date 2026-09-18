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
import { fetchLeague, fetchBoxScores, fetchNflScoreboard, findMatchupPeriod } from "./espn.js";
import { buildManagerNames } from "./managerNames.js";

const BENCH_SLOTS = new Set([20, 21]); // BE, IR — see espn_api football/constant.py POSITION_MAP

// Starter lineup slots, in the order the expanded matchup view displays
// them — see espn_api football/constant.py POSITION_MAP for the full slot
// id table. Slot 23 ("RB/WR/TE") is the FLEX spot.
const SLOT_LABELS = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 23: "FLEX", 16: "D/ST", 17: "K" };
const SLOT_ORDER = [0, 2, 4, 6, 23, 16, 17];

// A FLEX-slotted player's *real* position (needed to pick the right stat
// line) isn't in the lineup slot — it's ESPN's separate defaultPositionId,
// a different numbering than SLOT_LABELS above.
const DEFAULT_POSITION_MAP = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

// Subset of espn_api football/constant.py PLAYER_STATS_MAP needed to build
// a readable per-position stat line from a player's raw `stats` object.
function formatStatLine(position, stats) {
  const s = stats || {};
  const n = (id) => s[id] || 0;
  switch (position) {
    case "QB": {
      let line = `${n(1)}/${n(0)}, ${n(3)} YDS, ${n(4)} TD, ${n(20)} INT`;
      if (n(24)) line += `, ${n(24)} RUSH YDS`;
      return line;
    }
    case "RB": {
      const parts = [`${n(23)} CAR, ${n(24)} YDS, ${n(25)} TD`];
      const rec = n(41) || n(53);
      if (rec) parts.push(`${rec} REC, ${n(42) || n(61)} YDS, ${n(43)} TD`);
      return parts.join(" · ");
    }
    case "WR":
    case "TE":
      return `${n(41) || n(53)} REC, ${n(42) || n(61)} YDS, ${n(43)} TD`;
    case "K":
      return `${n(83)}/${n(84)} FG, ${n(86)}/${n(87)} XP`;
    case "D/ST": {
      let line = `${n(99)} SACK, ${n(95)} INT, ${n(96)} FR`;
      const defTd = n(105) || n(94);
      if (defTd) line += `, ${defTd} TD`;
      return line;
    }
    default:
      return "";
  }
}

/** proTeamId -> live NFL game state, from the public scoreboard feed. This
 * is the authoritative source for whether a player's game is upcoming, in
 * progress, or over — used both for the per-player detail panel and (via
 * countGameStatus below) the matchup-level in-play/remaining counts,
 * instead of guessing from a fixed post-kickoff time window. */
function buildGameStateMap(scoreboardData) {
  const map = new Map();
  for (const event of scoreboardData?.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const status = comp.status || {};
    const possessionTeamId = comp.situation?.possession ? parseInt(comp.situation.possession, 10) : null;
    const competitors = comp.competitors || [];
    for (const c of competitors) {
      const teamId = parseInt(c.team?.id, 10);
      if (!teamId) continue;
      const opponent = competitors.find((o) => o !== c);
      map.set(teamId, {
        date: event.date,
        teamScore: parseInt(c.score, 10) || 0,
        opponentScore: opponent ? parseInt(opponent.score, 10) || 0 : 0,
        opponentAbbrev: opponent?.team?.abbreviation || "",
        period: status.period || 0,
        displayClock: status.displayClock || "",
        state: status.type?.state || "pre", // "pre" | "in" | "post"
        hasPossession: possessionTeamId === teamId,
      });
    }
  }
  return map;
}

function buildPlayerCard(entry, gameStateByProTeam) {
  const player = entry.playerPoolEntry?.player || entry.player || {};
  const slot = SLOT_LABELS[entry.lineupSlotId] || "";
  const position = slot === "FLEX" ? DEFAULT_POSITION_MAP[player.defaultPositionId] || "RB" : slot;
  const stats = player.stats || [];
  const actualStat = stats.find((s) => s.statSourceId === 0);
  const projStat = stats.find((s) => s.statSourceId === 1);
  const game = gameStateByProTeam.get(player.proTeamId) || null;
  return {
    name: player.fullName || "",
    slot,
    livePoints: actualStat ? round2(actualStat.appliedTotal) : null,
    projectedPoints: projStat ? round2(projStat.appliedTotal) : 0,
    statLine: actualStat ? formatStatLine(position, actualStat.stats) : "",
    game: game && {
      opponent: game.opponentAbbrev,
      date: game.date,
      teamScore: game.teamScore,
      opponentScore: game.opponentScore,
      period: game.period,
      clock: game.displayClock,
      state: game.state,
      hasPossession: game.hasPossession,
    },
  };
}

/** Starters only (bench/IR excluded), in standard lineup order. */
function buildStarters(entries, gameStateByProTeam) {
  return entries
    .filter((e) => SLOT_ORDER.includes(e.lineupSlotId))
    .sort((a, b) => SLOT_ORDER.indexOf(a.lineupSlotId) - SLOT_ORDER.indexOf(b.lineupSlotId))
    .map((e) => buildPlayerCard(e, gameStateByProTeam));
}

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

function formatStreak(streakType, streakLength) {
  if (!streakLength) return null;
  if (streakType === "WIN") return `W${streakLength}`;
  if (streakType === "LOSS") return `L${streakLength}`;
  return null; // TIE / NONE — nothing worth showing
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
    streak: formatStreak(overall.streakType, overall.streakLength),
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
  const winProbability =
    typeof sideData.winProbability === "number" ? round2(sideData.winProbability * 100) : null;
  const entries = sideData.rosterForCurrentScoringPeriod?.entries || [];
  return { teamId: sideData.teamId, score, projected, winProbability, entries };
}

/** A roster slot's real-world game is either not started yet ("remaining"),
 * in progress right now ("inPlay"), or over — read directly from the NFL
 * scoreboard's own game state rather than guessing from a fixed time
 * window after kickoff, so an overtime or otherwise-long game doesn't get
 * marked "done" just because a few hours have passed. A bye week (no
 * entry in gameStateByProTeam) counts as neither. */
function countGameStatus(entries, gameStateByProTeam) {
  let remaining = 0;
  let inPlay = 0;
  for (const entry of entries) {
    if (BENCH_SLOTS.has(entry.lineupSlotId)) continue;
    const player = entry.playerPoolEntry?.player || entry.player || {};
    const game = gameStateByProTeam.get(player.proTeamId);
    if (!game) continue; // bye week, or NFL scoreboard unavailable
    if (game.state === "pre") remaining++;
    else if (game.state === "in") inPlay++;
  }
  return { remaining, inPlay };
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

  const [boxData, nflScoreboard] = await Promise.all([
    fetchBoxScores(env, currentWeek, matchupPeriod),
    // Public API, separate from ESPN's private fantasy endpoints — degrade
    // to "no live NFL game info" rather than failing the whole dashboard
    // if it's ever unreachable.
    fetchNflScoreboard(env, currentWeek).catch(() => null),
  ]);
  const gameStateByProTeam = buildGameStateMap(nflScoreboard);

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
    const awayStatus = countGameStatus(away.entries, gameStateByProTeam);
    const homeStatus = countGameStatus(home.entries, gameStateByProTeam);
    matchups.push({
      awayName: awayTeam?.name || "",
      awayManager: managerNames.get(away.teamId) || "",
      awayRecord: awayTeam?.record || "",
      awayStreak: awayTeam?.streak || null,
      awayScore: away.score,
      awayProjected: away.projected,
      awayWinProbability: away.winProbability,
      awayRemaining: awayStatus.remaining,
      awayInPlay: awayStatus.inPlay,
      homeName: homeTeam?.name || "",
      homeManager: managerNames.get(home.teamId) || "",
      homeRecord: homeTeam?.record || "",
      homeStreak: homeTeam?.streak || null,
      homeScore: home.score,
      homeProjected: home.projected,
      homeWinProbability: home.winProbability,
      homeRemaining: homeStatus.remaining,
      homeInPlay: homeStatus.inPlay,
      awayPlayers: buildStarters(away.entries, gameStateByProTeam),
      homePlayers: buildStarters(home.entries, gameStateByProTeam),
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
