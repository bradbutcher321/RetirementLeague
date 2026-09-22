"""
Builds docs/data/rule-changes.json from D1's league_settings (real ESPN
rule/format history, every year 2015-present) instead of the Google Sheet.
An "era" is a run of consecutive years with identical settings; a new era
starts wherever something actually changed (team count, playoff format,
roster structure, PPR value, median scoring). This naturally gives "tabs
only where something changed" across the WHOLE history, not just the 3
seasons the sheet happened to have manually noted.

Buy-in/payout dollar amounts have no ESPN equivalent and still come from
the sheet's "Rules" tab, merged in wherever a documented season's year
falls inside an ESPN-derived era.

Usage: python generate_rule_changes_data.py
"""
import json
import os
import re
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


def rule_signature(settings):
    return {
        "team_count": settings.get("team_count"),
        "playoff_team_count": settings.get("playoff_team_count"),
        "position_slot_counts": settings.get("position_slot_counts"),
        "ppr": ppr_value(settings.get("scoring_format", [])),
        "median_scoring": settings.get("median_scoring"),
        "faab": settings.get("faab"),
        "keeper_count": settings.get("keeper_count"),
    }


def roster_structure(position_slot_counts):
    merged = {}
    for slot, count in (position_slot_counts or {}).items():
        if slot in EXCLUDED_SLOTS:
            continue
        label = "FLEX" if slot in FLEX_SLOTS else slot
        merged[label] = merged.get(label, 0) + count
    ordered = [k for k in STARTER_ORDER if k in merged] + [k for k in merged if k not in STARTER_ORDER]
    return [{"position": k, "count": merged[k]} for k in ordered]


def ppr_label(ppr):
    if ppr is None:
        return "No reception scoring"
    if ppr == 0:
        return "Standard (no PPR)"
    if ppr == 1:
        return "Full PPR"
    return f"{ppr} PPR"


def build_eras(settings_by_year):
    years = sorted(settings_by_year)
    eras = []
    for year in years:
        sig = rule_signature(settings_by_year[year])
        if eras and eras[-1]["signature"] == sig:
            eras[-1]["end_year"] = year
        else:
            eras.append({"start_year": year, "end_year": year, "signature": sig})
    return eras


# --------------------------------------------------------------------------
# Sheet money overlay
# --------------------------------------------------------------------------

def load_money_eras(spreadsheet):
    """{season_start_year: raw rules text} from the sheet's "Rules" tab --
    used only for buy-in/payout figures, which have no ESPN equivalent."""
    ws = spreadsheet.worksheet("Rules")
    rows = ws.get_all_values()
    col = 2

    def cell(r):
        return r[col].strip() if len(r) > col else ""

    label_pattern = re.compile(r"(\d{4})\s*-\s*\d{4}\s*season", re.IGNORECASE)
    money_by_year = {}
    i = 0
    while i < len(rows):
        m = label_pattern.search(cell(rows[i]))
        if m:
            start_year = int(m.group(1))
            j = i + 1
            while j < len(rows) and not cell(rows[j]):
                j += 1
            body = cell(rows[j]) if j < len(rows) else ""
            money_lines = [
                line.strip() for line in body.split("\n")
                if re.match(r"(buy-?in|.*payout)", line.strip(), re.IGNORECASE)
            ]
            if money_lines:
                money_by_year[start_year] = money_lines
            i = j + 1
        else:
            i += 1
    return money_by_year


def money_for_era(era, money_by_year):
    for year in range(era["start_year"], era["end_year"] + 1):
        if year in money_by_year:
            return money_by_year[year]
    return None


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    print("Loading D1 (league_settings)...")
    rows = hl.d1_query("SELECT year, settings_json FROM league_settings ORDER BY year")
    settings_by_year = {r["year"]: json.loads(r["settings_json"]) for r in rows}

    print("Loading Google Sheet (Rules tab, buy-in/payouts only)...")
    spreadsheet = authorize().open_by_key(SHEET_ID)
    money_by_year = load_money_eras(spreadsheet)

    eras = build_eras(settings_by_year)
    output_eras = []
    for era in eras:
        sig = era["signature"]
        label = f"{era['start_year']}" if era["start_year"] == era["end_year"] else f"{era['start_year']}-{era['end_year']}"
        output_eras.append({
            "label": label,
            "start_year": era["start_year"],
            "end_year": era["end_year"],
            "team_count": sig["team_count"],
            "playoff_team_count": sig["playoff_team_count"],
            "ppr_label": ppr_label(sig["ppr"]),
            "median_scoring": sig["median_scoring"],
            "keeper_count": sig["keeper_count"],
            "waiver_type": "FAAB" if sig["faab"] else "Standard priority waivers",
            "roster_structure": roster_structure(sig["position_slot_counts"]),
            "money_lines": money_for_era(era, money_by_year),
        })
        print(f"  {label}: {sig}")

    output = {"generated_at": datetime.now(timezone.utc).isoformat(), "eras": output_eras}
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(output_eras)} eras to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
