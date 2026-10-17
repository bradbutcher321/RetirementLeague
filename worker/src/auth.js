/**
 * Manager sign-in (site audit III #24).
 *
 * "This is me" is a setting on each phone, which anyone can change. This is
 * the real thing: the commissioner texts each manager a link, the link signs
 * that browser in, and the site then knows who is asking.
 *
 * Each manager has two things, both worked out from AUTH_SECRET, the
 * manager's name and their reset count, so neither is stored anywhere:
 *   - a link key (16 characters), which only ever travels in the texted link
 *   - an app code (8 characters), which the website shows a signed-in
 *     manager so they can type or paste it into the Home Screen app (a link
 *     opens Safari, and the app keeps its own storage)
 * Either one is swapped for a key of that browser's own (a random token;
 * only its hash is kept, in auth_sessions). Reset adds one to the count,
 * which replaces the link and the code together, and drops every session.
 *
 * POST /auth/claim   { code, kind }  -> { token, manager }; code is a link
 *                    key or an app code, kind is "web" or "app"
 * GET  /auth/me      Authorization: Bearer <token> -> { manager, kind };
 *                    ?code=1 adds the app code
 * POST /auth/signout Authorization: Bearer <token>
 * POST /auth/admin   { pin, action, ... } -> the Commissioner page. A signed-in
 *                    commissioner needs no PIN; anyone else sends the PIN:
 *                      list  { names }   -> every manager's link key, where
 *                                           they're signed in, and their role
 *                      sent  { manager } -> notes that the text went out
 *                      reset { manager } -> new link and code, signed out
 *                      role  { manager, commissioner } -> Brad or Jon only,
 *                                           signed in (never by PIN); neither
 *                                           of them can be removed (roles.js)
 *
 * Other routes call sessionManager() to learn who is asking.
 *
 * Requires:
 *   - Secret:  AUTH_SECRET (wrangler secret put AUTH_SECRET; any long random
 *              string -- changing it replaces every link and code at once)
 *   - Secret:  PARLAY_PIN  (the Commissioner page's PIN)
 *   - Tables auth_managers and auth_sessions in DB (schema.sql)
 *   - KV namespace COOLDOWN_KV, for the wrong-code lockout
 */
import { checkPin } from "./parlayEntry.js";
import { FOUNDERS, commissioners, isCommissioner, logAction, setCommissioner } from "./roles.js";

// No 0/O or 1/I/L: nothing to misread off a screen or mistype.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const KEY_LEN = 16;
const CODE_LEN = 8;
// Ten wrong codes from one address locks that address out for an hour.
// Per address, so one person's fat thumbs can't lock out the league.
const MAX_FAILS = 10;
const LOCK_SECONDS = 3600;
// A session's last-seen time is only rewritten once it's this stale.
const SEEN_EVERY_MS = 60 * 60 * 1000;
// Sessions nobody has used in this long are dropped at the next sign-in
// (Safari forgets a site it hasn't visited in a week; its key lingers here).
const STALE_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_NAMES = 30;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function same(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/** `n` characters of ALPHABET from HMAC(AUTH_SECRET, label). Bytes of 248
 * and up are skipped so every character is equally likely. */
async function derive(env, label, n) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  let out = "";
  for (let round = 0; out.length < n; round++) {
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${label}:${round}`)));
    for (const b of mac) if (b < 248 && out.length < n) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}
const linkKey = (env, m) => derive(env, `link:${m.manager}:${m.gen}`, KEY_LEN);
const appCode = (env, m) => derive(env, `code:${m.manager}:${m.gen}`, CODE_LEN);

const bearer = (request) => (request.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/)?.[1] || "";

/** Who is asking: { manager, kind, hash } for a signed-in request, else null. */
export async function sessionManager(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT manager, kind, seen FROM auth_sessions WHERE token_hash = ?1").bind(hash).first();
  if (!row) return null;
  const now = Date.now();
  if (now - row.seen > SEEN_EVERY_MS) {
    await env.DB.prepare("UPDATE auth_sessions SET seen = ?1 WHERE token_hash = ?2").bind(now, hash).run();
  }
  return { manager: row.manager, kind: row.kind, hash };
}

async function claim(request, env) {
  if (!env.AUTH_SECRET) return { status: 503, body: { error: "not_configured" } };
  const body = await request.json().catch(() => null);
  const given = String((body && body.code) || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (given.length !== KEY_LEN && given.length !== CODE_LEN) return { status: 400, body: { error: "bad_code" } };

  const failKey = `auth:fails:${request.headers.get("CF-Connecting-IP") || "unknown"}`;
  const fails = Number(await env.COOLDOWN_KV.get(failKey)) || 0;
  if (fails >= MAX_FAILS) return { status: 429, body: { error: "locked" } };

  const { results } = await env.DB.prepare("SELECT manager, gen FROM auth_managers").all();
  let who = null;
  // Every manager is checked, match or not, so the time taken says nothing.
  for (const m of results) {
    const want = given.length === KEY_LEN ? await linkKey(env, m) : await appCode(env, m);
    if (same(given, want)) who = m;
  }
  if (!who) {
    await env.COOLDOWN_KV.put(failKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    return { status: 403, body: { error: "wrong_code", triesLeft: MAX_FAILS - fails - 1 } };
  }

  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE seen < ?1").bind(now - STALE_MS),
    env.DB.prepare("INSERT INTO auth_sessions (token_hash, manager, kind, created, seen) VALUES (?1, ?2, ?3, ?4, ?4)")
      .bind(await sha256(token), who.manager, body.kind === "app" ? "app" : "web", now),
  ]);
  return { status: 200, body: { token, manager: who.manager, commissioner: await isCommissioner(env, who.manager) } };
}

async function me(request, env) {
  const s = await sessionManager(request, env);
  if (!s) return { status: 401, body: { error: "signed_out" } };
  const out = { manager: s.manager, kind: s.kind, commissioner: await isCommissioner(env, s.manager) };
  if (new URL(request.url).searchParams.get("code") === "1" && env.AUTH_SECRET) {
    const m = await env.DB.prepare("SELECT manager, gen FROM auth_managers WHERE manager = ?1").bind(s.manager).first();
    if (m) out.code = await appCode(env, m);
  }
  return { status: 200, body: out };
}

async function signout(request, env) {
  const token = bearer(request);
  if (token) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?1").bind(await sha256(token)).run();
  return { status: 200, body: { ok: true } };
}

/** Who may use the Commissioner page: a signed-in commissioner, with no PIN,
 * or anyone who has the PIN. -> { who } (who is the manager's name, null for
 * the PIN) or { denied } (the response to send back). Shared with admin.js. */
export async function commissionerGate(request, env, body) {
  const me = await sessionManager(request, env).catch(() => null);
  if (me && (await isCommissioner(env, me.manager))) return { who: me.manager };
  // No PIN sent at all isn't a guess, so it doesn't count toward the lockout.
  if (!body || !body.pin) return { denied: { status: 403, body: { error: "pin_needed" } } };
  const denied = await checkPin(env, body.pin);
  return denied ? { denied } : { who: null };
}

/** One manager as the Commissioner page shows them. */
async function adminRow(env, m, sessions, commish) {
  const mine = sessions.filter((s) => s.manager === m.manager);
  return {
    manager: m.manager,
    key: await linkKey(env, m),
    sentAt: m.sent_at || null,
    web: mine.filter((s) => s.kind !== "app").length,
    app: mine.filter((s) => s.kind === "app").length,
    lastSeen: mine.reduce((t, s) => Math.max(t, s.seen || 0), 0) || null,
    commissioner: commish.includes(m.manager),
    founder: FOUNDERS.includes(m.manager),
  };
}

/** Makes sure every name has a row (the page passes this season's managers). */
export async function ensureManagers(env, names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === "string" && n && n.length <= 40).slice(0, MAX_NAMES);
  if (list.length) await env.DB.batch(list.map((n) => env.DB.prepare("INSERT OR IGNORE INTO auth_managers (manager) VALUES (?1)").bind(n)));
  return list;
}

async function admin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return { status: 400, body: { error: "bad_json" } };
  const gate = await commissionerGate(request, env, body);
  if (gate.denied) return gate.denied;
  if (!env.AUTH_SECRET) return { status: 503, body: { error: "not_configured" } };
  const by = gate.who;

  const name = typeof body.manager === "string" ? body.manager.slice(0, 40) : "";
  if (body.action === "list") {
    const names = await ensureManagers(env, body.names);
    if (!names.length) return { status: 400, body: { error: "no_names" } };
    const [managers, sessions, commish] = await Promise.all([
      env.DB.prepare("SELECT manager, gen, sent_at FROM auth_managers").all(),
      env.DB.prepare("SELECT manager, kind, seen FROM auth_sessions").all(),
      commissioners(env),
    ]);
    const rows = managers.results.filter((m) => names.includes(m.manager));
    return { status: 200, body: { me: by, founder: !!by && FOUNDERS.includes(by), managers: await Promise.all(rows.map((m) => adminRow(env, m, sessions.results, commish))) } };
  }
  if (body.action === "sent" && name) {
    await env.DB.prepare("UPDATE auth_managers SET sent_at = ?1 WHERE manager = ?2").bind(Date.now(), name).run();
    await logAction(env, by, "signin", `Sent ${name} a sign-in text`);
    return { status: 200, body: { ok: true } };
  }
  if (body.action === "reset" && name) {
    const [, , fresh] = await env.DB.batch([
      env.DB.prepare("UPDATE auth_managers SET gen = gen + 1, sent_at = NULL WHERE manager = ?1").bind(name),
      env.DB.prepare("DELETE FROM auth_sessions WHERE manager = ?1").bind(name),
      env.DB.prepare("SELECT manager, gen, sent_at FROM auth_managers WHERE manager = ?1").bind(name),
    ]);
    if (!fresh.results.length) return { status: 404, body: { error: "no_manager" } };
    await logAction(env, by, "signin", `Reset ${name}'s sign-in`);
    return { status: 200, body: { manager: await adminRow(env, fresh.results[0], [], await commissioners(env)) } };
  }
  // Only Brad and Jon, signed in (not by PIN), can make or remove a commissioner,
  // and neither of them can be removed.
  if (body.action === "role" && name && typeof body.commissioner === "boolean") {
    if (!by || !FOUNDERS.includes(by)) return { status: 403, body: { error: "founders_only" } };
    if (FOUNDERS.includes(name)) return { status: 403, body: { error: "founder_locked" } };
    const known = await env.DB.prepare("SELECT 1 AS x FROM auth_managers WHERE manager = ?1").bind(name).first();
    if (!known) return { status: 404, body: { error: "no_manager" } };
    await setCommissioner(env, name, body.commissioner, by);
    await logAction(env, by, "role", body.commissioner ? `Made ${name} a commissioner` : `Removed ${name} as a commissioner`);
    return { status: 200, body: { ok: true, commissioner: body.commissioner } };
  }
  return { status: 400, body: { error: "bad_action" } };
}

export const AUTH_ROUTES = {
  "/auth/claim": ["POST", claim],
  "/auth/me": ["GET", me],
  "/auth/signout": ["POST", signout],
  "/auth/admin": ["POST", admin],
};
