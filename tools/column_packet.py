#!/usr/bin/env python3
"""Build the fact packet The Column is written from (site audit III #3).

    python tools/column_packet.py recap   [--year 2026] [--week 5]  > packet.json
    python tools/column_packet.py preview [--year 2026]             > packet.json

The writer (a scheduled Claude Code routine) may use only numbers that are in
this packet; tools/column_add.py checks that before anything is saved. So
every figure a column could want -- margins, bench totals, best lineups,
records, series -- is worked out here, not left to the writer to add up.

recap   the last finished week of the season, from the committed data
        (docs/data/league.json games + lineups/<year>.json). The best
        lineups come from the Worker (the same numbers as the dashboard's
        "Left the win on the bench"), or are worked out here if it is down.
preview the week being played now: pairings, projections and win chances
        come from the Worker's dashboard feed.

Exits 3 with {"skip": ...} on stdout when there is nothing new to write
(the week already has a column), so a routine can stop quietly.
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
WORKER = "https://retirement-league-refresh-proxy.bradbutcher321.workers.dev"
# Game rows in league.json: [year, week, type, away, home, away_score, home_score, winner, id, median]


def load(*parts):
    with open(os.path.join(DATA, *parts), encoding="utf-8") as f:
        return json.load(f)


def worker_json(query=""):
    req = urllib.request.Request(f"{WORKER}/{query}", headers={"User-Agent": "Mozilla/5.0 (RetirementLeague column)"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


def r2(x):
    return None if x is None else round(float(x) + 0.0, 2)


def record_str(w, l, t):
    return f"{w}-{l}" + (f"-{t}" if t else "")


def standings(games, year, upto):
    """Record counts the head-to-head result and the median game, the way
    the site's standings do. Sorted by wins, then points scored."""
    t = {}
    for g in games:
        if g[0] != year or g[2] != "Reg" or g[1] > upto or g[4] is None:
            continue
        _, _, _, a, b, sa, sb, _, _, med = g
        for who, s, o in ((a, sa, sb), (b, sb, sa)):
            x = t.setdefault(who, {"w": 0, "l": 0, "t": 0, "pf": 0.0})
            x["pf"] += s
            x["w" if s > o else "l" if s < o else "t"] += 1
            if med is not None:
                x["w" if s > med else "l" if s < med else "t"] += 1
    order = sorted(t, key=lambda m: (-t[m]["w"], -t[m]["pf"]))
    return {m: {**t[m], "pf": r2(t[m]["pf"]), "rank": i + 1} for i, m in enumerate(order)}


def series(games, a, b):
    """All-time head-to-head, playoffs included (what Head to Head shows)."""
    aw = bw = ties = 0
    for g in games:
        if g[2] == "Bye" or g[4] is None or {g[3], g[4]} != {a, b}:
            continue
        if g[5] == g[6]:
            ties += 1
        elif (g[3] if g[5] > g[6] else g[4]) == a:
            aw += 1
        else:
            bw += 1
    lead = a if aw > bw else b if bw > aw else None
    return {"a": a, "b": b, "a_wins": aw, "b_wins": bw, "ties": ties, "leader": lead,
            "text": f"{lead} leads {max(aw, bw)}-{min(aw, bw)}" if lead else f"tied {aw}-{bw}"}


def pos_lookup():
    try:
        return {e[0]: e[2] for e in load("players-index.json")["players"]}
    except Exception:
        return {}


def guess_pos(row, pos_of):
    slot = row[2]
    if "/" not in slot and slot not in ("BE", "IR", "BN"):
        return slot
    p = pos_of.get(row[6])
    if p:
        return p
    line = row[5] or ""
    if "/" in line and "YDS" in line and "CAR" not in line and "REC" not in line:
        return "QB"
    return "RB" if "CAR" in line and "REC" not in line else "WR"


def best_lineup(rows, pos_of):
    """Highest total the same slots could have scored from the whole roster."""
    pool = [(guess_pos(r, pos_of), r[3], r[6]) for r in rows if r[2] != "IR"]
    slots = [r[2] for r in rows if r[2] not in ("BE", "BN", "IR")]
    used, total = set(), 0.0
    for flex in (False, True):
        for slot in slots:
            if ("/" in slot) != flex:
                continue
            ok = set(slot.split("/"))
            cands = [p for p in pool if p[2] not in used and p[0] in ok]
            if cands:
                top = max(cands, key=lambda p: p[1])
                used.add(top[2])
                total += top[1]
    return r2(total)


def lineup_facts(rows, pos_of):
    starters = [r for r in rows if r[2] not in ("BE", "BN", "IR")]
    bench = [r for r in rows if r[2] in ("BE", "BN")]

    def pl(r):
        return {"name": r[0], "pos": guess_pos(r, pos_of), "slot": r[2], "pts": r2(r[3]), "proj": r2(r[4]),
                "vs_proj": r2(r[3] - r[4])}
    st = [pl(r) for r in starters]
    bn = [pl(r) for r in sorted(bench, key=lambda r: -r[3])]
    return {
        "starters_total": r2(sum(r[3] for r in starters)),
        "bench_total": r2(sum(r[3] for r in bench)),
        "best_start": max(st, key=lambda p: p["vs_proj"]) if st else None,
        "worst_start": min(st, key=lambda p: p["vs_proj"]) if st else None,
        "top_scorer": max(st, key=lambda p: p["pts"]) if st else None,
        "lowest_starter": min(st, key=lambda p: p["pts"]) if st else None,
        "top_bench": bn[:3],
        "best_lineup_computed": best_lineup(rows, pos_of),
    }


def existing_ids():
    try:
        return {c["id"] for c in load("column.json").get("columns", [])}
    except Exception:
        return set()


def last_final_week(games, year):
    """Latest regular-season or playoff week with every game decided."""
    by = {}
    for g in games:
        if g[0] == year and g[2] != "Bye" and g[4] is not None:
            by.setdefault(g[1], []).append(g)
    done = [w for w, gs in by.items() if all(x[7] for x in gs) and all(x[5] or x[6] for x in gs)]
    return max(done) if done else None


def skip(msg):
    print(json.dumps({"skip": msg}))
    sys.exit(3)


def build_recap(year, week):
    league = load("league.json")
    games = league["games"]
    if year is None:
        year = max(g[0] for g in games)
    if week is None:
        week = last_final_week(games, year)
    if week is None:
        skip(f"no finished week in {year}")
    cid = f"{year}-w{week:02d}-recap"
    if cid in existing_ids():
        skip(f"{cid} already written")
    wk = [g for g in games if g[0] == year and g[1] == week and g[2] != "Bye" and g[4] is not None]
    lineups = load("lineups", f"{year}.json")["weeks"].get(str(week), {})
    pos_of = pos_lookup()
    med = next((g[9] for g in wk if g[9] is not None), None)
    best_worker = {}
    try:
        d = worker_json(f"?week={week}")
        for m in d.get("matchups", []):
            if m.get("awayBest") is not None:
                best_worker[m["awayManager"]] = r2(m["awayBest"])
            if m.get("homeBest") is not None:
                best_worker[m["homeManager"]] = r2(m["homeBest"])
    except Exception as e:  # the Worker is only the preferred source of best lineups
        print(f"worker unavailable ({e}); computing best lineups here", file=sys.stderr)

    now = standings(games, year, week) if wk[0][2] == "Reg" else {}
    before = standings(games, year, week - 1) if wk[0][2] == "Reg" else {}
    scores = sorted((s for g in wk for s in (g[5], g[6])), reverse=True)
    teams, matchups = {}, []
    for g in wk:
        _, _, gtype, a, b, sa, sb, win, _, _ = g
        matchups.append({"a": a, "b": b, "a_score": r2(sa), "b_score": r2(sb), "winner": win,
                         "margin": r2(abs(sa - sb)), "type": gtype, "series_after": series(games, a, b)})
        for who, opp, s, o in ((a, b, sa, sb), (b, a, sb, sa)):
            lf = lineup_facts(lineups.get(who, []), pos_of) if who in lineups else {}
            best = best_worker.get(who, lf.get("best_lineup_computed"))
            t = {"opponent": opp, "score": r2(s), "opp_score": r2(o),
                 "result": "W" if s > o else "L" if s < o else "T", "margin": r2(s - o),
                 "rank_in_week": scores.index(s) + 1, "of": len(scores),
                 "vs_median": None if med is None else r2(s - med),
                 "beat_median": None if med is None else s > med,
                 **lf, "best_lineup": best,
                 "points_left_on_bench": None if best is None else r2(max(best - s, 0))}
            t["best_lineup_beats_opponent"] = bool(best is not None and s < o and best > o)
            if who in now:
                t.update(record_after=record_str(now[who]["w"], now[who]["l"], now[who]["t"]),
                         rank_after=now[who]["rank"], season_points=now[who]["pf"],
                         rank_before=before.get(who, {}).get("rank"),
                         rank_move=(before[who]["rank"] - now[who]["rank"]) if who in before else None)
            teams[who] = t
    facts = {
        "high_score": max(({"manager": m, "score": t["score"]} for m, t in teams.items()), key=lambda x: x["score"]),
        "low_score": min(({"manager": m, "score": t["score"]} for m, t in teams.items()), key=lambda x: x["score"]),
        "biggest_win": max(matchups, key=lambda m: m["margin"]),
        "closest_game": min(matchups, key=lambda m: m["margin"]),
        "median": r2(med),
        "losers_whose_best_lineup_would_have_won": [m for m, t in teams.items() if t["best_lineup_beats_opponent"]],
        "losers": sum(1 for t in teams.values() if t["result"] == "L"),
        "top_best_start": max(((m, t["best_start"]) for m, t in teams.items() if t.get("best_start")),
                              key=lambda x: x[1]["vs_proj"], default=None),
        "best_lineup_of_week": max(((m, t["best_lineup"]) for m, t in teams.items() if t.get("best_lineup") is not None),
                                   key=lambda x: x[1], default=None),
    }
    return {
        "kind": "recap", "id": cid, "season": year, "week": week,
        "game_type": wk[0][2], "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notes": [
            "Record counts each head-to-head result and the median game (two results a week).",
            "best_lineup is the most the same lineup slots could have scored from the whole roster.",
            "rank_move > 0 means the manager moved up the standings this week.",
        ],
        "matchups": matchups, "teams": teams, "facts": facts,
        "standings_after": [{"rank": v["rank"], "manager": m, "record": record_str(v["w"], v["l"], v["t"]),
                             "points_for": v["pf"]} for m, v in now.items()],
    }


def build_preview(year):
    d = worker_json("")
    games = load("league.json")["games"]
    year = year or d.get("season") or max(g[0] for g in games)
    week = d["week"]
    cid = f"{year}-w{week:02d}-preview"
    if cid in existing_ids():
        skip(f"{cid} already written")
    now = standings(games, year, week - 1)
    by_mgr = {t["manager"]: t for t in d.get("teams", [])}
    out = []
    for m in d.get("matchups", []):
        a, b = m["awayManager"], m["homeManager"]
        pa, pb = r2(m.get("awayProjected")), r2(m.get("homeProjected"))
        wa = m.get("awayWinProbability")
        out.append({
            "a": a, "b": b,
            "a_record": m.get("awayRecord"), "b_record": m.get("homeRecord"),
            "a_projected": pa, "b_projected": pb,
            "projected_gap": None if pa is None or pb is None else r2(abs(pa - pb)),
            "a_win_pct": None if wa is None else round(wa * 100 if wa <= 1 else wa),
            "b_win_pct": None if wa is None else 100 - round(wa * 100 if wa <= 1 else wa),
            "a_streak": m.get("awayStreak"), "b_streak": m.get("homeStreak"),
            "a_rank": now.get(a, {}).get("rank"), "b_rank": now.get(b, {}).get("rank"),
            "a_season_points": now.get(a, {}).get("pf"), "b_season_points": now.get(b, {}).get("pf"),
            "series": series(games, a, b),
        })
    return {
        "kind": "preview", "id": cid, "season": year, "week": week,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notes": [
            "Projections and win chances are ESPN's, pulled from the Worker; win_pct is a whole percent.",
            "Record counts each head-to-head result and the median game (two results a week).",
            "projected_median is the middle projected score of the 12 teams.",
        ],
        "projected_median": r2(d.get("projectedMedian")),
        "games": out,
        "standings_before": [{"rank": v["rank"], "manager": m, "record": record_str(v["w"], v["l"], v["t"]),
                              "points_for": v["pf"], "playoff_pct": by_mgr.get(m, {}).get("playoffPct")}
                             for m, v in now.items()],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["recap", "preview"])
    ap.add_argument("--year", type=int)
    ap.add_argument("--week", type=int)
    a = ap.parse_args()
    pk = build_recap(a.year, a.week) if a.kind == "recap" else build_preview(a.year)
    json.dump(pk, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
