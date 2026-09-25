"""
Writes docs/data/league.json from D1 for everything except the raw game
log -- the D1-backed pipeline for Standings/Head to Head/Overview/Game
Records, following the same pattern as generate_franchise_data_d1.py.

Two pieces still come from the Google Sheet, since neither has a full D1
equivalent:
  - games: the Game Tracker log's type/gid/median columns. ESPN's API (and
    D1's matchups.bracket_type) only exposes 4 coarse playoff buckets --
    NONE, WINNERS_BRACKET, WINNERS_CONSOLATION_LADDER, LOSERS_CONSOLATION_LADDER
    -- with no way to tell a semifinal from the championship game, or a
    5th-place game from the Sacko game. Those (Champ/3rd/5th/Sacko) are
    tagged by hand in the sheet; see history_lib.compute_season_sacko_row's
    docstring for the same limitation on just the Sacko game.
  - earnings: Money Tracker (real-money dues/payouts), which has no ESPN
    equivalent, same as franchise.json's money block.

Everything else -- per-season record/points/rank/playoff-appearance/champ/
sacko, and draft order -- comes from D1's teams/matchups/draft_picks/
season_sackos, computed the same way generate_franchise_data_d1.py computes
them at the career level, just scoped to one year at a time here.

The output JSON shape matches what Standings/Head to Head/Overview/Game
Records already expect, so those pages need no changes.

Usage: python generate_league_data_d1.py
"""
import json
import os
import statistics
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl
import generate_franchise_data as gf  # sheet-only pieces: games, money, auth

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "league.json")
MEDIAN_ERA_START_YEAR = 2025


def compact_games(games):
    return [
        [g["year"], g["week"], g["type"], g["p1"], g["p2"], g["s1"], g["s2"], g["winner"], g["gid"], g["median"]]
        for g in games
    ]


# --------------------------------------------------------------------------
# Loading D1
# --------------------------------------------------------------------------

def load_d1():
    teams = hl.d1_query(
        "SELECT year, team_id, owner_espn_id, regular_season_standing, final_standing FROM teams"
    )
    matchups = hl.d1_query(
        "SELECT year, week, team_id, opponent_team_id, team_score, opponent_score, "
        "is_playoff, outcome, bracket_type FROM matchups ORDER BY year, week"
    )
    draft_picks = hl.d1_query(
        "SELECT year, round_num, round_pick, team_id FROM draft_picks WHERE round_num = 1"
    )
    season_sackos = hl.d1_query("SELECT year, team_id, opponent_team_id FROM season_sackos")
    return teams, matchups, draft_picks, season_sackos


# --------------------------------------------------------------------------
# Per-season rollups (mirrors generate_franchise_data_d1.compute_record_and_points
# and compute_median_stats, scoped to a single year instead of a career)
# --------------------------------------------------------------------------

def compute_season_row(player, team, games_this_team_year, reg_median_by_year_week, is_sacko):
    year = team["year"]
    reg = [g for g in games_this_team_year if g["bracket_type"] == "NONE"]
    playoff = [g for g in games_this_team_year if g["is_playoff"]]

    def wl(rows):
        # A playoff bye (no opponent, no outcome) is deliberately not
        # counted as a win here, unlike the old sheet's Total W -- a team
        # that didn't play shouldn't be credited with a result.
        return sum(1 for g in rows if g["outcome"] == "W"), sum(1 for g in rows if g["outcome"] == "L")

    reg_w, reg_l = wl(reg)
    playoff_w, playoff_l = wl(playoff)
    tot_w, tot_l = wl(games_this_team_year)
    reg_pf = round(sum(g["team_score"] or 0 for g in reg), 2)
    reg_pa = round(sum(g["opponent_score"] or 0 for g in reg if g["opponent_team_id"] is not None), 2)
    tot_pf = round(sum(g["team_score"] or 0 for g in games_this_team_year), 2)
    tot_pa = round(sum(g["opponent_score"] or 0 for g in games_this_team_year
                        if g["opponent_team_id"] is not None), 2)

    med_w = med_l = 0
    if year >= MEDIAN_ERA_START_YEAR:
        for g in reg:
            median_score = reg_median_by_year_week.get((year, g["week"]))
            if median_score is None or g["team_score"] is None:
                continue
            if g["team_score"] > median_score:
                med_w += 1
            elif g["team_score"] < median_score:
                med_l += 1

    return {
        "year": year,
        "player": player,
        "reg_w": reg_w, "reg_l": reg_l, "reg_pf": reg_pf, "reg_pa": reg_pa,
        "tot_w": tot_w, "tot_l": tot_l, "tot_pf": tot_pf, "tot_pa": tot_pa,
        "med_w": med_w, "med_l": med_l,
        "champ": 1 if team["final_standing"] == 1 else 0,
        "playoff": 1 if (playoff_w + playoff_l) > 0 else 0,
        "sacko": 1 if is_sacko else 0,
        "reg_rank": team["regular_season_standing"],
        "final_rank": team["final_standing"],
    }


def main():
    print("Loading D1 (teams + matchups + draft_picks + season_sackos)...")
    teams, matchups, draft_picks, season_sackos = load_d1()

    # Overwrite ESPN's own final_standing with the league's actual rule --
    # see history_lib.apply_final_standings. Same helper
    # generate_franchise_data_d1.py uses, so this and the Franchise page can
    # never drift apart on it.
    hl.apply_final_standings(teams, matchups, season_sackos)

    # Keyed by (year, team_id), not just team_id -- see generate_franchise_data_d1
    # for why (a departed owner's team_id can be reassigned in a later year).
    team_id_to_player_by_year = {}
    for player, ids in hl.SHEET_NAME_TO_ESPN_IDS.items():
        for t in teams:
            if t["owner_espn_id"] in ids:
                team_id_to_player_by_year[(t["year"], t["team_id"])] = player

    sacko_teams = {(s["year"], s["team_id"]) for s in season_sackos}

    matchups_by_team_year = {}
    for m in matchups:
        matchups_by_team_year.setdefault((m["year"], m["team_id"]), []).append(m)

    # League-wide regular-season median score per (year, week), median era
    # only -- same computation as generate_franchise_data_d1.
    reg_scores_by_year_week = {}
    for m in matchups:
        if m["bracket_type"] != "NONE" or m["year"] < MEDIAN_ERA_START_YEAR:
            continue
        reg_scores_by_year_week.setdefault((m["year"], m["week"]), []).append(m["team_score"])
    reg_median_by_year_week = {k: statistics.median(v) for k, v in reg_scores_by_year_week.items() if v}

    season_out = []
    for t in teams:
        player = team_id_to_player_by_year.get((t["year"], t["team_id"]))
        if player is None:
            continue
        games_this_team_year = matchups_by_team_year.get((t["year"], t["team_id"]), [])
        is_sacko = (t["year"], t["team_id"]) in sacko_teams
        season_out.append(compute_season_row(player, t, games_this_team_year, reg_median_by_year_week, is_sacko))
    season_out.sort(key=lambda s: (s["year"], s["player"]))

    draft_order = {}
    for d in draft_picks:
        player = team_id_to_player_by_year.get((d["year"], d["team_id"]))
        if player is None or not d["round_pick"]:
            continue
        draft_order.setdefault(player, {})[d["year"]] = d["round_pick"]

    print("Loading Google Sheet (Game Tracker + Money Tracker)...")
    spreadsheet = gf.authorize().open_by_key(gf.SHEET_ID)
    games = gf.load_games(spreadsheet)
    money = gf.load_money(spreadsheet)

    payload = {
        "generated_at": None,
        "games": compact_games(games),
        "seasons": season_out,
        "draft_order": draft_order,
        "earnings": {p: (m or {}).get("net_result") for p, m in money.items()},
    }
    if os.path.exists(OUTPUT_PATH):
        with open(OUTPUT_PATH, encoding="utf-8") as f:
            old = json.load(f)
        strip = lambda d: {k: v for k, v in d.items() if k != "generated_at"}
        if strip(old) == strip(payload):
            print("No changes; not rewriting.")
            return
    payload["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote {OUTPUT_PATH}: {len(payload['games'])} games, {len(payload['seasons'])} season rows")


if __name__ == "__main__":
    main()
