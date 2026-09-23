"""
Adds dropdown data validation to "Auto Parlay Tracker" so new picks typed
directly into the structured columns stay consistent, instead of relying on
free text (or, later, a parser) to get it right. Re-runnable -- safe to run
again if the value lists below change.

Strict columns (Player, Side, Result) reject anything not in the list --
there's never a legitimate reason for a new value there. Sport and Bet Type
use a warning instead of a hard reject: the league has already used 11
different sports and 17 different bet types across two seasons, so a new
one showing up next week is plausible and shouldn't be blocked, just nudged
toward the existing spelling when one already fits.

Usage: python add_parlay_validation.py
"""
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH
import generate_parlay_data as gp

TARGET_TAB = "Auto Parlay Tracker"
VALIDATION_LAST_ROW = 3000  # generous headroom for future picks, 0-indexed exclusive

# Column indices match migrate_parlay_tracker.py's HEADER order (0-indexed).
COL_SACKO, COL_PLAYER, COL_SPORT, COL_BET_TYPE, COL_SIDE, COL_RESULT = 2, 3, 4, 5, 10, 13

# NHL and Hockey both appear in history for the same sport -- NHL is the
# canonical spelling going forward; the existing "Hockey" row is left as-is
# (this only affects the dropdown list, not any existing cell value).
SPORTS = ["NFL", "NCAAF", "NBA", "NCAAM", "NHL", "MLB", "Futbol", "UFC", "Boxing", "Womens Tennis"]
BET_TYPES = ["Money Line", "Spread", "Alt Spread", "1st Half Spread", "Anytime TD",
             "Total Points", "Total Goals", "Total Rounds", "Receiving Yards",
             "Passing TD", "Passing Yards", "Receptions", "Total Yards",
             "Home Runs", "Player Points", "Interceptions", "Coin Toss"]
SIDES = ["Over", "Under"]
RESULTS = ["Win", "Loss", "Pending"]


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def clear_all_validation(spreadsheet, sheet_id):
    """Removes every data validation rule on the sheet first. Without this,
    re-running after a column shift (e.g. inserting Sacko) leaves the old
    rules sitting on whatever column now occupies that position -- which is
    exactly what broke Line and Gametime last time (they inherited Side's
    and Result's old strict dropdowns and started rejecting real values)."""
    spreadsheet.batch_update({
        "requests": [{"setDataValidation": {"range": {"sheetId": sheet_id}}}]
    })


def validation_request(sheet_id, col, values, strict):
    return {
        "setDataValidation": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": 1,  # skip the header row
                "endRowIndex": VALIDATION_LAST_ROW,
                "startColumnIndex": col,
                "endColumnIndex": col + 1,
            },
            "rule": {
                "condition": {
                    "type": "ONE_OF_LIST",
                    "values": [{"userEnteredValue": v} for v in values],
                },
                "strict": strict,
                "showCustomUi": True,
            },
        }
    }


def ensure_row_count(spreadsheet, worksheet, min_rows):
    """A range request beyond the sheet's actual grid size is silently
    clamped to it, not rejected -- this is why validation only ever
    reached row 1000 despite being requested through row 3000 (the sheet's
    real row count until now)."""
    props = next(s["properties"] for s in spreadsheet.fetch_sheet_metadata()["sheets"]
                 if s["properties"]["sheetId"] == worksheet.id)
    if props["gridProperties"]["rowCount"] < min_rows:
        spreadsheet.batch_update({"requests": [{
            "updateSheetProperties": {
                "properties": {"sheetId": worksheet.id, "gridProperties": {"rowCount": min_rows}},
                "fields": "gridProperties.rowCount",
            }
        }]})


def main():
    print("Loading Google Sheet...")
    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    players, _ = gp.load_tracker(spreadsheet)
    target = spreadsheet.worksheet(TARGET_TAB)
    ensure_row_count(spreadsheet, target, VALIDATION_LAST_ROW)
    clear_all_validation(spreadsheet, target.id)

    requests = [
        validation_request(target.id, COL_SACKO, players, strict=True),
        validation_request(target.id, COL_PLAYER, players, strict=True),
        validation_request(target.id, COL_SPORT, SPORTS, strict=False),
        validation_request(target.id, COL_BET_TYPE, BET_TYPES, strict=False),
        validation_request(target.id, COL_SIDE, SIDES, strict=True),
        validation_request(target.id, COL_RESULT, RESULTS, strict=True),
    ]
    spreadsheet.batch_update({"requests": requests})
    print(f"Applied dropdown validation to Sacko, Player, Sport, Bet Type, Side, Result "
          f"on '{TARGET_TAB}' (rows 2-{VALIDATION_LAST_ROW}).")


if __name__ == "__main__":
    main()
