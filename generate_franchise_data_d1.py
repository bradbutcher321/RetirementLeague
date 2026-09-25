"""
Builds docs/data/franchise.json from the D1 league-history database instead
of the Google Sheet -- the D1-backed replacement for generate_franchise_data.py.

Everything ESPN itself knows about (records, streaks, rivalries, score
extremes, standings, draft position, roster moves, season-by-season history)
is computed here from D1's teams/matchups/draft_picks tables. The weekly
"Sacko" (lowest scorer of the week, capped at 3/year since it costs $20 --
past the cap it falls to the next-lowest scorer, cascading as needed) is
also computed from D1's scores rather than read off the Parlay Tracker
sheet; verified against every sheet-recorded week since the rule started in
2025 and it matches exactly. Only Money Tracker (real-money dues/earnings/
parlay buy-ins) has no ESPN equivalent and always comes from the sheet.

The output JSON shape is identical to generate_franchise_data.py's, so
docs/franchise.html needs no changes at all.

Usage: python generate_franchise_data_d1.py
"""
import json
import os
import statistics
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl
from generate_franchise_data import authorize, load_money, SHEET_ID, longest_and_current_streak

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "franchise.json")
MEDIAN_ERA_START_YEAR = 2025
SACKO_START_YEAR = 2025
SACKO_CAP_PER_YEAR = 3


# --------------------------------------------------------------------------
# Loading D1
# --------------------------------------------------------------------------

def load_d1():
    teams = hl.d1_query(
        "SELECT year, team_id, team_name, owner_espn_id, regular_season_standing, "
        "final_standing, acquisitions FROM teams"
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
# Per-player derivations
# --------------------------------------------------------------------------

def compute_identity(teams_by_player):
    team_row_by_year = {t["year"]: t for t in teams_by_player}
    ordered_years = sorted(team_row_by_year)
    if not ordered_years:
        return {"current_team_name": None, "previous_team_names": []}
    names_in_order = [team_row_by_year[y]["team_name"] for y in ordered_years]
    current = names_in_order[-1]
    seen = []
    for name in names_in_order[:-1]:
        if name != current and name not in seen:
            seen.append(name)
    return {"current_team_name": current, "previous_team_names": seen}


def win_pct(w, l, t=0):
    total = w + l + t
    return round((w + 0.5 * t) / total * 100, 1) if total else None


def compute_record_and_points(games):
    # bracket_type == 'NONE' is the true regular season; is_playoff is true
    # only for the real championship bracket. Consolation-ladder games
    # (bracket_type is WINNERS_/LOSERS_CONSOLATION_LADDER) are neither --
    # they're post-season placement games for teams that missed the real
    # playoffs, so they count toward total points/extremes but not this split.
    reg = [g for g in games if g["bracket_type"] == "NONE"]
    playoff = [g for g in games if g["is_playoff"]]
    # Tracked separately, not folded into reg or playoff -- these are the
    # "toilet bowl" for teams that missed the real playoffs. Not shown
    # anywhere on the site yet; kept here so it's available if that changes.
    consolation = [g for g in games if g["bracket_type"] == "LOSERS_CONSOLATION_LADDER"]

    def wlt(rows):
        w = sum(1 for g in rows if g["outcome"] == "W")
        l = sum(1 for g in rows if g["outcome"] == "L")
        t = sum(1 for g in rows if g["outcome"] == "T")
        return w, l, t

    reg_w, reg_l, reg_t = wlt(reg)
    playoff_w, playoff_l, _ = wlt(playoff)
    consolation_w, consolation_l, _ = wlt(consolation)

    total_pf = sum(g["team_score"] or 0 for g in games)
    total_pa = sum(g["opponent_score"] or 0 for g in games if g["opponent_team_id"] is not None)
    n = len(games) or 1

    return {
        "record": {"reg_w": reg_w, "reg_l": reg_l, "reg_t": reg_t, "playoff_w": playoff_w, "playoff_l": playoff_l,
                   "consolation_w": consolation_w, "consolation_l": consolation_l},
        "win_rates": {"reg_pct": win_pct(reg_w, reg_l, reg_t), "playoff_pct": win_pct(playoff_w, playoff_l)},
        "points": {
            "total_pf": round(total_pf, 2), "total_pa": round(total_pa, 2),
            "avg_pf": round(total_pf / n, 2), "avg_pa": round(total_pa / n, 2),
        },
    }, reg


def compute_median_stats(reg_games_by_year_week, player_reg_games):
    """Median-era (year >= MEDIAN_ERA_START_YEAR) regular-season median
    wins/losses, plus the reg-season win% restricted to the same years so
    median_luck compares like for like."""
    med_w = med_l = 0
    era_reg_w = era_reg_l = 0
    for g in player_reg_games:
        if g["year"] < MEDIAN_ERA_START_YEAR:
            continue
        era_reg_w += g["outcome"] == "W"
        era_reg_l += g["outcome"] == "L"
        median_score = reg_games_by_year_week.get((g["year"], g["week"]))
        if median_score is None or g["team_score"] is None:
            continue
        if g["team_score"] > median_score:
            med_w += 1
        elif g["team_score"] < median_score:
            med_l += 1
    median_pct = win_pct(med_w, med_l)
    era_reg_pct = win_pct(era_reg_w, era_reg_l)
    median_luck = round(median_pct - era_reg_pct, 1) if median_pct is not None and era_reg_pct is not None else None
    return {"wins": med_w, "losses": med_l, "pct": median_pct}, median_luck


def compute_extremes(games):
    scores = [g["team_score"] for g in games if g["team_score"] is not None]
    nonzero_scores = [s for s in scores if s > 0]
    win_margins, loss_margins = [], []
    for g in games:
        if g["opponent_team_id"] is None or g["team_score"] is None or g["opponent_score"] is None:
            continue
        margin = round(g["team_score"] - g["opponent_score"], 2)
        if margin > 0:
            win_margins.append(margin)
        elif margin < 0:
            loss_margins.append(-margin)
    return {
        "highest_score": max(scores) if scores else None,
        "lowest_score": min(nonzero_scores) if nonzero_scores else None,
        "biggest_win_margin": max(win_margins) if win_margins else None,
        "lowest_win_margin": min(win_margins) if win_margins else None,
        "biggest_loss_margin": max(loss_margins) if loss_margins else None,
        "lowest_loss_margin": min(loss_margins) if loss_margins else None,
        "score_stdev": round(statistics.pstdev(scores), 2) if len(scores) > 1 else None,
    }


def compute_streaks(games, reg_games_by_year_week):
    h2h, combined, median = [], [], []
    for g in games:
        if g["opponent_team_id"] is None or g["team_score"] is None or g["opponent_score"] is None:
            continue
        beat_opponent = g["team_score"] > g["opponent_score"]
        h2h.append(beat_opponent)
        combined.append(beat_opponent)
        if g["bracket_type"] == "NONE" and g["year"] >= MEDIAN_ERA_START_YEAR:
            median_score = reg_games_by_year_week.get((g["year"], g["week"]))
            if median_score is not None:
                beat_median = g["team_score"] > median_score
                combined.append(beat_median)
                median.append(beat_median)

    def package(outcomes):
        w, l, cur = longest_and_current_streak(outcomes)
        return {"longest_win": w, "longest_loss": l, "current": cur}

    return {"head_to_head": package(h2h), "combined": package(combined), "median": package(median)}


def compute_rivalries(games, team_id_to_player_by_year, active_players):
    records = {}
    for g in games:
        opp_id = g["opponent_team_id"]
        if opp_id is None or g["team_score"] is None or g["opponent_score"] is None:
            continue
        opp_name = team_id_to_player_by_year.get((g["year"], opp_id))
        if not opp_name:
            continue
        rec = records.setdefault(opp_name, {"w": 0, "l": 0})
        if g["team_score"] > g["opponent_score"]:
            rec["w"] += 1
        elif g["team_score"] < g["opponent_score"]:
            rec["l"] += 1

    qualifying = {opp: r for opp, r in records.items() if r["w"] + r["l"] >= 3}
    if not qualifying:
        return {"nemesis": None, "favorite_opponent": None}

    def pct(rec):
        total = rec["w"] + rec["l"]
        return rec["w"] / total if total else 0

    def package(opp):
        rec = qualifying[opp]
        return {"opponent": opp, "wins": rec["w"], "losses": rec["l"], "win_pct": round(pct(rec) * 100, 1)}

    def build(pick_fn):
        top_opp = pick_fn(qualifying)
        result = package(top_opp)
        if top_opp not in active_players:
            active_qualifying = {o: r for o, r in qualifying.items() if o in active_players and o != top_opp}
            if active_qualifying:
                result["also"] = package(pick_fn(active_qualifying))
        return top_opp, result

    nemesis_opp, nemesis = build(lambda pool: min(pool, key=lambda o: pct(pool[o])))
    favorite_opp, favorite = build(lambda pool: max(pool, key=lambda o: pct(pool[o])))
    if nemesis_opp == favorite_opp:
        favorite = None
    return {"nemesis": nemesis, "favorite_opponent": favorite}


def compute_weekly_sackos(matchups, team_id_to_player_by_year):
    """The weekly Sacko is the lowest scorer of the week, every scheduled
    week (playoffs included) -- but capped at SACKO_CAP_PER_YEAR per person
    per year since it costs $20/week; past the cap it falls to the
    next-lowest scorer that week, cascading further if they're capped too.
    Returns {player: total count across all years}."""
    scores_by_week = {}
    for m in matchups:
        if m["year"] < SACKO_START_YEAR or m["team_score"] is None:
            continue
        scores_by_week.setdefault((m["year"], m["week"]), []).append((m["team_id"], m["team_score"]))

    counts = {}  # (year, player) -> count this year
    totals = {}  # player -> total count
    for (year, week), rows in sorted(scores_by_week.items()):
        for team_id, _ in sorted(rows, key=lambda r: r[1]):
            player = team_id_to_player_by_year.get((year, team_id))
            if player is None:
                continue
            if counts.get((year, player), 0) < SACKO_CAP_PER_YEAR:
                counts[(year, player)] = counts.get((year, player), 0) + 1
                totals[player] = totals.get(player, 0) + 1
                break
    return totals


def compute_moves(teams_by_player):
    """ESPN's own "Acquisitions" counter -- the number it surfaces as a
    team's transaction/moves count on its team-card view."""
    by_year = {t["year"]: t["acquisitions"] or 0 for t in teams_by_player}
    if not by_year:
        return {"total": 0, "avg_per_season": 0, "busiest_season": None}
    busiest_year = max(by_year, key=lambda y: by_year[y])
    return {
        "total": sum(by_year.values()),
        "avg_per_season": round(sum(by_year.values()) / len(by_year), 1),
        "busiest_season": {"year": busiest_year, "moves": by_year[busiest_year]},
    }


def compute_draft(teams_by_player, draft_pos_by_year_team):
    positions = [
        draft_pos_by_year_team[(t["year"], t["team_id"])]
        for t in teams_by_player if (t["year"], t["team_id"]) in draft_pos_by_year_team
    ]
    if not positions:
        return {"avg_position": None, "best_position": None, "worst_position": None}
    return {
        "avg_position": round(sum(positions) / len(positions), 1),
        "best_position": min(positions),
        "worst_position": max(positions),
    }


def compute_standings(teams_by_player, games, sacko_years):
    placements = [t["regular_season_standing"] for t in teams_by_player if t["regular_season_standing"] is not None]
    finals = {t["year"]: t["final_standing"] for t in teams_by_player}
    playoff_years = {g["year"] for g in games if g["is_playoff"]}
    bye_count = sum(1 for g in games if g["opponent_team_id"] is None)
    player_years = {t["year"] for t in teams_by_player}
    return {
        "reg_season_champs": sum(1 for p in placements if p == 1),
        "best_regular_finish": min(placements) if placements else None,
        "worst_regular_finish": max(placements) if placements else None,
        "playoff_appearances": len(playoff_years),
        "champ_appearances": sum(1 for f in finals.values() if f in (1, 2)),
        "championships": sum(1 for f in finals.values() if f == 1),
        "sackos": len(player_years & sacko_years),
        "byes": bye_count,
    }


def compute_season_history(teams_by_player, games):
    games_by_year = {}
    for g in games:
        games_by_year.setdefault(g["year"], []).append(g)

    history = []
    for t in sorted(teams_by_player, key=lambda t: t["year"]):
        year = t["year"]
        year_games = games_by_year.get(year, [])
        reg = [g for g in year_games if g["bracket_type"] == "NONE"]
        playoff = [g for g in year_games if g["is_playoff"]]
        reg_w = sum(1 for g in reg if g["outcome"] == "W")
        reg_l = sum(1 for g in reg if g["outcome"] == "L")
        playoff_w = sum(1 for g in playoff if g["outcome"] == "W")
        playoff_l = sum(1 for g in playoff if g["outcome"] == "L")
        made_playoffs = len(playoff) > 0
        points_for = sum(g["team_score"] or 0 for g in year_games)
        history.append({
            "year": year,
            "team_name": t["team_name"],
            "reg_record": f"{reg_w}-{reg_l}",
            "reg_standing": t["regular_season_standing"],
            "made_playoffs": made_playoffs,
            "playoff_record": f"{playoff_w}-{playoff_l}" if made_playoffs else None,
            "final_standing": t["final_standing"],
            "champion": t["final_standing"] == 1,
            "points_for": round(points_for, 2) if year_games else None,
        })
    return history


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    print("Loading D1 (teams + matchups + draft_picks + season_sackos)...")
    teams, matchups, draft_picks, season_sackos = load_d1()

    # Overwrite ESPN's own final_standing with the league's actual rule --
    # see history_lib.apply_final_standings.
    hl.apply_final_standings(teams, matchups, season_sackos)

    # Keyed by (year, team_id), not just team_id -- ESPN does sometimes
    # reassign a departed owner's numeric team_id to a new owner in a later
    # year (team_id 9 was Corey Costello in 2017-2018, then reassigned to
    # Collin starting 2019), so team_id alone isn't a stable identity key.
    team_id_to_player_by_year = {}
    for player, ids in hl.SHEET_NAME_TO_ESPN_IDS.items():
        for t in teams:
            if t["owner_espn_id"] in ids:
                team_id_to_player_by_year[(t["year"], t["team_id"])] = player

    sacko_years_by_player = {}
    for s in season_sackos:
        player = team_id_to_player_by_year.get((s["year"], s["team_id"]))
        if player:
            sacko_years_by_player.setdefault(player, set()).add(s["year"])

    draft_pos_by_year_team = {(d["year"], d["team_id"]): d["round_pick"] for d in draft_picks}

    matchups_by_team_year = {}
    for m in matchups:
        matchups_by_team_year.setdefault((m["year"], m["team_id"]), []).append(m)

    # Median-era regular-season median score per (year, week), across every
    # team that played that week -- used for combined/median streaks and luck.
    reg_scores_by_year_week = {}
    for m in matchups:
        if m["bracket_type"] != "NONE" or m["year"] < MEDIAN_ERA_START_YEAR:
            continue
        reg_scores_by_year_week.setdefault((m["year"], m["week"]), []).append(m["team_score"])
    reg_median_by_year_week = {k: statistics.median(v) for k, v in reg_scores_by_year_week.items() if v}

    all_players = list(hl.SHEET_NAME_TO_ESPN_IDS)
    current_year = max(t["year"] for t in teams)
    active_players = {team_id_to_player_by_year[(current_year, t["team_id"])] for t in teams
                       if t["year"] == current_year and (current_year, t["team_id"]) in team_id_to_player_by_year}

    print("Loading Google Sheet (Money Tracker)...")
    spreadsheet = authorize().open_by_key(SHEET_ID)
    money_block = load_money(spreadsheet)
    weekly_sacko_counts = compute_weekly_sackos(matchups, team_id_to_player_by_year)

    players_out = []
    for player in all_players:
        teams_by_player = [t for t in teams if team_id_to_player_by_year.get((t["year"], t["team_id"])) == player]
        if not teams_by_player:
            continue

        games = []
        for t in teams_by_player:
            games += matchups_by_team_year.get((t["year"], t["team_id"]), [])
        games.sort(key=lambda g: (g["year"], g["week"]))
        reg_games = [g for g in games if g["bracket_type"] == "NONE"]

        career, _ = compute_record_and_points(games)
        median, median_luck = compute_median_stats(reg_median_by_year_week, reg_games)
        career["median"] = median
        career["win_rates"]["median_pct"] = median["pct"]
        career["standings"] = compute_standings(teams_by_player, games, sacko_years_by_player.get(player, set()))

        years_played = sorted({t["year"] for t in teams_by_player})
        players_out.append({
            "name": player,
            **compute_identity(teams_by_player),
            "founded_year": years_played[0] if years_played else None,
            "seasons": len(years_played),
            "career": career,
            "extremes": compute_extremes(games),
            "streaks": compute_streaks(games, reg_median_by_year_week),
            "rivalries": compute_rivalries(games, team_id_to_player_by_year, active_players),
            "moves": compute_moves(teams_by_player),
            "draft": compute_draft(teams_by_player, draft_pos_by_year_team),
            "weekly_sackos": weekly_sacko_counts.get(player, 0),
            "median_luck": median_luck,
            "money": money_block.get(player),
            "season_history": compute_season_history(teams_by_player, games),
        })

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "median_era_start_year": MEDIAN_ERA_START_YEAR,
        "players": players_out,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(players_out)} franchises to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
