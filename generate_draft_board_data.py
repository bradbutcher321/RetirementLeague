"""
Builds docs/data/draft-board.json -- every draft, every year available in
D1, laid out as a snake-draft grid (rounds x slots) with player position
and a within-year positional draft rank (RB1, RB2, WR1, ...).

With --value it skips D1 and writes docs/data/draft-value.json instead
(site audit II #33): from the existing board and docs/data/lineups/<year>.json
(2017 on), each pick's regular-season points as a starter for the team that
drafted him, in how many starts, and that minus his round's average; then
per year every manager's draft total, grade and best and worst pick, and the
draft's best value and biggest bust. A season in progress counts the weeks
league.json has finished. Two files so that each has one writer: the
franchise workflow writes the board twice a week, the league workflow
writes the value every few hours after the lineups update.

Usage: python generate_draft_board_data.py [--value]
"""
import json
import os
import statistics
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data")
OUTPUT_PATH = os.path.join(DATA_DIR, "draft-board.json")
VALUE_PATH = os.path.join(DATA_DIR, "draft-value.json")
LEAGUE_PATH = os.path.join(DATA_DIR, "league.json")
BENCH_SLOTS = {"BE", "IR"}


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


def grade_for(z):
    """A letter from a manager's draft total against that year's field:
    a standard deviation either side of the mean is an A or an F."""
    if z >= 1:
        return "A"
    if z >= 0.35:
        return "B"
    if z > -0.35:
        return "C"
    if z > -1:
        return "D"
    return "F"


def pick_ref(pick, val, round_num, team_count, manager):
    return {
        "player": pick["player_name"],
        "position": pick.get("position"),
        "manager": manager,
        "round": round_num,
        "pick": pick["overall"] - (round_num - 1) * team_count,
        "pts": val[0],
        "gs": val[1],
        "v": val[2],
    }


def year_value(year, board, league):
    """One year's draft value, or None when there's no lineup file for it.
    `picks` is {round: {slot: [pts, starts, pts minus the round average]}},
    shaped like the board's grid."""
    path = os.path.join(DATA_DIR, "lineups", f"{year}.json")
    settings = (league.get("settings") or {}).get(str(year)) or {}
    reg_weeks = settings.get("reg_weeks")
    if not os.path.exists(path) or not reg_weeks:
        return None
    with open(path, encoding="utf-8") as f:
        weeks = json.load(f)["weeks"]

    # Only weeks whose every regular-season game is final in league.json, so
    # a week in progress doesn't count half its points.
    games = [g for g in league["games"] if g[0] == year and g[2] == "Reg"]
    open_weeks = {g[1] for g in games if g[7] == "In Progress"}
    done = {g[1] for g in games} - open_weeks
    last = max((w for w in done if w <= reg_weeks), default=0)
    if not last:
        return None

    totals = {}  # (manager, player) -> [points, starts]
    for wk, teams in weeks.items():
        if int(wk) > last:
            continue
        for manager, players in teams.items():
            for name, _team, slot, points, _proj in players:
                if slot in BENCH_SLOTS:
                    continue
                t = totals.setdefault((manager, name), [0.0, 0])
                t[0] += points or 0
                t[1] += 1

    team_count = board["team_count"]
    manager_at = {c["slot"]: c["manager"] for c in board["columns"]}
    picks = []  # (round, slot, manager, pick, [pts, starts, v])
    for rnd, row in board["grid"].items():
        for slot, pick in row.items():
            if not pick.get("player_name"):
                continue
            manager = manager_at.get(int(slot))
            pts, gs = totals.get((manager, pick["player_name"]), (0.0, 0))
            picks.append((int(rnd), int(slot), manager, pick, [round(pts, 2), gs, 0]))

    by_round = {}
    for rnd, _s, _m, _p, val in picks:
        by_round.setdefault(rnd, []).append(val[0])
    round_avg = {r: sum(v) / len(v) for r, v in by_round.items()}
    cells = {}
    for rnd, slot, _m, _p, val in picks:
        val[2] = round(val[0] - round_avg[rnd], 2)
        cells.setdefault(str(rnd), {})[str(slot)] = val

    managers = {}
    for rnd, _s, manager, pick, val in picks:
        if not manager:
            continue
        m = managers.setdefault(manager, {"pts": 0.0, "gs": 0, "picks": []})
        m["pts"] += val[0]
        m["gs"] += val[1]
        m["picks"].append(pick_ref(pick, val, rnd, team_count, manager))

    pts = [m["pts"] for m in managers.values()]
    mean = statistics.mean(pts)
    sd = statistics.pstdev(pts) or 1
    order = sorted(managers, key=lambda n: -managers[n]["pts"])
    summary = {}
    for name in order:
        m = managers[name]
        refs = m["picks"]
        summary[name] = {
            "pts": round(m["pts"], 2),
            "gs": m["gs"],
            "rank": 1 + sum(1 for x in pts if x > m["pts"]),
            "grade": grade_for((m["pts"] - mean) / sd),
            "best": max(refs, key=lambda r: r["v"]),
            "bust": min(refs, key=lambda r: r["v"]),
        }
    every = [pick_ref(p, val, r, team_count, m) for r, _s, m, p, val in picks]
    return {
        "through_week": last,
        "reg_weeks": reg_weeks,
        "complete": last >= reg_weeks,
        "best": max(every, key=lambda r: r["v"]),
        "bust": min(every, key=lambda r: r["v"]),
        "managers": summary,
        "picks": cells,
    }


def write_draft_value():
    with open(OUTPUT_PATH, encoding="utf-8") as f:
        output = json.load(f)
    with open(LEAGUE_PATH, encoding="utf-8") as f:
        league = json.load(f)
    values = {}
    for year, board in output["boards"].items():
        v = year_value(int(year), board, league)
        if v:
            values[year] = v
            print(f"  {year} value: through week {v['through_week']}, best {v['best']['player']} ({v['best']['manager']})")
    with open(VALUE_PATH, "w", encoding="utf-8") as f:
        json.dump({"generated_at": league.get("generated_at"), "years": values}, f, separators=(",", ":"))
    print(f"Wrote draft value for {len(values)} years to {VALUE_PATH}")


def main():
    if "--value" in sys.argv:
        write_draft_value()
        return

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
