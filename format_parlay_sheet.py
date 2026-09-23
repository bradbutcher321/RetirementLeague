"""
Visual polish for "Auto Parlay Tracker": separates weeks (a live background
banding rule plus a top border every 12 rows, since every week is always
exactly 12 picks -- one per manager), keeps the header and identifying
columns visible while scrolling, and adds guidance notes on the header
cells explaining which fields matter for which bet type (the real source
of entry confusion, since Team/Opponent/Player Prop/Line/Side apply
differently depending on Bet Type). Re-runnable -- safe to run again.

Usage: python format_parlay_sheet.py
"""
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH

TARGET_TAB = "Auto Parlay Tracker"
VALIDATION_LAST_ROW = 3000  # matches add_parlay_validation.py
PLAYERS_PER_WEEK = 12  # every week is always all 12 managers, one row each

BAND_COLOR = {"red": 0.949, "green": 0.961, "blue": 0.976}  # light gray-blue
BORDER_COLOR = {"red": 0.4, "green": 0.4, "blue": 0.4}

HEADER_NOTES = {
    "Bet Type": (
        "Pick from the dropdown -- what else to fill in depends on it:\n"
        "- Spread / Alt Spread / 1st Half Spread: Team, Opponent, Line\n"
        "- Money Line: Team, Opponent only\n"
        "- Total Points / Total Goals / Total Rounds: Team, Opponent, Side, Line\n"
        "- Player props (Anytime TD, Receiving Yards, etc.): Player Prop "
        "(+ Side and Line, except Anytime TD needs neither)"
    ),
    "Team": "Who you bet on (Spread/Money Line), or either team in the game (Totals). Leave blank for player props.",
    "Opponent": "The other team in the game. Leave blank for player props.",
    "Player Prop": "Player's name -- player-stat bets only (Anytime TD, Receiving Yards, etc). Leave blank otherwise.",
    "Line": "The number, e.g. -5.5 or 38.5. Leave blank for Money Line and Anytime TD.",
    "Side": "Over or Under. Only applies to Totals and player-stat props (not Anytime TD, Spread, or Money Line).",
}


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def main():
    print("Loading Google Sheet...")
    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    target = spreadsheet.worksheet(TARGET_TAB)

    header = target.row_values(1)
    n_cols = len(header)

    meta = spreadsheet.fetch_sheet_metadata()
    sheet_props = next(s for s in meta["sheets"] if s["properties"]["sheetId"] == target.id)
    existing_rule_count = len(sheet_props.get("conditionalFormats", []))
    current_row_count = sheet_props["properties"]["gridProperties"]["rowCount"]

    requests = []
    # The sheet's actual grid has to be at least as tall as the range we're
    # about to format, or Sheets silently clamps any range request to
    # whatever the grid really has -- this bit everyone earlier: validation
    # and banding were both requested through row 3000 but only ever landed
    # through row 1000, the sheet's real row count.
    if current_row_count < VALIDATION_LAST_ROW:
        requests.append({
            "updateSheetProperties": {
                "properties": {"sheetId": target.id, "gridProperties": {"rowCount": VALIDATION_LAST_ROW}},
                "fields": "gridProperties.rowCount",
            }
        })
    # Clear existing conditional format rules first so re-running this
    # script updates the banding rule in place instead of stacking a
    # duplicate on top of it each time.
    requests += [{"deleteConditionalFormatRule": {"sheetId": target.id, "index": 0}} for _ in range(existing_rule_count)]

    # Reset any static background from a previous run of this script --
    # the banding below now comes entirely from a live conditional format
    # rule instead, so a stale direct fill underneath could look wrong if
    # the rule and the direct color ever disagree.
    requests.append({
        "repeatCell": {
            "range": {"sheetId": target.id, "startRowIndex": 1, "endRowIndex": VALIDATION_LAST_ROW,
                       "startColumnIndex": 0, "endColumnIndex": n_cols},
            "cell": {"userEnteredFormat": {"backgroundColor": {"red": 1, "green": 1, "blue": 1}}},
            "fields": "userEnteredFormat.backgroundColor",
        }
    })

    # Live alternating background, keyed off Year+Week, covering the same
    # range the dropdowns already reach -- a running "how many distinct
    # (Year, Week) pairs have I seen so far" count that flips parity each
    # time a new week starts. Because it's a formula (not a precomputed
    # color), it keeps working correctly for weeks added long after this
    # script last ran, with no need to re-run it just for banding.
    requests.append({
        "addConditionalFormatRule": {
            "rule": {
                "ranges": [{"sheetId": target.id, "startRowIndex": 1, "endRowIndex": VALIDATION_LAST_ROW,
                             "startColumnIndex": 0, "endColumnIndex": n_cols}],
                "booleanRule": {
                    "condition": {
                        "type": "CUSTOM_FORMULA",
                        # COUNTUNIQUE on a "&"-concatenation of two ranges doesn't
                        # reliably array-evaluate outside an explicit array formula
                        # (it silently collapsed to a scalar, so the rule never
                        # fired) -- SUMPRODUCT forces genuine element-wise array
                        # evaluation of COUNTIFS, which is the standard reliable
                        # way to count distinct (Year, Week) combinations so far.
                        "values": [{"userEnteredValue":
                            '=ISEVEN(SUMPRODUCT(1/COUNTIFS($A$2:$A2,$A$2:$A2,$B$2:$B2,$B$2:$B2)))'}],
                    },
                    "format": {"backgroundColor": BAND_COLOR},
                },
            },
            "index": 0,
        }
    })

    # Top border every 12 rows -- every week is always exactly 12 picks (one
    # per manager), so this is purely mechanical: it doesn't need to read
    # any actual data, and covers the full range in one pass, forever, with
    # no re-run needed after new weeks are added. (Conditional formatting
    # can't do borders, or this would be a live rule like the banding above.)
    for sheet_row_start in range(1, VALIDATION_LAST_ROW, PLAYERS_PER_WEEK):  # 0-indexed sheet row
        requests.append({
            "updateBorders": {
                "range": {"sheetId": target.id, "startRowIndex": sheet_row_start,
                           "endRowIndex": sheet_row_start + 1, "startColumnIndex": 0, "endColumnIndex": n_cols},
                "top": {"style": "SOLID_MEDIUM", "color": BORDER_COLOR},
            }
        })

    # Freeze the header row and the identifying columns (Year/Week/Sacko/Player).
    requests.append({
        "updateSheetProperties": {
            "properties": {"sheetId": target.id, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 4}},
            "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        }
    })

    # Guidance notes on header cells.
    for col_name, note in HEADER_NOTES.items():
        col = header.index(col_name)
        requests.append({
            "updateCells": {
                "range": {"sheetId": target.id, "startRowIndex": 0, "endRowIndex": 1,
                           "startColumnIndex": col, "endColumnIndex": col + 1},
                "rows": [{"values": [{"note": note}]}],
                "fields": "note",
            }
        })

    spreadsheet.batch_update({"requests": requests})
    print(f"Applied live week banding and a mechanical every-{PLAYERS_PER_WEEK}-row "
          f"border (rows 2-{VALIDATION_LAST_ROW}), frozen panes, and "
          f"{len(HEADER_NOTES)} header notes to '{TARGET_TAB}'.")


if __name__ == "__main__":
    main()
