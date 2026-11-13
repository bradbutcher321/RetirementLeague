/**
 * Secret Santa (docs/secret-santa.html), from sign-ups to Unwrap night.
 *
 * 1. Sign-ups, Nov 1 to Nov 12 Eastern (the card closes at 12 AM Nov 13).
 *    Each signed-in manager fills in one card: where to ship a shirt if the
 *    in-person event can't happen, their shirt size, the colors they prefer,
 *    and the December days they could meet up. Brad and Jon (any
 *    commissioner) can save outside that window so they can try the page.
 * 2. The draw: the first read after sign-ups close puts everyone with a card
 *    in one shuffled loop (each gives to the next, the last to the first).
 *    It's kept in site_settings (santa_draw) and is never sent whole until
 *    the commissioners unmask it on Unwrap night.
 * 3. Reveal night, Fri Nov 13 at 9:00 PM: the Room. Everyone in the draw
 *    sends a heartbeat. Once they're all here a commissioner presses Start
 *    (10 seconds out, so every phone counts down together); from 9:30 a
 *    commissioner can start it with whoever is here. Once it has started,
 *    everyone gets their own giftee; anyone who missed it opens theirs alone.
 *    Reveal day has its own pushes (checkSantaHype): noon, 8:00, the 8:45
 *    reminder, 9:00, then "X just walked into the Room" to anyone not there.
 *    The reaction cam's photo (taken on the phone as the name lands) is
 *    kept here, seen only by its owner until the unmask.
 * 4. Gifting: each Santa's shortlist (the big board, up to three shirts), and
 *    the gift itself, step by step: picked, ordered, shipped, delivered,
 *    wrapped (santa_gifts). Everyone sees how far each Santa has gotten (the
 *    sleigh race), never who they're buying for; the last place is roasted
 *    in a push on Monday and Thursday evenings. Plus an anonymous mailbox
 *    between each Santa and giftee, and a guess at who your Santa is.
 * 5. Unwrap night: a commissioner unmasks, and the whole loop, every shirt,
 *    every guess and the photos go out to everyone. Then the Shirtys: three
 *    awards voted on phones, two the site works out; a commissioner seals
 *    each envelope. The year's loop, haul and winners are kept for good
 *    (site_settings santa_hof, GET /santa/hof) for League History and the
 *    Franchise page.
 *
 * GET  /santa                Authorization optional; see status() for the shape.
 * POST /santa                your card (sign-ups)
 * POST /santa/nudge          { manager, kind: "signup" | "buy" | "room" }
 * POST /santa/remind         { on }  the 15-minute reminder
 * POST /santa/room           { holding?, react?, say?, after? }  the Room's heartbeat
 * POST /santa/opened         { inRoom }  you watched your envelope open
 * POST /santa/gift           { shirt, title, url, size, ordered, shipped, eta, delivered, wrapped } or { clear: true }
 * POST /santa/board          { board: [shirt, ...] }  up to three
 * POST /santa/msg            { to: "giftee" | "santa", text }
 * POST /santa/guess          { guess }  (null clears it)
 * GET  /santa/photo?m=Name   a reaction-cam photo (image/jpeg): yours any time, anyone's after the unmask
 * POST /santa/photo          { img: base64 JPEG } or { clear: true }
 * POST /santa/vote           { cat, pick }  a Shirty vote (pick = whose shirt, by giftee; null clears)
 * GET  /santa/hof            every year's loop, haul and Shirty winners (public)
 * POST /santa/admin          commissioners: { action: "dates" | "ship" | "draw" | "start" | "unmask" | "remind" | "shirty", ... }
 *
 * Tables are in schema.sql (analytics D1): santa_cards, santa_people,
 * santa_room, santa_events, santa_gifts, santa_msgs, santa_photos, santa_votes.
 */
import { sessionManager } from "./auth.js";
import { broadcast, subscriberSummary } from "./push.js";
import { getSetting, isCommissioner, logAction, setSetting } from "./roles.js";

export const SIZES = ["S", "M", "L", "XL", "2XL", "3XL"];
export const COLORS = ["Black", "White", "Navy", "Light Blue", "Light Pink", "Natural", "Sport Grey", "Yellow Haze", "Forest Green"];
const YEAR = 2026;
// Sign-ups open 12:00 AM Nov 1 EDT and close 12:00 AM Nov 13 EST (Nov 12 is the last day).
export const OPENS = Date.parse("2026-11-01T00:00:00-04:00");
export const CLOSES = Date.parse("2026-11-13T00:00:00-05:00");
// Reveal night: the Room opens at 9:00 PM ET Fri, Nov 13; a commissioner can start it from 9:30.
export const REVEAL = Date.parse("2026-11-13T21:00:00-05:00");
export const FORCE_AT = REVEAL + 30 * 60 * 1000;
const REMIND_AT = REVEAL - 15 * 60 * 1000;
// Reveal day's other pushes (checkSantaHype): noon and 8:00 PM Eastern.
const NOON = Date.parse("2026-11-13T12:00:00-05:00");
const EIGHT = Date.parse("2026-11-13T20:00:00-05:00");
const DECEMBER = /^2026-12-(0[1-9]|[12]\d|3[01])$/;
const DAY = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const NUDGE_SECONDS = 24 * 60 * 60;
const HERE_MS = 12 * 1000;      // a heartbeat this recent means you're in the Room
const HOLDING_MS = 3 * 1000;    // and this recent while holding the seal
const START_DELAY = 10 * 1000;  // the countdown every phone shows before the lights go down
const WALKIN_MS = 5 * 60 * 1000; // "X just walked in": at most one per person this often
const DROP_DELAY = 3500;        // once everyone is holding, every seal breaks this long after
// santa_room.holding is a set of bits: holding the seal, sound checked, reaction cam on, seal already broken.
const F_HOLD = 1, F_SND = 2, F_CAM = 4, F_OPEN = 8;
// The rehearsal Room (commissioners try reveal night ahead of time): its own
// start and break time, and its own seats ("rh:Brad"), so it never touches the real draw.
const space = (rh) => (rh ? { start: "santa_start_rh", drop: "santa_drop_rh", pre: "rh:" } : { start: "santa_start", drop: "santa_drop", pre: "" });
const EMOJI = ["🎁", "🔥", "😂", "👀", "🗑️"];
const SAY_MAX = 140;            // a typed line in the Room's chat
const SHIRTS = 957;             // docs/data/santa-shirts.json
const PHOTO_MAX = 700000;       // base64 characters (about 500 KB of JPEG)
// The gift's steps, as the sleigh race shows them (0 is "still at the North Pole").
const STAGES = ["Picked", "Ordered", "Shipped", "Delivered", "Wrapped"];
// The Shirtys. Voted awards go to the Santa who picked the shirt.
export const SHIRTYS = [
  { key: "best", label: "Best Shirt", vote: true },
  { key: "offensive", label: "Most Offensive", vote: true },
  { key: "fit", label: "Worst Fit", vote: true },
  { key: "detective", label: "Best Detective", vote: false },
  { key: "late", label: "Last-Minute Santa", vote: false },
  { key: "props", label: "Sharpest Card", vote: false },
];
// Santa props: picked before the Room starts, settled on Unwrap night. `who` props name a manager.
const PROPS = { off: "who", ou: "ou", late: "who", wrap: "who" };
const OU_LINE = 3.5;            // right guesses on Unwrap night: over or under
const RATES = ["🔥", "😂", "🗑️"]; // rating a shirt as it's unwrapped
const WALL_MAX = 200;
const SHIRTY = Object.fromEntries(SHIRTYS.map((c) => [c.key, c]));

const fail = (status, error) => ({ status, body: { error } });
const clip = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const day = (v) => (typeof v === "string" && DAY.test(v) ? v : null);
const mineRow = (r) => ({
  name: r.name, street: r.street, apt: r.apt || "", city: r.city, state: r.state, zip: r.zip,
  size: r.size, colors: JSON.parse(r.colors || "[]"), dates: JSON.parse(r.dates || "[]"), updated: r.updated,
});
const giftRow = (r) => r && ({ shirt: r.shirt, title: r.title || "", url: r.url || "", size: r.size || "", price: r.price, ordered: r.ordered, shipped: r.shipped || null, eta: r.eta, delivered: r.delivered, wrapped: r.wrapped || null, updated: r.updated });
/** How far a Santa has gotten: 0 (nothing yet) to 5 (wrapped). */
export const stageOf = (g) => (!g ? 0 : g.wrapped ? 5 : g.delivered ? 4 : g.shipped ? 3 : g.ordered ? 2 : g.shirt != null || g.title || g.url ? 1 : 0);
const nameList = (names) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`);
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } };

// ---------- The draw ----------
function shuffle(a) {
  const r = new Uint32Array(a.length);
  crypto.getRandomValues(r);
  for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** The draw, made on the first read after sign-ups close. INSERT OR IGNORE
 * keeps two readers at the same moment from drawing twice. */
async function ensureDraw(env, signed) {
  let draw = await getSetting(env, "santa_draw");
  if (draw || Date.now() < CLOSES || signed.length < 2) return draw;
  const value = { chain: shuffle([...signed]), at: Date.now() };
  await env.DB.prepare("INSERT OR IGNORE INTO site_settings (k, v, updated) VALUES ('santa_draw', ?1, ?2)").bind(JSON.stringify(value), value.at).run();
  return getSetting(env, "santa_draw");
}
const gifteeOf = (chain, n) => { const i = chain.indexOf(n); return i < 0 ? null : chain[(i + 1) % chain.length]; };
const santaOf = (chain, n) => { const i = chain.indexOf(n); return i < 0 ? null : chain[(i + chain.length - 1) % chain.length]; };

async function settings(env) {
  return { purchaseBy: null, eventAt: null, place: "", notes: "", ship: false, unmasked: null, host: null, shirtys: {}, ...(await getSetting(env, "santa", {})) };
}

/** Everything the page shows. Who's in, the day counts, the draw's date, the
 * Room, who opened, the sleigh race and the commissioners' dates are the same
 * for everyone. Your own card, your giftee (once the Room has started), your
 * board, gift, photo, mailbox and guess are only ever sent to you.
 * Commissioners also get a status row per manager, which never says who has
 * whom. */
async function status(request, env) {
  const now = Date.now();
  const me = await sessionManager(request, env).catch(() => null);
  const [rows, people, gifts, set, start, photos, votesRes, wallRes] = await Promise.all([
    env.DB.prepare("SELECT manager, name, street, apt, city, state, zip, size, colors, dates, updated FROM santa_cards").all(),
    env.DB.prepare("SELECT * FROM santa_people").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT * FROM santa_gifts").all().catch(() => ({ results: [] })),
    settings(env),
    getSetting(env, "santa_start"),
    env.DB.prepare("SELECT manager, at FROM santa_photos").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT voter, cat, pick FROM santa_votes").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT id, manager, emoji, at FROM santa_events WHERE kind = 'wall' ORDER BY id DESC LIMIT 40").all().catch(() => ({ results: [] })),
  ]);
  const allVotes = votesRes.results, wallRows = wallRes.results;
  const cards = Object.fromEntries(rows.results.map((r) => [r.manager, r]));
  const signed = rows.results.map((r) => r.manager);
  const draw = await ensureDraw(env, signed);
  const chain = draw ? draw.chain : [];
  const ppl = Object.fromEntries(people.results.map((r) => [r.manager, r]));
  const gift = Object.fromEntries(gifts.results.map((r) => [r.santa, r]));
  const photo = Object.fromEntries(photos.results.map((r) => [r.manager, r.at]));
  const dates = {};
  for (const r of rows.results) for (const d of JSON.parse(r.dates || "[]")) dates[d] = (dates[d] || 0) + 1;
  const started = start && now >= start.at ? start.at : null;

  // Been by today (Eastern), and today's visit for you.
  const etDay = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (me) await env.DB.prepare("INSERT INTO santa_people (manager, seen) VALUES (?1, ?2) ON CONFLICT(manager) DO UPDATE SET seen = excluded.seen").bind(me.manager, now).run().catch(() => {});
  const today = etDay(now);
  const seen = people.results.filter((r) => r.seen && etDay(r.seen) === today).map((r) => r.manager);
  if (me && !seen.includes(me.manager)) seen.push(me.manager);

  const body = {
    open: now >= OPENS && now < CLOSES, opens: OPENS, closes: CLOSES, reveal: REVEAL, forceAt: FORCE_AT,
    signed, dates, mine: me && cards[me.manager] ? mineRow(cards[me.manager]) : null,
    drawn: draw ? draw.at : null, crew: chain.length ? [...chain].sort() : null,
    start: start ? start.at : null, started, unmasked: set.unmasked, hosted: !!(set.host && set.unmasked),
    purchaseBy: set.purchaseBy, eventAt: set.eventAt, place: set.place || "", notes: set.notes || "", ship: !!set.ship,
    opened: people.results.filter((r) => r.opened).map((r) => r.manager),
    seen,
    totals: { bought: chain.filter((n) => gift[n] && gift[n].ordered).length, delivered: chain.filter((n) => gift[n] && gift[n].delivered).length, total: chain.length },
    remind: me ? (ppl[me.manager] ? !!ppl[me.manager].remind : true) : null,
  };
  // Event night's RSVPs (everyone sees who's coming).
  const rsvp = allVotes.filter((v) => v.cat === "rsvp" && chain.includes(v.voter));
  body.rsvp = { in: rsvp.filter((v) => v.pick === "in").map((v) => v.voter).sort(), out: rsvp.filter((v) => v.pick === "out").map((v) => v.voter).sort(), mine: me ? (rsvp.find((v) => v.voter === me.manager) || {}).pick || null : null };
  // Santa props: your own picks and how many have a card in. Everyone's picks go out with the unmask.
  const propVotes = allVotes.filter((v) => v.cat.startsWith("prop:") && chain.includes(v.voter));
  body.props = {
    mine: me ? Object.fromEntries(propVotes.filter((v) => v.voter === me.manager).map((v) => [v.cat.slice(5), v.pick])) : {},
    cards: new Set(propVotes.map((v) => v.voter)).size, locked: !!start,
    ...(set.unmasked ? { all: Object.fromEntries(Object.keys(PROPS).map((k) => [k, Object.fromEntries(propVotes.filter((v) => v.cat === "prop:" + k).map((v) => [v.voter, v.pick]))])) } : {}),
  };
  // Santa says: the anonymous wall. Names come off with the unmask.
  if (started) body.wall = wallRows.filter((r) => !r.manager.startsWith("rh:")).reverse().map((r) => ({ id: r.id, text: r.emoji, at: r.at, mine: !!me && r.manager === me.manager, ...(set.unmasked ? { by: r.manager } : {}) }));
  // The sleigh race: each Santa's step, from the Room's start.
  if (started) body.race = Object.fromEntries(chain.map((n) => [n, stageOf(gift[n])]));

  if (me && started && chain.includes(me.manager)) {
    const g = gifteeOf(chain, me.manager), s = santaOf(chain, me.manager), c = cards[g];
    const msgs = await env.DB.prepare(
      "SELECT santa, giftee, from_santa, text, at FROM santa_msgs WHERE (santa = ?1 AND giftee = ?2) OR (santa = ?3 AND giftee = ?1) ORDER BY id"
    ).bind(me.manager, g, s).all().catch(() => ({ results: [] }));
    const mine = ppl[me.manager] || {};
    body.you = {
      giftee: c ? {
        name: g, size: c.size, colors: JSON.parse(c.colors || "[]"),
        ...(set.ship ? { address: { name: c.name, street: c.street, apt: c.apt || "", city: c.city, state: c.state, zip: c.zip } } : {}),
      } : { name: g },
      gift: giftRow(gift[me.manager]) || null,
      board: json(mine.board, []),
      photo: photo[me.manager] || null,
      guess: mine.guess || null,
      opened: !!mine.opened,
      // Your side of each thread: "giftee" is you writing as Santa, "santa" is your Santa writing to you.
      msgs: {
        giftee: msgs.results.filter((m) => m.santa === me.manager).map((m) => ({ mine: !!m.from_santa, text: m.text, at: m.at })),
        santa: msgs.results.filter((m) => m.giftee === me.manager).map((m) => ({ mine: !m.from_santa, text: m.text, at: m.at })),
      },
    };
  }

  if (set.unmasked) {
    body.unwrap = {
      chain,
      gifts: Object.fromEntries(chain.map((n) => [gifteeOf(chain, n), gift[n] ? { shirt: gift[n].shirt, title: gift[n].title || "", url: gift[n].url || "" } : null])),
      guesses: Object.fromEntries(chain.map((n) => [n, ppl[n] ? ppl[n].guess : null])),
      photos: Object.fromEntries(chain.filter((n) => photo[n]).map((n) => [n, photo[n]])),
    };
    body.unwrap.fits = Object.fromEntries(chain.filter((n) => photo[fitKey(n)]).map((n) => [n, photo[fitKey(n)]]));
    body.unwrap.rates = await rateTallies(env, chain);
    // The Shirtys: how many have voted in each, your own vote, and each sealed envelope's winners.
    const votes = allVotes;
    body.shirtys = Object.fromEntries(SHIRTYS.map((c) => [c.key, {
      voters: votes.filter((v) => v.cat === c.key && chain.includes(v.voter)).length,
      mine: me ? (votes.find((v) => v.cat === c.key && v.voter === me.manager) || {}).pick || null : null,
      result: (set.shirtys || {})[c.key] || null,
    }]));
  }

  // Unwrap night, hosted: only what has been shown so far.
  if (set.host && !set.unmasked && started) body.host = await hostView(env, set, chain, me, { votes: allVotes, gift, ppl, photo });

  if (me && (await isCommissioner(env, me.manager))) {
    // For reveal night: who has notifications on, and when each last came by signed in.
    const [subs, sess] = await Promise.all([
      subscriberSummary(env).catch(() => []),
      env.DB.prepare("SELECT manager, MAX(seen) AS seen FROM auth_sessions GROUP BY manager").all().catch(() => ({ results: [] })),
    ]);
    const devices = Object.fromEntries(subs.map((x) => [String(x.me || "").toLowerCase(), x.devices]));
    const lastSeen = Object.fromEntries(sess.results.map((r) => [r.manager, r.seen]));
    // Who can make which December day (for picking event night).
    body.avail = Object.fromEntries(rows.results.map((r) => [r.manager, JSON.parse(r.dates || "[]")]));
    body.commish = (chain.length ? chain : signed).slice().sort().map((n) => ({
      manager: n, card: !!cards[n], opened: ppl[n] ? ppl[n].opened : null, push: devices[n.toLowerCase()] || 0, last: lastSeen[n] || null,
      ordered: gift[n] ? gift[n].ordered : null, shipped: gift[n] ? gift[n].shipped : null, eta: gift[n] ? gift[n].eta : null,
      delivered: gift[n] ? gift[n].delivered : null, wrapped: gift[n] ? gift[n].wrapped : null,
    }));
  }
  return { status: 200, body };
}

// ---------- Sign-ups ----------
async function save(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, "bad_json");
  const now = Date.now();
  if ((now < OPENS || now >= CLOSES) && !(await isCommissioner(env, me.manager))) return fail(403, now < OPENS ? "not_open" : "closed");

  const card = {
    name: clip(body.name, 60), street: clip(body.street, 80), apt: clip(body.apt, 20),
    city: clip(body.city, 50), state: clip(body.state, 2).toUpperCase(), zip: clip(body.zip, 10),
    size: SIZES.includes(body.size) ? body.size : "",
    colors: [...new Set((Array.isArray(body.colors) ? body.colors : []).filter((c) => COLORS.includes(c)))],
    dates: [...new Set((Array.isArray(body.dates) ? body.dates : []).filter((d) => typeof d === "string" && DECEMBER.test(d)))].sort(),
  };
  if (!card.size) return fail(400, "no_size");
  if (!card.name || !card.street || !card.city || !/^[A-Z]{2}$/.test(card.state) || !/^\d{5}(-\d{4})?$/.test(card.zip)) return fail(400, "no_address");

  await env.DB.prepare(
    `INSERT INTO santa_cards (manager, name, street, apt, city, state, zip, size, colors, dates, updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(manager) DO UPDATE SET name = excluded.name, street = excluded.street, apt = excluded.apt, city = excluded.city,
       state = excluded.state, zip = excluded.zip, size = excluded.size, colors = excluded.colors, dates = excluded.dates, updated = excluded.updated`
  ).bind(me.manager, card.name, card.street, card.apt, card.city, card.state, card.zip, card.size, JSON.stringify(card.colors), JSON.stringify(card.dates), now).run();
  return { status: 200, body: { ok: true, mine: { ...card, updated: now } } };
}

/** A push to someone who hasn't signed up (anyone can send it, while sign-ups
 * are open), isn't in the Room yet (anyone, on reveal night) or hasn't marked
 * their shirt bought (commissioners, after the Room). Once a day per person
 * and kind (the Room's every 5 minutes), whoever sends it. */
async function nudge(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const body = await request.json().catch(() => null);
  const to = clip(body && body.manager, 40);
  const kind = body && (body.kind === "buy" || body.kind === "room") ? body.kind : "signup";
  if (!to || to === me.manager) return fail(400, "bad_manager");
  const now = Date.now();
  let message;
  if (kind === "signup") {
    if (now < OPENS || now >= CLOSES) return fail(403, now < OPENS ? "not_open" : "closed");
    const known = await env.DB.prepare("SELECT 1 AS x FROM auth_managers WHERE manager = ?1").bind(to).first();
    if (!known) return fail(404, "no_manager");
    if (await env.DB.prepare("SELECT 1 AS x FROM santa_cards WHERE manager = ?1").bind(to).first()) return fail(409, "already_in");
    message = { title: "Secret Santa", body: `${me.manager} says you haven't signed up yet.`, url: "secret-santa.html", tag: "santa-nudge" };
  } else if (kind === "room") {
    if (now < REVEAL - 5 * 60 * 1000 || (await getSetting(env, "santa_start"))) return fail(403, "not_now");
    message = { title: "Secret Santa", body: `${me.manager} says everyone's waiting on you in the Room.`, url: "secret-santa.html", tag: "santa-room" };
  } else {
    if (!(await isCommissioner(env, me.manager))) return fail(403, "not_commissioner");
    const g = await env.DB.prepare("SELECT ordered FROM santa_gifts WHERE santa = ?1").bind(to).first();
    if (g && g.ordered) return fail(409, "already_bought");
    const set = await settings(env);
    message = { title: "Secret Santa", body: `Your shirt isn't marked bought yet.${set.purchaseBy ? ` Buy it by ${fmtDay(set.purchaseBy)}.` : ""}`, url: "secret-santa.html", tag: "santa-buy" };
  }
  const key = `santa:nudge:${kind}:${to}`;
  if (await env.COOLDOWN_KV.get(key)) return fail(429, "nudged_today");
  await env.COOLDOWN_KV.put(key, "1", { expirationTtl: kind === "room" ? 300 : NUDGE_SECONDS });
  const r = await broadcast(env, message, to).catch(() => ({ devices: 0 }));
  return { status: 200, body: { ok: true, devices: r.devices || 0 } };
}
const fmtDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

// ---------- Reveal day ----------
async function remind(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const body = await request.json().catch(() => ({}));
  const on = body.on ? 1 : 0;
  await env.DB.prepare("INSERT INTO santa_people (manager, remind) VALUES (?1, ?2) ON CONFLICT(manager) DO UPDATE SET remind = excluded.remind").bind(me.manager, on).run();
  return { status: 200, body: { ok: true, remind: !!on } };
}
/** Everyone in the draw who hasn't turned the 15-minute reminder off. */
async function wantsHype(env, chain) {
  const { results } = await env.DB.prepare("SELECT manager FROM santa_people WHERE remind = 0").all().catch(() => ({ results: [] }));
  const off = new Set(results.map((r) => r.manager));
  return chain.filter((n) => !off.has(n));
}
/** Sends once per key (push_sent); false if it already went. */
async function once(env, key, now) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO push_sent (k, ts) VALUES (?1, ?2)").bind(key, now).run();
  return !!(r.meta && r.meta.changes);
}

/** The 15-minute push, from the cron's first run in the window (scheduled() in index.js). */
export async function checkSantaReminder(env, now = Date.now()) {
  if (now < REMIND_AT || now >= REVEAL || !env.VAPID_PRIVATE_JWK) return;
  if (await env.DB.prepare("SELECT 1 AS x FROM push_sent WHERE k = 'santa:remind:2026'").first()) return;
  const draw = await getSetting(env, "santa_draw");
  if (!draw || !(await once(env, "santa:remind:2026", now))) return;
  const message = { title: "Secret Santa starts in 15 minutes", body: "The Room opens at 9:00 PM. Everyone opens their envelope together.", url: "secret-santa.html", tag: "santa-remind" };
  await Promise.allSettled((await wantsHype(env, draw.chain)).map((n) => broadcast(env, message, n)));
}

/** Reveal day's other pushes, from the cron: noon, 8:00 PM and 9:00 PM
 * (that one only to whoever isn't in the Room yet). Each goes once, from the
 * first run in its window, to everyone in the draw (the page's switch is only
 * the 15-minute reminder). */
export async function checkSantaHype(env, now = Date.now()) {
  if (!env.VAPID_PRIVATE_JWK || now < NOON || now >= FORCE_AT) return;
  const draw = await getSetting(env, "santa_draw");
  if (!draw) return;
  let key, message, to;
  if (now < NOON + 3 * 3600 * 1000) {
    key = "santa:hype:noon:2026";
    message = { title: "Reveal night is tonight", body: "Your envelope is in the vault. The Room opens at 9:00 PM.", url: "secret-santa.html", tag: "santa-hype" };
  } else if (now >= EIGHT && now < REMIND_AT) {
    key = "santa:hype:eight:2026";
    message = { title: "One hour", body: "Find a spot where nobody can see your screen.", url: "secret-santa.html", tag: "santa-hype" };
  } else if (now >= REVEAL && now < FORCE_AT) {
    if (await getSetting(env, "santa_start")) return;
    key = "santa:hype:nine:2026";
    const { present } = await roomNow(env, draw.chain, now);
    to = draw.chain.filter((n) => !present.includes(n));
    message = { title: "The Room is open", body: `${present.length} of ${draw.chain.length} are here. Walk in.`, url: "secret-santa.html", tag: "santa-room" };
  } else return;
  if (!(await once(env, key, now))) return;
  await Promise.allSettled((to || draw.chain).map((n) => broadcast(env, message, n)));
}

/** Who's in the Room now: in the draw (the rehearsal Room: anyone in it),
 * with a heartbeat in the last 12 seconds. `holding` also counts anyone whose
 * seal has already broken. `flags` says who has checked their sound and
 * turned the reaction cam on. */
async function roomNow(env, chain, now, pre = "") {
  const { results } = await env.DB.prepare("SELECT manager, seen, holding FROM santa_room").all();
  const live = results.filter((r) => r.manager.startsWith("rh:") === !!pre && now - r.seen < HERE_MS)
    .map((r) => ({ ...r, manager: r.manager.slice(pre.length) })).filter((r) => !chain || chain.includes(r.manager));
  return {
    present: live.map((r) => r.manager),
    holding: live.filter((r) => (r.holding & F_OPEN) || ((r.holding & F_HOLD) && now - r.seen < HOLDING_MS)).map((r) => r.manager),
    flags: Object.fromEntries(live.map((r) => [r.manager, { snd: !!(r.holding & F_SND), cam: !!(r.holding & F_CAM) }])),
  };
}
async function startRoom(env, crew, by, key = "santa_start") {
  const value = { at: Date.now() + START_DELAY, crew, by };
  await env.DB.prepare("INSERT OR IGNORE INTO site_settings (k, v, updated) VALUES (?1, ?2, ?3)").bind(key, JSON.stringify(value), Date.now()).run();
  return getSetting(env, key);
}
/** "Jon just walked into the Room": to everyone in the draw who isn't there,
 * once at least half of them are, and at most once every five minutes each. */
async function walkedIn(env, chain, who, now) {
  if (!env.VAPID_PRIVATE_JWK || now < REVEAL) return;
  const { present } = await roomNow(env, chain, now);
  if (present.length * 2 < chain.length) return;
  const out = chain.filter((n) => n !== who && !present.includes(n));
  const bucket = Math.floor(now / WALKIN_MS);
  await Promise.allSettled(out.map(async (n) => {
    if (!(await once(env, `santa:walkin:${n}:${bucket}`, now))) return;
    const others = out.length - 1;
    await broadcast(env, { title: `${who} just walked into the Room`, body: `Waiting on you${others ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}.`, url: "secret-santa.html", tag: "santa-room" }, n);
  }));
}

/** The Room's heartbeat. Every few seconds from everyone on the page from
 * 9:00 PM, and about every 0.7s while holding the seal. -> { present,
 * holding, start: { at, crew } | null, events, giftee (once started) } */
async function room(request, env, ctx) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const now = Date.now();
  const body = await request.json().catch(() => ({}));
  const rh = !!body.rehearsal, sp = space(rh);
  if (!rh && now < REVEAL - 5 * 60 * 1000) return fail(403, "not_yet");
  const draw = rh ? null : await getSetting(env, "santa_draw");
  if (!rh && !draw) return fail(403, "no_draw");
  let start = await getSetting(env, sp.start);
  // Someone who isn't in the draw can watch, but doesn't take a seat.
  const seated = rh || draw.chain.includes(me.manager);
  if (seated) {
    const seat = sp.pre + me.manager;
    const bits = (body.holding ? F_HOLD : 0) | (body.snd ? F_SND : 0) | (body.cam ? F_CAM : 0) | (body.opened ? F_OPEN : 0);
    const was = await env.DB.prepare("SELECT seen FROM santa_room WHERE manager = ?1").bind(seat).first();
    const joined = !was || now - was.seen >= HERE_MS;
    const writes = [env.DB.prepare("INSERT INTO santa_room (manager, seen, holding) VALUES (?1, ?2, ?3) ON CONFLICT(manager) DO UPDATE SET seen = excluded.seen, holding = excluded.holding").bind(seat, now, bits)];
    if (joined && !start) writes.push(env.DB.prepare("INSERT INTO santa_events (manager, kind, at) VALUES (?1, 'join', ?2)").bind(seat, now));
    if (EMOJI.includes(body.react)) writes.push(env.DB.prepare("INSERT INTO santa_events (manager, kind, emoji, at) VALUES (?1, 'react', ?2, ?3)").bind(seat, body.react, now));
    // A typed line in the Room's chat (kept in the emoji column, kind "say").
    const say = typeof body.say === "string" ? body.say.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, SAY_MAX) : "";
    if (say) writes.push(env.DB.prepare("INSERT INTO santa_events (manager, kind, emoji, at) VALUES (?1, 'say', ?2, ?3)").bind(seat, say, now));
    await env.DB.batch(writes);
    if (!rh && joined && !start && ctx) ctx.waitUntil(walkedIn(env, draw.chain, me.manager, now).catch((e) => console.error("walk-in push failed:", e)));
  }

  const { present, holding: holders, flags } = await roomNow(env, rh ? null : draw.chain, now, sp.pre);
  // A commissioner starts it (admin "start"); it never starts itself.
  start = start || (await getSetting(env, sp.start));
  // The seal: the first moment everyone from the start who is still here is
  // holding, one break time is set for all of them, a few seconds out.
  let drop = start && now >= start.at ? await getSetting(env, sp.drop) : null;
  if (start && now >= start.at && !drop) {
    const crewNow = start.crew.filter((n) => present.includes(n));
    if (crewNow.length && crewNow.every((n) => holders.includes(n))) {
      await env.DB.prepare("INSERT OR IGNORE INTO site_settings (k, v, updated) VALUES (?1, ?2, ?3)").bind(sp.drop, JSON.stringify({ at: now + DROP_DELAY }), now).run();
      drop = await getSetting(env, sp.drop);
    }
  }
  // The chat: the last ten minutes while waiting, the whole night once it has started (the afterparty).
  const after = Number(body.after) || 0;
  const { results: events } = await env.DB.prepare("SELECT id, manager, kind, emoji, at FROM santa_events WHERE id > ?1 AND at > ?2 AND kind IN ('join', 'react', 'say') ORDER BY id DESC LIMIT 60").bind(after, now - (start ? 12 * 3600 * 1000 : 10 * 60 * 1000)).all();
  const mineOnly = events.filter((e) => e.manager.startsWith("rh:") === rh).slice(0, 30).map((e) => ({ ...e, manager: e.manager.slice(sp.pre.length) }));
  const out = { present, holding: holders, flags, start: start ? { at: start.at, crew: start.crew } : null, drop: drop ? drop.at : null, now, events: mineOnly.reverse() };
  if (start && now >= start.at - START_DELAY && seated) {
    if (rh) {
      // A stand-in giftee: the next person in the rehearsal, or anyone else with a card.
      const crew = [...start.crew].sort(), i = crew.indexOf(me.manager);
      let g = crew.length > 1 && i >= 0 ? crew[(i + 1) % crew.length] : null;
      if (!g) { const other = await env.DB.prepare("SELECT manager FROM santa_cards WHERE manager != ?1 ORDER BY manager LIMIT 1").bind(me.manager).first(); g = other ? other.manager : "Santa"; }
      out.giftee = { name: g, size: "XL", colors: [] };
    } else {
      const g = gifteeOf(draw.chain, me.manager);
      const c = await env.DB.prepare("SELECT size, colors FROM santa_cards WHERE manager = ?1").bind(g).first();
      out.giftee = { name: g, size: c ? c.size : "", colors: c ? JSON.parse(c.colors || "[]") : [] };
    }
  }
  return { status: 200, body: out };
}

async function opened(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const start = await getSetting(env, "santa_start");
  if (!start || Date.now() < start.at) return fail(403, "not_started");
  const body = await request.json().catch(() => ({}));
  await env.DB.prepare(
    `INSERT INTO santa_people (manager, opened, in_room) VALUES (?1, ?2, ?3)
     ON CONFLICT(manager) DO UPDATE SET opened = COALESCE(santa_people.opened, excluded.opened), in_room = MAX(santa_people.in_room, excluded.in_room)`
  ).bind(me.manager, Date.now(), body.inRoom ? 1 : 0).run();
  return { status: 200, body: { ok: true } };
}

// ---------- Gifting ----------
/** You, in the draw, after the Room started; else an error. */
async function participant(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return { error: fail(401, "signed_out") };
  const [draw, start] = await Promise.all([getSetting(env, "santa_draw"), getSetting(env, "santa_start")]);
  if (!draw || !draw.chain.includes(me.manager)) return { error: fail(403, "not_in_draw") };
  if (!start || Date.now() < start.at) return { error: fail(403, "not_started") };
  return { me, chain: draw.chain };
}

/** Your gift: the shirt (picked from the board, or any link), then a date for
 * each step. A pick alone has no dates yet. */
async function saveGift(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, "bad_json");
  if (body.clear) {
    await env.DB.prepare("DELETE FROM santa_gifts WHERE santa = ?1").bind(p.me.manager).run();
    return { status: 200, body: { ok: true, gift: null } };
  }
  const shirt = Number.isInteger(body.shirt) && body.shirt >= 0 && body.shirt < SHIRTS ? body.shirt : null;
  let url = clip(body.url, 300);
  if (url && !/^https:\/\/(www\.)?thegoodshirts\.com\//i.test(url)) return fail(400, "bad_url");
  const g = {
    shirt, title: clip(body.title, 140), url, size: SIZES.includes(body.size) ? body.size : "",
    price: Number.isFinite(+body.price) && +body.price > 0 && +body.price < 1000 ? Math.round(+body.price * 100) / 100 : null,
    ordered: day(body.ordered), shipped: day(body.shipped), eta: day(body.eta), delivered: day(body.delivered), wrapped: day(body.wrapped),
  };
  if (shirt == null && !g.title && !g.url) return fail(400, "no_shirt");
  // A later step needs the ones before it.
  if (!g.ordered && (g.shipped || g.delivered || g.wrapped)) return fail(400, "no_order_date");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO santa_gifts (santa, shirt, title, url, size, price, ordered, shipped, eta, delivered, wrapped, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(santa) DO UPDATE SET shirt = excluded.shirt, title = excluded.title, url = excluded.url, size = excluded.size, price = excluded.price,
       ordered = excluded.ordered, shipped = excluded.shipped, eta = excluded.eta, delivered = excluded.delivered, wrapped = excluded.wrapped, updated = excluded.updated`
  ).bind(p.me.manager, g.shirt, g.title, g.url, g.size, g.price, g.ordered, g.shipped, g.eta, g.delivered, g.wrapped, now).run();
  return { status: 200, body: { ok: true, gift: { ...g, updated: now } } };
}

/** The big board: up to three shirts you're thinking about, best first. */
async function saveBoard(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const body = await request.json().catch(() => null);
  const list = Array.isArray(body && body.board) ? body.board : null;
  if (!list) return fail(400, "bad_json");
  const board = [...new Set(list.filter((i) => Number.isInteger(i) && i >= 0 && i < SHIRTS))].slice(0, 3);
  await env.DB.prepare("INSERT INTO santa_people (manager, board) VALUES (?1, ?2) ON CONFLICT(manager) DO UPDATE SET board = excluded.board").bind(p.me.manager, JSON.stringify(board)).run();
  return { status: 200, body: { ok: true, board } };
}

/** The anonymous mailbox. Writing to your giftee signs it "Santa"; writing to
 * your Santa signs it with your name. Each new message is a push to the other side. */
async function msg(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const body = await request.json().catch(() => null);
  const text = clip(body && body.text, 500);
  if (!text) return fail(400, "empty");
  const toGiftee = body.to === "giftee";
  // This or that: Santa sends two shirts ("[[tot:12,45]]"), the giftee taps one ("[[pick:12]]").
  const tot = /^\[\[tot:(\d+),(\d+)\]\]$/.exec(text), pick = /^\[\[pick:(\d+)\]\]$/.exec(text);
  if (/\[\[/.test(text) && !(tot && toGiftee && +tot[1] < SHIRTS && +tot[2] < SHIRTS && tot[1] !== tot[2]) && !(pick && !toGiftee && +pick[1] < SHIRTS)) return fail(400, "bad_text");
  const said = tot ? "This or that? Tap to pick a shirt." : pick ? "They picked one of your two shirts." : text.slice(0, 120);
  const santa = toGiftee ? p.me.manager : santaOf(p.chain, p.me.manager);
  const giftee = toGiftee ? gifteeOf(p.chain, p.me.manager) : p.me.manager;
  const now = Date.now();
  await env.DB.prepare("INSERT INTO santa_msgs (santa, giftee, from_santa, text, at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(santa, giftee, toGiftee ? 1 : 0, text, now).run();
  const to = toGiftee ? giftee : santa;
  await broadcast(env, { title: toGiftee ? "Your Secret Santa wrote you" : `${p.me.manager} wrote back`, body: said, url: "secret-santa.html#mailbox", tag: "santa-msg" }, to).catch(() => {});
  return { status: 200, body: { ok: true, at: now } };
}

async function guess(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const set = await settings(env);
  if (set.unmasked || set.host || (set.eventAt && Date.now() >= set.eventAt)) return fail(403, "locked");
  const body = await request.json().catch(() => ({}));
  const g = body.guess == null ? null : clip(body.guess, 40);
  if (g != null && (!p.chain.includes(g) || g === p.me.manager)) return fail(400, "bad_guess");
  // guessed_at: when the guess last changed (Best Detective goes to whoever had the right one first).
  await env.DB.prepare("INSERT INTO santa_people (manager, guess, guessed_at) VALUES (?1, ?2, ?3) ON CONFLICT(manager) DO UPDATE SET guess = excluded.guess, guessed_at = excluded.guessed_at").bind(p.me.manager, g, g ? Date.now() : null).run();
  return { status: 200, body: { ok: true, guess: g } };
}

// ---------- The reaction cam ----------
/** Your photo, taken on your phone as your giftee's name landed (or retaken). */
async function photoPost(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const set = await settings(env);
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, "bad_json");
  // A fit check: you, in the shirt, on Unwrap night (kept under its own key, next to the reaction photos).
  const fit = body.kind === "fit";
  if (fit ? !(set.host || set.unmasked) : (set.unmasked || set.host)) return fail(403, "locked");
  const key = fit ? fitKey(p.me.manager) : p.me.manager;
  if (body.clear) {
    await env.DB.prepare("DELETE FROM santa_photos WHERE manager = ?1").bind(key).run();
    return { status: 200, body: { ok: true, photo: null } };
  }
  const img = String(body.img || "").replace(/^data:image\/jpeg;base64,/, "");
  if (!img || img.length > PHOTO_MAX || !/^[A-Za-z0-9+/]+=*$/.test(img)) return fail(400, "bad_photo");
  const now = Date.now();
  await env.DB.prepare("INSERT INTO santa_photos (manager, img, at) VALUES (?1, ?2, ?3) ON CONFLICT(manager) DO UPDATE SET img = excluded.img, at = excluded.at").bind(key, img, now).run();
  return { status: 200, body: { ok: true, photo: now } };
}
/** A photo: your own any time; once the loop is unmasked, anyone's to anyone signed in. */
async function photoGet(request, env) {
  const me = await sessionManager(request, env).catch(() => null);
  if (!me) return fail(401, "signed_out");
  const q = new URL(request.url).searchParams, who = clip(q.get("m"), 40) || me.manager, fit = q.get("kind") === "fit";
  if (!fit && who !== me.manager) {
    // A reaction photo is its owner's until the unmask, or until the hosted night has shown who that Santa had.
    const set = await settings(env);
    let shown = !!set.unmasked;
    if (!shown && set.host) { const draw = await getSetting(env, "santa_draw"), at = draw && hostAt(set, draw.chain), k = draw ? draw.chain.indexOf(who) : -1; shown = k >= 0 && (k < at.link || (k === at.link && at.beat >= 1)); }
    if (!shown) return fail(403, "sealed");
  }
  const row = await env.DB.prepare("SELECT img FROM santa_photos WHERE manager = ?1").bind(fit ? fitKey(who) : who).first();
  if (!row) return fail(404, "no_photo");
  const bin = atob(row.img), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { status: 200, binary: bytes, type: "image/jpeg" };
}

// ---------- The Shirtys ----------
/** A vote: whose shirt (by who got it). Not your own pick, and only until a
 * commissioner seals that envelope. */
async function vote(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const set = await settings(env);
  if (!set.unmasked) return fail(403, "not_unmasked");
  const body = await request.json().catch(() => null);
  const c = body && SHIRTY[body.cat];
  if (!c || !c.vote) return fail(400, "bad_cat");
  if ((set.shirtys || {})[c.key]) return fail(403, "sealed");
  if (body.pick == null) {
    await env.DB.prepare("DELETE FROM santa_votes WHERE voter = ?1 AND cat = ?2").bind(p.me.manager, c.key).run();
    return { status: 200, body: { ok: true, pick: null } };
  }
  const pick = clip(body.pick, 40);
  if (!p.chain.includes(pick)) return fail(400, "bad_pick");
  if (santaOf(p.chain, pick) === p.me.manager) return fail(400, "own_pick");
  await env.DB.prepare("INSERT INTO santa_votes (voter, cat, pick, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(voter, cat) DO UPDATE SET pick = excluded.pick, at = excluded.at").bind(p.me.manager, c.key, pick, Date.now()).run();
  return { status: 200, body: { ok: true, pick } };
}
/** Opens a category's envelope: who won. Ties all win. */
async function shirtyResult(env, key, chain, set) {
  const c = SHIRTY[key];
  const gifts = Object.fromEntries((await env.DB.prepare("SELECT * FROM santa_gifts").all()).results.map((r) => [r.santa, r]));
  const shirtOf = (giftee) => { const g = gifts[santaOf(chain, giftee)]; return g ? { shirt: g.shirt, title: g.title || "" } : { shirt: null, title: "" }; };
  if (c.vote) {
    const { results } = await env.DB.prepare("SELECT voter, pick FROM santa_votes WHERE cat = ?1").bind(key).all();
    const tally = {};
    for (const v of results) if (chain.includes(v.voter) && chain.includes(v.pick)) tally[v.pick] = (tally[v.pick] || 0) + 1;
    const top = Math.max(0, ...Object.values(tally));
    const winners = top ? Object.keys(tally).filter((g) => tally[g] === top).sort().map((g) => ({ manager: santaOf(chain, g), giftee: g, votes: top, ...shirtOf(g) })) : [];
    return { label: c.label, winners, voters: results.filter((v) => chain.includes(v.voter)).length };
  }
  const people = Object.fromEntries((await env.DB.prepare("SELECT manager, guess, guessed_at FROM santa_people").all()).results.map((r) => [r.manager, r]));
  if (key === "props") {
    // Each prop's answer (null while it can't be known yet), then whoever got the most right.
    const off = (set.shirtys || {}).offensive, orders = chain.map((n) => gifts[n] && gifts[n].ordered).filter(Boolean).sort(), wraps = chain.map((n) => gifts[n] && gifts[n].wrapped).filter(Boolean).sort();
    const right = chain.filter((n) => people[n] && people[n].guess && people[n].guess === santaOf(chain, n)).length;
    const answers = {
      off: off ? off.winners.map((w) => w.giftee) : null,
      ou: [right > OU_LINE ? "over" : "under"],
      late: orders.length ? chain.filter((n) => gifts[n] && gifts[n].ordered === orders[orders.length - 1]) : null,
      wrap: wraps.length ? chain.filter((n) => gifts[n] && gifts[n].wrapped === wraps[0]) : null,
    };
    const { results } = await env.DB.prepare("SELECT voter, cat, pick FROM santa_votes WHERE cat LIKE 'prop:%'").all();
    const score = {};
    for (const v of results) { const a = answers[v.cat.slice(5)]; if (chain.includes(v.voter) && a && a.includes(v.pick)) score[v.voter] = (score[v.voter] || 0) + 1; }
    const top = Math.max(0, ...Object.values(score)), of = Object.values(answers).filter(Boolean).length;
    return { label: c.label, winners: top ? Object.keys(score).filter((n) => score[n] === top).sort().map((n) => ({ manager: n, right: top, of })) : [], answers, score, guessedRight: right };
  }
  if (key === "detective") {
    // Everyone who named their own Santa; the first to settle on it wins (ties all win).
    const right = chain.filter((n) => people[n] && people[n].guess && people[n].guess === santaOf(chain, n));
    const first = Math.min(...right.map((n) => people[n].guessed_at || Infinity));
    const winners = right.filter((n) => (people[n].guessed_at || Infinity) === first).map((n) => ({ manager: n, guess: people[n].guess, at: people[n].guessed_at || null }));
    return { label: c.label, winners, right: right.length };
  }
  // Last-Minute Santa: the latest order date anyone recorded.
  const dates = chain.map((n) => gifts[n] && gifts[n].ordered).filter(Boolean).sort();
  const last = dates[dates.length - 1];
  const winners = last ? chain.filter((n) => gifts[n] && gifts[n].ordered === last).map((n) => ({ manager: n, ordered: last, purchaseBy: set.purchaseBy || null })) : [];
  return { label: c.label, winners };
}

// ---------- Santa props, RSVPs, Santa says ----------
/** You, in the draw (before or after the Room); else an error. */
async function drawn(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return { error: fail(401, "signed_out") };
  const draw = await getSetting(env, "santa_draw");
  if (!draw || !draw.chain.includes(me.manager)) return { error: fail(403, "not_in_draw") };
  return { me, chain: draw.chain };
}
const setVote = (env, voter, cat, pick) => (pick == null
  ? env.DB.prepare("DELETE FROM santa_votes WHERE voter = ?1 AND cat = ?2").bind(voter, cat).run()
  : env.DB.prepare("INSERT INTO santa_votes (voter, cat, pick, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(voter, cat) DO UPDATE SET pick = excluded.pick, at = excluded.at").bind(voter, cat, pick, Date.now()).run());

/** A prop pick. Open from the draw until a commissioner starts the Room. */
async function prop(request, env) {
  const p = await drawn(request, env);
  if (p.error) return p.error;
  if (await getSetting(env, "santa_start")) return fail(403, "locked");
  const body = await request.json().catch(() => null);
  const kind = body && PROPS[body.cat];
  if (!kind) return fail(400, "bad_cat");
  const pick = body.pick == null ? null : clip(body.pick, 40);
  if (pick != null && (kind === "ou" ? !["over", "under"].includes(pick) : !p.chain.includes(pick))) return fail(400, "bad_pick");
  await setVote(env, p.me.manager, "prop:" + body.cat, pick);
  return { status: 200, body: { ok: true, pick } };
}
async function rsvpPost(request, env) {
  const p = await drawn(request, env);
  if (p.error) return p.error;
  const body = await request.json().catch(() => ({}));
  const pick = body.going === true ? "in" : body.going === false ? "out" : null;
  await setVote(env, p.me.manager, "rsvp", pick);
  return { status: 200, body: { ok: true, mine: pick } };
}
/** Santa says: a line on the wall, signed "A Santa" until the unmask. */
async function wallPost(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const body = await request.json().catch(() => null);
  const text = String((body && body.text) || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, WALL_MAX);
  if (!text) return fail(400, "empty");
  const now = Date.now();
  const r = await env.DB.prepare("INSERT INTO santa_events (manager, kind, emoji, at) VALUES (?1, 'wall', ?2, ?3)").bind(p.me.manager, text, now).run();
  return { status: 200, body: { ok: true, id: r.meta && r.meta.last_row_id, at: now } };
}

// ---------- Unwrap night, hosted ----------
// A commissioner runs it one gift at a time, in the loop's order, so whoever
// just opened is the next Santa "on the clock". Each link has three beats:
// 0 on the clock (phones vote on who that Santa had), 1 the pick, 2 the shirt.
// set.host.step counts beats; at 3 x the loop's length the whole loop is
// unmasked for good.
const fitKey = (n) => `fit:${YEAR}:${n}`;
async function rateTallies(env, chain) {
  const { results } = await env.DB.prepare("SELECT emoji FROM santa_events WHERE kind = 'rate'").all().catch(() => ({ results: [] }));
  const out = {};
  for (const r of results) {
    const [e, k] = String(r.emoji || "").split("|"), g = chain[(Number(k) + 1) % chain.length];
    if (!RATES.includes(e) || !g) continue;
    (out[g] = out[g] || {})[e] = (out[g][e] || 0) + 1;
  }
  return out;
}
function hostAt(set, chain) {
  const n = chain.length, step = Math.max(0, Math.min(3 * n, (set.host && set.host.step) || 0));
  return { n, step, link: Math.min(n - 1, Math.floor(step / 3)), beat: step >= 3 * n ? 2 : step % 3 };
}
async function hostView(env, set, chain, me, { votes, gift, ppl, photo }) {
  const { n, step, link, beat } = hostAt(set, chain);
  const rates = await rateTallies(env, chain);
  const links = [];
  for (let k = 0; k <= link; k++) {
    const S = chain[k], G = chain[(k + 1) % n], full = k < link, had = votes.filter((v) => v.cat === "had:" + k && chain.includes(v.voter));
    const o = { s: S, voted: had.length, mine: me ? (had.find((v) => v.voter === me.manager) || {}).pick || null : null };
    if (full || beat >= 1) Object.assign(o, { g: G, guess: (ppl[G] && ppl[G].guess) || null, called: had.filter((v) => v.pick === G).length, photo: !!photo[S] });
    if (full || beat >= 2) {
      const x = gift[S];
      Object.assign(o, { shirt: x ? x.shirt : null, title: x ? x.title || "" : "", also: json(ppl[S] && ppl[S].board, []).filter((i) => !x || i !== x.shirt).slice(0, 2), rates: rates[G] || {} });
    }
    links.push(o);
  }
  return { step, n, link, beat, links };
}
/** The phones' and the TV's poll while Unwrap night is running: the same view, without the rest of the page. */
async function hostGet(request, env) {
  const me = await sessionManager(request, env).catch(() => null);
  const [set, draw, start] = await Promise.all([settings(env), getSetting(env, "santa_draw"), getSetting(env, "santa_start")]);
  if (!draw || !start || !set.host || set.unmasked) return { status: 200, body: { host: null, unmasked: set.unmasked || null } };
  const [votes, gifts, people, photos] = await Promise.all([
    env.DB.prepare("SELECT voter, cat, pick FROM santa_votes WHERE cat LIKE 'had:%'").all(),
    env.DB.prepare("SELECT * FROM santa_gifts").all(), env.DB.prepare("SELECT * FROM santa_people").all(), env.DB.prepare("SELECT manager, at FROM santa_photos").all(),
  ]);
  const view = await hostView(env, set, draw.chain, me, {
    votes: votes.results, gift: Object.fromEntries(gifts.results.map((r) => [r.santa, r])),
    ppl: Object.fromEntries(people.results.map((r) => [r.manager, r])), photo: Object.fromEntries(photos.results.map((r) => [r.manager, r.at])),
  });
  // The newest ratings, for the emoji that float up on the TV.
  const after = Number(new URL(request.url).searchParams.get("after")) || 0;
  const { results: recent } = await env.DB.prepare("SELECT id, emoji FROM santa_events WHERE kind = 'rate' AND id > ?1 ORDER BY id DESC LIMIT 12").bind(after).all();
  return { status: 200, body: { host: view, unmasked: null, rates: recent.reverse().map((r) => ({ id: r.id, e: String(r.emoji).split("|")[0] })) } };
}
/** "Who did this Santa have?": a guess from your phone while they're on the clock. */
async function hadPost(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const set = await settings(env);
  if (!set.host || set.unmasked) return fail(403, "not_hosting");
  const { link, beat } = hostAt(set, p.chain);
  if (beat !== 0) return fail(403, "closed");
  const body = await request.json().catch(() => ({}));
  const pick = body.pick == null ? null : clip(body.pick, 40);
  if (pick != null && (!p.chain.includes(pick) || pick === p.chain[link])) return fail(400, "bad_pick");
  await setVote(env, p.me.manager, "had:" + link, pick);
  return { status: 200, body: { ok: true, pick } };
}
/** A tap on a shirt as it's unwrapped (as many as you like). */
async function ratePost(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const set = await settings(env);
  if (!set.host || set.unmasked) return fail(403, "not_hosting");
  const { link, beat } = hostAt(set, p.chain);
  if (beat !== 2) return fail(403, "closed");
  const body = await request.json().catch(() => ({}));
  if (!RATES.includes(body.e)) return fail(400, "bad_rate");
  await env.DB.prepare("INSERT INTO santa_events (manager, kind, emoji, at) VALUES (?1, 'rate', ?2, ?3)").bind(p.me.manager, `${body.e}|${link}`, Date.now()).run();
  return { status: 200, body: { ok: true } };
}

// ---------- Deadline pushes ----------
/** From the cron: your envelope is still sealed (the morning after), the
 * buy-by date coming up (three days out, the day before, the day of, to
 * anyone not marked ordered), and event night (the day before, two hours
 * before). Each goes once, from the first run inside its window. */
export async function checkSantaDeadlines(env, now = Date.now()) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const [draw, start, set] = await Promise.all([getSetting(env, "santa_draw"), getSetting(env, "santa_start"), settings(env)]);
  if (!draw || !start || now < start.at || set.unmasked) return;
  const chain = draw.chain, H = 3600 * 1000, D = 24 * H;
  const send = (list, title, body) => Promise.allSettled(list.map((n) => broadcast(env, { title, body, url: "secret-santa.html", tag: "santa-deadline" }, n)));
  const within = (t, span) => now >= t && now < t + span;
  // The morning after the Room (about 10 AM Eastern after a 9 PM start).
  if (within(start.at + 13 * H, 12 * H) && (await once(env, "santa:dl:unopened:" + YEAR, now))) {
    const { results } = await env.DB.prepare("SELECT manager FROM santa_people WHERE opened IS NOT NULL").all();
    const opened = new Set(results.map((r) => r.manager));
    await send(chain.filter((n) => !opened.has(n)), "Your envelope is still sealed", "Everyone else knows who they have. Open yours on the Secret Santa page.");
  }
  const gifts = Object.fromEntries((await env.DB.prepare("SELECT santa, ordered, wrapped FROM santa_gifts").all()).results.map((r) => [r.santa, r]));
  if (set.purchaseBy) {
    const due = Date.parse(set.purchaseBy + "T17:00:00Z"), late = chain.filter((n) => !(gifts[n] && gifts[n].ordered)), day = fmtDay(set.purchaseBy);
    for (const [key, at, title, text] of [
      ["buy3", due - 3 * D, "Three days to buy your shirt", `Buy by ${day}. Good Shirts takes about 3 weeks to deliver.`],
      ["buy1", due - D, "Buy your shirt by tomorrow", `${day} is the last day that gets it here in time.`],
      ["buy0", due, "Today is the buy-by date", "Order the shirt today, then mark it bought on the Secret Santa page."],
    ]) if (late.length && within(at, 20 * H) && (await once(env, `santa:dl:${key}:${set.purchaseBy}`, now))) await send(late, title, text);
  }
  if (set.eventAt) {
    const when = new Date(set.eventAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }), where = set.place ? ` at ${set.place}` : "";
    if (within(set.eventAt - 26 * H, 20 * H) && (await once(env, "santa:dl:eve:" + set.eventAt, now))) {
      const bare = chain.filter((n) => !(gifts[n] && gifts[n].wrapped));
      await send(bare, "Unwrap night is tomorrow", `Wrap the shirt. ${when}${where}.`);
      await send(chain.filter((n) => !bare.includes(n)), "Unwrap night is tomorrow", `${when}${where}. Bring the shirt.`);
    }
    if (now >= set.eventAt - 2 * H && now < set.eventAt - 20 * 60 * 1000 && (await once(env, "santa:dl:soon:" + set.eventAt, now))) await send(chain, "Unwrap night in two hours", `${when}${where}. Bring the wrapped shirt, and lock in your guess.`);
  }
}

// ---------- The Hall of Fame ----------
/** This year's loop, haul and Shirty winners (once unmasked). */
async function yearRecord(env, set) {
  const draw = await getSetting(env, "santa_draw");
  if (!draw || !set.unmasked) return null;
  const chain = draw.chain;
  const gifts = Object.fromEntries((await env.DB.prepare("SELECT * FROM santa_gifts").all()).results.map((r) => [r.santa, r]));
  return {
    year: YEAR, eventAt: set.eventAt || null, unmasked: set.unmasked, chain,
    gifts: Object.fromEntries(chain.map((n) => { const g = gifts[santaOf(chain, n)]; return [n, g ? { shirt: g.shirt, title: g.title || "", url: g.url || "" } : null]; })),
    shirtys: Object.fromEntries(SHIRTYS.filter((c) => (set.shirtys || {})[c.key]).map((c) => [c.key, set.shirtys[c.key]])),
    fits: (await env.DB.prepare("SELECT manager FROM santa_photos WHERE manager LIKE ?1").bind(`fit:${YEAR}:%`).all().catch(() => ({ results: [] }))).results.map((r) => r.manager.slice(`fit:${YEAR}:`.length)),
  };
}
/** Every year so far (past years as they were saved, this one as it is now). */
async function hof(request, env) {
  const saved = await getSetting(env, "santa_hof", {});
  const now = await yearRecord(env, await settings(env));
  const years = { ...saved };
  if (now) years[YEAR] = now; else delete years[YEAR];
  return { status: 200, body: { years, labels: Object.fromEntries(SHIRTYS.map((c) => [c.key, c.label])) } };
}
async function saveHof(env) {
  const rec = await yearRecord(env, await settings(env));
  const saved = await getSetting(env, "santa_hof", {});
  if (rec) saved[YEAR] = rec; else delete saved[YEAR];
  await setSetting(env, "santa_hof", Object.keys(saved).length ? saved : null);
}

// ---------- The sleigh race's roast ----------
/** Monday and Thursday at 7 PM Eastern, from the reveal until event night: a
 * push to everyone in the draw naming whoever's furthest behind. Once all of
 * them are wrapped, one last push says so. */
export async function checkSantaRoast(env, now = Date.now()) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const et = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  if (!["Mon", "Thu"].includes(et.weekday) || Number(et.hour) !== 19) return;
  const [draw, start, set] = await Promise.all([getSetting(env, "santa_draw"), getSetting(env, "santa_start"), settings(env)]);
  if (!draw || !start || now < start.at || set.unmasked || (set.eventAt && now >= set.eventAt)) return;
  const chain = draw.chain;
  const gifts = Object.fromEntries((await env.DB.prepare("SELECT * FROM santa_gifts").all()).results.map((r) => [r.santa, r]));
  const st = Object.fromEntries(chain.map((n) => [n, stageOf(gifts[n])]));
  const low = Math.min(...chain.map((n) => st[n])), last = chain.filter((n) => st[n] === low).sort();
  const buyBy = set.purchaseBy ? ` Buy by ${fmtDay(set.purchaseBy).replace(/^\w+, /, "")}.` : "";
  let key = `santa:roast:${new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" })}`, text;
  if (low === 5) { key = "santa:roast:wrapped:2026"; text = `All ${chain.length} shirts are wrapped. See you on event night.`; }
  else {
    const all = last.length === chain.length, who = all ? "Nobody" : nameList(last), many = !all && last.length > 1;
    text = [
      all ? `Nobody has left the North Pole yet.${buyBy}` : `${who} ${many ? "haven't" : "hasn't"} left the North Pole.${buyBy}`,
      all ? `Everyone has picked a shirt and nobody has ordered one.${buyBy}` : `${who} picked a shirt and stopped there.${buyBy}`,
      all ? "Every shirt is ordered and none has shipped. Tick tock." : `${who} ordered, but nothing has shipped. Tick tock.`,
      all ? "Every shirt is in the mail. Watch the porch." : `${who} ${many ? "are" : "is"} waiting on the mail. Everyone else has theirs.`,
      all ? "Every shirt is here and none is wrapped." : `${who} ${many ? "have" : "has"} a shirt in hand and no wrapping paper.`,
    ][low];
  }
  if (!(await once(env, key, now))) return;
  await Promise.allSettled(chain.map((n) => broadcast(env, { title: "The sleigh race", body: text, url: "secret-santa.html", tag: "santa-race" }, n)));
}

// ---------- Commissioners ----------
async function admin(request, env, ctx) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  if (!(await isCommissioner(env, me.manager))) return fail(403, "not_commissioner");
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, "bad_json");
  const now = Date.now();
  const set = await settings(env);
  const start = await getSetting(env, "santa_start");
  switch (body.action) {
    case "dates": {
      const purchaseBy = body.purchaseBy == null || body.purchaseBy === "" ? null : day(body.purchaseBy);
      const eventAt = Number.isFinite(body.eventAt) && body.eventAt > REVEAL ? body.eventAt : null;
      if (body.purchaseBy && !purchaseBy) return fail(400, "bad_date");
      const place = body.place === undefined ? set.place || "" : clip(body.place, 120), notes = body.notes === undefined ? set.notes || "" : clip(body.notes, 240);
      await setSetting(env, "santa", { ...set, purchaseBy, eventAt, place, notes });
      // New dates go out to everyone in the draw.
      if ((purchaseBy !== set.purchaseBy || eventAt !== set.eventAt) && (purchaseBy || eventAt) && ctx) {
        const draw = await getSetting(env, "santa_draw");
        const when = eventAt ? new Date(eventAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }) : null;
        const text = [when ? `Event night is ${when}${place ? ` at ${place}` : ""}.` : "", purchaseBy ? `Buy your shirt by ${fmtDay(purchaseBy)}: Good Shirts takes about 3 weeks.` : ""].filter(Boolean).join(" ");
        if (draw) ctx.waitUntil(Promise.allSettled(draw.chain.map((n) => broadcast(env, { title: "Secret Santa dates", body: text, url: "secret-santa.html", tag: "santa-dates" }, n))));
      }
      await logAction(env, me.manager, "santa", `Secret Santa dates: buy by ${purchaseBy || "TBD"}, event ${eventAt ? new Date(eventAt).toISOString() : "TBD"}`);
      return { status: 200, body: { ok: true, purchaseBy, eventAt } };
    }
    case "ship": {
      await setSetting(env, "santa", { ...set, ship: !!body.on });
      await logAction(env, me.manager, "santa", body.on ? "Secret Santa: shipping instead (addresses shown to each Santa)" : "Secret Santa: back to the in-person event");
      return { status: 200, body: { ok: true, ship: !!body.on } };
    }
    case "draw": {
      if (now < CLOSES) return fail(403, "still_open");
      if (start) return fail(403, "started");
      const { results } = await env.DB.prepare("SELECT manager FROM santa_cards").all();
      if (results.length < 2) return fail(400, "too_few");
      await setSetting(env, "santa_draw", { chain: shuffle(results.map((r) => r.manager)), at: now, by: me.manager });
      await logAction(env, me.manager, "santa", `Secret Santa: drew again (${results.length} in)`);
      return { status: 200, body: { ok: true, drawn: now } };
    }
    case "start": {
      // The rehearsal Room: any time, with whoever is in it.
      if (body.rehearsal) {
        const sp = space(true), had = await getSetting(env, sp.start);
        if (had) return { status: 200, body: { ok: true, start: had.at } };
        const { present } = await roomNow(env, null, now, sp.pre);
        if (!present.length) return fail(400, "nobody_here");
        const s = await startRoom(env, present, me.manager, sp.start);
        return { status: 200, body: { ok: true, start: s.at } };
      }
      // Everyone's here: any time from 9:00. Anyone missing: from 9:30, or
      // sooner when the commissioner says to go without them (force).
      if (now < REVEAL) return fail(403, "too_early");
      if (start) return { status: 200, body: { ok: true, start: start.at } };
      const draw = await getSetting(env, "santa_draw");
      if (!draw) return fail(400, "no_draw");
      const { present } = await roomNow(env, draw.chain, now);
      if (!present.length) return fail(400, "nobody_here");
      if (now < FORCE_AT && !body.force && !draw.chain.every((n) => present.includes(n))) return fail(403, "too_early");
      const s = await startRoom(env, present, me.manager);
      await logAction(env, me.manager, "santa", `Secret Santa: started the Room with ${present.length} of ${draw.chain.length}`);
      // Anyone who missed it: their envelope waits for them.
      const missed = draw.chain.filter((n) => !s.crew.includes(n));
      if (missed.length && ctx) ctx.waitUntil(Promise.allSettled(missed.map((n) => broadcast(env, { title: "The reveal started without you", body: "Your envelope is waiting on the Secret Santa page.", url: "secret-santa.html", tag: "santa-room" }, n))));
      return { status: 200, body: { ok: true, start: s.at } };
    }
    case "host": {
      // Unwrap night, hosted: start it (step 0), move it a beat (step), or call it off (on: false).
      // The last beat unmasks the whole loop for good.
      if (!start || now < start.at) return fail(403, "not_started");
      if (set.unmasked) return fail(403, "unmasked");
      const draw = await getSetting(env, "santa_draw");
      if (body.on === false) { await setSetting(env, "santa", { ...set, host: null }); await logAction(env, me.manager, "santa", "Secret Santa: called off the hosted Unwrap night"); return { status: 200, body: { ok: true, host: null } }; }
      const max = 3 * draw.chain.length, step = Math.max(0, Math.min(max, Number.isInteger(body.step) ? body.step : 0));
      if (!set.host) await logAction(env, me.manager, "santa", "Secret Santa: started the hosted Unwrap night");
      if (step >= max) {
        await setSetting(env, "santa", { ...set, host: { step, by: me.manager }, unmasked: now });
        await saveHof(env);
        await logAction(env, me.manager, "santa", "Secret Santa: the hosted Unwrap night finished; everyone is unmasked");
        return { status: 200, body: { ok: true, done: true } };
      }
      await setSetting(env, "santa", { ...set, host: { step, by: me.manager } });
      return { status: 200, body: { ok: true, step } };
    }
    case "rehearsal_reset": {
      // Clears the rehearsal Room so it can run again.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM site_settings WHERE k IN ('santa_start_rh', 'santa_drop_rh')"),
        env.DB.prepare("DELETE FROM santa_room WHERE manager LIKE 'rh:%'"),
        env.DB.prepare("DELETE FROM santa_events WHERE manager LIKE 'rh:%'"),
      ]);
      return { status: 200, body: { ok: true } };
    }
    case "unmask": {
      if (!start || now < start.at) return fail(403, "not_started");
      await setSetting(env, "santa", { ...set, unmasked: body.on === false ? null : now });
      await saveHof(env);
      await logAction(env, me.manager, "santa", body.on === false ? "Secret Santa: hid the loop again" : "Secret Santa: unmasked everyone");
      return { status: 200, body: { ok: true } };
    }
    case "shirty": {
      // Seal a category's envelope (its winners go to everyone), or reopen it (open: true).
      const c = SHIRTY[body.cat];
      if (!c) return fail(400, "bad_cat");
      if (!set.unmasked) return fail(403, "not_unmasked");
      const draw = await getSetting(env, "santa_draw");
      const shirtys = { ...(set.shirtys || {}) };
      if (body.open) delete shirtys[c.key];
      else shirtys[c.key] = { ...(await shirtyResult(env, c.key, draw.chain, set)), at: now, by: me.manager };
      await setSetting(env, "santa", { ...set, shirtys });
      await saveHof(env);
      await logAction(env, me.manager, "santa", body.open ? `Secret Santa: reopened the ${c.label} vote` : `Secret Santa: sealed the ${c.label} envelope`);
      return { status: 200, body: { ok: true, result: shirtys[c.key] || null } };
    }
    case "remind": {
      const draw = await getSetting(env, "santa_draw");
      const who = draw ? draw.chain : [];
      if (!who.length) return fail(400, "no_draw");
      let text;
      if (!start) text = "Reveal night is Fri, Nov 13 at 9:00 PM ET. Everyone opens together in the Room.";
      else if (!set.unmasked) text = set.purchaseBy ? `Buy your shirt by ${fmtDay(set.purchaseBy)}, then mark it bought on the Secret Santa page.` : "Buy your shirt and mark it bought on the Secret Santa page.";
      else text = "The loop is unmasked. See who had who.";
      const r = await Promise.allSettled(who.map((n) => broadcast(env, { title: "Secret Santa", body: text, url: "secret-santa.html", tag: "santa-remind" }, n)));
      await logAction(env, me.manager, "santa", `Secret Santa: reminded everyone (${text})`);
      return { status: 200, body: { ok: true, devices: r.reduce((a, x) => a + ((x.value && x.value.devices) || 0), 0) } };
    }
  }
  return fail(400, "bad_action");
}

export const SANTA_ROUTES = {
  "/santa": { GET: status, POST: save },
  "/santa/nudge": { POST: nudge },
  "/santa/remind": { POST: remind },
  "/santa/room": { POST: room },
  "/santa/opened": { POST: opened },
  "/santa/gift": { POST: saveGift },
  "/santa/board": { POST: saveBoard },
  "/santa/msg": { POST: msg },
  "/santa/guess": { POST: guess },
  "/santa/photo": { GET: photoGet, POST: photoPost },
  "/santa/vote": { POST: vote },
  "/santa/hof": { GET: hof },
  "/santa/prop": { POST: prop },
  "/santa/rsvp": { POST: rsvpPost },
  "/santa/wall": { POST: wallPost },
  "/santa/host": { GET: hostGet },
  "/santa/had": { POST: hadPost },
  "/santa/rate": { POST: ratePost },
  "/santa/admin": { POST: admin },
};
