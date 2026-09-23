"""
Visual polish for "Auto Parlay Tracker": separates weeks so consecutive
weeks don't visually blend together in a one-row-per-pick table, keeps the
header and identifying columns visible while scrolling, and adds guidance
notes on the header cells explaining which fields matter for which bet
type (the real source of entry confusion, since Team/Opponent/Player Prop/
Line/Side apply differently depending on Bet Type). Re-runnable -- safe to
run again after adding more weeks.

Usage: python format_parlay_sheet.py
"""
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH

TARGET_TAB = "Auto Parlay Tracker"
COL_YEAR, COL_WEEK = 0, 1

WEEK_BAND_COLORS = [
    {"red": 1, "green": 1, "blue": 1},          # white
    {"red": 0.949, "green": 0.961, "blue": 0.976},  # light gray-blue
]
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


def week_blocks(rows):
    """rows: list of [year, week, ...] data rows (no header). Returns
    [(start_row_idx, end_row_idx), ...] 0-indexed, end exclusive, relative
    to the data (row 0 here = sheet row 2)."""
    blocks = []
    start = 0
    prev = (rows[0][COL_YEAR], rows[0][COL_WEEK]) if rows else None
    for i, r in enumerate(rows):
        key = (r[COL_YEAR], r[COL_WEEK])
        if key != prev:
            blocks.append((start, i))
            start = i
            prev = key
    if rows:
        blocks.append((start, len(rows)))
    return blocks


def main():
    print("Loading Google Sheet...")
    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    target = spreadsheet.worksheet(TARGET_TAB)

    header = target.row_values(1)
    n_cols = len(header)
    data_rows = [r for r in target.get_values("A2:Z3000") if any(r)]
    blocks = week_blocks(data_rows)
    print(f"Found {len(blocks)} week blocks across {len(data_rows)} rows.")

    requests = []

    # Alternate background per week block, and a top border where a new
    # week starts, so blocks read as visually separate groups.
    for i, (start, end) in enumerate(blocks):
        sheet_row_start = start + 1  # +1 to skip header (0-indexed sheet row)
        sheet_row_end = end + 1
        color = WEEK_BAND_COLORS[i % 2]
        requests.append({
            "repeatCell": {
                "range": {"sheetId": target.id, "startRowIndex": sheet_row_start,
                           "endRowIndex": sheet_row_end, "startColumnIndex": 0, "endColumnIndex": n_cols},
                "cell": {"userEnteredFormat": {"backgroundColor": color}},
                "fields": "userEnteredFormat.backgroundColor",
            }
        })
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
    print(f"Applied week banding/borders, frozen panes, and {len(HEADER_NOTES)} header notes to '{TARGET_TAB}'.")


if __name__ == "__main__":
    main()
