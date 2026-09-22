"""
Dumps league_history.sqlite into one .sql file per year (managers/teams get
their own small file) so each can be pushed to Cloudflare D1 with
`wrangler d1 execute --remote --file=...`. D1's remote execute is happiest
with modestly-sized files, and per-year is a natural, resumable chunk size
if a push fails partway through.

Usage: python export_to_d1_sql.py [--db PATH] [--out DIR]
"""
import argparse
import os
import sqlite3


def sql_value(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def insert_statements(conn, table, columns, where=None, params=()):
    q = f"SELECT {', '.join(columns)} FROM {table}"
    if where:
        q += f" WHERE {where}"
    rows = conn.execute(q, params).fetchall()
    stmts = []
    for row in rows:
        values = ", ".join(sql_value(v) for v in row)
        stmts.append(f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({values});")
    return stmts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "league_history.sqlite"))
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "d1_dump"))
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    conn = sqlite3.connect(args.db)

    managers_stmts = insert_statements(conn, "managers", ["espn_id", "display_name", "first_name", "last_name"])
    with open(os.path.join(args.out, "managers.sql"), "w", encoding="utf-8") as f:
        f.write("\n".join(managers_stmts))
    print(f"managers.sql: {len(managers_stmts)} rows")

    years = [r[0] for r in conn.execute("SELECT DISTINCT year FROM teams ORDER BY year")]
    for year in years:
        stmts = []
        stmts += insert_statements(
            conn, "teams",
            ["year", "team_id", "team_name", "team_abbrev", "owner_espn_id", "wins", "losses", "ties",
             "points_for", "points_against", "regular_season_standing", "final_standing"],
            where="year = ?", params=(year,),
        )
        stmts += insert_statements(
            conn, "matchups",
            ["year", "week", "team_id", "opponent_team_id", "team_score", "opponent_score", "is_playoff", "outcome"],
            where="year = ?", params=(year,),
        )
        stmts += insert_statements(
            conn, "roster_entries",
            ["year", "week", "team_id", "player_id", "player_name", "pro_team", "position",
             "lineup_slot", "is_starter", "points", "projected_points", "stats_json"],
            where="year = ?", params=(year,),
        )
        path = os.path.join(args.out, f"{year}.sql")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(stmts))
        print(f"{year}.sql: {len(stmts)} statements, {os.path.getsize(path) / 1024:.0f} KB")

    conn.close()


if __name__ == "__main__":
    main()
