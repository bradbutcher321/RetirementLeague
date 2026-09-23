"""
Builds docs/data/parlay.json for parlay-results.html from the league sheet's
"Parlay Tracker" tab (the hand-entered picks/results).

The sheet's own "Parlay Results" tab computes the stats with Sheets formulas;
this script reproduces that logic in Python so the static site doesn't need a
live Sheets dependency at page-load time.

Tracker layout: one column per week (row 2 = year, row 3 = week, row 4 = that
week's Sacko), then a 5-row block per player (Pick / Sport / Odds / Gametime /
Result), then Final Odds / Payout / Split / Result rows for the whole group's
parlay. Gametime cells are real datetimes in the sheet (America/New_York), so
values are read unformatted and converted from Sheets serial numbers.
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "1WghofPfu0Df9eEuePopV8Y0LJbPUYRdMOsPE-fZUtb4")
CREDS_PATH = os.environ.get("GOOGLE_CREDS_PATH", "google_secret.json")
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "parlay.json")

SACKO_COST = 20
SHEETS_EPOCH = datetime(1899, 12, 30)
FIELDS = ("Pick", "Sport", "Odds", "Gametime", "Result")
GRADED = ("Win", "Loss")


def authorize():
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
    ]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def cell(row, idx):
    return row[idx] if idx < len(row) else ""


def to_float(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("$", "").replace("+", "")
    try:
        return float(text)
    except ValueError:
        return None


def to_int(value):
    f = to_float(value)
    return int(f) if f is not None else None


def serial_to_iso(value):
    """Sheets serial number -> naive local (Eastern) ISO string. ISO strings
    of one format sort chronologically, so they double as sort keys."""
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    dt = SHEETS_EPOCH + timedelta(minutes=round(value * 1440))
    return dt.strftime("%Y-%m-%dT%H:%M:00")


def american_to_prob(odds):
    return 100 / (odds + 100) if odds > 0 else -odds / (-odds + 100)


def prob_to_american(prob):
    return -prob / (1 - prob) * 100 if prob > 0.5 else 100 / prob - 100


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def load_tracker(spreadsheet):
    ws = spreadsheet.worksheet("Parlay Tracker")
    rows = ws.get_values("A1:68", value_render_option="UNFORMATTED_VALUE")
    by_label = {}
    for r in rows:
        label = str(cell(r, 0)).strip()
        if label:
            by_label.setdefault(label, r)

    players = [str(cell(r, 0)).strip()[:-5] for r in rows if str(cell(r, 0)).strip().endswith(" Pick")]
    for player in players:
        for field in FIELDS:
            if f"{player} {field}" not in by_label:
                raise ValueError(f"Parlay Tracker is missing the '{player} {field}' row")
    for label in ("Year", "Week", "Sacko", "Final Odds", "Final Payout", "Final Split", "Final Result"):
        if label not in by_label:
            raise ValueError(f"Parlay Tracker is missing the '{label}' row")

    width = max(len(r) for r in rows)
    weeks = []
    for col in range(1, width):
        year = to_int(cell(by_label["Year"], col))
        week = to_int(cell(by_label["Week"], col))
        if year is None or week is None:
            continue
        picks = {}
        for player in players:
            pick = str(cell(by_label[f"{player} Pick"], col)).strip()
            if not pick:
                continue
            result = str(cell(by_label[f"{player} Result"], col)).strip().capitalize()
            picks[player] = {
                "pick": pick,
                "sport": str(cell(by_label[f"{player} Sport"], col)).strip() or None,
                "odds": to_float(cell(by_label[f"{player} Odds"], col)),
                "gametime": serial_to_iso(cell(by_label[f"{player} Gametime"], col)),
                "result": result if result in ("Win", "Loss") else "Pending",
            }
        if not picks:
            continue  # header pre-created for a week nobody has picked yet
        sacko = str(cell(by_label["Sacko"], col)).strip() or None
        weeks.append({
            "year": year,
            "week": week,
            "sacko": sacko,
            "picks": picks,
            "final": {
                "odds": to_float(cell(by_label["Final Odds"], col)),
                "payout": to_float(cell(by_label["Final Payout"], col)),
                "split": to_float(cell(by_label["Final Split"], col)),
            },
        })
    weeks.sort(key=lambda w: (w["year"], w["week"]))
    return players, weeks


# --------------------------------------------------------------------------
# Per-week derivations
# --------------------------------------------------------------------------

def week_state(week, players):
    """Fully graded = every player has a pick and none are pending."""
    picks = week["picks"]
    graded = sum(1 for p in picks.values() if p["result"] in GRADED)
    wins = sum(1 for p in picks.values() if p["result"] == "Win")
    losses = graded - wins
    complete = len(picks) == len(players) and graded == len(players)
    if losses:
        result = "Loss"
    elif complete:
        result = "Win"
    else:
        result = "Pending"
    return {"graded": graded, "wins": wins, "losses": losses, "complete": complete, "result": result}


def kill_info(week, players):
    """A parlay's 'killer' is whoever's leg lost at the earliest game time of
    the week (ties split the kill). 'Chances' are legs graded at or before
    that moment (all graded legs if nothing has lost)."""
    picks = week["picks"]
    loss_times = [p["gametime"] for p in picks.values() if p["result"] == "Loss" and p["gametime"]]
    earliest = min(loss_times) if loss_times else None
    killers = [n for n, p in picks.items() if earliest and p["result"] == "Loss" and p["gametime"] == earliest]
    chances = [
        n for n, p in picks.items()
        if p["result"] in GRADED and p["gametime"] and (earliest is None or p["gametime"] <= earliest)
    ]
    return killers, chances


def bet_positions(week):
    times = [p["gametime"] for p in week["picks"].values() if p["gametime"]]
    return {
        n: 1 + sum(1 for t in times if t < p["gametime"])
        for n, p in week["picks"].items() if p["gametime"]
    }


def sorted_legs(week, players):
    """Legs in player-block order then stable-sorted by game time, matching
    how the sheet resolves ties."""
    ordered = [(n, week["picks"][n]) for n in players if n in week["picks"]]
    return sorted(ordered, key=lambda x: x[1]["gametime"] or "9999")


# --------------------------------------------------------------------------
# Aggregate stats
# --------------------------------------------------------------------------

def wl_rows(counter, key_name):
    rows = []
    for key, (w, l) in counter.items():
        total = w + l
        rows.append({key_name: key, "w": w, "l": l, "win_pct": round(w / total * 100, 1) if total else None})
    # Groups with no decided legs sink to the bottom; the rest by win %.
    return sorted(rows, key=lambda r: (r["win_pct"] is None, -(r["win_pct"] or 0)))


def fixed_rows(counter, key_name):
    """Like wl_rows but keeps the counter's own (meaningful) order."""
    rows = []
    for key, (w, l) in counter.items():
        rows.append({key_name: key, "w": w, "l": l, "win_pct": round(w / (w + l) * 100, 1) if w + l else None})
    return rows


def over_under_side(pick):
    m = re.search(r"\b(over|under)\b|(?<![a-z])([ou])(?=\d)", pick.lower())
    if not m:
        return None
    return "Over" if (m.group(1) or m.group(2)) in ("over", "o") else "Under"


def odds_bucket(odds):
    if odds <= -250:
        return "Heavy Favorite"
    if odds <= -150:
        return "Favorite"
    if odds < 125:
        return "Toss-Up"
    if odds < 200:
        return "Underdog"
    return "Longshot"


def day_bucket(iso):
    day = datetime.fromisoformat(iso).weekday()  # Mon=0
    return {3: "Thursday", 4: "Friday", 5: "Saturday", 6: "Sunday"}.get(day, "Mon-Wed")


def compute_stats(players, weeks):
    over_under = {"Over": [0, 0], "Under": [0, 0]}
    odds_range = {k: [0, 0] for k in ("Heavy Favorite", "Favorite", "Toss-Up", "Underdog", "Longshot")}
    day_of_week = {k: [0, 0] for k in ("Thursday", "Friday", "Saturday", "Sunday", "Mon-Wed")}
    misses, close_calls = [], []
    leg = {p: [0, 0] for p in players}
    sports, bet_types = {}, {}
    odds_type = {"Favorite": [0, 0], "Underdog": [0, 0]}
    odds_lists = {p: [] for p in players}
    kills = {p: 0.0 for p in players}
    chances = {p: 0 for p in players}
    positions = {p: [] for p in players}
    winnings = {p: 0.0 for p in players}
    losses_amt = {p: 0.0 for p in players}
    sackos = {p: 0 for p in players}
    biggest_hit = {}
    safest_loss = {}
    flat = {p: {"profit": 0.0, "bets": 0} for p in players}
    streak = {p: {"current": 0, "longest_win": 0, "longest_loss": 0} for p in players}
    per_parlay = {n: 0 for n in range(len(players) + 1)}
    before_loss = {n: 0 for n in range(len(players) + 1)}

    for week in weeks:
        payout = week["final"]["payout"] or 0
        if week["sacko"] in sackos:
            sackos[week["sacko"]] += 1

        killers, chance_names = kill_info(week, players)
        for k in killers:
            kills[k] += 1 / len(killers)
        for n in chance_names:
            chances[n] += 1
        for n, pos in bet_positions(week).items():
            positions[n].append(pos)

        for name, p in week["picks"].items():
            if p["odds"]:
                odds_lists[name].append(p["odds"])
            sport = sports.setdefault(p["sport"], [0, 0]) if p["sport"] else None
            btype = bet_types.setdefault(p["pick"].split(":")[0].strip(), [0, 0]) if ":" in p["pick"] else None
            if p["result"] not in GRADED:
                continue
            idx = 0 if p["result"] == "Win" else 1
            leg[name][idx] += 1
            if idx == 0 and p["odds"] and (name not in biggest_hit or american_to_prob(p["odds"]) < american_to_prob(biggest_hit[name]["odds"])):
                biggest_hit[name] = {
                    "player": name, "odds": p["odds"], "pick": p["pick"], "sport": p["sport"],
                    "year": week["year"], "week": week["week"],
                }
            if p["odds"]:
                flat[name]["bets"] += 1
                flat[name]["profit"] += (p["odds"] if p["odds"] > 0 else 10000 / -p["odds"]) if idx == 0 else -100
                if idx == 1 and (name not in safest_loss or american_to_prob(p["odds"]) > american_to_prob(safest_loss[name]["odds"])):
                    safest_loss[name] = {
                        "player": name, "odds": p["odds"], "pick": p["pick"], "sport": p["sport"],
                        "year": week["year"], "week": week["week"],
                    }
            run = streak[name]
            if idx == 0:
                run["current"] = run["current"] + 1 if run["current"] > 0 else 1
                run["longest_win"] = max(run["longest_win"], run["current"])
            else:
                run["current"] = run["current"] - 1 if run["current"] < 0 else -1
                run["longest_loss"] = max(run["longest_loss"], -run["current"])
            if sport is not None:
                sport[idx] += 1
            if btype is not None:
                btype[idx] += 1
            if p["odds"]:
                odds_type["Favorite" if p["odds"] < 0 else "Underdog"][idx] += 1
                odds_range[odds_bucket(p["odds"])][idx] += 1
            side = over_under_side(p["pick"])
            if side:
                over_under[side][idx] += 1
            if p["gametime"]:
                day_of_week[day_bucket(p["gametime"])][idx] += 1
            if idx == 0:
                winnings[name] += payout
            else:
                losses_amt[name] += payout

        state = week_state(week, players)
        week["killed_by"] = killers
        entry = {"year": week["year"], "week": week["week"], "payout": payout, "legs_hit": state["wins"], "killed_by": killers}
        if state["losses"]:
            misses.append(entry)
        if state["complete"] and state["losses"]:
            close_calls.append({**entry, "lost_by": [n for n, p in week["picks"].items() if p["result"] == "Loss"]})
        if state["complete"]:
            per_parlay[state["wins"]] += 1
            wins_before = 0
            for _, p in sorted_legs(week, players):
                if p["result"] == "Loss":
                    break
                wins_before += 1
            before_loss[wins_before] += 1

    def by_desc(rows, key):
        return sorted(rows, key=lambda r: -round(r[key], 6))

    avg_odds = []
    for name in players:
        if odds_lists[name]:
            probs = [american_to_prob(o) for o in odds_lists[name]]
            avg_odds.append({"player": name, "avg_odds": round(prob_to_american(sum(probs) / len(probs)))})
    avg_odds_by_player = {a["player"]: a["avg_odds"] for a in avg_odds}

    return {
        "weekly_sackos": by_desc([{"player": n, "sackos": sackos[n], "cost": sackos[n] * SACKO_COST} for n in players], "sackos"),
        "individual_wl": sorted(
            [{"player": n, "w": w, "l": l, "win_pct": round(w / (w + l) * 100, 1) if w + l else 0} for n, (w, l) in leg.items()],
            # Ties on win % break on average odds, higher (more positive)
            # first -- a +140 winner called a harder bet than a -300 winner,
            # so it outranks it rather than landing arbitrarily.
            key=lambda r: (-r["win_pct"], -avg_odds_by_player.get(r["player"], -10**9)),
        ),
        "average_odds": by_desc(avg_odds, "avg_odds"),
        "parlays_killed": by_desc([
            {
                "player": n,
                "kills": round(kills[n], 2),
                "kill_chances": chances[n],
                "avg_bet_position": round(sum(positions[n]) / len(positions[n]), 2) if positions[n] else None,
            }
            for n in players
        ], "kills"),
        "potential_earnings": by_desc([
            {"player": n, "winnings": round(winnings[n], 2), "losses": round(losses_amt[n], 2)} for n in players
        ], "winnings"),
        "streaks": sorted(
            [{"player": n, **streak[n]} for n in players],
            key=lambda r: (-r["longest_win"], -r["current"]),
        ),
        "biggest_hits": sorted(biggest_hit.values(), key=lambda r: american_to_prob(r["odds"])),
        "safest_losses": sorted(safest_loss.values(), key=lambda r: -american_to_prob(r["odds"])),
        "flat_bet_profit": sorted(
            [{"player": n, "profit": round(f["profit"], 2), "bets": f["bets"]} for n, f in flat.items()],
            key=lambda r: -r["profit"],
        ),
        "sport_wl": wl_rows(sports, "sport"),
        "bet_type_wl": wl_rows(bet_types, "bet_type"),
        "odds_type_wl": wl_rows(odds_type, "odds_type"),
        "over_under_wl": wl_rows(over_under, "side"),
        "odds_range_wl": fixed_rows(odds_range, "range"),
        "day_of_week_wl": fixed_rows(day_of_week, "day"),
        "biggest_misses": sorted(misses, key=lambda r: -r["payout"])[:3],
        "closest_calls": sorted(close_calls, key=lambda r: (-r["legs_hit"], -r["payout"]))[:3],
        "legs_won_per_parlay": [{"legs": n, "occurrences": c} for n, c in per_parlay.items()],
        "legs_won_before_loss": [{"legs": n, "occurrences": c} for n, c in before_loss.items()],
    }


def main():
    print("Connecting to Google Sheets API...")
    spreadsheet = authorize().open_by_key(SHEET_ID)

    print("Loading Parlay Tracker...")
    players, weeks = load_tracker(spreadsheet)
    if not weeks:
        raise SystemExit("No parlay weeks found in Parlay Tracker; refusing to overwrite parlay.json")

    for week in weeks:
        week["final"]["result"] = week_state(week, players)["result"]

    years = sorted({w["year"] for w in weeks})
    stats_by_scope = {"all": compute_stats(players, weeks)}
    for year in years:
        stats_by_scope[str(year)] = compute_stats(players, [w for w in weeks if w["year"] == year])

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "players": players,
        "weeks": weeks,
        "years": years,
        "stats": stats_by_scope,
    }

    # Skip the write when only the timestamp would change, so frequent
    # scheduled runs don't produce a commit every time.
    try:
        with open(OUTPUT_PATH, encoding="utf-8") as f:
            existing = json.load(f)
        if {k: v for k, v in existing.items() if k != "generated_at"} == {k: v for k, v in output.items() if k != "generated_at"}:
            print("No changes; parlay.json left as is.")
            return
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(weeks)} weeks to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
