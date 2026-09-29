"""
Mirrors the "Auto Parlay Tracker" sheet's picks into the Cloudflare D1
"retirement-league-parlay" database (see parlay_schema.sql) -- durable,
queryable storage for the raw pick data, the same relationship league
history already has between its Google Sheet origins and its own D1
database (see database/update_history_d1.py, whose wrangler-CLI pattern
this reuses directly via database/history_lib.py's NPX/WORKER_DIR/
sql_value helpers).

Diffs every row in the sheet against what's already in D1 and only writes
the ones that changed (including new rows) -- every write is still
INSERT OR REPLACE keyed on (year, week, player), so it still self-heals
any later correction made in the sheet (a fixed team name, a graded
Result, etc.), just without paying D1's rows-written cost for the
~200+ rows that didn't change on a given run. This matters because this
script runs every 10 minutes (see refresh_parlay_data.yml) -- unconditionally
rewriting the whole table that often would eat a large, unnecessary chunk
of D1's free-tier daily rows-written budget, which is shared account-wide
with the history and analytics D1 databases. The one-time cost is a
single extra read of the whole table from D1, which is cheap (D1's free
daily rows-*read* budget is 50x the rows-written one).

Meant to run right alongside publish_parlay_stats.py (see
.github/workflows/refresh_parlay_data.yml) -- same read of the sheet,
different destination (D1 for durable storage vs. KV for the fast-serving
computed blob).

Usage: python sync_parlay_to_d1.py
"""
import os
import sys

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


def load_existing_rows():
    """{(year, week, player): row tuple in COLUMNS order} for every row
    already in D1, so main() can skip rewriting the ones that haven't
    changed. Column types line up with load_rows()'s without extra
    coercion: year/week are D1 INTEGER columns (JSON ints, matching
    to_int()), odds/final_odds/final_payout are REAL columns (SQLite's
    REAL column affinity always stores/returns these as floats, matching
    to_float()'s always-float-or-None), and everything else is TEXT
    (JSON strings or null, matching the str(...) or None fields below)."""
    existing = hl.d1_query(f"SELECT {', '.join(COLUMNS)} FROM picks", db_name=D1_DATABASE_NAME)
    return {(r["year"], r["week"], r["player"]): tuple(r[c] for c in COLUMNS) for r in existing}


def run_sql(statements):
    if not statements:
        print("Nothing to sync.")
        return
    hl.run_d1_sql(statements, "parlay picks", db_name=D1_DATABASE_NAME)
    print(f"Synced {len(statements)} row(s) to D1.")


def main():
    print("Connecting to Google Sheets API...")
    spreadsheet = authorize().open_by_key(SHEET_ID)

    print(f"Loading {TARGET_TAB}...")
    rows = load_rows(spreadsheet)
    if not rows:
        raise SystemExit(f"No picks found in {TARGET_TAB}; refusing to sync nothing")

    print("Checking which rows changed since the last sync...")
    existing = load_existing_rows()
    changed_rows = [row for row in rows if existing.get((row[0], row[1], row[2])) != row]
    print(f"{len(changed_rows)} of {len(rows)} row(s) changed or new; {len(rows) - len(changed_rows)} unchanged, skipped.")

    statements = hl.insert_or_replace_sql("picks", COLUMNS, changed_rows)
    run_sql(statements)


if __name__ == "__main__":
    main()
