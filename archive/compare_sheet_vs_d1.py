"""
Cross-checks the league's manually-maintained Google Sheet (Game Tracker)
against the D1 league-history database pulled straight from ESPN, looking
for weekly matchup discrepancies -- wrong scores, wrong opponents, missing
games in either source.

The two sources don't share a common key (the sheet uses player nicknames,
D1 uses ESPN's numeric team_id), so this maps between them via each
manager's stable ESPN member id (D1's managers/teams.owner_espn_id -- see
history_lib.py's manager_name(), which already prefers firstName/lastName
over the ESPN account username). That's a hand-verified one-time mapping
(SHEET_NAME_TO_ESPN_IDS below) rather than matching on fantasy team names,
since team names change every year, sometimes have typos/double-spaces
straight from ESPN, and in Flanders' case the underlying ESPN account
itself changed in 2022 -- none of which affects a manager's identity.

Usage: python compare_sheet_vs_d1.py
"""
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import history_lib as hl

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "1WghofPfu0Df9eEuePopV8Y0LJbPUYRdMOsPE-fZUtb4")
CREDS_PATH = os.environ.get("GOOGLE_CREDS_PATH", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "google_secret.json"))
SCORE_TOLERANCE = 0.05
SHEET_NAME_TO_ESPN_IDS = hl.SHEET_NAME_TO_ESPN_IDS


def to_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# D1 side
# --------------------------------------------------------------------------

def load_d1():
    teams = hl.d1_query("SELECT year, team_id, owner_espn_id FROM teams")
    matchups = hl.d1_query("SELECT year, week, team_id, opponent_team_id, team_score, opponent_score, outcome, is_playoff FROM matchups")

    team_id_by_owner_year = {}
    for t in teams:
        team_id_by_owner_year[(t["year"], t["owner_espn_id"])] = t["team_id"]

    matchup_by_key = {}
    for m in matchups:
        matchup_by_key[(m["year"], m["week"], m["team_id"])] = m

    return team_id_by_owner_year, matchup_by_key


# --------------------------------------------------------------------------
# Sheet side
# --------------------------------------------------------------------------

def authorize():
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
    ]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def load_games(spreadsheet):
    ws = spreadsheet.worksheet("Game Tracker")
    rows = ws.get_values("A4:L")
    games = []
    for r in rows:
        r = r + [""] * (12 - len(r))
        year, week, gtype, p1, p2, s1, s2, winner, margin, total, gid, median = r
        if not gid or not p1:
            continue
        if winner == "In Progress":
            continue
        games.append({
            "year": to_int(year), "week": to_int(week), "type": gtype,
            "p1": p1, "p2": p2 or None, "s1": to_float(s1), "s2": to_float(s2),
            "winner": winner, "gid": to_int(gid),
        })
    return games


# --------------------------------------------------------------------------
# Comparison
# --------------------------------------------------------------------------

def team_id_for(player, year, team_id_by_owner_year):
    for espn_id in SHEET_NAME_TO_ESPN_IDS.get(player, []):
        team_id = team_id_by_owner_year.get((year, espn_id))
        if team_id is not None:
            return team_id
    return None


def main():
    print("Loading D1 (teams + matchups)...")
    team_id_by_owner_year, d1_matchups = load_d1()

    print("Loading Google Sheet (Game Tracker)...")
    spreadsheet = authorize().open_by_key(SHEET_ID)
    games = load_games(spreadsheet)

    all_names = {g["p1"] for g in games} | {g["p2"] for g in games if g["p2"]}
    unknown_names = sorted(all_names - set(SHEET_NAME_TO_ESPN_IDS))
    if unknown_names:
        print(f"\n--- sheet names with no entry in SHEET_NAME_TO_ESPN_IDS: {unknown_names} ---")

    discrepancies = []
    unmapped_games = []
    checked = 0

    for g in games:
        if g["type"] == "Bye" or not g["p2"]:
            continue
        year, week = g["year"], g["week"]
        p1_id = team_id_for(g["p1"], year, team_id_by_owner_year)
        p2_id = team_id_for(g["p2"], year, team_id_by_owner_year)
        if p1_id is None or p2_id is None:
            unmapped_games.append(g)
            continue

        checked += 1
        d1_row = d1_matchups.get((year, week, p1_id))
        if d1_row is None:
            discrepancies.append(f"{year} wk{week}: {g['p1']} vs {g['p2']} -- MISSING in D1 (sheet: {g['s1']}-{g['s2']})")
            continue

        problems = []
        if d1_row["opponent_team_id"] != p2_id:
            problems.append(f"opponent mismatch (D1 opponent_team_id={d1_row['opponent_team_id']}, expected {p2_id} for {g['p2']})")
        d1_s1, d1_s2 = d1_row["team_score"], d1_row["opponent_score"]
        if g["s1"] is not None and d1_s1 is not None and abs(g["s1"] - d1_s1) > SCORE_TOLERANCE:
            problems.append(f"{g['p1']} score: sheet={g['s1']} D1={d1_s1}")
        if g["s2"] is not None and d1_s2 is not None and abs(g["s2"] - d1_s2) > SCORE_TOLERANCE:
            problems.append(f"{g['p2']} score: sheet={g['s2']} D1={d1_s2}")

        if problems:
            discrepancies.append(f"{year} wk{week}: {g['p1']} vs {g['p2']} -- " + "; ".join(problems))

    print(f"\nChecked {checked} games ({len(unmapped_games)} skipped -- couldn't map a player to a team_id that year).")
    if unmapped_games:
        sample = unmapped_games[:10]
        print("  Sample unmapped games:")
        for g in sample:
            print(f"    {g['year']} wk{g['week']}: {g['p1']} vs {g['p2']}")

    print(f"\n=== {len(discrepancies)} discrepancies ===")
    for d in discrepancies:
        print(" ", d)


if __name__ == "__main__":
    main()
