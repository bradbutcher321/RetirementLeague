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
 *    sends a heartbeat; when they're all here the Room starts itself (10
 *    seconds out, so every phone counts down together). From 9:30 a
 *    commissioner can start it with whoever is here. Once it has started,
 *    everyone gets their own giftee; anyone who missed it opens theirs alone.
 * 4. Gifting: each Santa records their shirt and its order, estimated and
 *    delivered dates (santa_gifts); everyone sees totals only. Plus an
 *    anonymous mailbox between each Santa and giftee, and a guess at who
 *    your Santa is.
 * 5. Unwrap night: a commissioner unmasks, and the whole loop, every shirt
 *    and every guess go out to everyone.
 *
 * GET  /santa                Authorization optional; see status() for the shape.
 * POST /santa                your card (sign-ups)
 * POST /santa/nudge          { manager, kind: "signup" | "buy" }
 * POST /santa/remind         { on }  the 15-minute reminder before the reveal
 * POST /santa/room           { holding?, react?, after? }  the Room's heartbeat
 * POST /santa/opened         { inRoom }  you watched your envelope open
 * POST /santa/gift           { shirt, title, url, size, ordered, eta, delivered } or { clear: true }
 * POST /santa/msg            { to: "giftee" | "santa", text }
 * POST /santa/guess          { guess }  (null clears it)
 * POST /santa/admin          commissioners: { action: "dates" | "ship" | "draw" | "start" | "unmask" | "remind", ... }
 *
 * Tables are in schema.sql (analytics D1): santa_cards, santa_people,
 * santa_room, santa_events, santa_gifts, santa_msgs.
 */
import { sessionManager } from "./auth.js";
import { broadcast } from "./push.js";
import { getSetting, isCommissioner, logAction, setSetting } from "./roles.js";

export const SIZES = ["S", "M", "L", "XL", "2XL", "3XL"];
export const COLORS = ["Black", "White", "Navy", "Light Blue", "Light Pink", "Natural", "Sport Grey", "Yellow Haze", "Forest Green"];
// Sign-ups open 12:00 AM Nov 1 EDT and close 12:00 AM Nov 13 EST (Nov 12 is the last day).
export const OPENS = Date.parse("2026-11-01T00:00:00-04:00");
export const CLOSES = Date.parse("2026-11-13T00:00:00-05:00");
// Reveal night: the Room opens at 9:00 PM ET Fri, Nov 13; a commissioner can start it from 9:30.
export const REVEAL = Date.parse("2026-11-13T21:00:00-05:00");
export const FORCE_AT = REVEAL + 30 * 60 * 1000;
const REMIND_AT = REVEAL - 15 * 60 * 1000;
const DECEMBER = /^2026-12-(0[1-9]|[12]\d|3[01])$/;
const DAY = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const NUDGE_SECONDS = 24 * 60 * 60;
const HERE_MS = 12 * 1000;      // a heartbeat this recent means you're in the Room
const HOLDING_MS = 3 * 1000;    // and this recent while holding the seal
const START_DELAY = 10 * 1000;  // the countdown every phone shows before the lights go down
const EMOJI = ["🎁", "🔥", "😂", "👀", "🎄"];
const SHIRTS = 957;             // docs/data/santa-shirts.json

const fail = (status, error) => ({ status, body: { error } });
const clip = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const day = (v) => (typeof v === "string" && DAY.test(v) ? v : null);
const mineRow = (r) => ({
  name: r.name, street: r.street, apt: r.apt || "", city: r.city, state: r.state, zip: r.zip,
  size: r.size, colors: JSON.parse(r.colors || "[]"), dates: JSON.parse(r.dates || "[]"), updated: r.updated,
});
const giftRow = (r) => r && ({ shirt: r.shirt, title: r.title || "", url: r.url || "", size: r.size || "", price: r.price, ordered: r.ordered, eta: r.eta, delivered: r.delivered, updated: r.updated });

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
  return { purchaseBy: null, eventAt: null, ship: false, unmasked: null, ...(await getSetting(env, "santa", {})) };
}

/** Everything the page shows. Who's in, the day counts, the draw's date, the
 * Room, who opened, the gift totals and the commissioners' dates are the same
 * for everyone. Your own card, your giftee (once the Room has started), your
 * gift, your mailbox and your guess are only ever sent to you. Commissioners
 * also get a status row per manager, which never says who has whom. */
async function status(request, env) {
  const now = Date.now();
  const me = await sessionManager(request, env).catch(() => null);
  const [rows, people, gifts, set, start] = await Promise.all([
    env.DB.prepare("SELECT manager, name, street, apt, city, state, zip, size, colors, dates, updated FROM santa_cards").all(),
    env.DB.prepare("SELECT manager, remind, seen, opened, in_room, guess FROM santa_people").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT * FROM santa_gifts").all().catch(() => ({ results: [] })),
    settings(env),
    getSetting(env, "santa_start"),
  ]);
  const cards = Object.fromEntries(rows.results.map((r) => [r.manager, r]));
  const signed = rows.results.map((r) => r.manager);
  const draw = await ensureDraw(env, signed);
  const chain = draw ? draw.chain : [];
  const ppl = Object.fromEntries(people.results.map((r) => [r.manager, r]));
  const gift = Object.fromEntries(gifts.results.map((r) => [r.santa, r]));
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
    start: start ? start.at : null, started, unmasked: set.unmasked,
    purchaseBy: set.purchaseBy, eventAt: set.eventAt, ship: !!set.ship,
    opened: people.results.filter((r) => r.opened).map((r) => r.manager),
    seen,
    totals: { bought: chain.filter((n) => gift[n] && gift[n].ordered).length, delivered: chain.filter((n) => gift[n] && gift[n].delivered).length, total: chain.length },
    remind: me ? (ppl[me.manager] ? !!ppl[me.manager].remind : true) : null,
  };

  if (me && started && chain.includes(me.manager)) {
    const g = gifteeOf(chain, me.manager), s = santaOf(chain, me.manager), c = cards[g];
    const msgs = await env.DB.prepare(
      "SELECT santa, giftee, from_santa, text, at FROM santa_msgs WHERE (santa = ?1 AND giftee = ?2) OR (santa = ?3 AND giftee = ?1) ORDER BY id"
    ).bind(me.manager, g, s).all().catch(() => ({ results: [] }));
    body.you = {
      giftee: c ? {
        name: g, size: c.size, colors: JSON.parse(c.colors || "[]"),
        ...(set.ship ? { address: { name: c.name, street: c.street, apt: c.apt || "", city: c.city, state: c.state, zip: c.zip } } : {}),
      } : { name: g },
      gift: giftRow(gift[me.manager]) || null,
      guess: ppl[me.manager] ? ppl[me.manager].guess : null,
      opened: !!(ppl[me.manager] && ppl[me.manager].opened),
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
    };
  }

  if (me && (await isCommissioner(env, me.manager))) {
    body.commish = (chain.length ? chain : signed).slice().sort().map((n) => ({
      manager: n, card: !!cards[n], opened: ppl[n] ? ppl[n].opened : null,
      ordered: gift[n] ? gift[n].ordered : null, eta: gift[n] ? gift[n].eta : null, delivered: gift[n] ? gift[n].delivered : null,
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
 * are open) or hasn't marked their shirt bought (commissioners, after the
 * Room). Once a day per person and kind, whoever sends it. */
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
    // Reveal night, before the Room starts: anyone can call someone in.
    if (now < REVEAL - 5 * 60 * 1000 || (await getSetting(env, "santa_start"))) return fail(403, "not_now");
    message = { title: "Secret Santa", body: `${me.manager} says everyone's waiting on you in the Room.`, url: "secret-santa.html", tag: "santa-room" };
  } else {
    if (!(await isCommissioner(env, me.manager))) return fail(403, "not_commissioner");
    const g = await env.DB.prepare("SELECT ordered FROM santa_gifts WHERE santa = ?1").bind(to).first();
    if (g && g.ordered) return fail(409, "already_bought");
    const set = await settings(env);
    message = { title: "Secret Santa", body: `Your shirt isn't marked bought yet.${set.purchaseBy ? ` Buy it by ${fmtDay(set.purchaseBy)}.` : ""}`, url: "secret-santa.html", tag: "santa-buy" };
  }
  // The Room's call-in can go again after 5 minutes; the others once a day.
  const key = `santa:nudge:${kind}:${to}`;
  if (await env.COOLDOWN_KV.get(key)) return fail(429, "nudged_today");
  await env.COOLDOWN_KV.put(key, "1", { expirationTtl: kind === "room" ? 300 : NUDGE_SECONDS });
  const r = await broadcast(env, message, to).catch(() => ({ devices: 0 }));
  return { status: 200, body: { ok: true, devices: r.devices || 0 } };
}
const fmtDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

// ---------- Reveal night ----------
async function remind(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const body = await request.json().catch(() => ({}));
  const on = body.on ? 1 : 0;
  await env.DB.prepare("INSERT INTO santa_people (manager, remind) VALUES (?1, ?2) ON CONFLICT(manager) DO UPDATE SET remind = excluded.remind").bind(me.manager, on).run();
  return { status: 200, body: { ok: true, remind: !!on } };
}

/** The 15-minute push, from the cron's first run in the window (scheduled() in index.js). */
export async function checkSantaReminder(env, now = Date.now()) {
  if (now < REMIND_AT || now >= REVEAL || !env.VAPID_PRIVATE_JWK) return;
  const key = "santa:remind:2026";
  if (await env.DB.prepare("SELECT 1 AS x FROM push_sent WHERE k = ?1").bind(key).first()) return;
  await env.DB.prepare("INSERT OR IGNORE INTO push_sent (k, ts) VALUES (?1, ?2)").bind(key, now).run();
  const draw = await getSetting(env, "santa_draw");
  if (!draw) return;
  const { results } = await env.DB.prepare("SELECT manager FROM santa_people WHERE remind = 0").all();
  const off = new Set(results.map((r) => r.manager));
  const message = { title: "Secret Santa starts in 15 minutes", body: "The Room opens at 9:00 PM. Everyone opens their envelope together.", url: "secret-santa.html", tag: "santa-remind" };
  await Promise.allSettled(draw.chain.filter((n) => !off.has(n)).map((n) => broadcast(env, message, n)));
}

/** Who's in the Room now: in the draw, with a heartbeat in the last 12 seconds. */
async function roomNow(env, chain, now) {
  const { results } = await env.DB.prepare("SELECT manager, seen, holding FROM santa_room").all();
  const live = results.filter((r) => chain.includes(r.manager) && now - r.seen < HERE_MS);
  return { present: live.map((r) => r.manager), holding: live.filter((r) => r.holding && now - r.seen < HOLDING_MS).map((r) => r.manager) };
}
async function startRoom(env, crew, by) {
  const value = { at: Date.now() + START_DELAY, crew, by };
  await env.DB.prepare("INSERT OR IGNORE INTO site_settings (k, v, updated) VALUES ('santa_start', ?1, ?2)").bind(JSON.stringify(value), Date.now()).run();
  return getSetting(env, "santa_start");
}

/** The Room's heartbeat. Every few seconds from everyone on the page from
 * 9:00 PM, and about every 0.7s while holding the seal. -> { present,
 * holding, start: { at, crew } | null, events, giftee (once started) } */
async function room(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const now = Date.now();
  if (now < REVEAL - 5 * 60 * 1000) return fail(403, "not_yet");
  const draw = await getSetting(env, "santa_draw");
  if (!draw) return fail(403, "no_draw");
  const body = await request.json().catch(() => ({}));
  // Someone who isn't in the draw can watch, but doesn't take a seat.
  if (draw.chain.includes(me.manager)) {
    const holding = body.holding ? 1 : 0;
    const was = await env.DB.prepare("SELECT seen FROM santa_room WHERE manager = ?1").bind(me.manager).first();
    const writes = [env.DB.prepare("INSERT INTO santa_room (manager, seen, holding) VALUES (?1, ?2, ?3) ON CONFLICT(manager) DO UPDATE SET seen = excluded.seen, holding = excluded.holding").bind(me.manager, now, holding)];
    if (!was || now - was.seen >= HERE_MS) writes.push(env.DB.prepare("INSERT INTO santa_events (manager, kind, at) VALUES (?1, 'join', ?2)").bind(me.manager, now));
    if (EMOJI.includes(body.react)) writes.push(env.DB.prepare("INSERT INTO santa_events (manager, kind, emoji, at) VALUES (?1, 'react', ?2, ?3)").bind(me.manager, body.react, now));
    await env.DB.batch(writes);
  }

  const { present, holding: holders } = await roomNow(env, draw.chain, now);
  let start = await getSetting(env, "santa_start");
  // Everyone's here: start in 10 seconds.
  if (!start && now >= REVEAL && draw.chain.every((n) => present.includes(n))) start = await startRoom(env, draw.chain, "everyone");
  const after = Number(body.after) || 0;
  const { results: events } = await env.DB.prepare("SELECT id, manager, kind, emoji, at FROM santa_events WHERE id > ?1 AND at > ?2 ORDER BY id DESC LIMIT 20").bind(after, now - 10 * 60 * 1000).all();
  const out = { present, holding: holders, start: start ? { at: start.at, crew: start.crew } : null, now, events: events.reverse() };
  if (start && now >= start.at - START_DELAY && draw.chain.includes(me.manager)) {
    const g = gifteeOf(draw.chain, me.manager);
    const c = await env.DB.prepare("SELECT size, colors FROM santa_cards WHERE manager = ?1").bind(g).first();
    out.giftee = { name: g, size: c ? c.size : "", colors: c ? JSON.parse(c.colors || "[]") : [] };
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
    ordered: day(body.ordered), eta: day(body.eta), delivered: day(body.delivered),
  };
  if (shirt == null && !g.title && !g.url) return fail(400, "no_shirt");
  if (!g.ordered) return fail(400, "no_order_date");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO santa_gifts (santa, shirt, title, url, size, price, ordered, eta, delivered, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(santa) DO UPDATE SET shirt = excluded.shirt, title = excluded.title, url = excluded.url, size = excluded.size, price = excluded.price,
       ordered = excluded.ordered, eta = excluded.eta, delivered = excluded.delivered, updated = excluded.updated`
  ).bind(p.me.manager, g.shirt, g.title, g.url, g.size, g.price, g.ordered, g.eta, g.delivered, now).run();
  return { status: 200, body: { ok: true, gift: { ...g, updated: now } } };
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
  const santa = toGiftee ? p.me.manager : santaOf(p.chain, p.me.manager);
  const giftee = toGiftee ? gifteeOf(p.chain, p.me.manager) : p.me.manager;
  const now = Date.now();
  await env.DB.prepare("INSERT INTO santa_msgs (santa, giftee, from_santa, text, at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(santa, giftee, toGiftee ? 1 : 0, text, now).run();
  const to = toGiftee ? giftee : santa;
  await broadcast(env, { title: toGiftee ? "Your Secret Santa wrote you" : `${p.me.manager} wrote back`, body: text.slice(0, 120), url: "secret-santa.html#mailbox", tag: "santa-msg" }, to).catch(() => {});
  return { status: 200, body: { ok: true, at: now } };
}

async function guess(request, env) {
  const p = await participant(request, env);
  if (p.error) return p.error;
  const set = await settings(env);
  if (set.unmasked || (set.eventAt && Date.now() >= set.eventAt)) return fail(403, "locked");
  const body = await request.json().catch(() => ({}));
  const g = body.guess == null ? null : clip(body.guess, 40);
  if (g != null && (!p.chain.includes(g) || g === p.me.manager)) return fail(400, "bad_guess");
  await env.DB.prepare("INSERT INTO santa_people (manager, guess) VALUES (?1, ?2) ON CONFLICT(manager) DO UPDATE SET guess = excluded.guess").bind(p.me.manager, g).run();
  return { status: 200, body: { ok: true, guess: g } };
}

// ---------- Commissioners ----------
async function admin(request, env) {
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
      await setSetting(env, "santa", { ...set, purchaseBy, eventAt });
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
      if (now < FORCE_AT) return fail(403, "too_early");
      if (start) return { status: 200, body: { ok: true, start: start.at } };
      const draw = await getSetting(env, "santa_draw");
      if (!draw) return fail(400, "no_draw");
      const { present } = await roomNow(env, draw.chain, now);
      const s = await startRoom(env, present, me.manager);
      await logAction(env, me.manager, "santa", `Secret Santa: started the Room with ${present.length} of ${draw.chain.length}`);
      return { status: 200, body: { ok: true, start: s.at } };
    }
    case "unmask": {
      if (!start || now < start.at) return fail(403, "not_started");
      await setSetting(env, "santa", { ...set, unmasked: body.on === false ? null : now });
      await logAction(env, me.manager, "santa", body.on === false ? "Secret Santa: hid the loop again" : "Secret Santa: unmasked everyone");
      return { status: 200, body: { ok: true } };
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
  "/santa/msg": { POST: msg },
  "/santa/guess": { POST: guess },
  "/santa/admin": { POST: admin },
};
