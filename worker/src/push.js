/**
 * Notifications for the Home Screen app (site audit II #37).
 *
 * The site's You sheet (nav.js) subscribes through the service worker and
 * posts the subscription here along with who the visitor is ("This is me",
 * #36) and which notifications they want. Rows live in the analytics D1
 * database (see schema.sql: push_subs, push_sent).
 *
 * POST /push/subscribe   { sub, me, prefs }  -> stores or updates the row
 * POST /push/unsubscribe { endpoint }        -> drops it
 *
 * checkPushEvents() runs from the cron (index.js scheduled()) on the same
 * dashboard build as the median snapshot, and sends:
 *   final   your matchup is over (every starter on both sides has played)
 *   median  you're locked above the median (Median Watch's own rule)
 *   lineup  a starter of yours is on bye, ruled out, or questionable with a
 *          0 projection, Thursday morning until the last kickoff (site audit
 *          III #6, the Lineup Check box on the dashboard); one message per
 *          run however many starters, each starter once per week
 *   recap   every game this week is over, so Week in Review is up (everyone)
 *   record  a Game Records record was set or broken, good or bad -- a team
 *          score, margin, combined points, a starter's game (everyone; site
 *          audit III #14, the Record Watch box on the dashboard)
 *   parlay  your parlay leg hit or died
 *   rival   your Daddy / your Bitch (docs/rivals.js: who beats you most, who
 *          you beat most): the morning of the week's first kickoff when you
 *          play one, once when they pull 10 points ahead of you, and the
 *          final (which stands in for the plain "matchup is final")
 *   parlayAll  every leg that hits while the parlay is alive, then one
 *          "killed" when it dies (killed_by in the parlay data); legs
 *          whose games start after the kill send nothing
 * Each event is sent once: its key goes in push_sent the first time it is
 * seen, whether or not anyone was subscribed, so a new subscriber never
 * gets a backlog of things that already happened.
 */
import { sendPush } from "./webpush.js";
// The records rules, shared with the dashboard (docs/record-watch.js).
import RecordWatch from "../../docs/record-watch.js";
// The lineup rules and their Thursday-to-Monday window (docs/lineup-check.js).
import LineupCheck from "../../docs/lineup-check.js";
// Who beats you most / who you beat most, shared with the standings tags and the tap-a-name sheet.
import Rivals from "../../docs/rivals.js";

const PREF_KEYS = ["final", "median", "lineup", "rival", "recap", "record", "parlay", "parlayAll", "health"];
// Off unless asked for: everyone else's legs is a lot of buzzing, and it
// came after people had already subscribed with the four above on. "health"
// is the commissioner's daily site check (healthCheck.js). "rival" is new
// and stands in for the plain final alert on a rival game, so it waits to be asked.
const PREF_OFF_BY_DEFAULT = new Set(["parlayAll", "health", "rival"]);
const SITE = "https://bradbutcher321.github.io/RetirementLeague/";
const f2 = (n) => (Number(n) || 0).toFixed(2);

function cleanPrefs(p) {
  const out = {};
  for (const k of PREF_KEYS) out[k] = PREF_OFF_BY_DEFAULT.has(k) ? !!(p && p[k] === true) : !p || p[k] !== false;
  return out;
}

export async function subscribe(request, env) {
  const body = await request.json().catch(() => null);
  const sub = body && body.sub;
  const endpoint = sub && sub.endpoint;
  const keys = sub && sub.keys;
  if (!endpoint || !/^https:\/\//.test(endpoint) || !keys || !keys.p256dh || !keys.auth) {
    return { status: 400, body: { error: "bad subscription" } };
  }
  const me = typeof body.me === "string" ? body.me.slice(0, 40) : "";
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, p256dh, auth, me, prefs, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, me = ?4, prefs = ?5, updated = ?6`
  ).bind(endpoint, keys.p256dh, keys.auth, me, JSON.stringify(cleanPrefs(body.prefs)), now).run();
  return { status: 200, body: { ok: true } };
}

export async function unsubscribe(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.endpoint) return { status: 400, body: { error: "no endpoint" } };
  await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(body.endpoint).run();
  return { status: 200, body: { ok: true } };
}

/** Sends, and forgets a subscription the push service says is gone. */
async function deliver(env, sub, message) {
  const status = await sendPush(env, sub, { ...message, url: SITE + (message.url || "") }).catch((err) => { console.error("Push send failed:", err && err.stack || err); return 0; });
  if (status === 404 || status === 410) {
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(sub.endpoint).run();
  }
  return status;
}

// The history Record Watch ranks live games against, from the site's own
// data files (league.json rows are [year, week, type, p1, p2, s1, s2, winner,
// ...]; data/lineups/records.json for the player records). Kept for ten
// minutes, the cron's pace; null when league.json can't be read, which just
// skips the alerts.
let recordCache = { at: 0, value: null };
// league.json as rows, shared by the records and the rivals; kept ten minutes.
let leagueCache = { at: 0, rows: null };
async function leagueRows() {
  if (leagueCache.rows && Date.now() - leagueCache.at < 10 * 60 * 1000) return leagueCache.rows;
  const res = await fetch(SITE + "data/league.json");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const { games } = await res.json();
  leagueCache = { at: Date.now(), rows: games.map((g) => ({ year: g[0], week: g[1], type: g[2], p1: g[3], p2: g[4], s1: g[5], s2: g[6], winner: g[7] })) };
  return leagueCache.rows;
}
// The head-to-head book for the Rival alerts: this season's managers are the
// ones on the live dashboard. null when league.json can't be read.
let rivalCache = { at: 0, book: null };
async function rivalBook(dashboard) {
  try {
    const rows = await leagueRows();
    if (!rivalCache.book || rivalCache.at !== leagueCache.at) {
      rivalCache = { at: leagueCache.at, book: Rivals.build(rows, (dashboard.teams || []).map((t) => t.manager).filter(Boolean)) };
    }
    return rivalCache.book;
  } catch (err) {
    console.error("Rival check couldn't read league.json:", err && err.stack || err);
    return null;
  }
}
async function recordBook() {
  if (Date.now() - recordCache.at < 10 * 60 * 1000) return recordCache.value;
  try {
    const rows = await leagueRows();
    const players = await fetch(SITE + "data/lineups/records.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    recordCache = { at: Date.now(), value: RecordWatch.build(rows, players) };
  } catch (err) {
    console.error("Record check couldn't read league.json:", err && err.stack || err);
    recordCache = { at: Date.now() - 9 * 60 * 1000, value: null }; // try again in a minute
  }
  return recordCache.value;
}

/** Every event the current dashboard and parlay data say has happened:
 * [{ key, to: manager name or null for everyone, pref, message }]. */
function currentEvents(year, dashboard, parlay, book, rivals) {
  const out = [];
  const week = dashboard.week;
  const teams = dashboard.teams || [];
  const known = Boolean(dashboard.medianStatusKnown);
  const done = (t) => !(t.remaining || 0) && !(t.inPlay || 0);
  const scored = teams.some((t) => (t.current || 0) > 0);
  const weekOver = known && scored && teams.every(done);

  if (known && scored) {
    for (const m of dashboard.matchups || []) {
      if (m.awayRemaining || m.awayInPlay || m.homeRemaining || m.homeInPlay) continue;
      const sides = [
        [m.awayManager, m.awayScore, m.homeManager, m.homeScore],
        [m.homeManager, m.homeScore, m.awayManager, m.awayScore],
      ];
      for (const [me, mine, opp, theirs] of sides) {
        if (!me) continue;
        const verb = mine > theirs ? "beat" : mine < theirs ? "lost to" : "tied";
        const head = mine > theirs ? "W" : mine < theirs ? "L" : "T";
        out.push({
          key: `final:${year}:${week}:${me}`,
          to: me,
          pref: "final",
          message: {
            title: `Week ${week} final: ${head} ${f2(mine)}–${f2(theirs)}`,
            body: `You ${verb} ${opp}${mine !== theirs ? ` by ${f2(Math.abs(mine - theirs))}` : ""}.`,
            url: "index.html",
            tag: `final-${week}`,
          },
        });
      }
    }
  }

  // Your Daddy and Your Bitch (docs/rivals.js). Only the games between you
  // and one of them; the record each message quotes is from before this week
  // (league.json can be a week behind, so the live game is added by hand).
  if (rivals) {
    const wk = { year: Number(year), week };
    const kickoff = Date.parse(dashboard.firstKickoff);
    const morning = Number.isFinite(kickoff) && Date.now() >= kickoff - 12 * 3600 * 1000;
    for (const m of dashboard.matchups || []) {
      const over = !(m.awayRemaining || m.awayInPlay || m.homeRemaining || m.homeInPlay);
      for (const [me, mine, opp, theirs] of [
        [m.awayManager, m.awayScore, m.homeManager, m.homeScore],
        [m.homeManager, m.homeScore, m.awayManager, m.awayScore],
      ]) {
        const k = me && opp && rivals.kind(me, opp);
        if (!k) continue;
        const label = Rivals.LABEL[k];
        const r = rivals.rec(me, opp, wk);
        const said = r ? `You're ${r.w}\u2013${r.l} against ${opp} all-time and have ${Rivals.word(r)}.` : `You haven't played ${opp} before.`;
        if (morning) {
          out.push({
            key: `rival:play:${year}:${week}:${me}`,
            to: me,
            pref: "rival",
            message: {
              title: k === "daddy" ? `Revenge game vs ${label}` : `${label} is up next`,
              body: `${opp} this week. ${said}`,
              url: "index.html",
              tag: `rival-${week}`,
            },
          });
        }
        if (known && scored && !over && theirs - mine >= 10 && theirs >= 40) {
          out.push({
            key: `rival:lead:${year}:${week}:${me}`,
            to: me,
            pref: "rival",
            message: {
              title: `${label} is up on you`,
              body: `${opp} leads ${f2(theirs)}\u2013${f2(mine)}. ${said}`,
              url: "index.html",
              tag: `rival-${week}`,
            },
          });
        }
        if (known && scored && over) {
          const w = (r ? r.w : 0) + (mine > theirs ? 1 : 0), l = (r ? r.l : 0) + (mine < theirs ? 1 : 0);
          out.push({
            key: `rival:final:${year}:${week}:${me}`,
            to: me,
            pref: "rival",
            replaces: `final:${year}:${week}:${me}`,
            message: {
              title: mine > theirs ? `You beat ${label}` : mine < theirs ? `${label} beat you` : `You tied ${label}`,
              body: `Week ${week} final: ${f2(mine)}\u2013${f2(theirs)}. You're now ${w}\u2013${l} against ${opp} all-time.`,
              url: "index.html",
              tag: `final-${week}`,
            },
          });
        }
      }
    }
  }

  // Median Watch's lock: at least half the league is finished and below
  // your current score, so nobody left can pass you. Not sent once the
  // whole week is over, when Week in Review says it instead.
  if (known && !weekOver) {
    const half = Math.floor(teams.length / 2);
    const finished = teams.filter(done).map((t) => t.current || 0).sort((a, b) => a - b);
    if (finished.length >= half && half > 0) {
      const line = finished[half - 1];
      for (const t of teams) {
        if (!t.manager || !((t.current || 0) > line)) continue;
        out.push({
          key: `median:${year}:${week}:${t.manager}`,
          to: t.manager,
          pref: "median",
          message: {
            title: "Median win clinched",
            body: `${f2(t.current)} is safe in the top half for Week ${week}: that's a win.`,
            url: "index.html",
            tag: `median-${week}`,
          },
        });
      }
    }
  }

  // A starter who can't score (the Lineup Check box, lineup-check.js). One
  // event per starter per week, so he is told about once; `merge` lets
  // checkPushEvents fold the new ones for a manager into a single message.
  const LINEUP_SAY = { bye: "is on bye", out: "is out", zero: "is questionable and projected at 0" };
  for (const m of dashboard.matchups || []) {
    for (const [me, players] of [[m.awayManager, m.awayPlayers], [m.homeManager, m.homePlayers]]) {
      if (!me) continue;
      for (const { player, kind } of LineupCheck.problems(players, dashboard, Date.now())) {
        out.push({
          key: `lineup:${year}:${week}:${me}:${player.id || player.name}`,
          to: me,
          pref: "lineup",
          merge: `lineup:${year}:${week}:${me}`,
          message: {
            title: `Lineup check, Week ${week}`,
            body: `${player.name} (${player.slot}) ${LINEUP_SAY[kind]}.`,
            url: "index.html",
            tag: `lineup-${week}`,
          },
        });
      }
    }
  }

  // A record the games have just set or broken, good or bad (the Record Watch
  // box on the dashboard, record-watch.js). Each is sent once: the key names
  // the record and who, and the box can't flip back because a record that is
  // only "beaten" while games are live is one a score can't slip back from.
  if (book && known && scored) {
    
    for (const m of dashboard.matchups || []) {
      const game = RecordWatch.fromMatchup(m, year, week, known);
      for (const it of RecordWatch.evaluate(book, game)) {
        if (!it.achieved || it.rank !== 1) continue;
        out.push({
          key: `record:${year}:${week}:${it.key}`,
          to: null,
          pref: "record",
          message: {
            title: it.title,
            body: `${RecordWatch.plain(it)}. ${it.sub}.`,
            url: "index.html",
            tag: `record-${year}-${week}-${it.key}`,
          },
        });
      }
    }
  }

  if (weekOver) {
    const ranked = teams.slice().sort((a, b) => (b.current || 0) - (a.current || 0));
    const top = ranked[0], low = ranked[ranked.length - 1];
    out.push({
      key: `recap:${year}:${week}`,
      to: null,
      pref: "recap",
      message: {
        title: `Week ${week} in Review is up`,
        body: `Top score ${top.manager} ${f2(top.current)}. Sacko ${low.manager} ${f2(low.current)}.`,
        url: "index.html",
        tag: `recap-${week}`,
      },
    });
  }

  const pw = parlay && parlay.weeks && parlay.weeks[parlay.weeks.length - 1];
  if (pw && pw.picks) {
    for (const [name, p] of Object.entries(pw.picks)) {
      if (p.result !== "Win" && p.result !== "Loss") continue;
      const hit = p.result === "Win";
      out.push({
        key: `parlay:${pw.year}:${pw.week}:${name}`,
        to: name,
        pref: "parlay",
        message: {
          title: hit ? "Your parlay leg hit" : "Your parlay leg died",
          body: String(p.pick || ""),
          url: "parlay-results.html",
          tag: `parlay-${pw.year}-${pw.week}`,
        },
      });
    }

    // Everyone's legs until the parlay dies. The kill is the first loss by
    // game time (the publisher's killed_by); a hit only counts if its game
    // started before the killing game did, so a late hit graded in the same
    // refresh as the kill stays quiet.
    const killers = (pw.killed_by || []).filter((n) => pw.picks[n] && pw.picks[n].result === "Loss");
    const killedAt = killers.length ? killers.map((n) => String(pw.picks[n].gametime || "")).sort()[0] : null;
    for (const [name, p] of Object.entries(pw.picks)) {
      if (p.result !== "Win") continue;
      if (killedAt !== null && !(String(p.gametime || "") < killedAt)) continue;
      // Legs in as of this one: hits whose games started no later than it.
      const hits = Object.values(pw.picks).filter((q) => q.result === "Win" && String(q.gametime || "") <= String(p.gametime || "")).length;
      out.push({
        key: `parlayall:${pw.year}:${pw.week}:${name}`,
        to: null,
        about: name,
        pref: "parlayAll",
        message: {
          title: `${name}'s leg hit`,
          body: `${String(p.pick || "")} · ${hits} of ${Object.keys(pw.picks).length} in`,
          url: "parlay-results.html",
          tag: `parlayall-${pw.year}-${pw.week}-${name}`,
        },
      });
    }
    if (killers.length) {
      const who = killers.join(" & ");
      out.push({
        key: `parlaykill:${pw.year}:${pw.week}`,
        to: null,
        pref: "parlayAll",
        message: {
          title: `${who} killed the parlay`,
          body: killers.map((n) => String(pw.picks[n].pick || "")).join(" · "),
          url: "parlay-results.html",
          tag: `parlayall-${pw.year}-${pw.week}-kill`,
        },
      });
    }
  }
  return out;
}

/** Events that share a `merge` become one: the first, with every body in
 * order (a manager with two starters out gets one message, not two). */
function mergeEvents(events) {
  const groups = new Map();
  const out = [];
  for (const e of events) {
    const first = e.merge && groups.get(e.merge);
    if (first) first.message = { ...first.message, body: `${first.message.body} ${e.message.body}` };
    else {
      const copy = { ...e, message: { ...e.message } };
      if (e.merge) groups.set(e.merge, copy);
      out.push(copy);
    }
  }
  return out;
}

export async function checkPushEvents(env, dashboard) {
  if (!env.VAPID_PRIVATE_JWK || !dashboard || !dashboard.teams) return;
  const parlay = await env.COOLDOWN_KV.get("parlay_stats_v1", "json").catch(() => null);
  const events = currentEvents(env.ESPN_YEAR, dashboard, parlay, await recordBook(), await rivalBook(dashboard));
  if (!events.length) return;

  // Only the ones not seen before. The batch's INSERT OR IGNORE makes a
  // second overlapping cron run see them as already sent.
  const keys = events.map((e) => e.key);
  const seen = new Set();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT k FROM push_sent WHERE k IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const r of results) seen.add(r.k);
  }
  const newEvents = events.filter((e) => !seen.has(e.key));
  if (!newEvents.length) return;
  const now = Date.now();
  await env.DB.batch(newEvents.map((e) => env.DB.prepare("INSERT OR IGNORE INTO push_sent (k, ts) VALUES (?1, ?2)").bind(e.key, now)));
  const fresh = mergeEvents(newEvents);

  const { results: subs } = await env.DB.prepare("SELECT * FROM push_subs").all();
  if (!subs.length) return;
  const sends = [];
  // A rival game's result replaces the plain "matchup is final" for anyone
  // with Rivals on, so they get one message about it, not two.
  const replaced = new Set(fresh.filter((e) => e.replaces).map((e) => e.replaces));
  for (const e of fresh) {
    for (const sub of subs) {
      const prefs = cleanPrefs(JSON.parse(sub.prefs || "{}"));
      if (!prefs[e.pref]) continue;
      if (replaced.has(e.key) && prefs.rival) continue;
      if (e.to && (sub.me || "").toLowerCase() !== e.to.toLowerCase()) continue;
      // Your own leg already comes from "parlay" when that's on.
      if (e.about && prefs.parlay && (sub.me || "").toLowerCase() === e.about.toLowerCase()) continue;
      sends.push(deliver(env, sub, e.message));
    }
  }
  await Promise.allSettled(sends);
}

/** Sends one message to every subscriber with `pref` on (no per-manager
 * targeting, no once-only key: the caller decides when to call). */
export async function notifyPref(env, pref, message) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const { results: subs } = await env.DB.prepare("SELECT * FROM push_subs").all();
  await Promise.allSettled(subs.filter((s) => cleanPrefs(JSON.parse(s.prefs || "{}"))[pref]).map((s) => deliver(env, s, message)));
}

/** The Commissioner page's own message: to everyone who has a subscription,
 * or just one manager's devices (`to`, a name). Ignores each person's
 * notification choices on purpose: it is the commissioner talking.
 * -> { sent, gone, devices } */
export async function broadcast(env, message, to = null) {
  if (!env.VAPID_PRIVATE_JWK) return { error: "not_configured" };
  const { results } = await env.DB.prepare("SELECT * FROM push_subs").all();
  const subs = to ? results.filter((s) => (s.me || "").toLowerCase() === String(to).toLowerCase()) : results;
  const codes = await Promise.all(subs.map((s) => deliver(env, s, { ...message, tag: message.tag || "commissioner" })));
  return { devices: subs.length, sent: codes.filter((c) => c >= 200 && c < 300).length, gone: codes.filter((c) => c === 404 || c === 410).length };
}

/** Who has the app's notifications on: [{ me, devices, health }] by manager. */
export async function subscriberSummary(env) {
  const { results } = await env.DB.prepare("SELECT me, prefs FROM push_subs").all();
  const by = new Map();
  for (const r of results) {
    const key = r.me || "";
    const row = by.get(key) || { me: key, devices: 0, health: false };
    row.devices++;
    if (cleanPrefs(JSON.parse(r.prefs || "{}")).health) row.health = true;
    by.set(key, row);
  }
  return [...by.values()];
}
