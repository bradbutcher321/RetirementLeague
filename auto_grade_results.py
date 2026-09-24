"""
Grades finished games against real final scores from ESPN, filling in
Result ("Win"/"Loss") for picks that are still Pending but whose Gametime
has already passed -- Phase 2 of PARLAY_DATA_MIGRATION.md.

Only Money Line, Spread, and Alt Spread, and Total Points/Goals/Rounds
bets are auto-graded -- these are fully determined by the final score
alone. Every other bet type always needs a human and is reported
separately rather than silently skipped, so nothing falls through the
cracks unnoticed:
  - 1st Half Spread needs the halftime score, not the final one.
  - Player props (Receiving Yards, Passing TD, etc.) and Anytime TD need
    a box score, not just a final score.
  - Coin Toss isn't something ESPN's scoreboard reports at all.

A push (the final score/total lands exactly on the line) is reported for
manual review rather than guessed -- the sheet's Result column only has
Win/Loss/Pending today, and inventing a value for a push isn't this
script's call to make (see PARLAY_DATA_MIGRATION.md's Phase 2 notes).

Runs every 30 minutes as a step in the "Refresh Parlay Data" GitHub
Action (.github/workflows/refresh_parlay_data.yml), right before that
same run republishes stats to KV and syncs picks to D1 -- so a pick
grades and the site reflects it within one 30-minute cycle of its game
actually finishing, with no one needing to run anything by hand. Uses
the same GOOGLE_CREDENTIALS secret (write-scoped) the other scheduled
scripts already have available in CI -- no new secret was needed, since
that credential was never scope-*restricted* to read-only, the read-only
scripts just never asked for write scope. Safe to run unattended and
this often precisely because of the guarantees below: it can only ever
add a Win/Loss to a currently-blank Result, checks each of a week's 12
picks independently (grading whichever games have actually finished
without waiting on the other 11), and leaves anything it can't grade
confidently for a human instead of guessing. Can still be run by hand
too, e.g. with --dry-run to preview what a run would do.

Never overwrites a Result that's already Win/Loss -- only ever fills a
blank/Pending cell -- and leaves a cell note on anything it grades
(final score + when) so it's never a silent black box.

Usage:
    python auto_grade_results.py            # grade and write
    python auto_grade_results.py --dry-run   # report only, write nothing
"""
import argparse
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH
from parlay_note_parser import VS_ONLY, TOTAL_VS, parse_signed_number
from espn_gametime_lookup import find_final_score

TARGET_TAB = "Auto Parlay Tracker"
EASTERN = ZoneInfo("America/New_York")

# Spread/Alt Spread deliberately excludes "1st Half Spread" (in
# parlay_note_parser.py's own TEAM_LINE_VS) -- that one needs the
# halftime score, which find_final_score() doesn't have.
GRADABLE_BET_TYPES = {"Spread", "Alt Spread"} | VS_ONLY | TOTAL_VS


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def grade_pick(bet_type, team_score, opp_score, line_text, side_text):
    """Returns 'Win', 'Loss', or None (a push, or something not
    confidently gradable -- caller treats None as "needs a human")."""
    if bet_type in VS_ONLY:  # Money Line
        if team_score == opp_score:
            return None  # a 2-way money line has no defined outcome for a tie
        return "Win" if team_score > opp_score else "Loss"

    if bet_type in ("Spread", "Alt Spread"):
        line = parse_signed_number(line_text)
        if line is None:
            return None
        covered = (team_score - opp_score) + line
        if covered == 0:
            return None  # push
        return "Win" if covered > 0 else "Loss"

    if bet_type in TOTAL_VS:
        line = parse_signed_number(line_text)
        if line is None or side_text not in ("Over", "Under"):
            return None
        total = team_score + opp_score
        if total == line:
            return None  # push
        above = total > line
        return "Win" if (above if side_text == "Over" else not above) else "Loss"

    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Report what would be graded without writing anything")
    args = parser.parse_args()

    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    ws = spreadsheet.worksheet(TARGET_TAB)

    rows = ws.get_values("A2:N3000")  # Year..Result
    now_eastern = datetime.now(EASTERN).replace(tzinfo=None)

    graded, needs_review, still_pending = [], [], []

    for i, r in enumerate(rows):
        row_num = i + 2
        result = (r[13].strip() if len(r) > 13 else "")
        if result in ("Win", "Loss"):
            continue  # already graded (manually or by a previous run) -- never touch

        player = r[3].strip() if len(r) > 3 else ""
        bet_type = r[5].strip() if len(r) > 5 else ""
        sport = r[4].strip() if len(r) > 4 else ""
        team = r[6].strip() if len(r) > 6 else ""
        opponent = r[7].strip() if len(r) > 7 else ""
        line = r[9].strip() if len(r) > 9 else ""
        side = r[10].strip() if len(r) > 10 else ""
        gametime = r[12].strip() if len(r) > 12 else ""
        if not player or not bet_type:
            continue  # blank row -- nobody's picked yet

        if not gametime:
            still_pending.append((row_num, player, "no Gametime recorded"))
            continue
        try:
            gt = datetime.fromisoformat(gametime)
        except ValueError:
            still_pending.append((row_num, player, f"unparseable Gametime '{gametime}'"))
            continue
        if gt > now_eastern:
            still_pending.append((row_num, player, f"{gametime} hasn't happened yet"))
            continue

        if bet_type not in GRADABLE_BET_TYPES:
            needs_review.append((row_num, player, f"'{bet_type}' isn't gradable from a final score alone"))
            continue
        if not team or not opponent:
            needs_review.append((row_num, player, "missing Team/Opponent"))
            continue

        team_score, opp_score, _team_won = find_final_score(team, opponent, sport, gametime)
        if team_score is None:
            needs_review.append((row_num, player, f"game not found or not final yet ({team} vs {opponent}, {sport})"))
            continue

        outcome = grade_pick(bet_type, team_score, opp_score, line, side)
        if outcome is None:
            needs_review.append((row_num, player, f"push -- {team_score:g}-{opp_score:g} lands exactly on the line"))
            continue

        graded.append((row_num, player, outcome, team_score, opp_score))

    print(f"{len(graded)} pick(s) to grade, {len(needs_review)} need manual review, "
          f"{len(still_pending)} still genuinely pending.\n")
    for row_num, player, outcome, ts, os_ in graded:
        print(f"  row {row_num} ({player}): {outcome}  [{ts:g}-{os_:g}]")
    if needs_review:
        print("\nNeeds manual review:")
        for row_num, player, why in needs_review:
            print(f"  row {row_num} ({player}): {why}")

    if not graded:
        print("\nNothing to write.")
        return
    if args.dry_run:
        print(f"\nDry run -- {len(graded)} result(s) would be written, nothing actually written.")
        return

    note_stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    for row_num, player, outcome, ts, os_ in graded:
        ws.update([[outcome]], f"N{row_num}")
        ws.update_note(f"N{row_num}", f"Auto-graded {note_stamp} ({ts:g}-{os_:g} final)")
    print(f"\nWrote {len(graded)} result(s).")


if __name__ == "__main__":
    main()
