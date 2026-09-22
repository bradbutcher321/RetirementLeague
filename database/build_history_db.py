"""
Builds/updates database/league_history.sqlite -- the league's full history,
from its 2015 inception through the current season. Two fidelity tiers:

  - 2019+: full weekly box scores -- every team's complete roster each week,
    starters and bench both, with every ESPN stat category per player
    (roster_entries table).
  - 2015-2018: team/matchup level only (teams + matchups tables) -- who
    played whom, scores, records, standings. ESPN's stored snapshots for
    these years don't retain per-week bench rosters or per-week player stat
    lines at all (confirmed by direct API inspection -- 2018 has no
    per-matchup roster data whatsoever, 2016-2017 only expose a
    starters-only list with no real lineup-slot detail), so roster_entries
    is intentionally left empty for these years -- that data doesn't exist
    to recover, from ESPN or anywhere else.

The canonical copy of this data now lives in Cloudflare D1 (see
update_history_d1.py, which writes there directly) -- this script and its
local .sqlite output are a dev/backup copy and the tool used for the
original one-time backfill, not something that needs to stay in sync with
D1 on an ongoing basis.

Usage:
    ESPN_S2=... ESPN_SWID=... python build_history_db.py [--years 2015 2025] [--db PATH]

Safe to re-run: every insert is INSERT OR REPLACE, keyed by
(year, week, team_id[, player_id]), so re-running over an already-loaded
range just refreshes those rows instead of duplicating them.
"""
import argparse
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from espn_api.football import League
import history_lib as hl

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "league_history.sqlite")
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")


def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        conn.executescript(f.read())
    return conn


def insert_rows(conn, table, columns, rows):
    if not rows:
        return
    placeholders = ", ".join("?" for _ in columns)
    conn.executemany(
        f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
        rows,
    )


def build_year(conn, year, espn_s2, swid, delay):
    print(f"=== {year} ===")
    league = League(league_id=hl.LEAGUE_ID, year=year, espn_s2=espn_s2, swid=swid)
    insert_rows(conn, "managers", hl.MANAGER_COLUMNS, hl.manager_rows(league.teams))
    insert_rows(conn, "teams", hl.TEAM_COLUMNS, hl.team_rows(year, league.teams))
    insert_rows(conn, "draft_picks", hl.DRAFT_COLUMNS, hl.draft_rows(league))
    insert_rows(conn, "league_settings", hl.LEAGUE_SETTINGS_COLUMNS, [hl.league_settings_row(league)])
    conn.commit()
    print(f"  {len(league.draft)} draft picks, league settings recorded")

    if year < hl.BOX_SCORE_MIN_YEAR:
        rows = hl.season_only_matchup_rows(league)
        insert_rows(conn, "matchups", hl.MATCHUP_COLUMNS, rows)
        conn.commit()
        print(f"  {len(rows)} team-week matchup rows (season-level only -- no per-player roster data exists for this year)")
        return

    cache = {}
    for week in hl.matchup_weeks(league):
        try:
            boxes = league.box_scores(week=week, player_team_cache=cache)
        except Exception as exc:
            print(f"  week {week}: FAILED ({exc}) -- skipping")
            continue
        matchup_rows, roster_rows = hl.box_scores_to_rows(year, week, boxes)
        insert_rows(conn, "matchups", hl.MATCHUP_COLUMNS, matchup_rows)
        insert_rows(conn, "roster_entries", hl.ROSTER_COLUMNS, roster_rows)
        conn.commit()
        print(f"  week {week}: {len(matchup_rows)} matchup-sides, {len(roster_rows)} roster entries")
        time.sleep(delay)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--years", nargs=2, type=int, metavar=("START", "END"),
                         default=(hl.SEASON_MIN_YEAR, hl.current_nfl_season_year()))
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--delay", type=float, default=0.3, help="seconds between per-week requests")
    args = parser.parse_args()

    start, end = args.years
    if start < hl.SEASON_MIN_YEAR:
        raise SystemExit(f"The league didn't exist before {hl.SEASON_MIN_YEAR}; refusing --years {start} ...")

    espn_s2 = os.environ.get("ESPN_S2")
    swid = os.environ.get("ESPN_SWID")
    if not espn_s2 or not swid:
        raise SystemExit("Set ESPN_S2 and ESPN_SWID environment variables first.")

    conn = open_db(args.db)
    for year in range(start, end + 1):
        build_year(conn, year, espn_s2, swid, args.delay)
    conn.close()
    print(f"Done. Database at {args.db}")


if __name__ == "__main__":
    main()
