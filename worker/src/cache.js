/**
 * A plain read-through cache for the slower-moving payloads (a player's game
 * log, a finished week's dashboard, the NFL schedule), in the same D1
 * `cache` table the live dashboard uses. A failed build falls back to the
 * last copy, however old; a failed D1 read or write just skips the cache.
 */
export async function cached(env, key, maxAgeSeconds, build) {
  const now = Math.floor(Date.now() / 1000);
  let row = null;
  try {
    row = await env.DB.prepare("SELECT fetched_at, data FROM cache WHERE k = ?1").bind(key).first();
  } catch (err) {
    console.error("D1 cache read failed:", err);
  }
  if (row && now - row.fetched_at < maxAgeSeconds) return JSON.parse(row.data);
  let data;
  try {
    data = await build();
  } catch (err) {
    if (row) return JSON.parse(row.data);
    throw err;
  }
  try {
    await env.DB.prepare(
      `INSERT INTO cache (k, fetched_at, kv_at, data) VALUES (?1, ?2, ?2, ?3)
       ON CONFLICT(k) DO UPDATE SET fetched_at = excluded.fetched_at, kv_at = excluded.kv_at, data = excluded.data`
    ).bind(key, now, JSON.stringify(data)).run();
  } catch (err) {
    console.error("D1 cache write failed:", err);
  }
  return data;
}
