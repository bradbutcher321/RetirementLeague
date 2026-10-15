/**
 * Projected median over the week, for Median Watch's chart.
 *
 * ESPN only ever reports the projection as it stands right now, so the
 * history has to be kept here: the scheduled run (every 10 minutes during
 * game windows, hourly otherwise -- see wrangler.toml) saves one row per run
 * to HISTORY_DB.median_snapshots (database/migrations/006_median_snapshots.sql).
 *
 * GET /median-history[?week=N] -> { season, week, points: [{ t, pm, cm, live, p }] }
 *   t: unix seconds, pm/cm: projected/current median, live: starters in play,
 *   p: { manager: projected total }, c: { manager: current total } (absent on
 *   snapshots from before it was kept). Defaults to the latest week recorded.
 */

const round2 = (n) => Math.round(n * 100) / 100;

export async function recordMedianSnapshot(env, dashboard) {
  if (!dashboard || !dashboard.week || !(dashboard.teams || []).length) return false;
  const season = Number(env.ESPN_YEAR);
  const week = dashboard.week;
  const teams = {}, current = {};
  let live = 0;
  for (const t of dashboard.teams) {
    teams[t.manager || t.name] = round2(t.projected || 0);
    current[t.manager || t.name] = round2(t.current || 0);
    live += t.inPlay || 0;
  }
  const teamsJson = JSON.stringify(teams);
  const currentJson = JSON.stringify(current);

  // Overnight and midweek runs see the same numbers hour after hour; one
  // row says it as well as ten. The live count is compared too, or the
  // last game ending with no score change goes unrecorded and the chart
  // thinks games ran all night.
  const last = await env.HISTORY_DB.prepare(
    "SELECT projected_median, current_median, live, teams, current_teams FROM median_snapshots WHERE season = ? AND week = ? ORDER BY ts DESC LIMIT 1"
  ).bind(season, week).first();
  if (last && last.teams === teamsJson && last.current_teams === currentJson && last.projected_median === dashboard.projectedMedian
      && last.current_median === dashboard.currentMedian && last.live === live) return false;

  await env.HISTORY_DB.prepare(
    "INSERT OR REPLACE INTO median_snapshots (season, week, ts, projected_median, current_median, live, teams, current_teams) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(season, week, Math.floor(Date.now() / 1000), dashboard.projectedMedian, dashboard.currentMedian, live, teamsJson, currentJson).run();
  return true;
}

export async function getMedianHistory(env, url) {
  const season = Number(env.ESPN_YEAR);
  let week = Number(url.searchParams.get("week")) || null;
  if (!week) {
    const row = await env.HISTORY_DB.prepare(
      "SELECT MAX(week) AS week FROM median_snapshots WHERE season = ?"
    ).bind(season).first();
    week = row && row.week;
  }
  if (!week) return { season, week: null, points: [] };
  const { results } = await env.HISTORY_DB.prepare(
    "SELECT ts, projected_median, current_median, live, teams, current_teams FROM median_snapshots WHERE season = ? AND week = ? ORDER BY ts"
  ).bind(season, week).all();
  return {
    season,
    week,
    points: results.map((r) => ({
      t: r.ts,
      pm: r.projected_median,
      cm: r.current_median,
      live: r.live,
      p: JSON.parse(r.teams),
      ...(r.current_teams ? { c: JSON.parse(r.current_teams) } : {}),
    })),
  };
}
