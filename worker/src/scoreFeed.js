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
 * change.
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

  const sql = `INSERT INTO score_events
      (season, week, ts, player_id, manager, player, pos, prev, total, delta, stats, prev_stats, team, opp, period, clock)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(l.total, ?14), ?8, ROUND(?8 - COALESCE(l.total, ?14), 2), ?9, COALESCE(l.stats, ?15), ?10, ?11, ?12, ?13
    FROM (SELECT 1) AS one
    LEFT JOIN (SELECT total, stats, ts FROM score_events WHERE season = ?1 AND week = ?2 AND player_id = ?4 ORDER BY id DESC LIMIT 1) AS l ON 1
    WHERE COALESCE(l.total, ?14) <> ?8 AND (l.ts IS NULL OR l.ts < ?3)`;
  const stmt = env.HISTORY_DB.prepare(sql);
  await env.HISTORY_DB.batch(changed.map((l) => {
    const was = before.get(l.id);
    return stmt.bind(season, week, ts, l.id, l.m, l.n, l.pos, l.pts, JSON.stringify(l.s), l.tm, l.op, l.q, l.clk,
      was?.pts ?? 0, JSON.stringify(was?.s || {}));
  }));
  return changed.length;
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
    `SELECT id, ts, player_id, manager, player, pos, prev, total, delta, stats, prev_stats, team, opp, period, clock
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
    })),
  };
}
