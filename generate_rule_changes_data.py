"""
Builds docs/data/rule-changes.json: a year-by-year rules timeline sourced
from D1's league_settings (real ESPN rule/format history, every year
2015-present) plus the Google Sheet's "Money Tracker" tab (actual buy-in and
payout amounts per year -- there's no ESPN equivalent for money).

Shape:
  - "baseline": the very first season's full rules + money, in full.
  - "changes": one entry per later year that changed *something* from the
    year before (format or buy-in); years with no change are omitted
    entirely so the timeline only calls out what's different.
  - "current": the latest season's full rules + money, in full, same shape
    as baseline. If the latest season's payouts aren't final yet (still in
    progress), the payouts shown fall back to the most recent completed
    season's and say so via "payouts_year".

Usage: python generate_rule_changes_data.py
"""
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
import history_lib as hl
from generate_franchise_data import authorize, SHEET_ID

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "rule-changes.json")

# Combo lineup slots all mean "FLEX" for a human-readable roster structure;
# bench/IR aren't part of the "starting lineup" a rules page cares about.
FLEX_SLOTS = {"RB/WR", "RB/WR/TE", "WR/TE", "OP"}
EXCLUDED_SLOTS = {"BE", "IR"}
STARTER_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K"]


def ppr_value(scoring_format):
    rec = next((s for s in scoring_format if s.get("abbr") == "REC"), None)
    return rec["points"] if rec else None


def ppr_label(ppr):
    if ppr is None:
        return "No reception scoring"
    if ppr == 0:
        return "Standard (no PPR)"
    if ppr == 1:
        return "Full PPR"
    return f"{ppr} PPR"


def roster_structure(position_slot_counts):
    merged = {}
    for slot, count in (position_slot_counts or {}).items():
        if slot in EXCLUDED_SLOTS:
            continue
        label = "FLEX" if slot in FLEX_SLOTS else slot
        merged[label] = merged.get(label, 0) + count
    ordered = [k for k in STARTER_ORDER if k in merged] + [k for k in merged if k not in STARTER_ORDER]
    return [{"position": k, "count": merged[k]} for k in ordered]


def rule_year(year, settings):
    return {
        "year": year,
        "team_count": settings.get("team_count"),
        "playoff_team_count": settings.get("playoff_team_count"),
        "ppr_label": ppr_label(ppr_value(settings.get("scoring_format", []))),
        "median_scoring": bool(settings.get("median_scoring")),
        "keeper_count": settings.get("keeper_count") or 0,
        "waiver_type": "FAAB" if settings.get("faab") else "Standard priority waivers",
        "roster_structure": roster_structure(settings.get("position_slot_counts")),
    }


# --------------------------------------------------------------------------
# Sheet money overlay (Money Tracker tab: per-player Buy In / Earnings columns)
# --------------------------------------------------------------------------

def to_float(value):
    if value is None or value == "" or value == "-":
        return None
    try:
        return float(str(value).replace(",", "").replace("$", ""))
    except ValueError:
        return None


def load_money_by_year(spreadsheet):
    """{year: {"buy_in": int, "payouts": [amounts...] descending}} from the
    Money Tracker tab. Buy-in is the modal per-player amount that year;
    payouts are every nonzero Earnings cell that year, largest first (each
    entry is an actual recorded payout, ties included as separate entries)."""
    ws = spreadsheet.worksheet("Money Tracker")
    rows = ws.get_values("A1:AB40")
    money_by_year = {}
    for r in rows[2:]:
        year_cell = r[0].strip() if r else ""
        if not year_cell.isdigit():
            continue
        buyins = [to_float(r[1 + i]) if 1 + i < len(r) else None for i in range(12)]
        earnings = [to_float(r[13 + i]) if 13 + i < len(r) else None for i in range(12)]
        nonzero_buyins = [b for b in buyins if b]
        if not nonzero_buyins:
            continue  # future year with no data yet
        buy_in = int(max(set(nonzero_buyins), key=nonzero_buyins.count))
        payouts = sorted((int(e) for e in earnings if e), reverse=True)
        money_by_year[int(year_cell)] = {"buy_in": buy_in, "payouts": payouts}
    return money_by_year


# --------------------------------------------------------------------------
# Diffing
# --------------------------------------------------------------------------

def roster_diff(prev_list, curr_list):
    prev = {r["position"]: r["count"] for r in prev_list}
    curr = {r["position"]: r["count"] for r in curr_list}
    parts = []
    changed_positions = set(prev) | set(curr)
    ordered_positions = [p for p in STARTER_ORDER if p in changed_positions] + \
        sorted(changed_positions - set(STARTER_ORDER))
    for pos in ordered_positions:
        p, c = prev.get(pos, 0), curr.get(pos, 0)
        if p == c:
            continue
        if p == 0:
            parts.append(f"added {pos}")
        elif c == 0:
            parts.append(f"dropped {pos}")
        else:
            parts.append(f"{pos} {p} → {c}")
    return f"Roster: {', '.join(parts)}" if parts else None


def diff_entry(prev, curr, prev_money, curr_money):
    changes = []
    if prev["team_count"] != curr["team_count"]:
        changes.append(f"Teams: {prev['team_count']} → {curr['team_count']}")
    if prev["playoff_team_count"] != curr["playoff_team_count"]:
        changes.append(f"Playoff Teams: {prev['playoff_team_count']} → {curr['playoff_team_count']}")
    if prev["ppr_label"] != curr["ppr_label"]:
        changes.append(f"Scoring: {prev['ppr_label']} → {curr['ppr_label']}")
    if prev["median_scoring"] != curr["median_scoring"]:
        changes.append(f"Median Scoring: {'Yes' if prev['median_scoring'] else 'No'} → {'Yes' if curr['median_scoring'] else 'No'}")
    if prev["waiver_type"] != curr["waiver_type"]:
        changes.append(f"Waivers: {prev['waiver_type']} → {curr['waiver_type']}")
    if prev["keeper_count"] != curr["keeper_count"]:
        changes.append(f"Keepers: {prev['keeper_count'] or 'None'} → {curr['keeper_count'] or 'None'}")
    roster = roster_diff(prev["roster_structure"], curr["roster_structure"])
    if roster:
        changes.append(roster)
    if curr_money and prev_money and prev_money["buy_in"] != curr_money["buy_in"]:
        changes.append(f"Buy-in: ${prev_money['buy_in']} → ${curr_money['buy_in']}")
    return changes


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    print("Loading D1 (league_settings)...")
    rows = hl.d1_query("SELECT year, settings_json FROM league_settings ORDER BY year")
    settings_by_year = {r["year"]: json.loads(r["settings_json"]) for r in rows}
    years = sorted(settings_by_year)

    print("Loading Google Sheet (Money Tracker tab)...")
    spreadsheet = authorize().open_by_key(SHEET_ID)
    money_by_year = load_money_by_year(spreadsheet)

    rule_by_year = {y: rule_year(y, settings_by_year[y]) for y in years}

    def full_record(year):
        rec = dict(rule_by_year[year])
        money = money_by_year.get(year)
        rec["buy_in"] = money["buy_in"] if money else None
        rec["payouts"] = money["payouts"] if money else []
        return rec

    baseline_year = years[0]
    current_year = years[-1]
    baseline = full_record(baseline_year)

    changes = []
    for i in range(1, len(years)):
        prev_year, curr_year = years[i - 1], years[i]
        delta = diff_entry(
            rule_by_year[prev_year], rule_by_year[curr_year],
            money_by_year.get(prev_year), money_by_year.get(curr_year),
        )
        if delta:
            changes.append({"year": curr_year, "changes": delta})

    current = full_record(current_year)
    if not current["payouts"]:
        # Current season likely in progress; show the most recent completed
        # season's payouts as the reference point instead of nothing.
        completed_years = [y for y in years if y != current_year and money_by_year.get(y, {}).get("payouts")]
        if completed_years:
            ref_year = max(completed_years)
            current["payouts"] = money_by_year[ref_year]["payouts"]
            current["payouts_year"] = ref_year

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "baseline": baseline,
        "changes": changes,
        "current": current,
    }
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote baseline ({baseline_year}), {len(changes)} change years, current ({current_year}) to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
