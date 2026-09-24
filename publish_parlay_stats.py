"""
Computes the same stats payload as generate_parlay_data.py, but pushes it
straight to Cloudflare KV instead of writing docs/data/parlay.json for git
to commit -- so the site gets fresh parlay data without a commit/push
cycle, the same way league history already reaches D1 directly (see
database/update_history_d1.py) and the Dashboard already reads straight
from KV (see worker/src/index.js).

Reuses generate_parlay_data.py's load_tracker()/week_state()/compute_stats()
completely unchanged -- only the output step differs (KV instead of a
committed file).

Talks to KV through `wrangler kv key put --remote`, the same wrangler-CLI
approach database/update_history_d1.py already uses for D1, so it inherits
the same proven CI auth (CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID -- both
already present as GitHub Actions secrets, no new secret needed).

Usage: python publish_parlay_stats.py
"""
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
from generate_parlay_data import authorize, SHEET_ID, load_tracker, week_state, compute_stats
import history_lib as hl

KV_NAMESPACE_ID = "1521d1a4fe954b00a05b4542c7a44670"  # COOLDOWN_KV, shared with the Dashboard cache
# No colon in the key -- confirmed directly that `wrangler kv key put` fails
# with a confusing "Authentication error" from this CLI/account combo on a
# colon-containing key name (e.g. "parlay:stats"), even though the Worker's
# own runtime KV binding handles colon-containing keys (like "dashboard:v2")
# fine. Not pursued further since avoiding it entirely is free.
KV_KEY = "parlay_stats_v1"


def main():
    print("Connecting to Google Sheets API...")
    spreadsheet = authorize().open_by_key(SHEET_ID)

    print("Loading Auto Parlay Tracker...")
    players, weeks = load_tracker(spreadsheet)
    if not weeks:
        raise SystemExit("No parlay weeks found; refusing to publish an empty payload")

    for week in weeks:
        week["final"]["result"] = week_state(week, players)["result"]

    years = sorted({w["year"] for w in weeks})
    stats_by_scope = {"all": compute_stats(players, weeks)}
    for year in years:
        stats_by_scope[str(year)] = compute_stats(players, [w for w in weeks if w["year"] == year])

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "players": players,
        "weeks": weeks,
        "years": years,
        "stats": stats_by_scope,
    }

    payload = json.dumps(output)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        f.write(payload)
        path = f.name
    try:
        result = subprocess.run(
            [hl.NPX, "-y", "wrangler", "kv", "key", "put", KV_KEY,
             f"--path={path}", "--namespace-id", KV_NAMESPACE_ID, "--remote"],
            cwd=hl.WORKER_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr)
            raise SystemExit("wrangler kv key put failed")
    finally:
        os.unlink(path)
    print(f"Published parlay stats to KV ({len(payload)} bytes, {len(weeks)} weeks)")


if __name__ == "__main__":
    main()
