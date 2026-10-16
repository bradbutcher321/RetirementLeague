/**
 * The dashboard's Feed (site audit III #7): every change to a starter's
 * fantasy points this week, as it happened.
 *
 * ESPN reports each player's points only as they stand now, so the history
 * is kept here: each live dashboard build (every 15 seconds while someone
 * has the dashboard open, every minute from the cron during games -- see
 * index.js) compares every starter with the last row saved for him and adds
 * a row to HISTORY_DB.score_events (database/migrations/007_score_events.sql)
 * when his points moved. Two plays inside one build's gap arrive as one
 * change. Each row also keeps what the change did to the matchup: the
 * manager's projected total before and after, the opponent's after, and
 * the projected median before and after (regular season only).
 *
 * GET /feed[?week=N][&since=ID][&big=1] -> { season, week, events: [...] },
 *   oldest first, only rows after `since` (the page polls for the new ones),
 *   only changes of more than 3 points either way with big=1 (the
 *   dashboard's Flow captions). Defaults to the latest week recorded, never
 *   past `maxWeek` (the live week).
 */

/** Adds a row for every starter whose points differ from his last saved
 * row. `previous` is the cached build before this one, and the baseline:
 * with no earlier build of this week to compare against nothing is saved
 * (the very first build would otherwise log every starter's whole week as
 * one change), starters whose points it already had are skipped without
 * asking D1, and a starter with no saved row yet starts from its numbers
 * rather than from zero. The insert itself
 * re-reads the last saved row, so two builds racing each other can't save
 * the same change twice, and an older build finishing late can't save a
 * step backwards (its timestamp is behind the row already there). */
export async function recordScoreEvents(env, previous, dashboard) {
  const lines = dashboard?.scoreLines;
  if (!lines?.length || dashboard.archived) return 0;
  const season = Number(env.ESPN_YEAR);
  const week = dashboard.week;
  const ts = Date.parse(dashboard.updatedAt) || Date.now();
  if (previous?.week !== week || !previous.scoreLines) return 0;
  const before = new Map(previous.scoreLines.map((l) => [l.id, l]));
  const changed = lines.filter((l) => l.id && (before.get(l.id)?.pts ?? 0) !== l.pts);
  if (!changed.length) return 0;

  // Projected totals by manager, this build and the one before it.
  const proj = (d) => new Map((d.teams || []).map((t) => [t.manager || t.name, t.projected]));
  const now = proj(dashboard), was = proj(previous);
  const oppOf = new Map();
  for (const m of dashboard.matchups || []) {
    oppOf.set(m.awayManager, m.homeManager);
    oppOf.set(m.homeManager, m.awayManager);
  }
  const regular = !dashboard.regularSeasonWeeks || week <= dashboard.regularSeasonWeeks;
  const num = (v) => (typeof v === "number" ? v : null);

  const sql = `INSERT INTO score_events
      (season, week, ts, player_id, manager, player, pos, prev, total, delta, stats, prev_stats, team, opp, period, clock,
       proj_prev, proj, opp_manager, opp_proj, median_prev, median)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(l.total, ?14), ?8, ROUND(?8 - COALESCE(l.total, ?14), 2), ?9, COALESCE(l.stats, ?15), ?10, ?11, ?12, ?13,
      ?16, ?17, ?18, ?19, ?20, ?21
    FROM (SELECT 1) AS one
    LEFT JOIN (SELECT total, stats, ts FROM score_events WHERE season = ?1 AND week = ?2 AND player_id = ?4 ORDER BY id DESC LIMIT 1) AS l ON 1
    WHERE COALESCE(l.total, ?14) <> ?8 AND (l.ts IS NULL OR l.ts < ?3)`;
  const stmt = env.HISTORY_DB.prepare(sql);
  await env.HISTORY_DB.batch(changed.map((l) => {
    const last = before.get(l.id);
    const opp = oppOf.get(l.m) || null;
    return stmt.bind(season, week, ts, l.id, l.m, l.n, l.pos, l.pts, JSON.stringify(l.s), l.tm, l.op, l.q, l.clk,
      last?.pts ?? 0, JSON.stringify(last?.s || {}),
      num(was.get(l.m)), num(now.get(l.m)), opp, opp ? num(now.get(opp)) : null,
      regular ? num(previous.projectedMedian) : null, regular ? num(dashboard.projectedMedian) : null);
  }));
  return changed.length;
}

/** The Feed page's live board, from a dashboard build: each team's score
 * now and projected (the ticker), and every NFL game of the week that has a
 * league starter in it, with its score, clock, who has the ball and those
 * starters' points (Live now). Away team first in `teams` and `score`. */
export function feedBoard(dashboard) {
  if (!dashboard?.matchups) return null;
  const teams = (dashboard.teams || []).map((t) => ({ m: t.manager, cur: t.current, proj: t.projected }));
  const games = new Map();
  for (const mu of dashboard.matchups) {
    for (const [side, m] of [["away", mu.awayManager], ["home", mu.homeManager]]) {
      for (const p of mu[side + "Players"] || []) {
        const g = p.game;
        if (!g || !g.team) continue;
        const key = [g.team, g.opponent].sort().join("-");
        let x = games.get(key);
        if (!x) {
          const [a, h] = g.home ? [g.opponent, g.team] : [g.team, g.opponent];
          const [as, hs] = g.home ? [g.opponentScore, g.teamScore] : [g.teamScore, g.opponentScore];
          x = { key, ko: g.date, state: g.state, q: g.period, clk: g.clock, teams: [a, h], score: [as, hs], poss: null, players: [] };
          games.set(key, x);
        }
        if (g.hasPossession) x.poss = g.team;
        x.players.push({ n: p.name, m, tm: g.team, pts: p.livePoints ?? 0 });
      }
    }
  }
  // A game not started yet is only a kickoff time and a starter count on the
  // page (the "Later" tile), so it travels as that.
  const list = [...games.values()].map((g) => (g.state === "pre" ? { key: g.key, ko: g.ko, state: "pre", count: g.players.length } : g));
  return { teams, games: list };
}

export async function getFeed(env, url, maxWeek = 99) {
  const season = Number(env.ESPN_YEAR);
  let week = Number(url.searchParams.get("week")) || null;
  const since = Math.max(0, parseInt(url.searchParams.get("since"), 10) || 0);
  const big = url.searchParams.get("big") === "1" ? " AND ABS(delta) > 3" : "";
  if (!week) {
    const row = await env.HISTORY_DB.prepare("SELECT MAX(week) AS week FROM score_events WHERE season = ? AND week <= ?")
      .bind(season, maxWeek || 99).first();
    week = row && row.week;
  }
  if (!week) return { season, week: null, events: [] };
  const { results } = await env.HISTORY_DB.prepare(
    `SELECT id, ts, player_id, manager, player, pos, prev, total, delta, stats, prev_stats, team, opp, period, clock,
            proj_prev, proj, opp_manager, opp_proj, median_prev, median
     FROM score_events WHERE season = ? AND week = ? AND id > ?${big} ORDER BY id`
  ).bind(season, week, since).all();
  return {
    season,
    week,
    // Short keys: a whole Sunday is a thousand-odd rows.
    events: results.map((r) => ({
      id: r.id,
      t: r.ts,
      pid: r.player_id,
      m: r.manager,
      n: r.player,
      pos: r.pos,
      a: r.prev,
      b: r.total,
      d: r.delta,
      s: JSON.parse(r.stats || "{}"),
      ps: JSON.parse(r.prev_stats || "{}"),
      tm: r.team || "",
      op: r.opp || "",
      q: r.period || 0,
      clk: r.clock || "",
      // The matchup around the change: this manager's projection before
      // and after, the opponent and theirs, the median before and after.
      pa: r.proj_prev,
      pb: r.proj,
      om: r.opp_manager,
      oj: r.opp_proj,
      ma: r.median_prev,
      mb: r.median,
    })),
  };
}
