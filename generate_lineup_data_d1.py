"""
Writes docs/data/lineups/<year>.json from D1's roster_entries -- every
team's full weekly lineup (starters and bench), for Game Records, where
tapping a game in a record's top 10 opens both teams' lineups.

One file per season, so the page only downloads the one year it needs, and
only when someone opens a game. roster_entries only exists from 2019 on
(history_lib.BOX_SCORE_MIN_YEAR): ESPN kept no per-week lineups before
that, so earlier games simply have no file.

Shape: {"weeks": {"<week>": {"<manager>": [[name, pro_team, slot, points,
projected], ...]}}}, each list already in display order -- starters in
lineup-slot order, then the bench by points, then IR.

Usage: python generate_lineup_data_d1.py [--check]
  --check  also confirms each manager's starters add up to their game score
           in league.json, and reports any game that doesn't.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl

ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(ROOT, "docs", "data", "lineups")
LEAGUE_PATH = os.path.join(ROOT, "docs", "data", "league.json")

# Same order the Dashboard's live matchup view uses for starters.
SLOT_ORDER = ["QB", "RB", "WR", "TE", "RB/WR/TE", "D/ST", "K"]
BENCH_SLOTS = {"BE", "IR"}


def sort_key(p):
    slot, points = p[2], p[3]
    if slot not in BENCH_SLOTS:
        return (0, SLOT_ORDER.index(slot) if slot in SLOT_ORDER else len(SLOT_ORDER), 0)
    return (1 if slot == "BE" else 2, 0, -points)


def build_year(year, team_to_manager):
    rows = hl.d1_query(
        "SELECT week, team_id, player_name, pro_team, lineup_slot, points, projected_points "
        f"FROM roster_entries WHERE year = {int(year)}"
    )
    weeks = {}
    for r in rows:
        manager = team_to_manager.get((year, r["team_id"]))
        if manager is None:
            continue
        weeks.setdefault(str(r["week"]), {}).setdefault(manager, []).append([
            r["player_name"], r["pro_team"], r["lineup_slot"],
            round(r["points"] or 0, 2), round(r["projected_points"] or 0, 2),
        ])
    for teams in weeks.values():
        for players in teams.values():
            players.sort(key=sort_key)
    return {"weeks": dict(sorted(weeks.items(), key=lambda kv: int(kv[0])))}


def check(year, payload):
    """Starters should add up to the score league.json has for that game."""
    with open(LEAGUE_PATH, encoding="utf-8") as f:
        games = json.load(f)["games"]
    bad = 0
    for y, week, gtype, p1, p2, s1, s2, winner, *_ in games:
        if y != year or gtype == "Bye" or winner == "In Progress":
            continue
        for who, score in ((p1, s1), (p2, s2)):
            if not who:
                continue
            players = payload["weeks"].get(str(week), {}).get(who)
            if players is None:
                print(f"  {year} wk {week} {gtype}: no lineup for {who}")
                bad += 1
                continue
            total = round(sum(p[3] for p in players if p[2] not in BENCH_SLOTS), 2)
            if abs(total - score) > 0.011:
                print(f"  {year} wk {week} {gtype}: {who} starters {total} != score {score}")
                bad += 1
    return bad


def main():
    do_check = "--check" in sys.argv
    teams = hl.d1_query("SELECT year, team_id, owner_espn_id FROM teams")
    # Keyed by (year, team_id) -- a departed owner's team_id can be reassigned
    # in a later year (see generate_franchise_data_d1).
    team_to_manager = {}
    for manager, ids in hl.SHEET_NAME_TO_ESPN_IDS.items():
        for t in teams:
            if t["owner_espn_id"] in ids:
                team_to_manager[(t["year"], t["team_id"])] = manager
    years = sorted(y for y in {t["year"] for t in teams} if y >= hl.BOX_SCORE_MIN_YEAR)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    bad = 0
    for year in years:
        payload = build_year(year, team_to_manager)
        if not payload["weeks"]:
            continue
        if do_check:
            bad += check(year, payload)
        path = os.path.join(OUTPUT_DIR, f"{year}.json")
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                if f.read() == text:
                    print(f"{year}: no changes")
                    continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{year}: wrote {len(payload['weeks'])} weeks ({len(text) // 1024} KB)")
    if do_check:
        print(f"Check: {bad} mismatched or missing lineups")


if __name__ == "__main__":
    main()
