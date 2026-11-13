"""
Writing the site's generated JSON (docs/data/*) only when the data changed.

Every generator stamps a fresh generated_at, so comparing whole files made
each scheduled run rewrite and commit its output even when nothing else
moved: two thirds of the repo's commits were "Update league data" with
only the time different (site audit X #31). write_if_changed() compares
the new data with the file's, generated_at aside, after a JSON round trip
(so an int dict key matches the string key the file holds), and leaves the
file alone when they match.
"""
import json
import os


def _plain(obj):
    return json.loads(json.dumps(obj))


def write_if_changed(path, obj, **dump_kwargs):
    """Writes obj to path with json.dump(**dump_kwargs) unless the file
    already holds the same data, ignoring a top-level generated_at. Returns
    True when it wrote. Pass the same dump options the file always used
    (indent=2, or separators=(",", ":")) so its bytes stay the same."""
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                old = json.load(f)
            new = _plain(obj)
            if isinstance(old, dict) and isinstance(new, dict):
                old.pop("generated_at", None)
                new.pop("generated_at", None)
            if old == new:
                print(f"{path}: no changes; not rewriting.")
                return False
        except ValueError:
            pass
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, **dump_kwargs)
    return True
