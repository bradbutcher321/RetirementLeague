"""
Builds the data behind the Trades & Waivers page (docs/moves.html) and the
Players pages (docs/players.html), site audit III #1 and #5:

  docs/data/moves.json          graded trades, best pickups, drop regret, adds
                                and lost claims by manager, the season's
                                latest moves
  docs/data/players-index.json  one row per player for search
  docs/data/players/<id>.json   one file per player, so a page loads only
                                its own

Sources: D1 (teams, draft_picks, roster_entries) for who owned and started
whom, and ESPN's mTransactions2 feed for adds, drops and claims (2018 on).
ESPN returns an accepted trade with no player list, so each trade is rebuilt
from the roster change it caused: a player who sits on one team one week and
another team the next, with no free-agent or waiver add to explain it.
A trade is graded by the points each side's players scored in the new
team's starting lineup from that week to the end of the season.

box scores (roster_entries) only go back to 2019, so trades and started
points start there; drafts and transactions go back further.

The ESPN cookies come from the ESPN_S2 and ESPN_SWID environment variables
(the repository secrets in CI) or, on a dev machine, from
~/.retirementleague-espn.env.

Usage: python generate_moves_data.py
"""
import collections
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "docs", "data")
PLAYERS_DIR = os.path.join(DATA, "players")
LEAGUE_ID = hl.LEAGUE_ID
ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
TX_MIN_YEAR = 2018        # earliest season ESPN's transaction feed answers for
BOX_MIN_YEAR = hl.BOX_SCORE_MIN_YEAR
LATEST_MOVES = 40


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def espn_cookies():
    s2, swid = os.environ.get("ESPN_S2"), os.environ.get("ESPN_SWID")
    if not (s2 and swid):
        path = os.path.expanduser("~/.retirementleague-espn.env")
        if os.path.exists(path):
            for line in open(path, encoding="utf-8"):
                m = re.match(r"\s*(?:export\s+)?(ESPN_S2|ESPN_SWID)=(.*)", line)
                if m:
                    val = m.group(2).strip().strip("'\"")
                    if m.group(1) == "ESPN_S2":
                        s2 = val
                    else:
                        swid = val
    if not (s2 and swid):
        raise SystemExit("ESPN_S2 and ESPN_SWID are needed to read ESPN's transactions.")
    return {"espn_s2": s2, "SWID": swid}


def fetch_transactions(years, current_year, cookies):
    """{year: [transaction, ...]} from mTransactions2, one request per week."""
    def one(args):
        year, week = args
        url = f"{ESPN_BASE}/seasons/{year}/segments/0/leagues/{LEAGUE_ID}?view=mTransactions2&scoringPeriodId={week}"
        for attempt in range(3):
            r = requests.get(url, cookies=cookies, timeout=60)
            if r.status_code == 200:
                return year, r.json().get("transactions") or []
            if r.status_code in (401, 403, 404):
                break
        raise RuntimeError(f"ESPN transactions {year} week {week}: HTTP {r.status_code}")
    jobs = [(y, w) for y in years for w in range(0, 19 if y < current_year else 20)]
    seen = collections.defaultdict(dict)
    with ThreadPoolExecutor(max_workers=6) as pool:
        for year, txs in pool.map(one, jobs):
            for t in txs:
                seen[year][t["id"]] = t
    return {y: list(seen[y].values()) for y in years}


ESPN_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}


def fetch_player_names(ids, year, cookies):
    """{player_id: (name, position)} straight from ESPN, for players a
    transaction names but no stored roster or draft row does yet (a pickup
    from this week, say)."""
    out = {}
    ids = sorted(ids)
    for i in range(0, len(ids), 50):
        flt = {"players": {"filterIds": {"value": ids[i:i + 50]}}}
        r = requests.get(f"{ESPN_BASE}/seasons/{year}/players?view=players_wl", cookies=cookies,
                         headers={"x-fantasy-filter": json.dumps(flt)}, timeout=60)
        if r.status_code != 200:
            continue
        for p in r.json():
            out[p["id"]] = (p.get("fullName"), ESPN_POS.get(p.get("defaultPositionId")))
    return out


def load_d1():
    teams = hl.d1_query("SELECT year, team_id, team_name, owner_espn_id FROM teams")
    picks = hl.d1_query(
        "SELECT year, round_num, round_pick, team_id, player_id, player_name, bid_amount, keeper_status FROM draft_picks")
    players = hl.d1_query("SELECT player_id, full_name, position FROM players")
    rosters = []
    for year in sorted({t["year"] for t in teams}):
        if year < BOX_MIN_YEAR:
            continue
        rosters += hl.d1_query(
            "SELECT year, week, team_id, player_id, player_name, position, is_starter, points "
            f"FROM roster_entries WHERE year = {year}")
    return teams, picks, players, rosters


def fix_name(s):
    return hl.fix_mojibake(s) if s else s


# --------------------------------------------------------------------------
# Building
# --------------------------------------------------------------------------

def build():
    league = json.load(open(os.path.join(DATA, "league.json"), encoding="utf-8"))
    seasons = league["seasons"]
    games = [dict(zip(["year", "week", "type", "p1", "p2", "s1", "s2", "winner", "gid", "median"], g)) for g in league["games"]]
    current_year = max(s["year"] for s in seasons)
    champ_of = {s["year"]: s["player"] for s in seasons if s["champ"] == 1}
    champ_week = {g["year"]: g["week"] for g in games if g["type"] == "Champ"}
    final_rank = {(s["year"], s["player"]): s["final_rank"] for s in seasons}

    teams, picks, players, rosters = load_d1()
    mgr_of = {(t["year"], t["team_id"]): hl.ESPN_ID_TO_SHEET_NAME.get(t["owner_espn_id"], "?") for t in teams}
    mgr = lambda year, tid: mgr_of.get((year, tid), "?")

    info = {}       # player_id -> [name, pos]
    for p in players:
        info[p["player_id"]] = [fix_name(p["full_name"]), p["position"]]
    for r in rosters:
        cur = info.setdefault(r["player_id"], [r["player_name"], r["position"]])
        if not cur[0]:
            cur[0] = r["player_name"]
        if not cur[1]:
            cur[1] = r["position"]
    for p in picks:
        cur = info.setdefault(p["player_id"], [p["player_name"], None])
        if not cur[0]:
            cur[0] = p["player_name"]
    name = lambda pid: (info.get(pid) or [str(pid)])[0] or str(pid)
    pos = lambda pid: (info.get(pid) or [None, None])[1]

    cookies = espn_cookies()
    tx = fetch_transactions(range(TX_MIN_YEAR, current_year + 1), current_year, cookies)
    unknown = {it["playerId"] for txs in tx.values() for t in txs for it in (t.get("items") or [])
               if it.get("playerId") and not (info.get(it["playerId"]) or [None])[0]}
    for pid, (n, p) in fetch_player_names(unknown, current_year, cookies).items():
        info[pid] = [n, p]

    # ---- roster index: (year, team, player) -> weeks and points
    by_week = collections.defaultdict(dict)     # (year, week) -> {pid: team}
    start_rows = collections.defaultdict(list)  # pid -> [(year, week, team, points)]
    for r in rosters:
        by_week[(r["year"], r["week"])][r["player_id"]] = r["team_id"]
        if r["is_starter"]:
            start_rows[r["player_id"]].append((r["year"], r["week"], r["team_id"], r["points"] or 0.0))
    weeks_of = collections.defaultdict(list)
    for (year, week) in sorted(by_week):
        weeks_of[year].append(week)

    def started(pid, year, from_week, team=None, other_than=None):
        pts, n = 0.0, 0
        for y, w, t, p in start_rows.get(pid, ()):
            if y != year or w < from_week:
                continue
            if team is not None and t != team:
                continue
            if other_than is not None and t == other_than:
                continue
            pts += p
            n += 1
        return round(pts, 2), n

    # ---- transactions
    executed = lambda t: t.get("status") == "EXECUTED"
    added_to = collections.defaultdict(set)     # (year, pid) -> teams that got him by add/draft
    adds, drops = [], []
    lost = collections.Counter()
    claims = collections.defaultdict(list)
    for year, txs in tx.items():
        for t in txs:
            if t["type"] == "WAIVER" and str(t.get("status", "")).startswith("FAILED_INVALIDPLAYERSOURCE"):
                lost[mgr(year, t["teamId"])] += 1
                for it in t.get("items") or []:
                    if it["type"] == "ADD":
                        claims[(year, t["scoringPeriodId"], it["playerId"])].append(mgr(year, t["teamId"]))
            if not executed(t):
                continue
            for it in t.get("items") or []:
                if t["type"] in ("FREEAGENT", "WAIVER", "ROSTER", "FUTURE_ROSTER") and it["type"] == "ADD" or t["type"] == "DRAFT":
                    added_to[(year, it["playerId"])].add(it.get("toTeamId"))
                if t["type"] in ("FREEAGENT", "WAIVER"):
                    ts = t.get("processDate") or t.get("proposedDate") or 0
                    rec = (year, t["scoringPeriodId"], it["playerId"], t["type"], ts)
                    if it["type"] == "ADD":
                        adds.append(rec + (it["toTeamId"],))
                    elif it["type"] == "DROP":
                        drops.append(rec + (it["fromTeamId"],))

    # ---- trades: roster moves no add explains
    found = collections.defaultdict(list)   # (year, week, frozenset(teams)) -> [(pid, from, to)]
    for year in sorted(weeks_of):
        wks = weeks_of[year]
        for a, b in zip(wks, wks[1:]):
            before, after = by_week[(year, a)], by_week[(year, b)]
            for pid, ta in before.items():
                tb = after.get(pid)
                if tb is not None and tb != ta and tb not in added_to.get((year, pid), set()):
                    found[(year, b, frozenset((ta, tb)))].append((pid, ta, tb))
    trades, trade_count = [], collections.Counter()
    trade_moves = collections.defaultdict(list)     # pid -> moves for player pages
    for (year, week, pair), lst in sorted(found.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        tids = sorted(pair)
        sides = {}
        for tid in tids:
            m = mgr(year, tid)
            got = [(pid, ta) for pid, ta, tb in lst if tb == tid]
            players_out = []
            for pid, _ in got:
                pts, n = started(pid, year, week, team=tid)
                players_out.append({"id": pid, "name": name(pid), "pos": pos(pid), "start_pts": pts, "starts": n})
            sides[m] = {"players": players_out, "start_pts": round(sum(p["start_pts"] for p in players_out), 2),
                        "final": final_rank.get((year, m)) or None}
        names = list(sides)
        for m in names:
            trade_count[m] += 1
        for pid, ta, tb in lst:
            trade_moves[pid].append({"year": year, "week": week, "kind": "TRADE", "mgr": mgr(year, tb), "from": mgr(year, ta)})
        if any(not s["players"] for s in sides.values()):
            continue        # one side unreadable from rosters alone
        a, b = names
        diff = sides[a]["start_pts"] - sides[b]["start_pts"]
        trades.append({"year": year, "week": week, "sides": sides,
                       "winner": (a if diff > 0 else b) if diff else None, "margin": round(abs(diff), 2),
                       "champ": champ_of.get(year) if year in champ_of else None})
    trades.sort(key=lambda t: (-t["year"], -t["week"]))

    # ---- pickups, drop regret, adds
    dropped_by = collections.defaultdict(list)      # (year, pid) -> [(ts, team)]
    for year, wk, pid, typ, ts, tid in drops:
        dropped_by[(year, pid)].append((ts, wk, tid))
    pickups = []
    adds_by = collections.Counter()
    season_adds = collections.defaultdict(collections.Counter)
    for year, wk, pid, typ, ts, tid in adds:
        adds_by[mgr(year, tid)] += 1
        season_adds[year][mgr(year, tid)] += 1
        if year < BOX_MIN_YEAR:
            continue
        pts, n = started(pid, year, max(wk, 1), team=tid)
        rec = {"year": year, "week": wk, "mgr": mgr(year, tid), "id": pid, "player": name(pid), "pos": pos(pid),
               "pts": pts, "starts": n, "type": typ}
        earlier = [d for d in dropped_by.get((year, pid), []) if d[0] <= ts and d[2] != tid]
        if earlier:
            rec["droppedBy"] = mgr(year, max(earlier)[2])
        pickups.append(rec)
    pickups.sort(key=lambda r: -r["pts"])

    regret, regret_total = [], collections.Counter()
    for year, wk, pid, typ, ts, tid in drops:
        if year < BOX_MIN_YEAR:
            continue
        pts, n = started(pid, year, wk + 1, other_than=tid)
        if not pts:
            continue
        best_team = None
        per = collections.Counter()
        for y, w, t, p in start_rows.get(pid, ()):
            if y == year and w > wk and t != tid:
                per[t] += p
        if per:
            best_team = per.most_common(1)[0][0]
        regret_total[mgr(year, tid)] += pts
        regret.append({"year": year, "week": wk, "droppedBy": mgr(year, tid), "id": pid, "player": name(pid), "pos": pos(pid),
                       "thenFor": mgr(year, best_team) if best_team is not None else None, "pts": round(per[best_team], 2) if best_team is not None else pts})
    regret.sort(key=lambda r: -r["pts"])

    # ---- the season's latest moves
    recent = []
    for t in tx.get(current_year, []):
        if t["type"] not in ("FREEAGENT", "WAIVER") or not executed(t):
            continue
        its = t.get("items") or []
        add = [it for it in its if it["type"] == "ADD"]
        drop = [it for it in its if it["type"] == "DROP"]
        if not add and not drop:
            continue
        rec = {"ts": int((t.get("processDate") or t.get("proposedDate") or 0) / 1000), "week": t["scoringPeriodId"],
               "type": "Waiver" if t["type"] == "WAIVER" else "Free agent", "mgr": mgr(current_year, t["teamId"]),
               "add": [[name(i["playerId"]), pos(i["playerId"])] for i in add],
               "drop": [[name(i["playerId"]), pos(i["playerId"])] for i in drop]}
        if add:
            beat = claims.get((current_year, t["scoringPeriodId"], add[0]["playerId"]))
            if beat:
                rec["beat"] = beat
        recent.append(rec)
    recent.sort(key=lambda r: -r["ts"])
    recent = recent[:LATEST_MOVES]

    top_season = sorted(((n, y, m) for y, c in season_adds.items() for m, n in c.items()), reverse=True)[:3]
    moves = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "first_year": BOX_MIN_YEAR, "tx_first_year": TX_MIN_YEAR, "current_year": current_year,
        "trade_total": sum(1 for _ in found), "trades": trades,
        "trade_count": trade_count.most_common(),
        "pickups": pickups[:30], "drop_regret": regret[:20],
        "regret_total": [[m, round(v, 1)] for m, v in regret_total.most_common()],
        "adds_by_mgr": adds_by.most_common(), "most_adds_season": top_season,
        "lost_claims": lost.most_common(), "recent": recent,
    }

    # ---- player pages
    drafts = collections.defaultdict(list)
    for p in picks:
        if not p["player_id"]:
            continue
        d = {"year": p["year"], "pick": f"{p['round_num']}.{p['round_pick']}", "mgr": mgr(p["year"], p["team_id"])}
        if p.get("bid_amount"):
            d["bid"] = p["bid_amount"]
        if p.get("keeper_status"):
            d["keeper"] = True
        drafts[p["player_id"]].append(d)

    card = {}
    pids = set(drafts) | set(start_rows)
    move_ids = collections.defaultdict(list)
    for year, wk, pid, typ, ts, tid in adds:
        move_ids[pid].append({"year": year, "week": wk, "kind": "ADD", "mgr": mgr(year, tid), "via": "waivers" if typ == "WAIVER" else "free agent"})
    for year, wk, pid, typ, ts, tid in drops:
        move_ids[pid].append({"year": year, "week": wk, "kind": "DROP", "mgr": mgr(year, tid)})
    for pid, lst in trade_moves.items():
        move_ids[pid] += lst
    game_by = {}
    for g in games:
        if g["p1"]:
            game_by[(g["year"], g["week"], g["p1"])] = g["p2"]
        if g["p2"]:
            game_by[(g["year"], g["week"], g["p2"])] = g["p1"]
    index = []
    for pid in pids:
        n = name(pid)
        if not n or str(n).isdigit():
            continue
        by_m = collections.defaultdict(lambda: {"pts": 0.0, "starts": 0, "years": set()})
        best, titles = None, []
        for y, w, t, p in start_rows.get(pid, ()):
            m = mgr(y, t)
            by_m[m]["pts"] += p
            by_m[m]["starts"] += 1
            by_m[m]["years"].add(y)
            if best is None or p > best["pts"]:
                best = {"pts": round(p, 2), "year": y, "week": w, "mgr": m, "opp": game_by.get((y, w, m))}
            if champ_week.get(y) == w and champ_of.get(y) == m:
                titles.append({"year": y, "mgr": m, "pts": round(p, 2)})
        # Rostered but never started (bench, then dropped) still belongs on the page.
        for (y, w), roster in by_week.items():
            if pid in roster:
                by_m[mgr(y, roster[pid])]["years"].add(y)
        by_mgr = sorted(({"mgr": m, "pts": round(v["pts"], 2), "starts": v["starts"], "years": sorted(v["years"])}
                         for m, v in by_m.items()), key=lambda x: (-x["pts"], x["mgr"]))
        total = round(sum(x["pts"] for x in by_mgr), 2)
        starts = sum(x["starts"] for x in by_mgr)
        mv = sorted(move_ids.get(pid, []), key=lambda x: (x["year"], x["week"]))
        d = sorted(drafts.get(pid, []), key=lambda x: x["year"])
        card[pid] = {"id": pid, "name": n, "pos": pos(pid), "drafts": d, "byMgr": by_mgr, "total": total, "starts": starts,
                     "best": best, "titles": titles, "moves": mv}
        index.append([pid, n, pos(pid) or "", len(d), round(total, 1)])
    index.sort(key=lambda r: (-r[4], -r[3], r[1]))
    return moves, {"generated_at": moves["generated_at"], "players": index, "draft_years": len({p["year"] for p in picks})}, card


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------

def write_if_changed(path, obj):
    """Writes obj as compact JSON unless the file already holds the same
    content (ignoring generated_at), so a quiet run commits nothing."""
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    if os.path.exists(path):
        try:
            old = json.load(open(path, encoding="utf-8"))
            new = json.loads(text)
            if isinstance(old, dict) and isinstance(new, dict) and "generated_at" in old and "generated_at" in new:
                old.pop("generated_at")
                new.pop("generated_at")
            if old == new:
                return False
        except ValueError:
            pass
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def main():
    moves, index, card = build()
    os.makedirs(PLAYERS_DIR, exist_ok=True)
    changed = write_if_changed(os.path.join(DATA, "moves.json"), moves)
    changed |= write_if_changed(os.path.join(DATA, "players-index.json"), index)
    n = 0
    for pid, c in card.items():
        n += write_if_changed(os.path.join(PLAYERS_DIR, f"{pid}.json"), c)
    keep = {f"{pid}.json" for pid in card}
    for f in os.listdir(PLAYERS_DIR):
        if f.endswith(".json") and f not in keep:
            os.remove(os.path.join(PLAYERS_DIR, f))
    print(f"moves.json: {len(moves['trades'])} trades with both sides, {len(moves['pickups'])} pickups; "
          f"{len(index['players'])} players ({n} files written)")


if __name__ == "__main__":
    main()
