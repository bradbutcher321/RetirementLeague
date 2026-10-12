"""
Writes one week of parlay picks to "Auto Parlay Tracker" from the site's
Enter Picks page (docs/parlay-entry.html). The page parses the note and finds
every game on ESPN in the browser, the Worker checks the PIN and dispatches
enter_parlay.yml with the result as the PICKS input, and this writes it with
the same SheetClient.save_week the desktop tool uses.

PICKS is JSON: {year, week, sacko, final_odds, final_payout, dry_run,
rows: {player: {sport, bet_type, team, opponent, player_prop, line, side,
odds, gametime, raw_pick}}}.

A week already in the sheet is overwritten in place, not added again. A
player whose pick didn't change keeps the Result already graded for it;
every new or changed pick starts at Pending.

Usage: PICKS='{...}' python enter_parlay.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parlay_sheet import SheetClient, ROW_FIELDS, PLAYERS_PER_WEEK

TEXT_FIELDS = ["sport", "bet_type", "team", "opponent", "player_prop", "line", "side", "gametime", "raw_pick"]
GAMETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def clean_rows(rows, players):
    unknown = [p for p in rows if p not in players]
    if unknown:
        fail(f"Not players in the sheet: {', '.join(unknown)}")
    out = {}
    for player, row in rows.items():
        clean = {f: str(row.get(f) or "").strip()[:200] for f in TEXT_FIELDS}
        if clean["gametime"] and not GAMETIME_RE.match(clean["gametime"]):
            fail(f"{player}: game time {clean['gametime']!r} isn't YYYY-MM-DDTHH:MM:SS")
        odds = row.get("odds")
        # save_week parses odds from text, the way the GUI's field hands it over.
        clean["odds"] = str(odds) if isinstance(odds, (int, float)) else ""
        clean["result"] = "Pending"
        out[player] = clean
    return out


def main():
    payload = json.loads(os.environ["PICKS"])
    try:
        year, week = int(payload["year"]), int(payload["week"])
    except (KeyError, TypeError, ValueError):
        fail("Year and Week must be numbers.")
    num = lambda v: float(v) if isinstance(v, (int, float)) else None

    client = SheetClient()
    rows = clean_rows(payload.get("rows") or {}, client.players)
    if not rows:
        fail("No picks to save.")

    start_row, block = client.find_week(year, week)
    if start_row:
        # Same pick as what's saved -> keep its graded Result.
        for i, player in enumerate(client.players[:PLAYERS_PER_WEEK]):
            old = block[i] if i < len(block) else []
            old_raw, old_result = (old[14], old[13]) if len(old) > 14 else ("", "")
            row = rows.get(player)
            if row and old_raw and old_raw == row["raw_pick"] and old_result:
                row["result"] = old_result
    target = start_row or client.next_new_week_row()

    print(f"{year} Week {week}: {len(rows)} picks -> row {target} ({'replacing' if start_row else 'new week'})")
    for player in client.players:
        r = rows.get(player)
        print(f"  {player:8} " + (" | ".join(str(r[f]) for f in ROW_FIELDS) if r else "(no pick)"))

    if payload.get("dry_run"):
        print("Dry run: nothing written.")
        return
    client.save_week(target, year, week, str(payload.get("sacko") or "").strip(),
                     num(payload.get("final_odds")), num(payload.get("final_payout")), rows)
    print("Saved.")


if __name__ == "__main__":
    main()
