"""
Replaces manual/dropdown Player entry on "Auto Parlay Tracker" with an
auto-filled formula, since every week is always the same 12 players in the
same fixed order. Writes a small "Player Order" reference list off to the
side of the main table, names it as a range, and fills the Player column
(rows 2-3000) with a formula that picks the right name purely from row
position -- so a new week's 12 rows already show the correct names with
no typing or dropdown selection needed.

Requires every existing week to already be a full, correctly-ordered
12-row block (see the Chad/Jeff placeholder-row fix for 2026 week 2) --
this formula assumes strict alignment and will silently mislabel players
if that's ever violated again.

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
HELPER_COL = "Q"  # off to the side of the main table (A-O)
NAMED_RANGE = "PlayerOrder"


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


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
    requests.append({
        "addNamedRange": {
            "namedRange": {
                "name": NAMED_RANGE,
                "range": {"sheetId": target.id, "startRowIndex": 1, "endRowIndex": 1 + len(players),
                           "startColumnIndex": 16, "endColumnIndex": 17},  # Q2:Q13
            }
        }
    })
    spreadsheet.batch_update({"requests": requests})

    # Fill the Player column with a formula keyed purely on row position --
    # row 2 is player 1 of the first week's block, row 14 is player 1 of
    # the second week's block, etc.
    n_rows = VALIDATION_LAST_ROW - 1
    formula = f"=INDEX({NAMED_RANGE},MOD(ROW()-2,{len(players)})+1)"
    target.update([[formula]] * n_rows, f"D2:D{VALIDATION_LAST_ROW}", value_input_option="USER_ENTERED")

    print(f"Wrote Player Order list to {HELPER_COL}1:{HELPER_COL}{1 + len(players)}, "
          f"named range '{NAMED_RANGE}', and filled D2:D{VALIDATION_LAST_ROW} with the auto-fill formula.")


if __name__ == "__main__":
    main()
