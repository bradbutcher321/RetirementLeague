/**
 * Your Roster (docs/roster.html; site audit VI #11, #12): what ESPN knows
 * that the site's own lineups file doesn't.
 *
 * GET /roster?week=N -> {
 *   year, liveWeek,
 *   byes: { "NYG": 8, ... }            each NFL team's bye week (ESPN's
 *                                       proTeamSchedules_wl, one read a day),
 *   rosters: { manager: [{ id, n, pos, tm, slot }] }   every roster right now,
 *                                       slot being ESPN's lineup slot (QB, RB,
 *                                       WR, TE, FLEX, D/ST, K, BE, IR),
 *   fa: { week, players: [{ id, n, pos, tm, pts, st }] }  the free agents and
 *                                       players on waivers who scored the most
 *                                       in week N (st: FREEAGENT | WAIVERS),
 *   updatedAt
 * }
 * N is the newest finished week the page has (the lineups file's last one).
 * Cached for an hour; the byes for a day.
 */
import { buildManagerNames } from "./managerNames.js";
import { cached } from "./cache.js";
import { espnLeagueGet } from "./espn.js";

const POSITIONS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const SLOTS = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 23: "FLEX", 16: "D/ST", 17: "K", 20: "BE", 21: "IR" };
const PRO_TEAMS = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};
const MAX_AGE = 60 * 60;
const FA_COUNT = 60;

async function byeWeeks(env) {
  return cached(env, `byes:${env.ESPN_YEAR}`, 24 * 60 * 60, async () => {
    const res = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${env.ESPN_YEAR}?view=proTeamSchedules_wl`, {
      headers: { Cookie: `espn_s2=${env.ESPN_S2}; SWID=${env.ESPN_SWID}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ESPN byes ${res.status}`);
    const data = await res.json();
    const out = {};
    for (const t of data?.settings?.proTeams || []) if (t.id && t.byeWeek) out[t.abbrev] = t.byeWeek;
    return out;
  });
}

async function rosters(env) {
  const data = await espnLeagueGet(env, { view: ["mTeam", "mRoster", "mSettings"] });
  const members = new Map((data.members || []).map((m) => [m.id, m]));
  const raw = (data.teams || []).map((t) => ({ teamId: t.id, owners: (t.owners || []).map((id) => members.get(id)).filter(Boolean), t }));
  const names = buildManagerNames(raw);
  const out = {};
  for (const { teamId, t } of raw) {
    out[names.get(teamId) || String(teamId)] = (t.roster?.entries || []).map((e) => {
      const p = e.playerPoolEntry?.player || {};
      return { id: p.id || e.playerId, n: p.fullName || "", pos: POSITIONS[p.defaultPositionId] || "", tm: PRO_TEAMS[p.proTeamId] || "", slot: SLOTS[e.lineupSlotId] || "BE" };
    });
  }
  return { rosters: out, liveWeek: data.scoringPeriodId || null };
}

async function freeAgents(env, week) {
  const data = await espnLeagueGet(env, { view: "kona_player_info", scoringPeriodId: week }, {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      filterSlotIds: { value: [0, 2, 4, 6, 23] },
      sortAppliedStatTotalForScoringPeriodId: { sortAsc: false, sortPriority: 1, value: week },
      limit: FA_COUNT,
    },
  });
  return (data.players || []).map((row) => {
    const p = row.player || {};
    const stat = (p.stats || []).find((s) => s.scoringPeriodId === week && s.statSourceId === 0);
    return { id: p.id, n: p.fullName || "", pos: POSITIONS[p.defaultPositionId] || "", tm: PRO_TEAMS[p.proTeamId] || "", pts: stat ? Math.round(stat.appliedTotal * 100) / 100 : 0, st: row.status || "" };
  }).filter((p) => p.pts > 0);
}

async function getRoster(request, env) {
  const week = parseInt(new URL(request.url).searchParams.get("week"), 10);
  const wk = week >= 1 && week <= 18 ? week : 0;
  const body = await cached(env, `roster:${env.ESPN_YEAR}:${wk}`, MAX_AGE, async () => {
    const [byes, ros, fa] = await Promise.all([
      byeWeeks(env).catch(() => ({})),
      rosters(env),
      wk ? freeAgents(env, wk).catch(() => []) : [],
    ]);
    return { year: Number(env.ESPN_YEAR), liveWeek: ros.liveWeek, byes, rosters: ros.rosters, fa: { week: wk || null, players: fa }, updatedAt: new Date().toISOString() };
  });
  return { status: 200, body };
}

export const ROSTER_ROUTES = { "/roster": ["GET", getRoster] };
