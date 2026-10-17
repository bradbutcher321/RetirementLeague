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
 * A manager's projected total also moves with no play behind it -- a lineup
 * change, injury news, ESPN revising a projection -- and those get a row of
 * their own (kind 'proj', migration 010) saying what moved it, so the play
 * that happens to come next isn't blamed for them.
 *
 * GET /feed[?week=N][&since=ID][&big=1] -> { season, week, events: [...] },
 *   oldest first, only rows after `since` (the page polls for the new ones),
 *   only changes of more than 3 points either way with big=1 (the
 *   dashboard's Flow captions). Defaults to the latest week recorded, never
 *   past `maxWeek` (the live week). A projection note comes as
 *   { k: 'p', n: headline, d: points moved, nt: [{ t, a }] }.
 */

/** Words for ESPN's injury report, in a note. */
const INJURY = { OUT: "Out", QUESTIONABLE: "Questionable", DOUBTFUL: "Doubtful", PROBABLE: "Probable",
  SUSPENSION: "Suspended", INJURY_RESERVE: "IR", DAY_TO_DAY: "Day-to-day" };
const injuryWord = (s) => (s ? INJURY[s] || s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "Healthy");
const round2 = (v) => Math.round(v * 100) / 100;
const median = (values) => {
  const s = [...values].sort((a, b) => a - b), k = s.length >> 1;
  return s.length ? (s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2) : null;
};

// Until a starter's game is under way, his own projection is what he counts
// for in his team's total; after that his points and the clock take over.
const notStarted = (l) => l.gs !== "in" && l.gs !== "post";

/** Why one manager's projected total moved apart from any scoring play:
 * lineup moves, injury news and ESPN revising a projection, each with how
 * many points it moved the total. `before` and `after` are his starters'
 * lines (id -> line) in the last build and this one; `residual` is how far
 * his total moved beyond what his plays explain. Returns null when nothing
 * is worth a row (no lineup or injury news, and the revisions add up to
 * under a point). */
export function projectionNote(before, after, residual, hasLive) {
  // A build from before the lines carried projections can't be compared.
  for (const l of before.values()) if (typeof l.pj !== "number") return null;
  const parts = [];
  const tweaks = [];
  for (const [id, l] of after) {
    const p = before.get(id);
    if (!p) {
      parts.push({ k: "in", t: `Started ${l.n}`, a: notStarted(l) ? l.pj : 0 });
    } else if (notStarted(l) && notStarted(p)) {
      if ((l.inj || "") !== (p.inj || "")) {
        parts.push({ k: "inj", t: `${l.n}: ${injuryWord(p.inj)} → ${injuryWord(l.inj)}`, a: round2(l.pj - p.pj) });
      } else if (Math.abs(l.pj - p.pj) >= 0.5) {
        tweaks.push({ n: l.n, a: round2(l.pj - p.pj) });
      }
    }
  }
  for (const [id, p] of before) {
    if (!after.has(id) && notStarted(p)) parts.push({ k: "out", t: `Took ${p.n} out`, a: -p.pj });
  }
  if (tweaks.length) {
    const sum = round2(tweaks.reduce((s, x) => s + x.a, 0));
    const who = tweaks.length === 1 ? `${tweaks[0].n}’s projection`
      : tweaks.length === 2 ? `${tweaks[0].n}’s and ${tweaks[1].n}’s projections` : `${tweaks.length} projections`;
    parts.push({ k: "proj", t: `ESPN ${sum < 0 ? "lowered" : "raised"} ${who}`, a: sum });
  }
  // What is left is clock drain in a live game (not news) or something the
  // lines can't see; only a gap bigger than that drain is worth saying.
  const left = round2(residual - parts.reduce((s, x) => s + x.a, 0));
  if (Math.abs(left) >= (hasLive ? 2 : 0.5)) parts.push({ k: "other", t: "Other projection changes", a: left });
  const total = round2(parts.reduce((s, x) => s + x.a, 0));
  const news = parts.some((x) => x.k === "in" || x.k === "out" || x.k === "inj");
  if (!news && Math.abs(total) < 1) return null;
  const why = parts.some((x) => x.k === "in" || x.k === "out") ? "Lineup change" : news ? "Injury news" : "Projection update";
  return { why, parts, total };
}

/** Adds a row for every starter whose points differ from his last saved
 * row. `previous` is the cached build before this one, and the baseline:
 * with no earlier build of this week to compare against nothing is saved
 * (the very first build would otherwise log every starter's whole week as
 * one change), starters whose points it already had are skipped without
 * asking D1, and a starter with no saved row yet starts from its numbers
 * rather than from zero. The insert itself
 * re-reads the last saved row, so two builds racing each other can't save
 * the same change twice, and an older build finishing late can't save a
 * step backwards (its timestamp is behind the row already there).
 *
 * The projections on each row follow the rows in order: a team's projected
 * total after a note is its total before plus the note, and after a play is
 * its total before plus what that play moved it (about as far as it moved
 * the points), scaled so a manager's rows add up to the build's real change.
 * The median on a row is worked out the same way, from all twelve teams as
 * the rows so far leave them. */
export async function recordScoreEvents(env, previous, dashboard) {
  const lines = dashboard?.scoreLines;
  if (!lines?.length || dashboard.archived) return 0;
  const season = Number(env.ESPN_YEAR);
  const week = dashboard.week;
  const ts = Date.parse(dashboard.updatedAt) || Date.now();
  if (previous?.week !== week || !previous.scoreLines) return 0;
  const before = new Map(previous.scoreLines.map((l) => [l.id, l]));
  const changed = lines.filter((l) => l.id && (before.get(l.id)?.pts ?? 0) !== l.pts);

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
  const byManager = (arr) => {
    const out = new Map();
    for (const l of arr) {
      if (!out.has(l.m)) out.set(l.m, new Map());
      out.get(l.m).set(l.id, l);
    }
    return out;
  };
  const prevBy = byManager(previous.scoreLines), curBy = byManager(lines);
  const plays = new Map();
  for (const l of changed) {
    if (!plays.has(l.m)) plays.set(l.m, []);
    plays.get(l.m).push({ l, d: round2(l.pts - (before.get(l.id)?.pts ?? 0)) });
  }

  const playSql = `INSERT INTO score_events
      (season, week, ts, player_id, manager, player, pos, prev, total, delta, stats, prev_stats, team, opp, period, clock,
       proj_prev, proj, opp_manager, opp_proj, median_prev, median)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(l.total, ?14), ?8, ROUND(?8 - COALESCE(l.total, ?14), 2), ?9, COALESCE(l.stats, ?15), ?10, ?11, ?12, ?13,
      ?16, ?17, ?18, ?19, ?20, ?21
    FROM (SELECT 1) AS one
    LEFT JOIN (SELECT total, stats, ts FROM score_events WHERE season = ?1 AND week = ?2 AND player_id = ?4 ORDER BY id DESC LIMIT 1) AS l ON 1
    WHERE COALESCE(l.total, ?14) <> ?8 AND (l.ts IS NULL OR l.ts < ?3)`;
  // A note has no earlier row of its own to check, so two builds seeing the
  // same news are told apart by what it says and when.
  const noteSql = `INSERT INTO score_events
      (season, week, ts, player_id, manager, player, pos, prev, total, delta, stats, kind, note,
       proj_prev, proj, opp_manager, opp_proj, median_prev, median)
    SELECT ?1, ?2, ?3, 0, ?4, ?5, '', 0, 0, ?6, '{}', 'proj', ?7, ?8, ?9, ?10, ?11, ?12, ?13
    WHERE NOT EXISTS (SELECT 1 FROM score_events WHERE season = ?1 AND week = ?2 AND kind = 'proj'
      AND manager = ?4 AND note = ?7 AND ABS(ts - ?3) < 90000)`;
  const playStmt = env.HISTORY_DB.prepare(playSql), noteStmt = env.HISTORY_DB.prepare(noteSql);

  const running = new Map(was); // each team's projection as the rows so far leave it
  const medianNow = () => (regular ? num(median([...running.values()].filter((v) => typeof v === "number"))) : null);
  const stmts = [];
  for (const m of curBy.keys()) {
    const start = was.get(m), end = now.get(m);
    const mine = plays.get(m) || [];
    const opp = oppOf.get(m) || null;
    const known = typeof start === "number" && typeof end === "number";
    const sumD = mine.reduce((s, x) => s + x.d, 0);
    const mLines = curBy.get(m);
    const hasLive = [...mLines.values()].some((l) => l.gs === "in");
    const note = known && prevBy.has(m) ? projectionNote(prevBy.get(m), mLines, round2(end - start - sumD), hasLive) : null;
    // A note moves the total first; what is left of the build's change is the plays'.
    let at = known ? start : null;
    if (note) {
      const to = round2(at + note.total), medianWas = medianNow();
      running.set(m, to);
      stmts.push(noteStmt.bind(season, week, ts, m, note.why, note.total,
        JSON.stringify(note.parts.map((x) => ({ t: x.t, a: x.a }))),
        at, to, opp, opp ? num(running.get(opp)) : null, medianWas, medianNow()));
      at = to;
    }
    if (!mine.length) continue;
    const ratio = at !== null && Math.abs(sumD) >= 1 ? (end - at) / sumD : null;
    const scale = ratio !== null && ratio > 0.5 && ratio < 1.5 ? ratio : 1;
    for (const { l, d } of mine) {
      const last = before.get(l.id);
      const to = at === null ? null : round2(at + d * scale), medianWas = medianNow();
      if (to !== null) running.set(m, to);
      stmts.push(playStmt.bind(season, week, ts, l.id, l.m, l.n, l.pos, l.pts, JSON.stringify(l.s), l.tm, l.op, l.q, l.clk,
        last?.pts ?? 0, JSON.stringify(last?.s || {}),
        at, to, opp, opp ? num(running.get(opp)) : null, medianWas, medianNow()));
      at = to;
    }
  }
  if (!stmts.length) return 0;
  await env.HISTORY_DB.batch(stmts);
  return stmts.length;
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
  // A game not started yet is only a kickoff time and whose starters are in
  // it on the page (the "Later" tile counts them, for a matchup too), so it
  // travels as that: one manager per starter.
  const list = [...games.values()].map((g) => (g.state === "pre" ? { key: g.key, ko: g.ko, state: "pre", ms: g.players.map((p) => p.m) } : g));
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
            proj_prev, proj, opp_manager, opp_proj, median_prev, median, kind, note
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
      // A projection note: `n` is its headline, `d` the points it moved the
      // projection, `nt` each reason with its share.
      ...(r.kind === "proj" ? { k: "p", nt: JSON.parse(r.note || "[]") } : {}),
    })),
  };
}
