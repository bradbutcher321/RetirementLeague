"""
Shared logic for building league-history rows from ESPN data. Used by both
build_history_db.py (local SQLite -- one-time backfill / dev copy) and
update_history_d1.py (the weekly job that writes straight to Cloudflare D1).
Keeping the row-building logic in one place means both writers agree on
exactly what a "row" is instead of two hand-maintained copies drifting apart.
"""
import json
from datetime import datetime

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
                    "is_playoff", "outcome")
ROSTER_COLUMNS = ("year", "week", "team_id", "player_id", "player_name", "pro_team", "position",
                   "lineup_slot", "is_starter", "points", "projected_points", "stats_json")
DRAFT_COLUMNS = ("year", "round_num", "round_pick", "team_id", "nominating_team_id", "player_id",
                  "player_name", "bid_amount", "keeper_status")
LEAGUE_SETTINGS_COLUMNS = ("year", "name", "team_count", "reg_season_count", "playoff_team_count",
                            "playoff_seed_tie_rule", "scoring_type", "median_scoring", "settings_json")


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
    """Team-level matchup rows built from the Team objects' own schedule/
    scores/outcomes -- works for years where ESPN gives us records and
    weekly team totals but no per-matchup roster snapshot at all (2015-2018).
    A bye shows up as the team scheduled against itself (see Team._fetch_schedule
    in espn_api/football/team.py); that's translated to a NULL opponent here."""
    reg_weeks = league.settings.reg_season_count
    rows = []
    for team in league.teams:
        for idx, score in enumerate(team.scores):
            week = idx + 1
            opponent = team.schedule[idx] if idx < len(team.schedule) else None
            is_bye = opponent is team or opponent is None
            opponent_id = None if is_bye else getattr(opponent, "team_id", None)
            opponent_score = None
            if not is_bye and opponent is not None and idx < len(opponent.scores):
                opponent_score = opponent.scores[idx]
            outcome_raw = team.outcomes[idx] if idx < len(team.outcomes) else None
            outcome = outcome_raw if outcome_raw in ("W", "L", "T") else None
            is_playoff = 1 if week > reg_weeks else 0
            rows.append((league.year, week, team.team_id, opponent_id, score, opponent_score, is_playoff, outcome))
    return rows


def box_scores_to_rows(year, week, box_scores) -> tuple:
    """Turns a week's list of BoxScore objects into (matchup_rows, roster_rows)
    ready for INSERT OR REPLACE, matching MATCHUP_COLUMNS / ROSTER_COLUMNS."""
    matchup_rows = []
    roster_rows = []

    for box in box_scores:
        is_playoff = 1 if box.is_playoff else 0
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
            matchup_rows.append((year, week, team_id, opp_id, team_score, opp_score, is_playoff, outcome))

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
