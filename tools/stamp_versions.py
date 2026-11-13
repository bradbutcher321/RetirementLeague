"""Stamps every page's ?v= from the file it points at (site audit X #35).

Each page names its shared files with a version (nav.js?v=..., theme.css?v=...)
so a phone keeps them until they change. Bumping those by hand across two dozen
pages was a chore, and a missed one left a phone on the old file. This sets
each ?v= to the first 8 characters of that file's SHA-1, so a changed file gets
a new version on every page at once and an unchanged one keeps its old one.

Run after changing anything in docs/ that a page loads with ?v=:

    python tools/stamp_versions.py          # rewrite the pages
    python tools/stamp_versions.py --check  # exit 1 if any page is stale (CI)
"""
import hashlib
import os
import re
import sys

DOCS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")
REF = re.compile(r'((?:src|href)=")([^"?#:]+\.(?:js|css))\?v=([^"&#]*)(")')


def digest(path, memo={}):
    if path not in memo:
        with open(path, "rb") as f:
            memo[path] = hashlib.sha1(f.read()).hexdigest()[:8]
    return memo[path]


def main(check=False):
    stale = []
    for name in sorted(os.listdir(DOCS)):
        if not name.endswith(".html"):
            continue
        page = os.path.join(DOCS, name)
        with open(page, encoding="utf-8", newline="") as f:
            text = f.read()

        def stamp(m):
            target = os.path.normpath(os.path.join(DOCS, m.group(2)))
            if not os.path.isfile(target):
                return m.group(0)
            v = digest(target)
            if v != m.group(3):
                stale.append(f"{name}: {m.group(2)} {m.group(3)} -> {v}")
            return f"{m.group(1)}{m.group(2)}?v={v}{m.group(4)}"

        new = REF.sub(stamp, text)
        if new != text and not check:
            with open(page, "w", encoding="utf-8", newline="") as f:
                f.write(new)
    for line in stale:
        print(line)
    print(f"{len(stale)} version{'s' if len(stale) != 1 else ''} {'stale' if check else 'stamped'}")
    return 1 if check and stale else 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv))
