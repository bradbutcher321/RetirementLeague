"""
Shared logic for building league-history rows from ESPN data. Used by both
build_history_db.py (local SQLite -- one-time backfill / dev copy) and
update_history_d1.py (the weekly job that writes straight to Cloudflare D1).
Keeping the row-building logic in one place means both writers agree on
exactly what a "row" is instead of two hand-maintained copies drifting apart.
"""
import json
import os
import shutil
import subprocess
from datetime import datetime

# ESPN's playoffTierType has 4 values: NONE (regular season), WINNERS_BRACKET
# (the championship bracket), WINNERS_CONSOLATION_LADDER (placement games
# among teams that DID make the playoffs but were eliminated before the
# final), and LOSERS_CONSOLATION_LADDER (the "toilet bowl" for teams that
# missed the playoffs). Verified against a real season: a manager's known
# playoff win/loss total exactly equalled WINNERS_BRACKET +
# WINNERS_CONSOLATION_LADDER games, with LOSERS_CONSOLATION_LADDER excluded --
# i.e. "made the playoffs" means being on the winners side at all, not just
# reaching the championship game itself.
REAL_PLAYOFF_BRACKET_TYPES = ("WINNERS_BRACKET", "WINNERS_CONSOLATION_LADDER")

D1_DATABASE_NAME = "retirement-league-history"
WORKER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "worker")
# On Windows, "npx" the plain command isn't directly executable (it's
# npx.cmd) and CreateProcess won't resolve that the way a shell would;
# resolving the real path here keeps this working the same on a local
# Windows dev machine and a Linux CI runner without needing shell=True.
NPX = shutil.which("npx.cmd") or shutil.which("npx") or "npx"

LEAGUE_ID = 58101
SEASON_MIN_YEAR = 2015     # league inception -- earliest year any data exists
BOX_SCORE_MIN_YEAR = 2019  # earliest year ESPN retains per-week roster/stat data

MANAGER_COLUMNS = ("espn_id", "display_name", "first_name", "last_name")
TEAM_COLUMNS = ("year", "team_id", "team_name", "team_abbrev", "owner_espn_id", "division_id",
                "division_name", "wins", "losses", "ties", "points_for", "points_against",
                "regular_season_standing", "final_standing", "playoff_pct", "streak_length",
                "streak_type", "waiver_rank", "draft_projected_rank", "acquisitions",
                "acquisition_budget_spent", "drops", "trades", "move_to_ir", "logo_url")
MATCHUP_COLUMNS = ("year", "week", "team_id", "opponent_team_id", "team_score", "opponent_score",
                    "is_playoff", "outcome", "bracket_type")
ROSTER_COLUMNS = ("year", "week", "team_id", "player_id", "player_name", "pro_team", "position",
                   "lineup_slot", "is_starter", "points", "projected_points", "stats_json")
DRAFT_COLUMNS = ("year", "round_num", "round_pick", "team_id", "nominating_team_id", "player_id",
                  "player_name", "bid_amount", "keeper_status")
LEAGUE_SETTINGS_COLUMNS = ("year", "name", "team_count", "reg_season_count", "playoff_team_count",
                            "playoff_seed_tie_rule", "scoring_type", "median_scoring", "settings_json")

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

ESPN_ID_TO_SHEET_NAME = {espn_id: name for name, ids in SHEET_NAME_TO_ESPN_IDS.items() for espn_id in ids}


def manager_name(owner: dict) -> tuple:
    """Prefer firstName/lastName over displayName -- displayName is usually
    the ESPN account username, not the person's real name."""
    return owner.get("firstName") or "", owner.get("lastName") or ""


def current_nfl_season_year() -> int:
    """The NFL season that's active (or most recently active) right now.
    The season named e.g. "2025" runs roughly Sept 2025 - Feb 2026, so
    before September it's still last year's season."""
    now = datetime.now()
    return now.year if now.month >= 8 else now.year - 1


def manager_rows(teams) -> list:
    seen = {}
    for team in teams:
        for owner in team.owners:
            espn_id = owner.get("id")
            if not espn_id or espn_id in seen:
                continue
            first, last = manager_name(owner)
            seen[espn_id] = (espn_id, owner.get("displayName"), first, last)
    return list(seen.values())


def team_rows(year, teams) -> list:
    rows = []
    for team in teams:
        primary_owner = team.owners[0]["id"] if team.owners else None
        rows.append((
            year, team.team_id, team.team_name, team.team_abbrev, primary_owner,
            team.division_id, team.division_name, team.wins, team.losses, team.ties,
            team.points_for, team.points_against, team.standing, team.final_standing,
            team.playoff_pct, team.streak_length, team.streak_type, team.waiver_rank,
            team.draft_projected_rank, team.acquisitions, team.acquisition_budget_spent,
            team.drops, team.trades, team.move_to_ir, team.logo_url,
        ))
    return rows


def draft_rows(league) -> list:
    rows = []
    for pick in league.draft:
        team_id = pick.team.team_id if pick.team else None
        nominating_id = pick.nominatingTeam.team_id if pick.nominatingTeam else None
        rows.append((
            league.year, pick.round_num, pick.round_pick, team_id, nominating_id,
            pick.playerId, pick.playerName, pick.bid_amount, pick.keeper_status,
        ))
    return rows


def league_settings_row(league) -> tuple:
    s = league.settings
    settings_json = json.dumps({
        "reg_season_count": s.reg_season_count,
        "matchup_periods": s.matchup_periods,
        "veto_votes_required": s.veto_votes_required,
        "team_count": s.team_count,
        "playoff_team_count": s.playoff_team_count,
        "keeper_count": s.keeper_count,
        "trade_deadline": s.trade_deadline,
        "division_map": s.division_map,
        "tie_rule": s.tie_rule,
        "playoff_tie_rule": s.playoff_tie_rule,
        "playoff_matchup_period_length": s.playoff_matchup_period_length,
        "playoff_seed_tie_rule": s.playoff_seed_tie_rule,
        "scoring_type": s.scoring_type,
        "median_scoring": s.median_scoring,
        "scoring_format": s.scoring_format,
        "faab": s.faab,
        "acquisition_budget": s.acquisition_budget,
        "acquisition_limit": s.acquisition_limit,
        "matchup_acquisition_limit": s.matchup_acquisition_limit,
        "matchup_limit_per_scoring_period": s.matchup_limit_per_scoring_period,
        "minimum_bid": s.minimum_bid,
        "waiver_process_days": s.waiver_process_days,
        "waiver_process_hour": s.waiver_process_hour,
        "trade_revision_hours": s.trade_revision_hours,
    })
    return (
        league.year, s.name, s.team_count, s.reg_season_count, s.playoff_team_count,
        s.playoff_seed_tie_rule, s.scoring_type, 1 if s.median_scoring else 0, settings_json,
    )


def matchup_weeks(league) -> list:
    """One representative NFL week per matchup period, in order. Almost
    always a 1:1 mapping; only differs for old multi-week playoff rounds,
    where we fall back to that round's first NFL week."""
    periods = league.settings.matchup_periods
    weeks = sorted(weeks[0] for weeks in periods.values())
    cutoff = getattr(league, "currentMatchupPeriod", None)
    if cutoff:
        weeks = [w for w in weeks if w <= cutoff]
    return weeks


def season_only_matchup_rows(league) -> list:
    """Team-level matchup rows built from ESPN's raw schedule -- works for
    years where ESPN gives us records and weekly team totals but no
    per-matchup roster snapshot at all (2015-2018). Reads the raw schedule
    directly (not the Team objects' schedule/scores/outcomes, which discard
    playoffTierType) so a real playoff game can be told apart from a
    consolation-ladder placement game, the same distinction box_scores_to_rows
    makes for 2019+."""
    data = league.espn_request.league_get(params={"view": "mMatchupScore"})
    rows = []
    for m in data.get("schedule", []):
        week = m.get("matchupPeriodId")
        bracket_type = m.get("playoffTierType") or "NONE"
        is_playoff = 1 if bracket_type in REAL_PLAYOFF_BRACKET_TYPES else 0
        winner = m.get("winner", "UNDECIDED")

        def outcome_for(is_home):
            if winner == "UNDECIDED":
                return None
            if winner == "TIE":
                return "T"
            return "W" if (winner == "HOME") == is_home else "L"

        home, away = m.get("home") or {}, m.get("away") or {}
        home_id, away_id = home.get("teamId"), away.get("teamId")
        home_score, away_score = home.get("totalPoints"), away.get("totalPoints")

        if home_id is not None:
            rows.append((league.year, week, home_id, away_id, home_score, away_score,
                         is_playoff, outcome_for(True), bracket_type))
        if away_id is not None:
            rows.append((league.year, week, away_id, home_id, away_score, home_score,
                         is_playoff, outcome_for(False), bracket_type))
    return rows


def box_scores_to_rows(year, week, box_scores) -> tuple:
    """Turns a week's list of BoxScore objects into (matchup_rows, roster_rows)
    ready for INSERT OR REPLACE, matching MATCHUP_COLUMNS / ROSTER_COLUMNS."""
    matchup_rows = []
    roster_rows = []

    for box in box_scores:
        # box.is_playoff is true for ESPN's consolation-ladder placement
        # games too, not just the real championship bracket -- only
        # WINNERS_BRACKET counts as "made the playoffs".
        bracket_type = box.matchup_type
        is_playoff = 1 if bracket_type in REAL_PLAYOFF_BRACKET_TYPES else 0
        home_id = box.home_team.team_id if box.home_team is not None else None
        away_id = box.away_team.team_id if box.away_team is not None else None
        sides = [(home_id, box.home_score, away_id, box.away_score, box.home_lineup)]
        if away_id is not None:
            sides.append((away_id, box.away_score, home_id, box.home_score, box.away_lineup))

        for team_id, team_score, opp_id, opp_score, lineup in sides:
            if team_id is None:
                continue
            outcome = None
            if opp_id is not None and team_score is not None and opp_score is not None:
                outcome = "T" if team_score == opp_score else ("W" if team_score > opp_score else "L")
            matchup_rows.append((year, week, team_id, opp_id, team_score, opp_score, is_playoff, outcome, bracket_type))

            for p in lineup:
                is_starter = 0 if p.slot_position in ("BE", "IR") else 1
                stats_blob = json.dumps({"actual": p.breakdown, "projected": p.projected_breakdown})
                roster_rows.append((
                    year, week, team_id, p.playerId, p.name, p.proTeam, p.position,
                    p.slot_position, is_starter, p.points, p.projected_points, stats_blob,
                ))

    return matchup_rows, roster_rows


def sql_value(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def insert_or_replace_sql(table, columns, rows) -> list:
    stmts = []
    for row in rows:
        values = ", ".join(sql_value(v) for v in row)
        stmts.append(f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({values});")
    return stmts


def d1_query(sql):
    """Runs a read-only query against remote D1 via `wrangler d1 execute
    --json` and returns the result rows as a list of dicts. Uses the same
    wrangler-CLI approach as the write path (update_history_d1.py) rather
    than D1's raw HTTP API, so both read and write inherit wrangler's
    already-proven auth/retry behavior."""
    result = subprocess.run(
        [NPX, "-y", "wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", f"--command={sql}", "--json"],
        cwd=WORKER_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"D1 query failed: {result.stderr}\nSQL: {sql}")
    data = json.loads(result.stdout)
    return data[0]["results"]
