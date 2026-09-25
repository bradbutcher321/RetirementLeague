"""
Fills in Game Tracker rows from D1's real data -- Winner/Margin/Total/Median
(columns H/I/J/L) are all formulas derived from S1/S2, so writing just
names + scores is enough for the rest of the row to compute itself.

Two things it fills, both only once D1 shows the games actually decided:
  - Scores for a row that already has both player names typed in (matches
    each name to its team_id for that year via SHEET_NAME_TO_ESPN_IDS,
    looks up that team's D1 matchup for the row's week, and reports a
    mismatch for manual review rather than writing over a name that
    doesn't match what D1 says that team actually played).
  - Names AND scores for a still-blank Reg/Bye/Sacko row, inferred
    straight from D1's schedule -- regular-season pairings and byes are
    fully known there regardless of whether anyone's typed them in yet,
    and the Sacko game is already resolved via season_sackos. Only
    attempted once every blank row for that (year, week, type) has a
    matching, fully-decided D1 game to assign -- a partially-finished week
    is left alone rather than guessing which blank row is which.

Play/Cons/3rd/5th/Champ rows are never auto-filled when blank: which
bracket game is which isn't reconstructable from bracket_type alone (see
history_lib.compute_final_standings' docstring) -- those still need a
human, same as before.

Never overwrites an existing name or score. Meant to be run by hand once a
week's games are final, not scheduled -- see auto_grade_results.py for the
same judgment call on a script with sheet write access.

Usage:
    python sync_scores_to_sheet.py            # find and write
    python sync_scores_to_sheet.py --dry-run   # report only, write nothing
"""
import argparse
import os
import sys
from datetime import datetime

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl
from generate_franchise_data import SHEET_ID, CREDS_PATH, to_int

TARGET_TAB = "Game Tracker"
# Sheet type -> D1 bracket_type(s) a blank row of that type can be inferred from.
INFERABLE_TYPES = {"Reg": ("NONE",), "Bye": hl.REAL_PLAYOFF_BRACKET_TYPES}


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def load_d1_lookup():
    teams = hl.d1_query("SELECT year, team_id, owner_espn_id FROM teams")
    matchups = hl.d1_query(
        "SELECT year, week, team_id, opponent_team_id, team_score, opponent_score, outcome, bracket_type FROM matchups"
    )
    season_sackos = hl.d1_query("SELECT year, team_id, opponent_team_id FROM season_sackos")

    team_id_by_year_player, player_by_year_team = {}, {}
    for player, ids in hl.SHEET_NAME_TO_ESPN_IDS.items():
        for t in teams:
            if t["owner_espn_id"] in ids:
                team_id_by_year_player[(t["year"], player)] = t["team_id"]
                player_by_year_team[(t["year"], t["team_id"])] = player

    matchup_by_year_week_team = {(m["year"], m["week"], m["team_id"]): m for m in matchups}
    matchups_by_year_week = {}
    for m in matchups:
        matchups_by_year_week.setdefault((m["year"], m["week"]), []).append(m)
    sacko_by_year = {s["year"]: s for s in season_sackos}

    return team_id_by_year_player, player_by_year_team, matchup_by_year_week_team, matchups_by_year_week, sacko_by_year


def decided_games_for_week(matchups_this_week, bracket_types):
    """Dedupes team-perspective D1 rows into one entry per actually-decided
    game that week (real 2-team games and byes both), restricted to the
    given bracket_type(s). Returns [(team_id, opponent_team_id_or_None)]."""
    seen, games = set(), []
    for m in matchups_this_week:
        if m["bracket_type"] not in bracket_types or m["team_id"] in seen:
            continue
        opp = m["opponent_team_id"]
        if opp is None:
            if m["team_score"] is None:
                continue  # this team hasn't played its bye week yet
            games.append((m["team_id"], None))
            seen.add(m["team_id"])
        else:
            if m["outcome"] is None or opp in seen:
                continue  # not decided yet, or already claimed as someone else's pairing
            games.append((m["team_id"], opp))
            seen.add(m["team_id"])
            seen.add(opp)
    return games


def infer_names(rows_parsed, player_by_year_team, matchups_by_year_week, sacko_by_year, needs_review):
    """Mutates rows_parsed in place, filling p1/p2 (and marking inferred=True)
    on blank-name Reg/Bye/Sacko rows wherever D1 gives an unambiguous,
    fully-decided answer for that (year, week, type) group."""
    groups = {}
    for row in rows_parsed:
        if row["p1"] or row["gtype"] not in (*INFERABLE_TYPES, "Sacko"):
            continue
        groups.setdefault((row["year"], row["week"], row["gtype"]), []).append(row)

    for (year, week, gtype), blank_rows in groups.items():
        if gtype == "Sacko":
            s = sacko_by_year.get(year)
            if s is None or len(blank_rows) != 1:
                continue
            loser = player_by_year_team.get((year, s["team_id"]))
            winner = player_by_year_team.get((year, s["opponent_team_id"]))
            if loser is None or winner is None:
                needs_review.append((blank_rows[0]["row_num"], f"Sacko {year}: couldn't map both teams to players"))
                continue
            blank_rows[0]["p1"], blank_rows[0]["p2"], blank_rows[0]["inferred"] = loser, winner, True
            continue

        bracket_types = INFERABLE_TYPES[gtype]
        games = decided_games_for_week(matchups_by_year_week.get((year, week), []), bracket_types)
        if len(games) != len(blank_rows):
            continue  # week not fully decided yet, or something doesn't line up -- don't guess
        for row, (tid, opp_id) in zip(blank_rows, games):
            p1 = player_by_year_team.get((year, tid))
            p2 = player_by_year_team.get((year, opp_id)) if opp_id is not None else None
            if p1 is None or (opp_id is not None and p2 is None):
                needs_review.append((row["row_num"], f"{gtype} wk{week} {year}: couldn't map a team_id to a player"))
                continue
            row["p1"], row["p2"], row["inferred"] = p1, p2, True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Report what would be written without writing anything")
    args = parser.parse_args()

    print("Loading D1 (teams + matchups + season_sackos)...")
    team_id_by_year_player, player_by_year_team, matchup_by_year_week_team, matchups_by_year_week, sacko_by_year = load_d1_lookup()

    print("Loading Google Sheet (Game Tracker)...")
    gc = authorize_write()
    spreadsheet = gc.open_by_key(SHEET_ID)
    ws = spreadsheet.worksheet(TARGET_TAB)
    raw_rows = ws.get_values("A4:L")

    rows_parsed = []
    for i, r in enumerate(raw_rows):
        r = r + [""] * (12 - len(r))
        year, week, gtype, p1, p2, s1, s2, winner, margin, total, gid, median = r
        year, week = to_int(year), to_int(week)
        if not gid or year is None or week is None:
            continue
        rows_parsed.append({
            "row_num": i + 4, "year": year, "week": week, "gtype": gtype,
            "p1": p1, "p2": p2, "s1": s1, "s2": s2, "inferred": False,
        })

    needs_review, not_final_yet, skipped_types = [], [], set()
    infer_names(rows_parsed, player_by_year_team, matchups_by_year_week, sacko_by_year, needs_review)

    to_write = []
    for row in rows_parsed:
        p1, p2 = row["p1"], row["p2"]
        if not p1:
            if row["gtype"] not in ("Reg", "Bye", "Sacko"):
                skipped_types.add(row["gtype"])
            continue
        if not row["inferred"] and row["s1"] != "" and (row["s2"] != "" or not p2):
            continue  # already fully scored by hand -- never touch

        p1_id = team_id_by_year_player.get((row["year"], p1))
        if p1_id is None:
            needs_review.append((row["row_num"], f"'{p1}' doesn't map to a team_id in {row['year']}"))
            continue
        m = matchup_by_year_week_team.get((row["year"], row["week"], p1_id))
        if m is None or m["outcome"] is None:
            not_final_yet.append((row["row_num"], f"{p1} wk{row['week']} {row['year']} -- not final in D1 yet"))
            continue

        if p2:
            p2_id = team_id_by_year_player.get((row["year"], p2))
            if p2_id is None:
                needs_review.append((row["row_num"], f"'{p2}' doesn't map to a team_id in {row['year']}"))
                continue
            if m["opponent_team_id"] != p2_id:
                needs_review.append((
                    row["row_num"],
                    f"{p1} vs {p2} wk{row['week']} {row['year']} -- D1 has {p1} playing a different opponent that week"
                ))
                continue
            to_write.append((row["row_num"], p1, p2, m["team_score"], m["opponent_score"], row["inferred"]))
        else:
            to_write.append((row["row_num"], p1, None, m["team_score"], None, row["inferred"]))

    print(f"\n{len(to_write)} row(s) to fill, {len(needs_review)} need manual review, "
          f"{len(not_final_yet)} not final in D1 yet.\n")
    for row_num, p1, p2, s1, s2, inferred in to_write:
        label = f"{p1} vs {p2}" if p2 else f"{p1} (Bye)"
        tag = " [names inferred]" if inferred else ""
        print(f"  row {row_num}: {label} -> {s1:g}" + (f"-{s2:g}" if s2 is not None else "") + tag)
    if needs_review:
        print("\nNeeds manual review:")
        for row_num, why in needs_review:
            print(f"  row {row_num}: {why}")
    if skipped_types:
        print(f"\nNot attempted (bracket position not inferable from D1 alone): {', '.join(sorted(skipped_types))}")

    if not to_write:
        print("\nNothing to write.")
        return
    if args.dry_run:
        print(f"\nDry run -- {len(to_write)} row(s) would be written, nothing actually written.")
        return

    note_stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    for row_num, p1, p2, s1, s2, inferred in to_write:
        if inferred:
            ws.update([[p1, p2 or ""]], f"D{row_num}:E{row_num}")
            ws.update_note(f"D{row_num}", f"Auto-filled from D1 {note_stamp}")
        ws.update([[s1]], f"F{row_num}")
        ws.update_note(f"F{row_num}", f"Auto-filled from D1 {note_stamp}")
        if p2:
            ws.update([[s2]], f"G{row_num}")
            ws.update_note(f"G{row_num}", f"Auto-filled from D1 {note_stamp}")
    print(f"\nWrote {len(to_write)} row(s).")


if __name__ == "__main__":
    main()
