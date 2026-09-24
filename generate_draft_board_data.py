"""
Builds docs/data/draft-board.json -- every draft, every year available in
D1, laid out as a snake-draft grid (rounds x slots) with player position
and a within-year positional draft rank (RB1, RB2, WR1, ...).

Usage: python generate_draft_board_data.py
"""
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "draft-board.json")


def load_d1():
    teams = hl.d1_query("SELECT year, team_id, team_name, owner_espn_id FROM teams")
    picks = hl.d1_query(
        "SELECT year, round_num, round_pick, team_id, player_id, player_name, keeper_status "
        "FROM draft_picks ORDER BY year, round_num, round_pick"
    )
    players = hl.d1_query("SELECT player_id, position FROM players")
    # Earliest-week pro team per player per year -- the team they were on
    # closest to that year's draft, before any in-season trades.
    pro_teams = hl.d1_query(
        "SELECT year, player_id, pro_team FROM ("
        "  SELECT year, player_id, pro_team, "
        "    ROW_NUMBER() OVER (PARTITION BY year, player_id ORDER BY week) rn "
        "  FROM roster_entries"
        ") WHERE rn = 1"
    )
    return teams, picks, players, pro_teams


def build_year_board(year, team_rows, year_picks, position_by_id, pro_team_by_player):
    team_name_by_id = {t["team_id"]: t["team_name"] for t in team_rows}
    manager_by_team_id = {
        t["team_id"]: hl.ESPN_ID_TO_SHEET_NAME.get(t["owner_espn_id"])
        for t in team_rows
    }

    rounds = sorted({p["round_num"] for p in year_picks})
    team_count = max((p["round_pick"] for p in year_picks), default=0)

    def slot_for(pick):
        return pick["round_pick"] if pick["round_num"] % 2 == 1 else team_count + 1 - pick["round_pick"]

    # Column headers: whichever team occupies each slot in round 1.
    round1_by_slot = {p["round_pick"]: p["team_id"] for p in year_picks if p["round_num"] == 1}
    columns = []
    for slot in range(1, team_count + 1):
        team_id = round1_by_slot.get(slot)
        columns.append({
            "slot": slot,
            "team_id": team_id,
            "team_name": team_name_by_id.get(team_id),
            "manager": manager_by_team_id.get(team_id),
        })

    # Positional draft rank (RB1, RB2, ...) in true chronological pick order.
    chronological = sorted(year_picks, key=lambda p: (p["round_num"], p["round_pick"]))
    position_counts = {}
    position_rank_by_pick = {}
    for p in chronological:
        pos = position_by_id.get(p["player_id"])
        if not pos or not p["player_name"]:
            continue
        position_counts[pos] = position_counts.get(pos, 0) + 1
        position_rank_by_pick[(p["round_num"], p["round_pick"])] = f"{pos}{position_counts[pos]}"

    grid = {}
    for p in year_picks:
        key = p["round_num"]
        grid.setdefault(key, {})[slot_for(p)] = {
            "overall": (p["round_num"] - 1) * team_count + p["round_pick"],
            "player_name": p["player_name"] or None,
            "position": position_by_id.get(p["player_id"]),
            "position_rank": position_rank_by_pick.get((p["round_num"], p["round_pick"])),
            "pro_team": pro_team_by_player.get(p["player_id"]),
            "keeper": bool(p["keeper_status"]),
        }

    return {
        "team_count": team_count,
        "rounds": rounds,
        "columns": columns,
        "grid": grid,
    }


def main():
    print("Loading D1 (teams + draft_picks + players + roster_entries)...")
    teams, picks, players, pro_teams = load_d1()
    position_by_id = {p["player_id"]: p["position"] for p in players}

    teams_by_year = {}
    for t in teams:
        teams_by_year.setdefault(t["year"], []).append(t)
    picks_by_year = {}
    for p in picks:
        picks_by_year.setdefault(p["year"], []).append(p)
    pro_team_by_year_player = {}
    for r in pro_teams:
        pro_team_by_year_player.setdefault(r["year"], {})[r["player_id"]] = r["pro_team"]

    years = sorted(set(picks_by_year) & set(teams_by_year))
    boards = {}
    for year in years:
        board = build_year_board(
            year, teams_by_year[year], picks_by_year[year], position_by_id,
            pro_team_by_year_player.get(year, {}),
        )
        if board["rounds"]:
            boards[str(year)] = board
        print(f"  {year}: {len(board['rounds'])} rounds x {board['team_count']} teams")

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "years": sorted((int(y) for y in boards), reverse=True),
        "boards": boards,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(boards)} draft boards to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
