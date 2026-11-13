"""
Copies the parlay picks from D1 into the "Auto Parlay Tracker" sheet tab,
nightly (copy_parlay_to_sheet.yml). Since site audit X #26 the Worker keeps
the parlay itself (worker/src/parlayData.js): picks are saved, graded and
published there, and the sheet is only a copy for anyone who still reads
it. An edit made in the sheet is overwritten here the next night; change a
pick on the site (Parlay Legs, or Commissioner > Parlay) instead.

Only rows that differ are written. Column D (the player name formula) and
column R are left alone; S is Grade Detail.

Usage: python parlay_to_sheet.py [--dry-run]
"""
import argparse
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl
from parlay_sheet import SheetClient, PLAYERS_PER_WEEK, ROW_FIELDS

D1_DATABASE_NAME = "retirement-league-parlay"
WIDTH = 19  # A..S


def norm(v):
    """A cell as compared: numbers as floats, text stripped, blanks as ''."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    try:
        return float(s) if s and s.lstrip("+-").replace(".", "", 1).isdigit() else s
    except ValueError:
        return s


def desired_row(year, week, i, first, pick):
    """The A..S values one sheet row should hold (D and R as None: left alone)."""
    row = [None] * WIDTH
    row[0], row[1] = year, week
    row[2] = (first.get("sacko") or "") if i == 0 else ""
    for j, f in enumerate(ROW_FIELDS):  # E..O
        v = pick.get(f) if pick else None
        row[4 + j] = "" if v is None else v
    row[15] = first.get("final_odds") if i == 0 and first.get("final_odds") is not None else ""
    row[16] = first.get("final_payout") if i == 0 and first.get("final_payout") is not None else ""
    row[18] = (pick.get("detail") or "") if pick else ""
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print what would change, write nothing")
    args = ap.parse_args()

    picks = hl.d1_query("SELECT * FROM picks", db_name=D1_DATABASE_NAME)
    if not picks:
        raise SystemExit("D1 has no picks; refusing to copy nothing over the sheet")
    weeks = defaultdict(dict)
    for p in picks:
        weeks[(p["year"], p["week"])][p["player"]] = p

    sheet = SheetClient()
    players = sheet.players
    current = sheet.ws.get_values(f"A2:S3000", value_render_option="UNFORMATTED_VALUE")
    starts = {}
    for i, r in enumerate(current):
        if len(r) > 1 and r[0] != "" and r[1] != "" and (r[0], r[1]) not in starts:
            try:
                starts[(int(r[0]), int(r[1]))] = 2 + i
            except (TypeError, ValueError):
                pass
    next_row = 2 + max([i + 1 for i, r in enumerate(current) if r and r[0] != ""] or [0])

    updates, changed = [], []
    for (year, week) in sorted(weeks):
        by_player = weeks[(year, week)]
        first = next(iter(by_player.values()))
        start = starts.get((year, week))
        if start is None:
            start, next_row = next_row, next_row + PLAYERS_PER_WEEK
        assert (start - 2) % PLAYERS_PER_WEEK == 0, f"{year} W{week} starts on row {start}, not a 12-row block"
        for i, player in enumerate(players):
            r = start + i
            want = desired_row(year, week, i, first, by_player.get(player))
            have = current[r - 2] if r - 2 < len(current) else []
            have = list(have) + [""] * (WIDTH - len(have))
            if all(w is None or norm(w) == norm(h) for w, h in zip(want, have)):
                continue
            changed.append(f"{year} W{week} {player} (row {r})")
            updates += [
                {"range": f"A{r}:C{r}", "values": [want[0:3]]},
                {"range": f"E{r}:Q{r}", "values": [want[4:17]]},
                {"range": f"S{r}", "values": [[want[18]]]},
            ]

    print(f"{len(changed)} row(s) differ from D1.")
    for c in changed[:50]:
        print("  " + c)
    if args.dry_run or not updates:
        return
    # RAW, never USER_ENTERED: Sheets would turn the ISO game times into its own dates.
    for k in range(0, len(updates), 300):
        sheet.ws.batch_update(updates[k:k + 300], value_input_option="RAW")
    print("Sheet updated.")


if __name__ == "__main__":
    main()
