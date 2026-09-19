"""
Writes docs/data/league.json: the raw game log plus per-season rollups that
the Standings, Head to Head, Overview and Game Records pages compute from in
the browser. Mirrors the Google Sheet's tabs of the same names, which are
all derived from Game Tracker, PlayerStats and RandomInfo.
"""
import json
import os
from datetime import datetime, timezone

import generate_franchise_data as gf

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "league.json")


def compact_games(games):
    return [
        [g["year"], g["week"], g["type"], g["p1"], g["p2"], g["s1"], g["s2"], g["winner"], g["gid"], g["median"]]
        for g in games
    ]


def season_rows(header, rows):
    def col(r, name, cast=gf.to_float):
        i = header.get(name)
        return cast(r[i]) if i is not None and i < len(r) else None

    out = []
    for r in rows:
        year = gf.to_int(r[header["Year"]])
        if year is None or not r[header["Player"]]:
            continue
        out.append({
            "year": year,
            "player": r[header["Player"]],
            "reg_w": col(r, "Reg W", gf.to_int), "reg_l": col(r, "Reg L", gf.to_int),
            "reg_pf": col(r, "Reg PF"), "reg_pa": col(r, "Reg PA"),
            "tot_w": col(r, "Total W", gf.to_int), "tot_l": col(r, "Total L", gf.to_int),
            "tot_pf": col(r, "Total PF"), "tot_pa": col(r, "Total PA"),
            "med_w": col(r, "Median W", gf.to_int) or 0, "med_l": col(r, "Median L", gf.to_int) or 0,
            "champ": col(r, "Champ Wins", gf.to_int) or 0,
            "playoff": col(r, "Playoff Appearances", gf.to_int) or 0,
            "sacko": col(r, "Sacko Counts", gf.to_int) or 0,
            "reg_rank": col(r, "Regular Season Standings", gf.to_int),
            "final_rank": col(r, "Final Standings", gf.to_int),
        })
    return out


def main():
    spreadsheet = gf.authorize().open_by_key(gf.SHEET_ID)
    games = gf.load_games(spreadsheet)
    header, rows = gf.load_player_stats(spreadsheet)
    draft = gf.load_random_info_block(spreadsheet, "Draft Order")
    money = gf.load_money(spreadsheet)

    payload = {
        "generated_at": None,
        "games": compact_games(games),
        "seasons": season_rows(header, rows),
        "draft_order": {p: {y: gf.to_int(v) for y, v in by.items() if gf.to_int(v)} for p, by in draft.items()},
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
