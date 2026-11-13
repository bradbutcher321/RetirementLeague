"""
One-off export of the 2017 and 2018 lineups to docs/data/lineups/<year>.json,
in the same shape generate_lineup_data_d1.py writes for 2019 on.

D1's roster_entries starts at 2019, but ESPN does still serve lineups for
these two seasons (checked 2026-10-08 with a logged-in session):
  - 2018: every team's full roster each week, starters and bench, with real
    lineup slots and projections (rosterForCurrentScoringPeriod).
  - 2017: starters only (rosterForMatchupPeriod), with each player's points
    but no weekly stat lines (so no team or projection) and every lineup
    slot reported as 0. The slots are rebuilt from position
    against that year's lineup (QB, 2 RB, 2 WR, TE, FLEX, D/ST, K): the RB,
    WR or TE beyond those counts is the FLEX. There's no bench.
Every team-week in both years adds up to ESPN's official score. 2015 and
2016 are left out: their starter lists are missing one to three players in
more than half the games, so those lineups can't be shown whole.

Past seasons don't change, so this only needs running again if the files
are lost. It needs a logged-in ESPN session:

Usage: ESPN_S2=... ESPN_SWID=... python generate_old_lineup_data.py
"""
import json
import os
import sys

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl
import generate_lineup_data_d1 as gl
from espn_api.football.constant import POSITION_MAP, PRO_TEAM_MAP

API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
YEARS = (2017, 2018)
# ESPN's defaultPositionId -> position, for 2017's slot-less starters.
DEFAULT_POSITION = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
SLOT_COUNTS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "D/ST": 1, "K": 1}
FLEX_POSITIONS = {"RB", "WR", "TE"}


def fetch_week(year, week, cookies):
    url = f"{API}/leagueHistory/{hl.LEAGUE_ID}?seasonId={year}" if year < 2018 else \
        f"{API}/seasons/{year}/segments/0/leagues/{hl.LEAGUE_ID}"
    r = requests.get(url, params=[("view", "mMatchupScore"), ("view", "mBoxscore"), ("scoringPeriodId", week)],
                     cookies=cookies, timeout=30)
    r.raise_for_status()
    data = r.json()
    data = data[0] if isinstance(data, list) else data
    return [m for m in data.get("schedule", []) if m.get("matchupPeriodId") == week]


def player_row(entry, slot, week):
    pool = entry["playerPoolEntry"]
    player = pool["player"]
    week_stats = [s for s in player.get("stats", []) if s.get("scoringPeriodId") == week]
    projected = next((s.get("appliedTotal") for s in week_stats if s.get("statSourceId") == 1), None)
    # player.proTeamId is the player's team today, not that season's (Frank
    # Gore reads MIA in 2017). A week's own stat line carries the team he
    # actually played for; 2017 has no weekly lines, so it gets no team.
    team_id = next((s.get("proTeamId") for s in week_stats if s.get("proTeamId")), None)
    return [player["fullName"], PRO_TEAM_MAP.get(team_id, "") if team_id else "", slot,
            round(pool.get("appliedStatTotal") or 0, 2), round(projected or 0, 2)]


def full_roster(side, week):
    """2018: real slots, bench included."""
    return [player_row(e, POSITION_MAP.get(e["lineupSlotId"], ""), week)
            for e in side["rosterForCurrentScoringPeriod"]["entries"]]


def starters_only(side, week):
    """2017: every slot is 0, so rebuild them from position."""
    used, rows = {}, []
    for e in side["rosterForMatchupPeriod"]["entries"]:
        pos = DEFAULT_POSITION.get(e["playerPoolEntry"]["player"].get("defaultPositionId"), "")
        if used.get(pos, 0) < SLOT_COUNTS.get(pos, 0):
            slot = pos
        elif pos in FLEX_POSITIONS:
            slot = "RB/WR/TE"
        else:
            slot = pos
        used[pos] = used.get(pos, 0) + 1
        rows.append(player_row(e, slot, week))
    return rows


def main():
    s2, swid = os.environ.get("ESPN_S2"), os.environ.get("ESPN_SWID")
    if not s2 or not swid:
        raise SystemExit("Set ESPN_S2 and ESPN_SWID environment variables first.")
    cookies = {"espn_s2": s2, "swid": swid}

    teams = hl.d1_query(f"SELECT year, team_id, owner_espn_id FROM teams WHERE year IN ({','.join(map(str, YEARS))})")
    team_to_manager = {}
    for manager, ids in hl.SHEET_NAME_TO_ESPN_IDS.items():
        for t in teams:
            if t["owner_espn_id"] in ids:
                team_to_manager[(t["year"], t["team_id"])] = manager

    os.makedirs(gl.OUTPUT_DIR, exist_ok=True)
    bad = 0
    for year in YEARS:
        weeks = {}
        for week in range(1, 18):
            for m in fetch_week(year, week, cookies):
                for side in (m.get("home"), m.get("away")):
                    if not side:
                        continue
                    manager = team_to_manager.get((year, side["teamId"]))
                    if manager is None:
                        continue
                    players = full_roster(side, week) if year >= 2018 else starters_only(side, week)
                    players.sort(key=gl.sort_key)
                    weeks.setdefault(str(week), {})[manager] = players
        payload = {"weeks": weeks}
        bad += gl.check(year, payload)
        path = os.path.join(gl.OUTPUT_DIR, f"{year}.json")
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{year}: wrote {len(weeks)} weeks ({len(text) // 1024} KB)")
    print(f"Check: {bad} mismatched or missing lineups")


if __name__ == "__main__":
    main()
