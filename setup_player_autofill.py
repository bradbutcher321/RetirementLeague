"""
Fills the two formula-driven columns on "Auto Parlay Tracker" that never
need manual entry:

- Player: auto-filled since every week is always the same 12 players in
  the same fixed order. Writes a small "Player Order" reference list off
  to the side of the main table, names it as a range, and fills the Player
  column (rows 2-3000) with a formula that picks the right name purely
  from row position -- so a new week's 12 rows already show the correct
  names with no typing or dropdown selection needed.
- Final Split: always exactly Final Payout / 12 (verified against all 19
  historical weeks), so it's a formula reading that same row's Final
  Payout cell rather than something a person types or pastes in.

Requires every existing week to already be a full, correctly-ordered
12-row block (see the Chad/Jeff placeholder-row fix for 2026 week 2) --
the Player formula assumes strict alignment and will silently mislabel
players if that's ever violated again.

Usage: python setup_player_autofill.py
"""
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH
import generate_parlay_data as gp

TARGET_TAB = "Auto Parlay Tracker"
VALIDATION_LAST_ROW = 3000
COL_PLAYER = 3  # 0-indexed, matches migrate_parlay_tracker.py's HEADER order
COL_FINAL_PAYOUT, COL_FINAL_SPLIT = "Q", "R"
HELPER_COL = "U"  # off to the side of the main table (A-R, see migrate_parlay_tracker.py)
NAMED_RANGE = "PlayerOrder"


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def col_letter_to_index(letters):
    """Spreadsheet column letter(s) -> 0-indexed column number."""
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def main():
    print("Loading Google Sheet...")
    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    players, _ = gp.load_tracker(spreadsheet)
    target = spreadsheet.worksheet(TARGET_TAB)

    # Reference list: header + the 12 names in the fixed order everything
    # else (the migration, the border pattern) already assumes.
    target.update([["Player Order"]] + [[p] for p in players], f"{HELPER_COL}1", value_input_option="RAW")

    # Replace any existing named range of the same name so this stays
    # re-runnable if the roster ever changes.
    meta = spreadsheet.fetch_sheet_metadata()
    sheet_props = next(s for s in meta["sheets"] if s["properties"]["sheetId"] == target.id)
    existing = [nr["namedRangeId"] for nr in meta.get("namedRanges", [])
                if nr["name"] == NAMED_RANGE and nr["range"]["sheetId"] == target.id]
    requests = [{"deleteNamedRange": {"namedRangeId": nrid}} for nrid in existing]
    helper_idx = col_letter_to_index(HELPER_COL)
    requests.append({
        "addNamedRange": {
            "namedRange": {
                "name": NAMED_RANGE,
                "range": {"sheetId": target.id, "startRowIndex": 1, "endRowIndex": 1 + len(players),
                           "startColumnIndex": helper_idx, "endColumnIndex": helper_idx + 1},
            }
        }
    })
    spreadsheet.batch_update({"requests": requests})

    # Fill the Player column with a formula keyed purely on row position --
    # row 2 is player 1 of the first week's block, row 14 is player 1 of
    # the second week's block, etc.
    n_rows = VALIDATION_LAST_ROW - 1
    player_formula = f"=INDEX({NAMED_RANGE},MOD(ROW()-2,{len(players)})+1)"
    target.update([[player_formula]] * n_rows, f"D2:D{VALIDATION_LAST_ROW}", value_input_option="USER_ENTERED")

    # Final Split: blank unless this row's own Final Payout is filled in
    # (only a week's first row ever has one), in which case it's just that
    # value divided by 12. Every row gets the exact same formula text (the
    # API doesn't do fill-down reference adjustment the way pasting in the
    # UI would), so this has to be genuinely self-referential -- INDEX on
    # the whole column at ROW() -- rather than a fixed cell like $Q2, which
    # would make every row point at row 2's payout specifically.
    split_formula = (
        f'=IF(INDEX(${COL_FINAL_PAYOUT}:${COL_FINAL_PAYOUT},ROW())="","",'
        f'INDEX(${COL_FINAL_PAYOUT}:${COL_FINAL_PAYOUT},ROW())/{len(players)})'
    )
    target.update([[split_formula]] * n_rows, f"{COL_FINAL_SPLIT}2:{COL_FINAL_SPLIT}{VALIDATION_LAST_ROW}", value_input_option="USER_ENTERED")

    print(f"Wrote Player Order list to {HELPER_COL}1:{HELPER_COL}{1 + len(players)}, "
          f"named range '{NAMED_RANGE}', filled D2:D{VALIDATION_LAST_ROW} with the Player auto-fill "
          f"formula, and {COL_FINAL_SPLIT}2:{COL_FINAL_SPLIT}{VALIDATION_LAST_ROW} with the Final Split formula.")


if __name__ == "__main__":
    main()
