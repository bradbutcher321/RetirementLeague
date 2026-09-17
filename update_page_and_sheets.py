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


# League-specific name preferences, applied regardless of what ESPN has on
# file for a manager's first name. Keyed lowercase so matching is
# case-insensitive. "nick" -> "Flanders" isn't a nickname-of-a-legal-name
# case like the others — it's this manager's long-standing league nickname
# (used everywhere on the Franchise page/sheet), which ESPN has no concept
# of at all, so it's mapped here as a one-off override.
MANAGER_NICKNAMES = {
    "joseph": "Joe",
    "jonathan": "Jon",
    "bradley": "Brad",
    "benjamin": "Ben",
    "nick": "Flanders",
}


def raw_manager_name(team):
    """Best-effort (first, last) name from the raw ESPN `members` entries
    espn_api attaches to a Team as `owners`. Prefers the real first/last
    name ESPN has on file over `displayName`, which is usually the
    account's public username (e.g. "Keithstone12") rather than the
    person's actual name. Different account setups populate different
    subsets of these fields, so this falls back gracefully instead of
    crashing on a missing key."""
    owners = getattr(team, "owners", None) or []
    if not owners:
        return "", ""
    owner = owners[0]
    first = (owner.get("firstName") or "").strip()
    last = (owner.get("lastName") or "").strip()
    first = MANAGER_NICKNAMES.get(first.lower(), first)
    if first or last:
        return first, last
    return owner.get("displayName", ""), ""


def build_manager_names(teams):
    """Builds {team_id: display_name} for every team: first name only,
    matching how managers are identified on the Franchise page — except
    when two managers share a first name (e.g. the league's two Joes),
    where the last initial is appended (no period) to disambiguate, e.g.
    "Joe G" / "Joe K"."""
    raw = {team.team_id: raw_manager_name(team) for team in teams}
    first_name_counts = {}
    for first, _ in raw.values():
        if first:
            first_name_counts[first] = first_name_counts.get(first, 0) + 1

    names = {}
    for team_id, (first, last) in raw.items():
        if not first:
            names[team_id] = last
        elif first_name_counts[first] > 1 and last:
            names[team_id] = f"{first} {last[0].upper()}"
        else:
            names[team_id] = first
    return names


def find_weekly_high(teams, current_week):
    """Finds the single-highest weekly score of the season so far across all
    teams, and which week it happened in. `Team.scores` is a season-long
    list indexed by week (index 0 = week 1), populated from ESPN's own
    schedule data, so this doesn't require any extra API calls or our own
    history-tracking."""
    best_team, best_week, best_score = None, None, -1.0
    for team in teams:
        for week_num, score in enumerate(getattr(team, "scores", [])[:current_week], start=1):
            if score is not None and score > best_score:
                best_team, best_week, best_score = team, week_num, score
    return best_team, best_week, best_score


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

    # Computed once across every team so first-name collisions (the two
    # Joes) can be detected league-wide, rather than one team at a time.
    manager_names = build_manager_names(league.teams)

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
            "manager": manager_names.get(home_team_full.team_id, ""),
            "record": home_record,
            "current": box.home_score,
            "projected": box.home_projected,
            "standing": home_standing,
            "points_for": getattr(home_team_full, "points_for", 0) or 0,
            "points_against": getattr(home_team_full, "points_against", 0) or 0,
            "playoff_pct": getattr(home_team_full, "playoff_pct", 0) or 0,
        })
        team_data.append({
            "name": box.away_team.team_name,
            "manager": manager_names.get(away_team_full.team_id, ""),
            "record": away_record,
            "current": box.away_score,
            "projected": box.away_projected,
            "standing": away_standing,
            "points_for": getattr(away_team_full, "points_for", 0) or 0,
            "points_against": getattr(away_team_full, "points_against", 0) or 0,
            "playoff_pct": getattr(away_team_full, "playoff_pct", 0) or 0,
        })

        matchup_data.append({
            "away_name": box.away_team.team_name,
            "away_manager": manager_names.get(away_team_full.team_id, ""),
            "away_record": away_record,
            "away_score": box.away_score,
            "away_projected": box.away_projected,
            "away_remaining": away_remaining,
            "home_name": box.home_team.team_name,
            "home_manager": manager_names.get(home_team_full.team_id, ""),
            "home_record": home_record,
            "home_score": box.home_score,
            "home_projected": box.home_projected,
            "home_remaining": home_remaining,
        })

    current_median = statistics.median(current_scores)
    projected_median = statistics.median(projected_scores)
    # Sort by actual league standing (as ESPN computes it: record + their
    # own tiebreakers), not by this week's score. Lower standing number =
    # better rank (1st place first).
    team_data.sort(key=lambda x: (x['standing'] if x['standing'] != '' else 999))

    # --- Superlatives: season-long single-week high score, and the current
    # points-for leader. Both are derived entirely from data ESPN already
    # tracks (Team.scores / Team.points_for), no extra history-keeping
    # needed on our end. ---
    weekly_high_team, weekly_high_week, weekly_high_score = find_weekly_high(league.teams, current_week)
    season_leader_team = max(league.teams, key=lambda t: getattr(t, "points_for", 0) or 0)

    # Before Week 1 kicks off every team is sitting at 0, which would make
    # both accolades meaningless (and playoff odds aren't simulated by ESPN
    # yet either) — leave those cells blank so the page can show a
    # "not available yet" state instead of a misleading zero.
    season_started = bool(weekly_high_score and weekly_high_score > 0)
    season_points_started = bool(season_leader_team.points_for and season_leader_team.points_for > 0)
    any_playoff_data = any(t["playoff_pct"] for t in team_data)

    # --- 3. WIPE AND WRITE BULK PAYLOAD ---
    # Defensively unmerge every cell in a generous range first (harmless
    # no-op if nothing is merged).
    try:
        worksheet.unmerge_cells("A1:Z500")
    except Exception as e:
        print(f"Note: unmerge_cells step skipped/failed harmlessly: {e}")

    worksheet.clear()

    # The two tables are laid out side by side in entirely separate columns
    # (leaderboard in A-I, matchups in K-V) rather than stacked in the same
    # columns. This is the fix for the "home team name goes missing" bug:
    # Google's CSV/gviz export infers ONE data type per column across the
    # whole tab. When a leaderboard numeric column and the matchup table's
    # text "Home Team" both lived in the same column, gviz decided the
    # column was numeric and silently dropped the text values — even
    # though they were stored correctly and displayed fine in the Sheets UI.
    # Giving each table its own columns means no column ever mixes types.
    LEADERBOARD_COLS = 9    # A-I
    MATCHUP_START_COL = 10  # column K (0-indexed: A=0 ... J=9, K=10)
    MATCHUP_COLS = 12       # K-V
    TOTAL_COLS = MATCHUP_START_COL + MATCHUP_COLS  # 22, i.e. through column V

    def pad_leaderboard(row):
        return row + [""] * (TOTAL_COLS - len(row))

    def pad_matchup(row):
        return [""] * MATCHUP_START_COL + row + [""] * (TOTAL_COLS - MATCHUP_START_COL - len(row))

    payload = [
        pad_leaderboard(["Matchup Week", f"Week {current_week}"]),
        pad_leaderboard(["Current Median Score", f"{current_median:.2f}"]),
        pad_leaderboard(["Projected Median Score", f"{projected_median:.2f}"]),
        pad_leaderboard(["Weekly High Team", weekly_high_team.team_name if season_started else ""]),
        pad_leaderboard(["Weekly High Manager", manager_names.get(weekly_high_team.team_id, "") if season_started else ""]),
        pad_leaderboard(["Weekly High Week", str(weekly_high_week) if season_started else ""]),
        pad_leaderboard(["Weekly High Score", f"{weekly_high_score:.2f}" if season_started else ""]),
        pad_leaderboard(["Season Leader Team", season_leader_team.team_name if season_points_started else ""]),
        pad_leaderboard(["Season Leader Manager", manager_names.get(season_leader_team.team_id, "") if season_points_started else ""]),
        pad_leaderboard(["Season Leader Points", f"{season_leader_team.points_for:.2f}" if season_points_started else ""]),
        pad_leaderboard([""]),
        pad_leaderboard(["Team Name", "Manager", "Record", "Current Score", "Projected Score", "Standing", "Points For", "Points Against", "Playoff Odds"]),
    ]

    for team in team_data:
        payload.append(pad_leaderboard([
            team["name"],
            team["manager"],
            team["record"],
            f"{team['current']:.2f}",
            f"{team['projected']:.2f}",
            team["standing"],
            f"{team['points_for']:.2f}",
            f"{team['points_against']:.2f}",
            f"{team['playoff_pct']:.1f}" if any_playoff_data else "",
        ]))

    payload.append(pad_leaderboard([""]))
    payload.append(pad_matchup([
        "Away Team", "Away Manager", "Away Record", "Away Score", "Away Projected", "Away Remaining",
        "Home Team", "Home Manager", "Home Record", "Home Score", "Home Projected", "Home Remaining",
    ]))

    for match in matchup_data:
        payload.append(pad_matchup([
            match["away_name"], match["away_manager"], match["away_record"], f"{match['away_score']:.2f}",
            f"{match['away_projected']:.2f}", match["away_remaining"],
            match["home_name"], match["home_manager"], match["home_record"], f"{match['home_score']:.2f}",
            f"{match['home_projected']:.2f}", match["home_remaining"],
        ]))

    worksheet.update(payload, "A1")

    # Save the current execution timestamp back into cell Z1 for the next validation check loop
    worksheet.update_acell('Z1', str(current_time))
    print(f"Successfully pushed updates to Google Sheets at epoch: {current_time}!")


if __name__ == "__main__":
    main()
