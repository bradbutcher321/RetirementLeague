"""
Populates D1's `players` table (player_id -> position) from ESPN's full
player pool, including long-retired players who'd never show up in a
"current" roster/free-agent query. ESPN's draft-pick payload itself only
has lineupSlotId, which is frequently just "BE" (bench) once a draft's
starting slots fill up, not a usable position -- see the module docstring
in database/schema.sql for why this lives in its own table instead of a
column on draft_picks.

Run this once initially, then again any time a new player who's never
appeared in a draft before shows up (i.e. once a year, after a draft, is
plenty -- position data for a real person doesn't change day to day).

Usage:
    ESPN_S2=... ESPN_SWID=... python backfill_draft_positions.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from espn_api.football import League
import history_lib as hl

# NOT espn_api's POSITION_MAP -- that maps lineup SLOT ids (which include
# flex combos like "RB/WR") and gave wrong answers here (e.g. Cooper Kupp,
# a WR, has defaultPositionId 3, which POSITION_MAP calls "RB/WR"). This is
# ESPN's separate true-position enum, confirmed against known players:
# Mahomes(QB)=1, Taylor(RB)=2, Kupp(WR)=3, Kelce(TE)=4, Tucker(K)=5,
# Falcons D/ST=16.
DEFAULT_POSITION_ID_MAP = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}


def fetch_full_player_pool(league):
    """Every player ESPN has ever known about (filterActive=false is what
    unlocks retired players -- confirmed against Marshawn Lynch, a 2015
    1st-round pick who last played in 2019)."""
    headers = {"x-fantasy-filter": json.dumps({"players": {"filterActive": {"value": False}}})}
    return league.espn_request.get(extend="/players", params={"view": "players_wl"}, headers=headers)


def main():
    espn_s2 = os.environ.get("ESPN_S2")
    swid = os.environ.get("ESPN_SWID")
    if not espn_s2 or not swid:
        raise SystemExit("Set ESPN_S2 and ESPN_SWID environment variables first.")

    needed_ids = {
        row["player_id"] for row in hl.d1_query("SELECT DISTINCT player_id FROM draft_picks")
        if row["player_id"] is not None
    }
    print(f"{len(needed_ids)} distinct drafted players to resolve.")

    print("Fetching ESPN's full player pool...")
    league = League(league_id=hl.LEAGUE_ID, year=hl.current_nfl_season_year(), espn_s2=espn_s2, swid=swid)
    pool = fetch_full_player_pool(league)
    print(f"Pool has {len(pool)} players.")

    rows = []
    missing = set(needed_ids)
    for p in pool:
        pid = p.get("id")
        if pid not in needed_ids:
            continue
        position = DEFAULT_POSITION_ID_MAP.get(p.get("defaultPositionId"))
        rows.append((pid, p.get("fullName"), position))
        missing.discard(pid)

    print(f"Resolved {len(rows)} players; {len(missing)} drafted player_ids not found in the pool.")
    if missing:
        print("  missing ids (sample):", list(missing)[:20])

    stmts = hl.insert_or_replace_sql("players", ("player_id", "full_name", "position"), rows)
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(stmts))
        path = f.name
    try:
        result = subprocess.run(
            [hl.NPX, "-y", "wrangler", "d1", "execute", hl.D1_DATABASE_NAME, "--remote", f"--file={path}"],
            cwd=hl.WORKER_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr)
            raise SystemExit("wrangler d1 execute failed for players")
        print(f"Wrote {len(rows)} rows to players.")
    finally:
        os.unlink(path)


if __name__ == "__main__":
    main()
