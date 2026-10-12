"""
Keeps a copy of every team logo on the site itself (docs/icons/teams/), so
pages never load one from wherever a manager pasted it into ESPN (audit II #5).

Why: ESPN stores a team logo as whatever URL the manager typed in, with no
validation. Uploads to ESPN's own image host (mystique-api.fantasy.espn.com)
only load for a browser logged in to ESPN -- everyone else gets a 401 -- and
plenty of the older links point at sites that have since gone away. Fetching
them here, with the league's ESPN cookies (ESPN_S2 / ESPN_SWID), and serving
the copy fixes the first problem and freezes the rest while they still load.

Files are named by a hash of the source URL, so a logo is downloaded once and
then reused on every later run without touching the network. A URL that
can't be fetched maps to None (the pages already fall back to a placeholder
for a missing logo) and is simply tried again next run.
"""

import hashlib
import os
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlparse

DOCS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")
LOGO_DIR = os.path.join(DOCS_DIR, "icons", "teams")
SITE_PREFIX = "icons/teams/"  # relative to docs/, where every page lives

EXT_BY_TYPE = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif",
    "image/svg+xml": ".svg", "image/webp": ".webp", "image/avif": ".avif",
}
MAX_BYTES = 5 * 1024 * 1024
TIMEOUT = 10


def _stem(url):
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def _existing(stem):
    if not os.path.isdir(LOGO_DIR):
        return None
    for name in os.listdir(LOGO_DIR):
        if os.path.splitext(name)[0] == stem:
            return name
    return None


def _cookie_header(url):
    host = urlparse(url).hostname or ""
    s2, swid = os.environ.get("ESPN_S2"), os.environ.get("ESPN_SWID")
    if host.endswith("espn.com") and s2 and swid:
        return f"espn_s2={s2}; SWID={swid}"
    return None


def _sniff(data):
    """Content type from the bytes, for hosts that send a wrong or missing header."""
    head = data[:512].lstrip()
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        return "image/svg+xml" if b"<svg" in data[:4096] else None
    return None


def _fetch(req):
    """Bytes and declared type. Retries once without certificate checks: some
    old hosts have lapsed certificates, and the result is only ever served
    as an <img> after _sniff() confirms it's an image."""
    for ctx in (None, ssl._create_unverified_context()):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
                return resp.read(MAX_BYTES + 1), (resp.headers.get_content_type() or "").lower()
        except urllib.error.URLError as e:
            if ctx is None and isinstance(getattr(e, "reason", None), ssl.SSLError):
                continue
            raise


def mirror(url, cache):
    """Site path for a copy of `url`, or None if it can't be fetched."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    if url in cache:
        return cache[url]
    stem = _stem(url)
    name = _existing(stem)
    if not name:
        req = urllib.request.Request(url, headers={
            # A browser's UA: several old image hosts 403 anything that looks
            # like a script.
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
            "Accept": "image/*,*/*;q=0.5",
        })
        cookie = _cookie_header(url)
        if cookie:
            req.add_header("Cookie", cookie)
        try:
            data, header_type = _fetch(req)
        except Exception as e:  # dead host, 401/404, timeout, bad TLS...
            print(f"  logo: couldn't fetch {url[:90]} ({e.__class__.__name__}: {str(e)[:60]})")
            cache[url] = None
            return None
        ctype = _sniff(data) or (header_type if header_type in EXT_BY_TYPE else None)
        if not data or len(data) > MAX_BYTES or ctype not in EXT_BY_TYPE:
            print(f"  logo: not an image {url[:90]} ({header_type or 'no type'}, {len(data)} bytes)")
            cache[url] = None
            return None
        os.makedirs(LOGO_DIR, exist_ok=True)
        name = stem + EXT_BY_TYPE[ctype]
        with open(os.path.join(LOGO_DIR, name), "wb") as f:
            f.write(data)
    cache[url] = SITE_PREFIX + name
    return cache[url]


def mirror_player_logos(players):
    """Swap every current and past logo URL in franchise.json's players for its site copy."""
    cache = {}
    for p in players:
        p["current_team_logo"] = mirror(p.get("current_team_logo"), cache)
        for meta in (p.get("previous_team_logos") or {}).values():
            meta["logo_url"] = mirror(meta.get("logo_url"), cache)
    ok = sum(1 for v in cache.values() if v)
    print(f"Team logos: {ok} of {len(cache)} distinct URLs served from {SITE_PREFIX}")
