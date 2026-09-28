"""
Grades finished games against real ESPN data, filling in Result ("Win"/
"Loss") for picks that are still Pending but whose Gametime has already
passed -- Phase 2 of PARLAY_DATA_MIGRATION.md.

Every bet type in the sheet's validation list is auto-graded except Coin
Toss, which ESPN's public API doesn't report anywhere (confirmed
directly) and always needs a human. Three kinds of ESPN data are used,
depending what the bet actually needs to settle:
  - SCORE_BET_TYPES (Money Line, Spread, Alt Spread, Total Points/Goals/
    Rounds): the final score alone, via find_final_score().
  - HALF_SCORE_BET_TYPES (1st Half Spread): the halftime score (first two
    periods' linescores), via find_half_score() -- find_final_score()'s
    full-game score can't settle this one.
  - PROP_BET_TYPES (Anytime TD, and every Over/Under player prop --
    Passing/Receiving Yards, Passing TD, Receptions, Interceptions, Total
    Yards, Player Points, Home Runs): a box-score stat line for that
    specific player, via find_prop_stat(). The player's team isn't
    recorded in the sheet for these (only Sport and Player Prop are), so
    this re-resolves it the same way parlay_gui.py did when the pick was
    first entered (ESPN player search), then locates that team's specific
    game on Gametime's date. A player who can't be confidently found in
    the finished game's box score at all is left for manual review rather
    than graded a guessed zero -- could be a real DNP, a name that
    doesn't match ESPN's box score spelling, or (rarer) a genuine same-
    name ambiguity ESPN's own search didn't resolve cleanly.

A push (the score/stat lands exactly on the line) is reported for manual
review rather than guessed -- the sheet's Result column only has
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
(the score/stat it graded from, and when) so it's never a silent black
box.

Verified against 49 already-graded historical picks covering every prop
bet type in real use (see PARLAY_DATA_MIGRATION.md): 38 confidently
regraded, all 38 matching the sheet's existing Win/Loss exactly (0
mismatches); the other 11 correctly came back "needs review" rather than
a wrong guess -- genuine same-name ambiguity ESPN's own search couldn't
resolve (e.g. two real NFL players both named "Josh Allen"), a real
pick-entry typo ("Isiah" for "Isaiah" Likely), or an ESPN search-index
quirk (a punctuation variant of a name returning zero hits) -- not a
grading error.

Also writes the score/stat a pick was actually graded from into a
"Grade Detail" column (see DETAIL_COLUMN) -- e.g. "17-10 final" or
"Matt Stafford: 390" -- so docs/parlay-results.html can show *why* a leg
won or lost, not just the Win/Loss pill. Normal grading writes this
alongside Result as it goes; --backfill instead fills it in for picks
that already have a Result but no detail yet (everything graded before
this column existed), without touching Result at all.

Usage:
    python auto_grade_results.py             # grade and write
    python auto_grade_results.py --dry-run    # report only, write nothing
    python auto_grade_results.py --backfill   # fill in Grade Detail for old graded picks
"""
import argparse
import os
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH
from parlay_note_parser import VS_ONLY, TOTAL_VS, TEAM_LINE_VS, PLAYER_OU, parse_signed_number
from espn_gametime_lookup import find_final_score, find_half_score, find_prop_stat

TARGET_TAB = "Auto Parlay Tracker"
EASTERN = ZoneInfo("America/New_York")
# Column S -- empty in the sheet until this was added, with T left as a
# gap (matching how the sheet has made room for new columns before, e.g.
# the "Player Order" helper list moving from Q to U -- see
# PARLAY_DATA_MIGRATION.md). Holds the plain-text score/stat a pick's
# Result was actually graded from (e.g. "17-10 final" or "Matt Stafford:
# 390"), so docs/parlay-results.html can show *why* a leg won or lost,
# not just the Win/Loss pill -- see generate_parlay_data.py's load_tracker().
DETAIL_COLUMN = "S"
DETAIL_COLUMN_IDX = 18

SCORE_BET_TYPES = (TEAM_LINE_VS - {"1st Half Spread"}) | VS_ONLY | TOTAL_VS
HALF_SCORE_BET_TYPES = {"1st Half Spread"}
# Anytime TD is binary (no Line/Side -- did they score at all, or "Nx Name"
# for an N-or-more-TDs leg) rather than an Over/Under stat, so it's tracked
# separately from the rest of PLAYER_OU even though both are graded via the
# same find_prop_stat() box-score lookup.
PROP_OU_BET_TYPES = set(PLAYER_OU)
PROP_BINARY_BET_TYPES = {"Anytime TD"}
PROP_BET_TYPES = PROP_OU_BET_TYPES | PROP_BINARY_BET_TYPES
GRADABLE_BET_TYPES = SCORE_BET_TYPES | HALF_SCORE_BET_TYPES | PROP_BET_TYPES

# "2x Rashee Rice" (2+ TDs), "Nx Name" in general -- see PROP_BINARY_BET_TYPES.
MULTI_LEG_PROP_RE = re.compile(r"^(\d+)x\s+(.+)$", re.IGNORECASE)


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def grade_pick(bet_type, team_score, opp_score, line_text, side_text):
    """Returns 'Win', 'Loss', or None (a push, or something not
    confidently gradable -- caller treats None as "needs a human"). Used
    for every bet type settled by two scores and (usually) a line -- game
    totals here, and, via grade_over_under below, player-prop stats too.
    team_score/opp_score are the full-game final score for most bet
    types, or the halftime score for 1st Half Spread -- grade_pick doesn't
    care which, the spread math is identical either way."""
    if bet_type in VS_ONLY:  # Money Line
        if team_score == opp_score:
            return None  # a 2-way money line has no defined outcome for a tie
        return "Win" if team_score > opp_score else "Loss"

    if bet_type in TEAM_LINE_VS:  # Spread, Alt Spread, 1st Half Spread
        line = parse_signed_number(line_text)
        if line is None:
            return None
        covered = (team_score - opp_score) + line
        if covered == 0:
            return None  # push
        return "Win" if covered > 0 else "Loss"

    if bet_type in TOTAL_VS:
        return grade_over_under(team_score + opp_score, line_text, side_text)

    return None


def grade_over_under(value, line_text, side_text):
    """Returns 'Win'/'Loss'/None (a missing/unparseable Line or Side, or a
    push) for a plain Over/Under against a known value -- shared by game
    totals (TOTAL_VS, via grade_pick above) and player-prop stats
    (PROP_OU_BET_TYPES, via grade_prop below), which are graded exactly
    the same way once the relevant number is known."""
    line = parse_signed_number(line_text)
    if line is None or side_text not in ("Over", "Under"):
        return None
    if value == line:
        return None  # push
    above = value > line
    return "Win" if (above if side_text == "Over" else not above) else "Loss"


def grade_prop(bet_type, player_prop_text, sport, gametime, line_text, side_text):
    """Returns (outcome, stat_total, reason) -- outcome is 'Win'/'Loss'/
    None; reason explains a None outcome (also set, with stat_total=None,
    if the player/game lookup itself fails) for the caller to report.

    Anytime TD is binary, not Line/Side-based: the stat total (TDs scored,
    summed across every way one can be -- see PROP_STAT_SPECS in
    espn_gametime_lookup.py) just needs to meet the required count -- 1,
    or N for an "Nx Name" multi-leg pick (e.g. "2x Rashee Rice" means 2+
    TDs). Every other prop is graded exactly like a game total, via
    grade_over_under."""
    m = MULTI_LEG_PROP_RE.match(player_prop_text)
    required, player_name = (int(m.group(1)), m.group(2)) if m else (1, player_prop_text)
    if not player_name:
        return None, None, "missing Player Prop"

    total, found = find_prop_stat(player_name, bet_type, sport, gametime)
    if not found:
        return None, None, f"'{player_name}' not found in the box score (not final yet, a DNP, or a name mismatch)"

    if bet_type in PROP_BINARY_BET_TYPES:
        return ("Win" if total >= required else "Loss"), total, None

    outcome = grade_over_under(total, line_text, side_text)
    if outcome is None:
        return None, total, f"push or missing Line/Side -- stat was {total:g}"
    return outcome, total, None


def ensure_detail_header(ws):
    if not (ws.get_values(f"{DETAIL_COLUMN}1:{DETAIL_COLUMN}1") or [[""]])[0]:
        ws.update([["Grade Detail"]], f"{DETAIL_COLUMN}1")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Report what would happen without writing anything")
    parser.add_argument("--backfill", action="store_true",
                         help="Fill in Grade Detail for already-graded historical picks that don't have one yet, "
                              "without touching Result or grading anything new")
    args = parser.parse_args()

    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    ws = spreadsheet.worksheet(TARGET_TAB)
    ensure_detail_header(ws)

    rows = ws.get_values(f"A2:{DETAIL_COLUMN}3000")  # Year..Grade Detail

    if args.backfill:
        run_backfill(ws, rows, args.dry_run)
        return

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
        player_prop = r[8].strip() if len(r) > 8 else ""
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
            needs_review.append((row_num, player, f"'{bet_type}' isn't auto-gradable (ESPN's API doesn't report a Coin Toss result)"))
            continue

        if bet_type in PROP_BET_TYPES:
            if not player_prop:
                needs_review.append((row_num, player, "missing Player Prop"))
                continue
            outcome, stat_total, reason = grade_prop(bet_type, player_prop, sport, gametime, line, side)
            if outcome is None:
                needs_review.append((row_num, player, reason))
                continue
            graded.append((row_num, player, outcome, f"{player_prop}: {stat_total:g}"))
            continue

        if not team or not opponent:
            needs_review.append((row_num, player, "missing Team/Opponent"))
            continue

        if bet_type in HALF_SCORE_BET_TYPES:
            team_score, opp_score = find_half_score(team, opponent, sport, gametime)
            score_label = "1st half"
        else:
            team_score, opp_score, _team_won = find_final_score(team, opponent, sport, gametime)
            score_label = "final"
        if team_score is None:
            needs_review.append((row_num, player, f"game not found or not final yet ({team} vs {opponent}, {sport})"))
            continue

        outcome = grade_pick(bet_type, team_score, opp_score, line, side)
        if outcome is None:
            needs_review.append((row_num, player, f"push -- {team_score:g}-{opp_score:g} ({score_label}) lands exactly on the line"))
            continue

        graded.append((row_num, player, outcome, f"{team_score:g}-{opp_score:g} {score_label}"))

    print(f"{len(graded)} pick(s) to grade, {len(needs_review)} need manual review, "
          f"{len(still_pending)} still genuinely pending.\n")
    for row_num, player, outcome, detail in graded:
        print(f"  row {row_num} ({player}): {outcome}  [{detail}]")
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
    for row_num, player, outcome, detail in graded:
        ws.update([[outcome]], f"N{row_num}")
        ws.update_note(f"N{row_num}", f"Auto-graded {note_stamp} ({detail})")
        ws.update([[detail]], f"{DETAIL_COLUMN}{row_num}")
    print(f"\nWrote {len(graded)} result(s).")


def run_backfill(ws, rows, dry_run):
    """One-time (re-runnable) sweep: fills in Grade Detail for picks that
    already have a Win/Loss Result but no detail yet -- everything graded
    before this column existed. Reuses the exact same lookup functions as
    normal grading, just to recover the score/stat text; never writes
    Result, even implicitly -- ESPN's historical data for an already-final
    game doesn't change, so there's nothing to re-grade, only an
    explanation to recover."""
    to_write, skipped = [], []

    for i, r in enumerate(rows):
        row_num = i + 2
        result = r[13].strip() if len(r) > 13 else ""
        if result not in ("Win", "Loss"):
            continue
        if r[DETAIL_COLUMN_IDX].strip() if len(r) > DETAIL_COLUMN_IDX else "":
            continue  # already has a detail -- don't overwrite a value a human might have hand-adjusted

        player = r[3].strip() if len(r) > 3 else ""
        bet_type = r[5].strip() if len(r) > 5 else ""
        sport = r[4].strip() if len(r) > 4 else ""
        team = r[6].strip() if len(r) > 6 else ""
        opponent = r[7].strip() if len(r) > 7 else ""
        player_prop = r[8].strip() if len(r) > 8 else ""
        line = r[9].strip() if len(r) > 9 else ""
        side = r[10].strip() if len(r) > 10 else ""
        gametime = r[12].strip() if len(r) > 12 else ""
        if not gametime:
            skipped.append((row_num, player, "no Gametime recorded"))
            continue

        if bet_type in PROP_BET_TYPES:
            if not player_prop:
                skipped.append((row_num, player, "missing Player Prop"))
                continue
            _outcome, stat_total, reason = grade_prop(bet_type, player_prop, sport, gametime, line, side)
            if stat_total is None:
                skipped.append((row_num, player, reason))
                continue
            detail = f"{player_prop}: {stat_total:g}"
        elif bet_type in SCORE_BET_TYPES | HALF_SCORE_BET_TYPES:
            if not team or not opponent:
                skipped.append((row_num, player, "missing Team/Opponent"))
                continue
            if bet_type in HALF_SCORE_BET_TYPES:
                team_score, opp_score = find_half_score(team, opponent, sport, gametime)
                score_label = "1st half"
            else:
                team_score, opp_score, _team_won = find_final_score(team, opponent, sport, gametime)
                score_label = "final"
            if team_score is None:
                skipped.append((row_num, player, f"game not found or not final yet ({team} vs {opponent}, {sport})"))
                continue
            detail = f"{team_score:g}-{opp_score:g} {score_label}"
        else:
            skipped.append((row_num, player, f"'{bet_type}' isn't auto-gradable"))
            continue

        to_write.append((row_num, player, detail))

    print(f"{len(to_write)} detail(s) to backfill, {len(skipped)} skipped.\n")
    for row_num, player, detail in to_write:
        print(f"  row {row_num} ({player}): {detail}")
    if skipped:
        print("\nSkipped:")
        for row_num, player, why in skipped:
            print(f"  row {row_num} ({player}): {why}")

    if not to_write:
        print("\nNothing to write.")
        return
    if dry_run:
        print(f"\nDry run -- {len(to_write)} detail(s) would be written, nothing actually written.")
        return

    ws.batch_update([{"range": f"{DETAIL_COLUMN}{row_num}", "values": [[detail]]} for row_num, _player, detail in to_write])
    print(f"\nWrote {len(to_write)} detail(s).")


if __name__ == "__main__":
    main()
