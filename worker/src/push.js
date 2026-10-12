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
 * POST /push/test        { endpoint }        -> one test notification to that row
 *
 * checkPushEvents() runs from the cron (index.js scheduled()) on the same
 * dashboard build as the median snapshot, and sends:
 *   final   your matchup is over (every starter on both sides has played)
 *   median  you're locked above the median (Median Watch's own rule)
 *   recap   every game this week is over, so Week in Review is up (everyone)
 *   parlay  your parlay leg hit or died
 * Each event is sent once: its key goes in push_sent the first time it is
 * seen, whether or not anyone was subscribed, so a new subscriber never
 * gets a backlog of things that already happened.
 */
import { sendPush } from "./webpush.js";

const PREF_KEYS = ["final", "median", "recap", "parlay"];
const SITE = "https://bradbutcher321.github.io/RetirementLeague/";
const f2 = (n) => (Number(n) || 0).toFixed(2);

function cleanPrefs(p) {
  const out = {};
  for (const k of PREF_KEYS) out[k] = !p || p[k] !== false;
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

export async function sendTest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.endpoint) return { status: 400, body: { error: "no endpoint" } };
  const sub = await env.DB.prepare("SELECT * FROM push_subs WHERE endpoint = ?1").bind(body.endpoint).first();
  if (!sub) return { status: 404, body: { error: "not subscribed" } };
  const status = await deliver(env, sub, {
    title: "Notifications are on",
    body: sub.me ? `You'll hear about ${sub.me}'s games here.` : "You'll hear when Week in Review is up.",
    url: "index.html",
    tag: "test",
  });
  const ok = status >= 200 && status < 300;
  return { status: ok ? 200 : 502, body: { ok, pushStatus: status } };
}

/** Sends, and forgets a subscription the push service says is gone. */
async function deliver(env, sub, message) {
  const status = await sendPush(env, sub, { ...message, url: SITE + (message.url || "") }).catch((err) => { console.error("Push send failed:", err && err.stack || err); return 0; });
  if (status === 404 || status === 410) {
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(sub.endpoint).run();
  }
  return status;
}

/** Every event the current dashboard and parlay data say has happened:
 * [{ key, to: manager name or null for everyone, pref, message }]. */
function currentEvents(year, dashboard, parlay) {
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
            title: `Week ${week} final: ${head} ${f2(mine)}â€“${f2(theirs)}`,
            body: `You ${verb} ${opp}${mine !== theirs ? ` by ${f2(Math.abs(mine - theirs))}` : ""}.`,
            url: "index.html",
            tag: `final-${week}`,
          },
        });
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
  }
  return out;
}

export async function checkPushEvents(env, dashboard) {
  if (!env.VAPID_PRIVATE_JWK || !dashboard || !dashboard.teams) return;
  const parlay = await env.COOLDOWN_KV.get("parlay_stats_v1", "json").catch(() => null);
  const events = currentEvents(env.ESPN_YEAR, dashboard, parlay);
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
  const fresh = events.filter((e) => !seen.has(e.key));
  if (!fresh.length) return;
  const now = Date.now();
  await env.DB.batch(fresh.map((e) => env.DB.prepare("INSERT OR IGNORE INTO push_sent (k, ts) VALUES (?1, ?2)").bind(e.key, now)));

  const { results: subs } = await env.DB.prepare("SELECT * FROM push_subs").all();
  if (!subs.length) return;
  const sends = [];
  for (const e of fresh) {
    for (const sub of subs) {
      const prefs = cleanPrefs(JSON.parse(sub.prefs || "{}"));
      if (!prefs[e.pref]) continue;
      if (e.to && (sub.me || "").toLowerCase() !== e.to.toLowerCase()) continue;
      sends.push(deliver(env, sub, e.message));
    }
  }
  await Promise.allSettled(sends);
}
