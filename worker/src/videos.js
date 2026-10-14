/**
 * League Videos: the weekly recap videos, for signed-in managers only
 * (docs/videos.html).
 *
 * The videos sit on YouTube, unlisted, one playlist per season. The playlist
 * ids are the secret VIDEO_PLAYLISTS (a JSON object, {"2023": "PL..."}), so
 * neither a playlist nor a video id is ever in the site's files: they only
 * leave the Worker in answer to a request with a valid sign-in.
 *
 * GET /videos[?season=2023] Authorization: Bearer <token>
 *   -> { seasons: [2023], season: 2023, videos: [{ id, title }] }
 *      in playlist order; a new video added to the playlist shows up here
 *      within CACHE_SECONDS. Without a season, the newest one.
 *
 * The playlist page is read as a visitor would (no API key): YouTube puts
 * the first hundred videos in the page's ytInitialData, which is all a
 * season needs.
 */
import { sessionManager } from "./auth.js";
import { cached } from "./cache.js";

const CACHE_SECONDS = 30 * 60;

/** The season -> playlist id map, or {} when it isn't set. */
function playlists(env) {
  try {
    const map = JSON.parse(env.VIDEO_PLAYLISTS || "{}");
    return Object.fromEntries(Object.entries(map).filter(([y, id]) => /^\d{4}$/.test(y) && /^[A-Za-z0-9_-]{10,60}$/.test(id)));
  } catch {
    return {};
  }
}

/** Every { id, title } in a playlist page's data, in page order. */
function pageVideos(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error("playlist page not recognised");
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    const l = o.lockupViewModel;
    if (l && l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && /^[A-Za-z0-9_-]{11}$/.test(l.contentId || "")) {
      const title = l.metadata?.lockupMetadataViewModel?.title?.content || "";
      out.push({ id: l.contentId, title });
      return;
    }
    for (const k in o) walk(o[k]);
  })(JSON.parse(m[1]));
  return out;
}

/** "2023 Retirement League - Week 4" -> "Week 4". */
const shortTitle = (t) => t.replace(/^\s*\d{4}\s+Retirement League\s*[-–:]?\s*/i, "").trim() || t;

async function fetchPlaylist(listId) {
  const res = await fetch(`https://www.youtube.com/playlist?list=${listId}&hl=en`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "CONSENT=YES+1; SOCS=CAI",
    },
  });
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  const videos = pageVideos(await res.text());
  if (!videos.length) throw new Error("no videos found");
  return videos.map((v) => ({ id: v.id, title: shortTitle(v.title) }));
}

async function getVideos(request, env) {
  if (!(await sessionManager(request, env))) return { status: 401, body: { error: "signed_out" } };
  const lists = playlists(env);
  const seasons = Object.keys(lists).map(Number).sort((a, b) => a - b);
  if (!seasons.length) return { status: 503, body: { error: "not_configured" } };
  const asked = Number(new URL(request.url).searchParams.get("season"));
  const season = seasons.includes(asked) ? asked : seasons[seasons.length - 1];
  const videos = await cached(env, `videos:${season}`, CACHE_SECONDS, () => fetchPlaylist(lists[season]));
  return { status: 200, body: { seasons, season, videos } };
}

export const VIDEO_ROUTES = {
  "/videos": ["GET", getVideos],
};
