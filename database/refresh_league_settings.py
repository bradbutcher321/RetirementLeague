"""
Re-pushes league_settings for a range of years -- cheap (one League() init
per year, no rosters/matchups needed), useful when a field gets added to
history_lib.league_settings_row() after the initial backfill and existing
D1 rows need to pick it up.

Usage: ESPN_S2=... ESPN_SWID=... python refresh_league_settings.py [--years 2015 2026]
"""
import argparse
import os
import sys
import tempfile
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from espn_api.football import League
import history_lib as hl


def run_sql(statements, label):
    if not statements:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(statements))
        path = f.name
    try:
        result = subprocess.run(
            [hl.NPX, "-y", "wrangler", "d1", "execute", hl.D1_DATABASE_NAME, "--remote", f"--file={path}"],
            cwd=hl.WORKER_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr)
            raise SystemExit(f"wrangler d1 execute failed for {label}")
        print(f"  {label}: written")
    finally:
        os.unlink(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--years", nargs=2, type=int, default=(hl.SEASON_MIN_YEAR, hl.current_nfl_season_year()))
    args = parser.parse_args()

    espn_s2 = os.environ.get("ESPN_S2")
    swid = os.environ.get("ESPN_SWID")
    if not espn_s2 or not swid:
        raise SystemExit("Set ESPN_S2 and ESPN_SWID environment variables first.")

    for year in range(args.years[0], args.years[1] + 1):
        print(f"=== {year} ===")
        league = League(league_id=hl.LEAGUE_ID, year=year, espn_s2=espn_s2, swid=swid)
        run_sql(hl.insert_or_replace_sql("league_settings", hl.LEAGUE_SETTINGS_COLUMNS, [hl.league_settings_row(league)]), "league_settings")


if __name__ == "__main__":
    main()
