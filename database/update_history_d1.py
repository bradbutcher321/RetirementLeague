"""
Pushes the current NFL season's box scores straight into the Cloudflare D1
league-history database (see schema.sql). Meant to run on a schedule (see
.github/workflows/update_history_d1.yml) so results land automatically as
games finish, without anyone re-running the backfill by hand.

Always re-derives the WHOLE current season (not just "new" weeks) -- cheap
(at most ~17 weeks), and it self-heals any stat correction ESPN makes after
a game was first marked final, since every write is INSERT OR REPLACE.

Also fills in that season's Sacko (see history_lib.compute_season_sacko_row)
the moment it's decided -- the matchup between the two worst regular-season
teams in the championship week -- but only for a year with no season_sackos
row yet, so it can never clobber the pre-2026 history imported from the
sheet (that history was tracked under a different, now-forgotten rule).

Talks to D1 through `wrangler d1 execute --remote` rather than a hand-rolled
HTTP client, so it inherits wrangler's already-proven auth/retry behavior:
locally that's the same OAuth login used for manual wrangler commands; in
CI it's the CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID env vars wrangler
picks up automatically in non-interactive mode.

Usage:
    ESPN_S2=... ESPN_SWID=... python update_history_d1.py [--year 2026]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from espn_api.football import League
import history_lib as hl


def run_sql(statements, label):
    if not statements:
        print(f"  {label}: nothing to write")
        return
    hl.run_d1_sql(statements, label)
    print(f"  {label}: {len(statements)} statements written")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=hl.current_nfl_season_year())
    args = parser.parse_args()
    year = args.year

    espn_s2 = os.environ.get("ESPN_S2")
    swid = os.environ.get("ESPN_SWID")
    if not espn_s2 or not swid:
        raise SystemExit("Set ESPN_S2 and ESPN_SWID environment variables first.")

    print(f"=== {year} ===")
    league = League(league_id=hl.LEAGUE_ID, year=year, espn_s2=espn_s2, swid=swid)

    run_sql(hl.insert_or_replace_sql("managers", hl.MANAGER_COLUMNS, hl.manager_rows(league.teams)), "managers")
    run_sql(hl.insert_or_replace_sql("teams", hl.TEAM_COLUMNS, hl.team_rows(year, league.teams)), "teams")
    run_sql(hl.insert_or_replace_sql("draft_picks", hl.DRAFT_COLUMNS, hl.draft_rows(league)), "draft_picks")
    run_sql(hl.insert_or_replace_sql("league_settings", hl.LEAGUE_SETTINGS_COLUMNS, [hl.league_settings_row(league)]), "league_settings")

    if year < hl.BOX_SCORE_MIN_YEAR:
        rows = hl.season_only_matchup_rows(league)
        run_sql(hl.insert_or_replace_sql("matchups", hl.MATCHUP_COLUMNS, rows), "matchups (season-level)")
        return

    cache = {}
    all_matchup_rows, all_roster_rows = [], []
    for week in hl.matchup_weeks(league):
        boxes = league.box_scores(week=week, player_team_cache=cache)
        matchup_rows, roster_rows = hl.box_scores_to_rows(year, week, boxes)
        all_matchup_rows += matchup_rows
        all_roster_rows += roster_rows
        print(f"  week {week}: {len(matchup_rows)} matchup-sides, {len(roster_rows)} roster entries")

    run_sql(hl.insert_or_replace_sql("matchups", hl.MATCHUP_COLUMNS, all_matchup_rows), "matchups")
    run_sql(hl.insert_or_replace_sql("roster_entries", hl.ROSTER_COLUMNS, all_roster_rows), "roster_entries")

    update_season_sacko(year)


def update_season_sacko(year):
    """Only ever fills in a year with no season_sackos row yet -- history
    before this rule was formalized was tracked a different, now-forgotten
    way and must never be overwritten by this computed version (see
    migration 004 / import_season_sackos.py)."""
    if hl.d1_query(f"SELECT year FROM season_sackos WHERE year = {year}"):
        return
    teams_this_year = hl.d1_query(f"SELECT team_id, regular_season_standing FROM teams WHERE year = {year}")
    matchups_this_year = hl.d1_query(
        f"SELECT team_id, week, opponent_team_id, outcome, bracket_type FROM matchups WHERE year = {year}"
    )
    row = hl.compute_season_sacko_row(year, teams_this_year, matchups_this_year)
    if row:
        run_sql(hl.insert_or_replace_sql("season_sackos", hl.SEASON_SACKO_COLUMNS, [row]), "season_sackos")
    else:
        print("  season_sackos: not decided yet")


if __name__ == "__main__":
    main()
