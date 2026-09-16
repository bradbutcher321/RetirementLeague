import os
import sys
import statistics
import time
import gspread
from google.oauth2.service_account import Credentials

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from espn_api.football import League

# Slot positions that count as "on the bench" and should NOT count toward
# a team's active/starting lineup when we compute "players remaining to play".
BENCH_SLOTS = {"BE", "IR"}


def count_remaining(lineup):
    """
    Given a box score lineup (list of BoxPlayer), return how many of the
    ACTIVE (non-bench, non-IR) players have not yet started their pro game.

    BoxPlayer.game_played is 0 if the player's game hasn't started/finished
    and 100 once their game is over. Some player objects may not expose this
    attribute depending on library version, so we fall back safely to 0
    (treated as "not played yet") rather than crashing.
    """
    remaining = 0
    for player in lineup:
        slot = getattr(player, "slot_position", "")
        if slot in BENCH_SLOTS:
            continue
        game_played = getattr(player, "game_played", 0)
        if game_played < 100:
            remaining += 1
    return remaining


def format_record(team):
    """Builds a 'W-L' or 'W-L-T' string from a Team object, tolerating
    library versions that may not expose a `ties` attribute."""
    wins = getattr(team, "wins", 0)
    losses = getattr(team, "losses", 0)
    ties = getattr(team, "ties", 0)
    if ties:
        return f"{wins}-{losses}-{ties}"
    return f"{wins}-{losses}"


def main():
    # --- 1. CONNECT TO GOOGLE SHEETS FIRST TO CHECK COOLDOWN ---
    print("Connecting to Google Sheets API...")
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_file("google_secret.json", scopes=scopes)
    client = gspread.authorize(creds)

    SHEET_ID = os.environ.get("GOOGLE_SHEET_ID")
    if not SHEET_ID:
        print("Error: The GOOGLE_SHEET_ID environment variable is missing!")
        sys.exit(1)

    spreadsheet = client.open_by_key(SHEET_ID)
    worksheet = spreadsheet.worksheet("Live Weekly Medians")

    # Check if a forced on-demand run is violating our 2-minute gate limit
    # We store the last epoch timestamp in cell Z1 to hide it from general view
    current_time = int(time.time())
    last_run_time = worksheet.acell('Z1').value

    # If the trigger source is a web-access dispatch event, enforce the 2-minute restriction
    is_web_triggered = os.environ.get("TRIGGER_SOURCE") == "web_access"

    if is_web_triggered and last_run_time:
        elapsed_seconds = current_time - int(last_run_time)
        if elapsed_seconds < 120:
            print(f"Skipping run. Site accessed too recently ({elapsed_seconds}s ago). Cooldown is 120s.")
            return  # Exit script safely without running calculations

    # --- 2. CONNECT TO ESPN AND RUN CALCULATIONS ---
    print("Connecting to ESPN API to fetch fresh stats...")
    LEAGUE_ID = int(os.environ.get("ESPN_LEAGUE_ID"))
    YEAR = int(os.environ.get("ESPN_YEAR", 2026))
    SWID = os.environ.get("ESPN_SWID")
    ESPN_S2 = os.environ.get("ESPN_S2")

    league = League(league_id=LEAGUE_ID, year=YEAR, espn_s2=ESPN_S2, swid=SWID)
    current_week = league.current_week
    box_scores = league.box_scores(week=current_week)

    # league.teams carries the authoritative record/standing data.
    # box_score.home_team / away_team are sometimes lighter-weight copies,
    # so we look records up by team_id to make sure wins/losses are correct.
    teams_by_id = {team.team_id: team for team in league.teams}

    current_scores, projected_scores, team_data, matchup_data = [], [], [], []

    for box in box_scores:
        current_scores.extend([box.home_score, box.away_score])
        projected_scores.extend([box.home_projected, box.away_projected])

        home_team_full = teams_by_id.get(box.home_team.team_id, box.home_team)
        away_team_full = teams_by_id.get(box.away_team.team_id, box.away_team)

        home_remaining = count_remaining(box.home_lineup)
        away_remaining = count_remaining(box.away_lineup)

        home_record = format_record(home_team_full)
        away_record = format_record(away_team_full)

        home_standing = getattr(home_team_full, "standing", None) or getattr(home_team_full, "final_standing", "")
        away_standing = getattr(away_team_full, "standing", None) or getattr(away_team_full, "final_standing", "")

        team_data.append({
            "name": box.home_team.team_name,
            "record": home_record,
            "current": box.home_score,
            "projected": box.home_projected,
            "remaining": home_remaining,
            "standing": home_standing,
        })
        team_data.append({
            "name": box.away_team.team_name,
            "record": away_record,
            "current": box.away_score,
            "projected": box.away_projected,
            "remaining": away_remaining,
            "standing": away_standing,
        })

        matchup_data.append({
            "away_name": box.away_team.team_name,
            "away_record": away_record,
            "away_score": box.away_score,
            "away_projected": box.away_projected,
            "away_remaining": away_remaining,
            "home_name": box.home_team.team_name,
            "home_record": home_record,
            "home_score": box.home_score,
            "home_projected": box.home_projected,
            "home_remaining": home_remaining,
        })

    current_median = statistics.median(current_scores)
    projected_median = statistics.median(projected_scores)
    team_data.sort(key=lambda x: x['current'], reverse=True)

    # --- 3. WIPE AND WRITE BULK PAYLOAD ---
    worksheet.clear()

    TOTAL_COLS = 10  # widest section (matchups) has 10 columns; pad everything to match

    def pad(row):
        return row + [""] * (TOTAL_COLS - len(row))

    payload = [
        pad(["Matchup Week", f"Week {current_week}"]),
        pad(["Current Median Score", f"{current_median:.2f}"]),
        pad(["Projected Median Score", f"{projected_median:.2f}"]),
        pad([""]),
        pad(["Team Name", "Record", "Current Score", "Projected Score", "Players Remaining", "Standing"]),
    ]

    for team in team_data:
        payload.append(pad([
            team["name"],
            team["record"],
            f"{team['current']:.2f}",
            f"{team['projected']:.2f}",
            team["remaining"],
            team["standing"],
        ]))

    payload.append(pad([""]))
    payload.append(pad([""]))
    payload.append(pad([
        "Away Team", "Away Record", "Away Score", "Away Projected", "Away Remaining",
        "Home Team", "Home Record", "Home Score", "Home Projected", "Home Remaining",
    ]))

    for match in matchup_data:
        payload.append(pad([
            match["away_name"], match["away_record"], f"{match['away_score']:.2f}",
            f"{match['away_projected']:.2f}", match["away_remaining"],
            match["home_name"], match["home_record"], f"{match['home_score']:.2f}",
            f"{match['home_projected']:.2f}", match["home_remaining"],
        ]))

    worksheet.update(payload, "A1")

    # Save the current execution timestamp back into cell Z1 for the next validation check loop
    worksheet.update_acell('Z1', str(current_time))
    print(f"Successfully pushed updates to Google Sheets at epoch: {current_time}!")


if __name__ == "__main__":
    main()
