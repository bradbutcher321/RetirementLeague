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
            return # Exit script safely without running calculations

    # --- 2. CONNECT TO ESPN AND RUN CALCULATIONS ---
    print("Connecting to ESPN API to fetch fresh stats...")
    LEAGUE_ID = int(os.environ.get("ESPN_LEAGUE_ID"))
    YEAR = int(os.environ.get("ESPN_YEAR", 2026))
    SWID = os.environ.get("ESPN_SWID")
    ESPN_S2 = os.environ.get("ESPN_S2")

    league = League(league_id=LEAGUE_ID, year=YEAR, espn_s2=ESPN_S2, swid=SWID)
    current_week = league.current_week
    box_scores = league.box_scores(week=current_week)
    
    current_scores, projected_scores, team_data, matchup_data = [], [], [], []

    for box in box_scores:
        current_scores.extend([box.home_score, box.away_score])
        projected_scores.extend([box.home_projected, box.away_projected])
        team_data.append({"name": box.home_team.team_name, "current": box.home_score, "projected": box.home_projected})
        team_data.append({"name": box.away_team.team_name, "current": box.away_score, "projected": box.away_projected})
        
        matchup_data.append({
            "home_name": box.home_team.team_name, "home_score": box.home_score, "home_projected": box.home_projected,
            "away_name": box.away_team.team_name, "away_score": box.away_score, "away_projected": box.away_projected
        })

    current_median = statistics.median(current_scores)
    projected_median = statistics.median(projected_scores)
    team_data.sort(key=lambda x: x['current'], reverse=True)

    # --- 3. WIPE AND WRITE BULK PAYLOAD ---
    worksheet.clear()
    
    payload = [
        ["Matchup Week", f"Week {current_week}", ""],
        ["Current Median Score", f"{current_median:.2f}", ""],
        ["Projected Median Score", f"{projected_median:.2f}", ""],
        ["", "", ""], 
        ["Team Name", "Current Score", "Projected Score"]
    ]
    
    for team in team_data:
        payload.append([team["name"], f"{team['current']:.2f}", f"{team['projected']:.2f}"])
        
    payload.extend([["", "", ""], ["", "", ""], ["Away Team / Project", "vs", "Home Team / Project"]])
    
    for match in matchup_data:
        away_string = f"{match['away_name']} ({match['away_score']:.2f} / Proj: {match['away_projected']:.2f})"
        home_string = f"{match['home_name']} ({match['home_score']:.2f} / Proj: {match['home_projected']:.2f})"
        payload.append([away_string, "vs", home_string])
        
    worksheet.update(payload, "A1")
    
    # Save the current execution timestamp back into cell Z1 for the next validation check loop
    worksheet.update_acell('Z1', str(current_time))
    print(f"Successfully pushed updates to Google Sheets at epoch: {current_time}!")

if __name__ == "__main__":
    main()
