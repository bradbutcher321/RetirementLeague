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
import json
import os
import subprocess
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "1WghofPfu0Df9eEuePopV8Y0LJbPUYRdMOsPE-fZUtb4")
CREDS_PATH = os.environ.get("GOOGLE_CREDS_PATH", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "google_secret.json"))
DATABASE_NAME = "retirement-league-history"
WORKER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "worker")
SCORE_TOLERANCE = 0.05

# Sheet nickname -> ESPN member id(s), hand-verified against D1's managers
# table (first_name/last_name). A list because Flanders' ESPN account
# changed in 2022 ("nicksupz" -> a re-registered "New - nicksupz"); both ids
# are the same person, just different accounts in different years.
SHEET_NAME_TO_ESPN_IDS = {
    "Brad": ["{3D7C21AB-9890-4D8D-8AFF-3036DD3E1793}"],       # Bradley Butcher
    "Flanders": ["{F42F0C91-BB3C-452A-ADB1-DDE83BA7FFFF}",    # Nick Flanders (2015-2021 account)
                 "{74C1B994-16CF-4EEB-81E5-4C1D1CC144EF}"],   # Nick Flanders (2022+ account)
    "Jared": ["{2FD532B2-DF44-4A8B-927E-BD5166ECE13A}"],      # Jared Scott
    "Joe G": ["{5D571B07-0F2E-4FFD-971B-070F2E5FFD2E}"],      # Joseph Gioffre
    "Joe K": ["{876F3438-87D6-498D-BC7E-05FA7CDF6E1C}"],      # Joe Kennedy
    "Chad": ["{C9F6D3FF-4CC6-40D2-B6D3-FF4CC6B0D21E}"],       # Chad Gioffre
    "Jeff": ["{034CDDD4-3BDB-4993-AE6A-84A3E373BF74}"],       # Jeff Reisner
    "Ben": ["{DF056524-CB7D-4F9E-8E21-76A999083891}"],        # Benjamin Reisner
    "Kris": ["{967F62C1-8093-4AD6-9D8F-50E2B9E52D44}"],       # Kris Cruz
    "Collin": ["{E0BF6829-AD9A-448A-948F-D96BD1AD07F9}"],     # Collin Rzeznik
    "Jon": ["{BF9F0CA5-49D9-4E13-8471-DAC6E35A0B27}"],        # Jonathan Dannenhoffer
    "TJ": ["{FD69B08B-CB13-4743-A9B0-8BCB13D74361}"],         # Tj Munroe
    "Chappy": ["{EB483C2B-06E5-4EEA-B724-941C230DA1D5}"],     # Daniel Chappelle (2015-2016)
    "Corey": ["{03143942-F76B-4746-801F-075A39FA7D55}"],      # Corey Costello (2017-2018)
}


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

def d1_query(sql):
    result = subprocess.run(
        ["npx", "-y", "wrangler", "d1", "execute", DATABASE_NAME, "--remote", f"--command={sql}", "--json"],
        cwd=WORKER_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=(os.name == "nt"),
    )
    if result.returncode != 0:
        raise SystemExit(f"D1 query failed: {result.stderr}")
    data = json.loads(result.stdout)
    return data[0]["results"]


def load_d1():
    teams = d1_query("SELECT year, team_id, owner_espn_id FROM teams")
    matchups = d1_query("SELECT year, week, team_id, opponent_team_id, team_score, opponent_score, outcome, is_playoff FROM matchups")

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
