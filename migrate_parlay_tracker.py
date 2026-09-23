"""
One-time (re-runnable) migration: converts the "Parlay Tracker" tab's
column-per-week, freeform-"Pick"-text layout into a tidy, one-row-per-pick
layout on the "Auto Parlay Tracker" tab, splitting each pick's "{Bet Type}:
{details}" text into structured fields a script can grade against real game
data later, instead of a sentence a human has to read.

Money Line convention: the first team listed is who was bet on (confirmed
with the league). Rows the parser can't confidently split (e.g. a Spread
pick missing its line) are still written, with just the unparseable fields
left blank, so they're easy to spot and fix by hand rather than guessed at.

Usage: python migrate_parlay_tracker.py
"""
import os
import re
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH
import generate_parlay_data as gp

TARGET_TAB = "Auto Parlay Tracker"
HEADER = ["Year", "Week", "Sacko", "Player", "Sport", "Bet Type", "Team", "Opponent",
          "Player Prop", "Line", "Side", "Odds", "Gametime", "Result", "Raw Pick"]

TEAM_LINE_VS = {"Spread", "Alt Spread", "1st Half Spread"}
VS_ONLY = {"Money Line"}
TOTAL_VS = {"Total Points", "Total Goals", "Total Rounds"}
PLAYER_OU = {"Receiving Yards", "Passing TD", "Home Runs", "Player Points",
             "Interceptions", "Total Yards", "Receptions", "Passing Yards"}
PLAYER_ONLY = {"Anytime TD", "Coin Toss"}

LINE_TEAM_VS = re.compile(r"^([+-]\d+(?:\.\d+)?)\s+(.+?)\s+vs\.?\s+(.+)$")
TEAM_LINE_VS_RE = re.compile(r"^(.+?)\s+([+-]\d+(?:\.\d+)?)\s+vs\.?\s+(.+)$")
TEAM_VS_TEAM_RE = re.compile(r"^(.+?)\s+vs\.?\s+(.+)$")
OU_TEAM_VS_TEAM_RE = re.compile(r"^(Over|Under)\s+(\.?\d+(?:\.\d+)?)\s+(.+?)\s+vs\.?\s+(.+)$")
OU_PLAYER_RE = re.compile(r"^(Over|Under)\s+(\.?\d+(?:\.\d+)?)\s+(.+)$")


def clear_formatting(spreadsheet, worksheet):
    """"Auto Parlay Tracker" started as a duplicate of the old column-per-week
    tab, so some cells still carry its custom date/time number format --
    writing a plain number into one displays it reinterpreted as a time
    (e.g. odds -110 showing as "Monday at 12:00AM") even though the
    underlying stored value is correct. Reset every cell's format before
    writing so the new table also displays cleanly."""
    spreadsheet.batch_update({
        "requests": [{
            "repeatCell": {
                "range": {"sheetId": worksheet.id},
                "cell": {"userEnteredFormat": {}},
                "fields": "userEnteredFormat",
            }
        }]
    })


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def parse_pick(pick):
    """Returns a dict of the structured fields, with anything the text
    didn't cleanly contain left as ''. Never raises -- worst case is a row
    with more blanks than expected, which is visible and fixable in the sheet."""
    row = {"bet_type": "", "team": "", "opponent": "", "player_prop": "", "line": "", "side": ""}
    text = pick.strip()
    if text == "Pass":
        row["bet_type"] = "Pass"
        return row

    m = re.match(r"^([^:]+):\s*(.*)$", text)
    if not m:
        return row
    bt, rest = m.group(1).strip(), m.group(2).strip()
    row["bet_type"] = bt

    if bt in TEAM_LINE_VS:
        mm = TEAM_LINE_VS_RE.match(rest)
        if mm:
            row["team"], row["line"], row["opponent"] = mm.group(1), mm.group(2), mm.group(3)
            return row
        mm = LINE_TEAM_VS.match(rest)
        if mm:
            row["line"], row["team"], row["opponent"] = mm.group(1), mm.group(2), mm.group(3)
            return row
        mm = TEAM_VS_TEAM_RE.match(rest)  # line missing entirely -- flagged by blank Line
        if mm:
            row["team"], row["opponent"] = mm.group(1), mm.group(2)
        return row

    if bt in VS_ONLY:
        mm = TEAM_VS_TEAM_RE.match(rest)
        if mm:
            row["team"], row["opponent"] = mm.group(1), mm.group(2)
        return row

    if bt in TOTAL_VS:
        mm = OU_TEAM_VS_TEAM_RE.match(rest)
        if mm:
            row["side"], row["line"], row["team"], row["opponent"] = mm.groups()
        return row

    if bt in PLAYER_OU:
        mm = OU_PLAYER_RE.match(rest)
        if mm:
            row["side"], row["line"], row["player_prop"] = mm.groups()
        return row

    if bt in PLAYER_ONLY:
        row["player_prop"] = rest
        return row

    return row  # unrecognized bet type -- written with just Bet Type + Raw Pick


def main():
    print("Loading Google Sheet...")
    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    players, weeks = gp.load_tracker(spreadsheet)

    rows = []
    flagged = []
    for week in weeks:
        # Sacko is a once-per-week fact, not a per-pick one -- write it only
        # on that week's first row so it isn't repeated down the block.
        sacko_written = False
        for player in players:
            pick = week["picks"].get(player)
            if not pick:
                continue
            parsed = parse_pick(pick["pick"])
            sacko = week["sacko"] or ""
            row = [
                week["year"], week["week"], sacko if not sacko_written else "", player, pick["sport"] or "",
                parsed["bet_type"], parsed["team"], parsed["opponent"], parsed["player_prop"],
                parsed["line"], parsed["side"], pick["odds"] if pick["odds"] is not None else "",
                pick["gametime"] or "", pick["result"], pick["pick"],
            ]
            sacko_written = True
            rows.append(row)
            missing_expected = (
                (parsed["bet_type"] in TEAM_LINE_VS and not parsed["line"]) or
                (parsed["bet_type"] in TOTAL_VS | PLAYER_OU and not parsed["side"]) or
                (parsed["bet_type"] not in TEAM_LINE_VS | VS_ONLY | TOTAL_VS | PLAYER_OU | PLAYER_ONLY | {"Pass"})
            )
            if missing_expected:
                flagged.append(row)

    print(f"Parsed {len(rows)} picks ({len(flagged)} flagged for manual review).")

    target = spreadsheet.worksheet(TARGET_TAB)
    clear_formatting(spreadsheet, target)
    target.clear()
    target.update([HEADER] + rows, "A1")
    print(f"Wrote {len(rows)} rows to '{TARGET_TAB}'.")

    if flagged:
        print("\nFlagged rows (missing a field the format expects):")
        for r in flagged:
            print(" ", r[3], r[0], "wk", r[1], "-", r[-1])


if __name__ == "__main__":
    main()
