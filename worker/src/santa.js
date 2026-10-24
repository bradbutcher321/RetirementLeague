/**
 * Secret Santa sign-ups (docs/secret-santa.html).
 *
 * Each signed-in manager fills in one card: where to ship a shirt if the
 * in-person event can't happen, their shirt size, the colors they prefer,
 * and the December days they could meet up. Sign-ups run from Nov 1 to
 * Nov 14, Eastern (the card closes at 12 AM Nov 15). Brad and Jon can save
 * outside that window so they can try the page.
 *
 * GET  /santa                       Authorization: Bearer <key> (optional)
 *   -> { open, signed: [names], dates: { "2026-12-05": 3 }, mine }
 *   Who is in and how many people can make each day are the same for
 *   everyone. `mine` is your own card (address included), or null; nobody
 *   else's address, size or colors is ever sent.
 * POST /santa                       Authorization: Bearer <key>
 *   { name, street, apt, city, state, zip, size, colors: [], dates: [] }
 *   Saves your card (a second save replaces the first). Size and the five
 *   address parts are required.
 * POST /santa/nudge { manager }     Authorization: Bearer <key>
 *   Pushes a reminder to a manager who hasn't signed up, if they have
 *   notifications on. Once a day per person, whoever sends it.
 *
 * The table is `santa_cards` in schema.sql (analytics D1).
 */
import { sessionManager } from "./auth.js";
import { broadcast } from "./push.js";
import { isCommissioner } from "./roles.js";

export const SIZES = ["S", "M", "L", "XL", "2XL", "3XL"];
export const COLORS = ["Black", "White", "Navy", "Light Blue", "Light Pink", "Natural", "Sport Grey", "Yellow Haze", "Forest Green"];
// Sign-ups open 12:00 AM Nov 1 EDT and close 12:00 AM Nov 15 EST.
export const OPENS = Date.parse("2026-11-01T00:00:00-04:00");
export const CLOSES = Date.parse("2026-11-15T00:00:00-05:00");
const DECEMBER = /^2026-12-(0[1-9]|[12]\d|3[01])$/;
const NUDGE_SECONDS = 24 * 60 * 60;

const fail = (status, error) => ({ status, body: { error } });
const clip = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const mineRow = (r) => ({
  name: r.name, street: r.street, apt: r.apt || "", city: r.city, state: r.state, zip: r.zip,
  size: r.size, colors: JSON.parse(r.colors || "[]"), dates: JSON.parse(r.dates || "[]"), updated: r.updated,
});

async function status(request, env) {
  const [me, rows] = await Promise.all([
    sessionManager(request, env).catch(() => null),
    env.DB.prepare("SELECT manager, name, street, apt, city, state, zip, size, colors, dates, updated FROM santa_cards").all(),
  ]);
  const dates = {};
  let mine = null;
  for (const r of rows.results) {
    for (const d of JSON.parse(r.dates || "[]")) dates[d] = (dates[d] || 0) + 1;
    if (me && r.manager === me.manager) mine = mineRow(r);
  }
  const now = Date.now();
  return { status: 200, body: { open: now >= OPENS && now < CLOSES, opens: OPENS, closes: CLOSES, signed: rows.results.map((r) => r.manager), dates, mine } };
}

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

async function nudge(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const body = await request.json().catch(() => null);
  const to = clip(body && body.manager, 40);
  if (!to || to === me.manager) return fail(400, "bad_manager");
  const now = Date.now();
  if (now < OPENS || now >= CLOSES) return fail(403, now < OPENS ? "not_open" : "closed");
  const known = await env.DB.prepare("SELECT 1 AS x FROM auth_managers WHERE manager = ?1").bind(to).first();
  if (!known) return fail(404, "no_manager");
  if (await env.DB.prepare("SELECT 1 AS x FROM santa_cards WHERE manager = ?1").bind(to).first()) return fail(409, "already_in");
  const key = `santa:nudge:${to}`;
  if (await env.COOLDOWN_KV.get(key)) return fail(429, "nudged_today");
  await env.COOLDOWN_KV.put(key, "1", { expirationTtl: NUDGE_SECONDS });
  const r = await broadcast(env, { title: "Secret Santa", body: `${me.manager} says you haven't signed up yet.`, url: "secret-santa.html", tag: "santa-nudge" }, to).catch(() => ({ devices: 0 }));
  return { status: 200, body: { ok: true, devices: r.devices || 0 } };
}

export const SANTA_ROUTES = {
  "/santa": { GET: status, POST: save },
  "/santa/nudge": { POST: nudge },
};
