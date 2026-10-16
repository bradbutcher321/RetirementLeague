/**
 * Draft Day Live (site audit III #17): the Draft Board's live view reads this.
 *
 * GET /draft -> {
 *   year, status: "pre" | "live" | "done", startsAt (ms or null),
 *   order: [teamId, ...]      round-one order, slot 1 first,
 *   teams: { teamId: { manager, name } },
 *   picks: [{ o: overall, t: teamId, p: playerId, k: keeper? }]   in pick order,
 *   rounds,                    the most rounds ESPN has shown a pick for,
 *   players: { playerId: { n: name, pos, tm: pro team, adp } },
 *   updatedAt
 * }
 *
 * Three ESPN reads (draft, teams + owners, the player pool with average draft
 * position), cached for a few seconds so a room full of phones and a TV cost
 * ESPN one request each. `adp` is ESPN's average draft position, the "where
 * he was expected to go" that the page grades every pick against; a player
 * with none gets no grade rather than a made-up one.
 */
import { buildManagerNames } from "./managerNames.js";
import { cached } from "./cache.js";
import { espnLeagueGet } from "./espn.js";

const DRAFT_MAX_AGE = 3;
const POOL_MAX_AGE = 10 * 60;
const TEAMS_MAX_AGE = 60 * 60;
const POOL_SIZE = 600;

const POSITIONS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const PRO_TEAMS = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};

/** One ESPN player row, cut down to what the board shows. */
function playerRow(row) {
  const p = row.player || row;
  const adp = Number(p.ownership?.averageDraftPosition) || Number(p.draftRanksByRankType?.STANDARD?.rank) || 0;
  return {
    n: p.fullName || "",
    pos: POSITIONS[p.defaultPositionId] || "",
    tm: PRO_TEAMS[p.proTeamId] || "",
    adp: adp ? Math.round(adp * 10) / 10 : 0,
  };
}

async function playerPool(env) {
  return cached(env, `draft-pool:${env.ESPN_YEAR}`, POOL_MAX_AGE, async () => {
    const data = await espnLeagueGet(env, { view: "kona_player_info" }, {
      players: {
        filterStatus: { value: ["FREEAGENT", "ONTEAM", "WAIVERS"] },
        limit: POOL_SIZE,
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
      },
    });
    const pool = {};
    for (const row of data.players || []) pool[row.id] = playerRow(row);
    return pool;
  });
}

async function leagueTeams(env) {
  return cached(env, `draft-teams:${env.ESPN_YEAR}`, TEAMS_MAX_AGE, async () => {
    const data = await espnLeagueGet(env, { view: ["mTeam", "mSettings"] });
    const members = new Map((data.members || []).map((m) => [m.id, m]));
    const raw = (data.teams || []).map((t) => ({
      teamId: t.id,
      name: [t.location, t.nickname].filter(Boolean).join(" ").trim() || t.name || "",
      owners: (t.owners || []).map((id) => members.get(id)).filter(Boolean),
    }));
    const names = buildManagerNames(raw);
    const teams = {};
    for (const t of raw) teams[t.teamId] = { manager: names.get(t.teamId) || "", name: t.name };
    const draft = data.settings?.draftSettings || {};
    return { teams, order: draft.pickOrder || [], startsAt: draft.date || null };
  });
}

export async function buildDraft(env) {
  const [{ teams, order, startsAt }, detail, pool] = await Promise.all([
    leagueTeams(env),
    espnLeagueGet(env, { view: "mDraftDetail" }),
    playerPool(env),
  ]);
  const d = detail.draftDetail || {};
  // ESPN may list every slot of the draft with playerId 0 for the ones still
  // to come; only made picks count.
  const all = d.picks || [];
  const made = all.filter((p) => p.playerId > 0).sort((a, b) => a.overallPickNumber - b.overallPickNumber);

  const players = {};
  const missing = [];
  for (const p of made) {
    if (pool[p.playerId]) players[p.playerId] = pool[p.playerId];
    else missing.push(p.playerId);
  }
  if (missing.length) {
    const extra = await espnLeagueGet(env, { view: "kona_player_info" }, { players: { filterIds: { value: missing } } });
    for (const row of extra.players || []) players[row.id] = playerRow(row);
  }

  const status = d.drafted ? "done" : d.inProgress || made.length ? "live" : "pre";
  return {
    year: Number(env.ESPN_YEAR),
    status,
    startsAt,
    order,
    teams,
    picks: made.map((p) => ({ o: p.overallPickNumber, t: p.teamId, p: p.playerId, ...(p.keeper ? { k: 1 } : {}) })),
    rounds: all.reduce((m, p) => Math.max(m, p.roundId || 0), 0),
    players,
    updatedAt: new Date().toISOString(),
  };
}

export async function getDraft(env) {
  return cached(env, `draft-live:${env.ESPN_YEAR}`, DRAFT_MAX_AGE, () => buildDraft(env));
}
