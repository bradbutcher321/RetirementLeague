/**
 * One player's season, week by week, for the dashboard's game log (tap a
 * player in an open matchup):
 *   - weeks already played: fantasy points and the stat line,
 *   - this week and every week after: the opponent (or bye) and ESPN's
 *     projection for that week.
 * The page lays this week's live numbers over the top, since it already has
 * them fresher than this cache.
 *
 * GET /player?id=<espn player id>&week=<live week>&last=<final week>
 */
import { fetchPlayerCards, fetchPlayerWeek, fetchProSchedules } from "./espn.js";
import { DEFAULT_POSITION_MAP, formatStatLine } from "./dashboard.js";
import { cached } from "./cache.js";

const LOG_MAX_AGE = 30 * 60;
// The NFL schedule only changes when a game is flexed or moved.
const SCHEDULE_MAX_AGE = 24 * 60 * 60;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Just what the log needs from ESPN's ~200KB schedule payload:
 * { teams: {proTeamId: abbrev}, games: [[week, gameId, homeId, awayId, kickoffMs]] } */
async function proSchedule(env) {
  return cached(env, `nfl-schedule:${env.ESPN_YEAR}`, SCHEDULE_MAX_AGE, async () => {
    const data = await fetchProSchedules(env);
    const teams = {};
    const games = new Map();
    for (const t of data.settings?.proTeams || []) {
      if (!t.id) continue; // id 0 is ESPN's "free agent" team
      teams[t.id] = t.abbrev;
      for (const [week, list] of Object.entries(t.proGamesByScoringPeriod || {})) {
        for (const g of list) games.set(g.id, [Number(week), g.id, g.homeProTeamId, g.awayProTeamId, g.date]);
      }
    }
    return { teams, games: [...games.values()] };
  });
}

export async function buildPlayerLog(env, playerId, liveWeek, lastWeek) {
  const [cards, schedule] = await Promise.all([fetchPlayerCards(env, [playerId]), proSchedule(env)]);
  const player = cards.players?.[0]?.player;
  if (!player) throw new Error(`No player ${playerId}`);
  const year = Number(env.ESPN_YEAR);
  const position = DEFAULT_POSITION_MAP[player.defaultPositionId] || "";

  const gamesById = new Map(schedule.games.map((g) => [String(g[1]), g]));
  const gameOf = (teamId, week) => schedule.games.find((g) => g[0] === week && (g[2] === teamId || g[3] === teamId)) || null;

  const stats = player.stats || [];
  const actual = new Map(stats
    .filter((s) => s.seasonId === year && s.statSourceId === 0 && s.statSplitTypeId === 1)
    .map((s) => [s.scoringPeriodId, s]));

  // One request per week left (see fetchPlayerWeek), all at once. A week
  // that fails just shows no projection.
  const ahead = [];
  for (let w = liveWeek; w <= lastWeek; w++) if (gameOf(player.proTeamId, w)) ahead.push(w);
  const projections = new Map(await Promise.all(ahead.map((w) =>
    fetchPlayerWeek(env, [playerId], w)
      .then((d) => {
        const line = (d.players?.[0]?.player?.stats || [])
          .find((s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === w);
        return [w, line ? round2(line.appliedTotal) : null];
      })
      .catch(() => [w, null]))));

  const weeks = [];
  for (let w = 1; w <= lastWeek; w++) {
    const a = actual.get(w);
    // A played week names its own game, so a player traded mid-season
    // keeps the opponents he actually faced.
    const team = a?.proTeamId || player.proTeamId;
    const game = (a && gamesById.get(String(a.externalId))) || gameOf(team, w);
    const row = { w };
    if (!game) {
      row.bye = true;
    } else {
      const home = game[2] === team;
      row.opp = schedule.teams[home ? game[3] : game[2]] || "";
      row.home = home;
      row.date = game[4];
    }
    if (a) {
      row.pts = round2(a.appliedTotal || 0);
      // A row with no stats at all is a game he sat out (injury, inactive).
      if (!Object.keys(a.stats || {}).length) row.dnp = true;
      else row.line = formatStatLine(position, a.stats);
    }
    if (w >= liveWeek && projections.has(w)) row.proj = projections.get(w);
    weeks.push(row);
  }

  const played = weeks.filter((r) => r.w < liveWeek && typeof r.pts === "number" && !r.dnp);
  const total = round2(played.reduce((sum, r) => sum + r.pts, 0));
  return {
    id: player.id,
    name: player.fullName || "",
    position,
    team: schedule.teams[player.proTeamId] || "",
    injury: player.injuryStatus && player.injuryStatus !== "ACTIVE" ? player.injuryStatus : null,
    liveWeek,
    total,
    avg: played.length ? round2(total / played.length) : null,
    games: played.length,
    weeks,
  };
}

export async function getPlayerLog(env, url) {
  const id = parseInt(url.searchParams.get("id"), 10);
  const liveWeek = parseInt(url.searchParams.get("week"), 10);
  const lastWeek = parseInt(url.searchParams.get("last"), 10) || 17;
  if (!id || !(liveWeek >= 1 && liveWeek <= 18) || !(lastWeek >= liveWeek && lastWeek <= 18)) {
    return { status: 400, body: { error: "Need id, week and last" } };
  }
  const body = await cached(env, `player:${id}:${liveWeek}:${lastWeek}`, LOG_MAX_AGE, () => buildPlayerLog(env, id, liveWeek, lastWeek));
  return { status: 200, body };
}
