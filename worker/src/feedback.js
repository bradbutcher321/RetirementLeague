/**
 * Feedback: signed-in managers report a bug or suggest something from their
 * You sheet (docs/nav.js), and the commissioners read and answer it on the
 * Commissioner page's Feedback tool (docs/commissioner.html, through /admin).
 *
 * POST /feedback { kind, text, page }   Authorization: Bearer <key>
 *   kind: bug | improve | feature | other. Saves it and pushes the
 *   commissioners (every one but the sender), so it doesn't sit unread.
 * GET /feedback/mine                    Authorization: Bearer <key>
 *   what you've sent, newest first, with its status and any reply.
 *
 * Commissioner actions (admin.js):
 *   feedback_list                       every item, newest first
 *   feedback_set { id, status, reply }  status: new | planned | done | no
 *   feedback_delete { id }
 *
 * The table is `feedback` in schema.sql (analytics D1).
 */
import { sessionManager } from "./auth.js";
import { broadcast } from "./push.js";
import { commissioners, logAction } from "./roles.js";

export const KINDS = { bug: "Bug", improve: "Improvement", feature: "Feature idea", other: "Something else" };
export const STATUSES = ["new", "planned", "done", "no"];
const MAX_TEXT = 1000;
const MAX_PER_DAY = 20;

const fail = (status, error) => ({ status, body: { error } });
const clip = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const row = (r) => ({ id: r.id, ts: r.ts, manager: r.manager, kind: r.kind, text: r.text, page: r.page, status: r.status, reply: r.reply || "", updated: r.updated || null });

async function submit(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, "bad_json");
  const kind = KINDS[body.kind] ? body.kind : "other";
  const text = clip(body.text, MAX_TEXT);
  if (text.length < 3) return fail(400, "no_text");
  const page = clip(body.page, 80).replace(/[^\w.\-#?=&/]/g, "");
  const since = Date.now() - 864e5;
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE manager = ?1 AND ts > ?2").bind(me.manager, since).first();
  if (n >= MAX_PER_DAY) return fail(429, "too_many");
  const ts = Date.now();
  const { meta } = await env.DB.prepare("INSERT INTO feedback (ts, manager, kind, text, page, status) VALUES (?1, ?2, ?3, ?4, ?5, 'new')")
    .bind(ts, me.manager, kind, text, page).run();
  // A push to the other commissioners. Never holds up the answer.
  const to = (await commissioners(env)).filter((c) => c !== me.manager);
  const short = text.length > 110 ? text.slice(0, 107) + "…" : text;
  await Promise.allSettled(to.map((c) => broadcast(env, { title: `${KINDS[kind]} from ${me.manager}`, body: short, url: "commissioner.html#feedback", tag: "feedback" }, c)));
  return { status: 200, body: { ok: true, item: row({ id: meta && meta.last_row_id, ts, manager: me.manager, kind, text, page, status: "new" }) } };
}

async function mine(request, env) {
  const me = await sessionManager(request, env);
  if (!me) return fail(401, "signed_out");
  const { results } = await env.DB.prepare("SELECT * FROM feedback WHERE manager = ?1 ORDER BY id DESC LIMIT 30").bind(me.manager).all();
  return { status: 200, body: { items: results.map(row) } };
}

/** The Commissioner page's side (admin.js has already checked who's asking). */
export async function feedbackAdmin(env, body, who) {
  switch (body.action) {
    case "feedback_list": {
      const { results } = await env.DB.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 200").all();
      return { status: 200, body: { items: results.map(row) } };
    }
    case "feedback_set": {
      const id = Number(body.id);
      const status = STATUSES.includes(body.status) ? body.status : null;
      if (!id || !status) return fail(400, "bad_feedback");
      const reply = clip(body.reply, 400);
      const item = await env.DB.prepare("SELECT manager, kind FROM feedback WHERE id = ?1").bind(id).first();
      if (!item) return fail(404, "not_found");
      await env.DB.prepare("UPDATE feedback SET status = ?1, reply = ?2, updated = ?3, updated_by = ?4 WHERE id = ?5")
        .bind(status, reply, Date.now(), who || "PIN", id).run();
      await logAction(env, who, "feedback", `Marked ${item.manager}'s ${KINDS[item.kind].toLowerCase()} ${({ new: "new", planned: "planned", done: "done", no: "won't do" })[status]}`);
      return { status: 200, body: { ok: true } };
    }
    case "feedback_delete": {
      const id = Number(body.id);
      if (!id) return fail(400, "bad_feedback");
      await env.DB.prepare("DELETE FROM feedback WHERE id = ?1").bind(id).run();
      return { status: 200, body: { ok: true } };
    }
  }
  return fail(400, "bad_action");
}

/** How many items nobody has looked at yet, for the hub. */
export async function feedbackNew(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'").first();
  return r ? r.n : 0;
}

export const FEEDBACK_ROUTES = {
  "/feedback": ["POST", submit],
  "/feedback/mine": ["GET", mine],
};
