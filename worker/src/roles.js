/**
 * Who is a commissioner, plus the small stores the Commissioner page keeps
 * (docs/commissioner.html).
 *
 * Brad and Jon (FOUNDERS) are commissioners for good: they are never stored,
 * so no row can take it from them, and only they can make or remove another
 * commissioner. Everyone else is a commissioner only while auth_roles has a
 * row for them.
 *
 * Also here: site_settings (one JSON value per key: the Live page's
 * announcement and draft date, the recap playlists) and admin_log (what a
 * commissioner did, newest last in the table, newest first on the page).
 * The tables are in schema.sql. A missing table never locks the founders
 * out: every read here falls back to "no roles, no settings".
 */
export const FOUNDERS = ["Brad", "Jon"];

/** Every commissioner: the founders, then whoever they added. */
export async function commissioners(env) {
  let added = [];
  try {
    const { results } = await env.DB.prepare("SELECT manager FROM auth_roles ORDER BY granted_at").all();
    added = results.map((r) => r.manager).filter((m) => !FOUNDERS.includes(m));
  } catch (err) {
    console.error("auth_roles read failed:", err);
  }
  return [...FOUNDERS, ...added];
}

export async function isCommissioner(env, manager) {
  if (!manager) return false;
  if (FOUNDERS.includes(manager)) return true;
  try {
    return !!(await env.DB.prepare("SELECT 1 AS x FROM auth_roles WHERE manager = ?1").bind(manager).first());
  } catch (err) {
    console.error("auth_roles read failed:", err);
    return false;
  }
}

export async function setCommissioner(env, manager, on, by) {
  if (on) {
    await env.DB.prepare("INSERT OR IGNORE INTO auth_roles (manager, granted_by, granted_at) VALUES (?1, ?2, ?3)").bind(manager, by, Date.now()).run();
  } else {
    await env.DB.prepare("DELETE FROM auth_roles WHERE manager = ?1").bind(manager).run();
  }
}

/** The JSON stored under `k`, or `fallback`. */
export async function getSetting(env, k, fallback = null) {
  try {
    const row = await env.DB.prepare("SELECT v FROM site_settings WHERE k = ?1").bind(k).first();
    return row ? JSON.parse(row.v) : fallback;
  } catch (err) {
    console.error("site_settings read failed:", err);
    return fallback;
  }
}

/** Stores `value` under `k`; null removes it. */
export async function setSetting(env, k, value) {
  if (value == null) {
    await env.DB.prepare("DELETE FROM site_settings WHERE k = ?1").bind(k).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO site_settings (k, v, updated) VALUES (?1, ?2, ?3)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated`
  ).bind(k, JSON.stringify(value), Date.now()).run();
}

/** One line in the Activity Log. `who` is a manager's name, or "PIN" for
 * someone who used the PIN instead of signing in. Never throws. */
export async function logAction(env, who, kind, text) {
  try {
    await env.DB.prepare("INSERT INTO admin_log (ts, who, kind, text) VALUES (?1, ?2, ?3, ?4)")
      .bind(Date.now(), who || "PIN", String(kind).slice(0, 20), String(text).slice(0, 300)).run();
    // Keep the table small: the page shows the latest hundred.
    if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM admin_log WHERE id < (SELECT MAX(id) - 500 FROM admin_log)").run();
  } catch (err) {
    console.error("admin_log write failed:", err);
  }
}
