"""
One-time import: pulls every "Sacko"-typed row from the Game Tracker sheet
(a specific manually-arranged matchup each season -- the rule behind which
one has varied over the years and isn't fully remembered, so this treats
the sheet's own historical labeling as ground truth) and records the
loser's team_id into D1's season_sackos table.

This is meant to run once to backfill history. Going forward, new years
should either get a fresh row added here (if the manual-matchup rule is
followed again) or via whatever process ends up designating each season's
Sacko game.

Usage: python import_season_sackos.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import history_lib as hl
from generate_franchise_data import authorize, to_int, to_float, SHEET_ID


def load_sacko_games(spreadsheet):
    ws = spreadsheet.worksheet("Game Tracker")
    rows = ws.get_values("A4:L")
    games = []
    for r in rows:
        r = r + [""] * (12 - len(r))
        year, week, gtype, p1, p2, s1, s2, winner, margin, total, gid, median = r
        if gtype != "Sacko" or not p1 or not p2:
            continue
        s1, s2 = to_float(s1), to_float(s2)
        if s1 is None or s2 is None:
            continue  # not decided yet (e.g. "In Progress")
        loser = p2 if s1 > s2 else p1
        winner_name = p1 if s1 > s2 else p2
        games.append({"year": to_int(year), "week": to_int(week), "loser": loser, "winner": winner_name})
    return games


def main():
    print("Loading Game Tracker Sacko rows...")
    spreadsheet = authorize().open_by_key(SHEET_ID)
    games = load_sacko_games(spreadsheet)

    teams = hl.d1_query("SELECT year, team_id, owner_espn_id FROM teams")
    team_id_by_year_player = {}
    for player, ids in hl.SHEET_NAME_TO_ESPN_IDS.items():
        for t in teams:
            if t["owner_espn_id"] in ids:
                team_id_by_year_player[(t["year"], player)] = t["team_id"]

    rows = []
    for g in games:
        loser_id = team_id_by_year_player.get((g["year"], g["loser"]))
        winner_id = team_id_by_year_player.get((g["year"], g["winner"]))
        if loser_id is None:
            print(f"  {g['year']}: couldn't map '{g['loser']}' to a team_id -- skipping")
            continue
        rows.append((g["year"], loser_id, g["week"], winner_id, "sheet"))
        print(f"  {g['year']} wk{g['week']}: Sacko = {g['loser']} (team_id {loser_id})")

    stmts = hl.insert_or_replace_sql(
        "season_sackos", ("year", "team_id", "week", "opponent_team_id", "source"), rows
    )
    hl.run_d1_sql(stmts, "season_sackos")
    print(f"Done. Wrote {len(rows)} season_sackos rows.")


if __name__ == "__main__":
    main()
