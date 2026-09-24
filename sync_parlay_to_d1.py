"""
Mirrors the "Auto Parlay Tracker" sheet's picks into the Cloudflare D1
"retirement-league-parlay" database (see parlay_schema.sql) -- durable,
queryable storage for the raw pick data, the same relationship league
history already has between its Google Sheet origins and its own D1
database (see database/update_history_d1.py, whose wrangler-CLI pattern
this reuses directly via database/history_lib.py's NPX/WORKER_DIR/
sql_value helpers).

Always re-syncs every row (not just "new" ones) -- cheap (a couple hundred
rows total), and every write is INSERT OR REPLACE keyed on
(year, week, player), so it self-heals any later correction made in the
sheet (a fixed team name, a graded Result, etc.) without needing to track
what changed.

Meant to run right alongside publish_parlay_stats.py (see
.github/workflows/refresh_parlay_data.yml) -- same read of the sheet,
different destination (D1 for durable storage vs. KV for the fast-serving
computed blob).

Usage: python sync_parlay_to_d1.py
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
from generate_parlay_data import authorize, SHEET_ID, TARGET_TAB, cell, to_float, to_int
import history_lib as hl

D1_DATABASE_NAME = "retirement-league-parlay"
COLUMNS = [
    "year", "week", "player", "sacko", "sport", "bet_type", "team", "opponent",
    "player_prop", "line", "side", "odds", "gametime", "result", "raw_pick",
    "final_odds", "final_payout",
]


def load_rows(spreadsheet):
    ws = spreadsheet.worksheet(TARGET_TAB)
    raw_rows = ws.get_values("A2:Q3000")
    week_meta = {}  # (year, week) -> {sacko, final_odds, final_payout}
    rows = []
    for r in raw_rows:
        year = to_int(cell(r, 0))
        week = to_int(cell(r, 1))
        player = str(cell(r, 3)).strip()
        if year is None or week is None or not player:
            continue
        key = (year, week)
        if key not in week_meta:
            week_meta[key] = {
                "sacko": str(cell(r, 2)).strip() or None,
                "final_odds": to_float(cell(r, 15)),
                "final_payout": to_float(cell(r, 16)),
            }
        meta = week_meta[key]
        rows.append((
            year, week, player, meta["sacko"],
            str(cell(r, 4)).strip() or None,   # sport
            str(cell(r, 5)).strip() or None,   # bet_type
            str(cell(r, 6)).strip() or None,   # team
            str(cell(r, 7)).strip() or None,   # opponent
            str(cell(r, 8)).strip() or None,   # player_prop
            str(cell(r, 9)).strip() or None,   # line
            str(cell(r, 10)).strip() or None,  # side
            to_float(cell(r, 11)),             # odds
            str(cell(r, 12)).strip() or None,  # gametime
            str(cell(r, 13)).strip() or None,  # result
            str(cell(r, 14)).strip() or None,  # raw_pick
            meta["final_odds"], meta["final_payout"],
        ))
    return rows


def run_sql(statements):
    if not statements:
        print("Nothing to sync.")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(statements))
        path = f.name
    try:
        result = subprocess.run(
            [hl.NPX, "-y", "wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", f"--file={path}"],
            cwd=hl.WORKER_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr)
            raise SystemExit("wrangler d1 execute failed")
        print(f"Synced {len(statements)} rows to D1.")
    finally:
        os.unlink(path)


def main():
    print("Connecting to Google Sheets API...")
    spreadsheet = authorize().open_by_key(SHEET_ID)

    print(f"Loading {TARGET_TAB}...")
    rows = load_rows(spreadsheet)
    if not rows:
        raise SystemExit(f"No picks found in {TARGET_TAB}; refusing to sync nothing")

    statements = hl.insert_or_replace_sql("picks", COLUMNS, rows)
    run_sql(statements)


if __name__ == "__main__":
    main()
