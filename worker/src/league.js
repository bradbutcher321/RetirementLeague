/**
 * The commissioner tools added in site audit X (#18-#23), kept in
 * site_settings (roles.js getSetting/setSetting) so none of them needed a
 * new table:
 *
 *   lore        { eggs: [{ t, on }], pin: { t, until } | null }
 *               League Lore's easter eggs, editable from a phone (#18).
 *               Until the first save the dashboard keeps its built-in list.
 *   column_fix  { hidden: [id], edits: { id: { headline, dek } } }
 *               The Column's quick fixes (#19): pull one down, fix its
 *               headline or dek. column.json itself is untouched.
 *   poll        { id, q, options, closes, closed, by, at, votes: { manager: i } }
 *   polls_past  the last ten closed polls (#20)
 *   push_later  [{ id, at, title, body, to, url, by }] (#23), sent by the cron
 *
 * POST /admin actions (admin.js passes anything it doesn't know here):
 *   lore_get / lore_set { eggs, pin }
 *   column_get / column_set { id, hidden?, headline?, dek? }
 *   poll_create { q, options, closes } / poll_close / poll_get
 *   push_later { title, body, to, url, at } / push_scheduled / push_cancel { id }
 * Public:
 *   GET /polls        the open (or last closed) poll, its counts and who voted;
 *                     with a signed-in key, your own vote
 *   POST /polls/vote  { id, choice } signed in
 *   siteExtras()      what /site-info adds: lore, column fixes, an open poll
 */
import { sessionManager } from "./auth.js";
import { getSetting, logAction, setSetting } from "./roles.js";
import { broadcast } from "./push.js";

const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const etDay = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));

// ---------- League Lore (#18) ----------
async function loreGet(env) {
  return { status: 200, body: { lore: await getSetting(env, "lore") } };
}
async function loreSet(env, body, who) {
  const eggs = Array.isArray(body.eggs) ? body.eggs.slice(0, 60).map((e) => ({ t: text(e && e.t, 400), on: !(e && e.on === false) })).filter((e) => e.t) : null;
  if (!eggs) return fail(400, "bad_eggs");
  const pin = body.pin && text(body.pin.t, 400) ? { t: text(body.pin.t, 400), until: /^\d{4}-\d\d-\d\d$/.test(body.pin.until || "") ? body.pin.until : null } : null;
  await setSetting(env, "lore", { eggs, pin, by: who || "PIN", at: Date.now() });
  await logAction(env, who, "lore", pin ? `Pinned a League Lore line: ${pin.t.replace(/<[^>]+>/g, "").slice(0, 60)}` : `Saved League Lore's easter eggs (${eggs.filter((e) => e.on).length} on)`);
  return { status: 200, body: { ok: true } };
}

// ---------- The Column (#19) ----------
async function columnGet(env) {
  return { status: 200, body: { fix: await getSetting(env, "column_fix", { hidden: [], edits: {} }) } };
}
async function columnSet(env, body, who) {
  const id = text(body.id, 80);
  if (!id) return fail(400, "no_id");
  const fix = await getSetting(env, "column_fix", { hidden: [], edits: {} });
  fix.hidden = fix.hidden || []; fix.edits = fix.edits || {};
  const said = [];
  if (typeof body.hidden === "boolean") {
    fix.hidden = fix.hidden.filter((x) => x !== id);
    if (body.hidden) fix.hidden.push(id);
    said.push(body.hidden ? "pulled down" : "put back up");
  }
  for (const k of ["headline", "dek"]) {
    if (body[k] === undefined) continue;
    const v = text(body[k], 300);
    const e = fix.edits[id] || (fix.edits[id] = {});
    if (v) e[k] = v; else delete e[k];
    if (!Object.keys(e).length) delete fix.edits[id];
    said.push(v ? `fixed its ${k}` : `reset its ${k}`);
  }
  await setSetting(env, "column_fix", fix);
  await logAction(env, who, "column", `The Column ${id}: ${said.join(", ") || "no change"}`);
  return { status: 200, body: { ok: true, fix } };
}

// ---------- League votes (#20) ----------
const tally = (p) => {
  const counts = p.options.map(() => 0);
  Object.values(p.votes || {}).forEach((i) => { if (counts[i] !== undefined) counts[i]++; });
  return counts;
};
const pollOut = (p, me) => p && {
  id: p.id, q: p.q, options: p.options, closes: p.closes || null, closed: !!p.closed, by: p.by, at: p.at,
  counts: tally(p), voters: Object.keys(p.votes || {}).sort(), mine: me && p.votes && p.votes[me] !== undefined ? p.votes[me] : null,
};
async function currentPoll(env) {
  const p = await getSetting(env, "poll");
  if (p && !p.closed && p.closes && Date.parse(p.closes) < Date.now()) { p.closed = true; await setSetting(env, "poll", p); }
  return p;
}
async function pollCreate(env, body, who) {
  const q = text(body.q, 160);
  const options = (Array.isArray(body.options) ? body.options : []).map((o) => text(o, 60)).filter(Boolean).slice(0, 6);
  if (!q || options.length < 2) return fail(400, "bad_poll");
  const old = await getSetting(env, "poll");
  if (old) { old.closed = true; const past = await getSetting(env, "polls_past", []); await setSetting(env, "polls_past", [old, ...past.filter((x) => x.id !== old.id)].slice(0, 10)); }
  const closes = /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(body.closes || "") ? body.closes : null;
  const p = { id: Date.now().toString(36), q, options, closes, closed: false, by: who || "PIN", at: Date.now(), votes: {} };
  await setSetting(env, "poll", p);
  await logAction(env, who, "poll", `Opened a vote: ${q}`);
  return { status: 200, body: { poll: pollOut(p) } };
}
async function pollClose(env, who) {
  const p = await getSetting(env, "poll");
  if (!p) return fail(404, "no_poll");
  p.closed = true;
  await setSetting(env, "poll", p);
  const past = await getSetting(env, "polls_past", []);
  await setSetting(env, "polls_past", [p, ...past.filter((x) => x.id !== p.id)].slice(0, 10));
  const c = tally(p), top = Math.max(...c);
  await logAction(env, who, "poll", `Closed the vote "${p.q}": ${p.options.filter((_, i) => c[i] === top).join(" / ")} ${top}`);
  return { status: 200, body: { poll: pollOut(p) } };
}
async function pollGet(env) {
  const [p, past] = await Promise.all([currentPoll(env), getSetting(env, "polls_past", [])]);
  return { status: 200, body: { poll: pollOut(p), past: past.map((x) => pollOut(x)) } };
}
async function pollsPublic(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  const p = await currentPoll(env);
  return { status: 200, body: { poll: pollOut(p, who && who.manager) } };
}
async function pollVote(request, env) {
  const who = await sessionManager(request, env).catch(() => null);
  if (!who) return fail(401, "signed_out");
  const body = await request.json().catch(() => ({}));
  const p = await currentPoll(env);
  if (!p || p.id !== body.id) return fail(404, "no_poll");
  if (p.closed) return fail(409, "closed");
  const i = Number(body.choice);
  if (!Number.isInteger(i) || i < 0 || i >= p.options.length) return fail(400, "bad_choice");
  p.votes = p.votes || {};
  p.votes[who.manager] = i;
  await setSetting(env, "poll", p);
  return { status: 200, body: { poll: pollOut(p, who.manager) } };
}

// ---------- Send later (#23) ----------
async function pushLater(env, body, who) {
  const title = text(body.title, 60), message = text(body.body, 180);
  if (!title) return fail(400, "no_title");
  const at = Date.parse(body.at || "");
  if (!Number.isFinite(at) || at < Date.now() + 60 * 1000) return fail(400, "bad_time");
  const to = Array.isArray(body.to) ? body.to.slice(0, 20).map((n) => text(n, 40)).filter(Boolean) : body.to && body.to !== "all" ? text(body.to, 40) : null;
  const list = await getSetting(env, "push_later", []);
  const item = { id: Date.now().toString(36), at, title, body: message, to, url: text(body.url, 120) || "", by: who || "PIN" };
  list.push(item);
  list.sort((a, b) => a.at - b.at);
  await setSetting(env, "push_later", list.slice(0, 30));
  await logAction(env, who, "push", `Set "${title}" to send ${new Date(at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })} ET`);
  return { status: 200, body: { ok: true, item } };
}
async function pushScheduled(env) {
  return { status: 200, body: { items: await getSetting(env, "push_later", []) } };
}
async function pushCancel(env, body, who) {
  const list = await getSetting(env, "push_later", []);
  const gone = list.find((x) => x.id === body.id);
  if (!gone) return fail(404, "not_found");
  await setSetting(env, "push_later", list.filter((x) => x.id !== body.id));
  await logAction(env, who, "push", `Cancelled "${gone.title}"`);
  return { status: 200, body: { ok: true } };
}
/** From the cron: sends whatever is due. Runs on every scheduled() call. */
export async function sendScheduledPushes(env) {
  const list = await getSetting(env, "push_later", []);
  const due = list.filter((x) => x.at <= Date.now());
  if (!due.length) return;
  await setSetting(env, "push_later", list.filter((x) => x.at > Date.now()));
  for (const x of due) {
    const out = await broadcast(env, { title: x.title, body: x.body, url: x.url || undefined }, x.to).catch((err) => ({ error: String(err) }));
    await logAction(env, x.by, "push", out.error ? `Scheduled "${x.title}" failed: ${out.error}` : `Sent "${x.title}" as scheduled (${out.sent} of ${out.devices} devices)`);
  }
}

// ---------- What /site-info adds ----------
export async function siteExtras(env) {
  const [lore, fix, p] = await Promise.all([getSetting(env, "lore"), getSetting(env, "column_fix"), getSetting(env, "poll")]);
  const pin = lore && lore.pin && (!lore.pin.until || lore.pin.until >= etDay()) ? lore.pin.t : null;
  return {
    lore: lore ? { eggs: lore.eggs.filter((e) => e.on).map((e) => e.t), pin } : null,
    columnFix: fix || null,
    poll: p && !p.closed ? { id: p.id, q: p.q } : null,
  };
}

/** The admin actions this file answers, or null for ones it doesn't. */
export async function leagueAdmin(env, body, who) {
  switch (body.action) {
    case "lore_get": return loreGet(env);
    case "lore_set": return loreSet(env, body, who);
    case "column_get": return columnGet(env);
    case "column_set": return columnSet(env, body, who);
    case "poll_create": return pollCreate(env, body, who);
    case "poll_close": return pollClose(env, who);
    case "poll_get": return pollGet(env);
    case "push_later": return pushLater(env, body, who);
    case "push_scheduled": return pushScheduled(env);
    case "push_cancel": return pushCancel(env, body, who);
  }
  return null;
}

export const POLL_ROUTES = {
  "/polls": ["GET", pollsPublic],
  "/polls/vote": ["POST", pollVote],
};
