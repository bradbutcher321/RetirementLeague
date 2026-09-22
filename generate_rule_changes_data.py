"""
Builds docs/data/rule-changes.json from the league sheet's "Rules" tab --
one era block per documented rule change (only years where something
actually changed get an entry, matching how the tab itself is kept).

Usage: python generate_rule_changes_data.py
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import authorize, SHEET_ID

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "rule-changes.json")


def load_eras(spreadsheet):
    ws = spreadsheet.worksheet("Rules")
    rows = ws.get_all_values()
    col = 2  # the "Rules" tab's content lives in column C throughout

    def cell(r):
        return r[col].strip() if len(r) > col else ""

    label_pattern = re.compile(r"season", re.IGNORECASE)
    eras = []
    i = 0
    while i < len(rows):
        text = cell(rows[i])
        if text and label_pattern.search(text):
            label = text
            # the rules text block is the next non-empty cell after the label
            j = i + 1
            while j < len(rows) and not cell(rows[j]):
                j += 1
            body = cell(rows[j]) if j < len(rows) else ""
            if body:
                eras.append({"label": label, "rules_text": body})
            i = j + 1
        else:
            i += 1
    return eras


def main():
    print("Loading Rules sheet...")
    spreadsheet = authorize().open_by_key(SHEET_ID)
    eras = load_eras(spreadsheet)
    for e in eras:
        print(f"  {e['label']}")

    output = {"generated_at": datetime.now(timezone.utc).isoformat(), "eras": eras}
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(eras)} eras to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
