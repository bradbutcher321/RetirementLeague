#!/usr/bin/env python3
"""Check a drafted column against its fact packet and save it (site audit III #3).

    python tools/column_add.py packet.json draft.json

draft.json is what the writer produces:

  recap:   {"headline", "dek", "body": [paragraph, ...],
            "standings": [{"manager", "note"}, ... one per manager, in any order]}
  preview: {"headline", "dek", "body": [paragraph, ...],
            "games": [{"a", "b", "note"}, ... one per matchup]}

Paragraphs may use <b>...</b> around figures and nothing else. Every number
in the text has to be one that is in the packet (integers up to 25 and years
are free, since "second" and "Week 5" need no source). Prints every problem
found and exits 1 without saving; on success writes docs/data/column.json
(newest column first, a column with the same id is replaced) and exits 0.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("COLUMN_OUT") or os.path.join(ROOT, "docs", "data", "column.json")
TOKEN = re.compile(r"(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?")
TAG = re.compile(r"<(/?)([a-zA-Z][^>]*)>")


def numbers_in(obj, acc):
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        acc.add(round(float(obj), 2))
    elif isinstance(obj, dict):
        for v in obj.values():
            numbers_in(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            numbers_in(v, acc)
    elif isinstance(obj, str):
        # Numbers inside packet strings (records like "7-3", "Ben leads 8-7").
        for t in TOKEN.findall(obj):
            acc.add(round(float(t.replace(",", "")), 2))


def check_text(label, text, allowed, errors):
    for tag in TAG.finditer(text):
        if tag.group(2).strip().lower() != "b":
            errors.append(f"{label}: only <b> tags are allowed, found <{tag.group(1)}{tag.group(2)}>")
    plain = TAG.sub("", text)
    for tok in TOKEN.findall(plain):
        v = round(float(tok.replace(",", "")), 2)
        if v == int(v) and (v <= 25 or 2015 <= v <= 2030):
            continue
        if v not in allowed:
            errors.append(f"{label}: the number {tok} is not in the packet")


def words(paragraphs):
    return sum(len(TAG.sub("", p).split()) for p in paragraphs)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    packet = json.load(open(sys.argv[1], encoding="utf-8"))
    draft = json.load(open(sys.argv[2], encoding="utf-8"))
    kind = packet["kind"]
    allowed = set()
    numbers_in(packet, allowed)
    errors = []

    for key, limit in (("headline", 70), ("dek", 220)):
        v = draft.get(key)
        if not isinstance(v, str) or not v.strip():
            errors.append(f"{key}: missing")
        elif len(v) > limit:
            errors.append(f"{key}: {len(v)} characters, the limit is {limit}")
        else:
            check_text(key, v, allowed, errors)
    body = draft.get("body")
    if not isinstance(body, list) or not all(isinstance(p, str) for p in body):
        errors.append("body: must be a list of paragraph strings")
        body = []
    if not 4 <= len(body) <= 8:
        errors.append(f"body: {len(body)} paragraphs, wanted 4 to 8")
    n = words(body)
    if body and not 280 <= n <= 800:
        errors.append(f"body: {n} words, wanted 280 to 800")
    for i, p in enumerate(body, 1):
        check_text(f"body[{i}]", p, allowed, errors)

    managers = set()
    out = {}
    if kind == "recap":
        managers = set(packet["teams"])
        rows = draft.get("standings")
        if not isinstance(rows, list):
            errors.append("standings: missing")
            rows = []
        got = [r.get("manager") for r in rows]
        if set(got) != managers or len(got) != len(managers):
            errors.append(f"standings: wanted exactly one row for each of {sorted(managers)}, got {sorted(map(str, got))}")
        notes = {}
        for r in rows:
            note = str(r.get("note", "")).strip()
            if not note or len(note) > 110:
                errors.append(f"standings note for {r.get('manager')}: needs 1 to 110 characters")
            check_text(f"standings note for {r.get('manager')}", note, allowed, errors)
            notes[r.get("manager")] = note
        if packet.get("standings_after"):
            out["standings"] = [
                {"rank": s["rank"], "manager": s["manager"], "record": s["record"],
                 "move": packet["teams"][s["manager"]].get("rank_move") or 0, "note": notes.get(s["manager"], "")}
                for s in packet["standings_after"]]
        else:
            # A playoff week has no standings movement: list the week's scores.
            order = sorted(packet["teams"], key=lambda m: packet["teams"][m]["rank_in_week"])
            out["standings_title"] = "How everyone scored"
            out["standings"] = [
                {"rank": packet["teams"][m]["rank_in_week"], "manager": m,
                 "record": f"{packet['teams'][m]['score']:.2f}", "move": 0, "note": notes.get(m, "")}
                for m in order]
    else:
        pairs = {frozenset((g["a"], g["b"])) for g in packet["games"]}
        rows = draft.get("games")
        if not isinstance(rows, list):
            errors.append("games: missing")
            rows = []
        got = {frozenset((r.get("a"), r.get("b"))) for r in rows}
        if got != pairs or len(rows) != len(pairs):
            errors.append("games: wanted exactly one row for each matchup in the packet")
        notes = {}
        for r in rows:
            note = str(r.get("note", "")).strip()
            if not note or len(note) > 140:
                errors.append(f"game note for {r.get('a')} vs {r.get('b')}: needs 1 to 140 characters")
            check_text(f"game note for {r.get('a')} vs {r.get('b')}", note, allowed, errors)
            notes[frozenset((r.get("a"), r.get("b")))] = note
        out["games"] = [{"a": g["a"], "b": g["b"], "note": notes.get(frozenset((g["a"], g["b"])), "")}
                        for g in packet["games"]]

    if errors:
        print("Not saved. Fix these and run again:")
        for e in errors:
            print(" -", e)
        sys.exit(1)

    eastern = timezone(timedelta(hours=-4 if 3 <= datetime.now(timezone.utc).month <= 10 else -5))
    col = {
        "id": packet["id"], "kind": kind, "season": packet["season"], "week": packet["week"],
        "published_at": datetime.now(eastern).isoformat(timespec="seconds"),
        "headline": draft["headline"].strip(), "dek": draft["dek"].strip(),
        "body": [p.strip() for p in body], **out,
    }
    try:
        doc = json.load(open(OUT, encoding="utf-8"))
    except FileNotFoundError:
        doc = {"columns": []}
    cols = [c for c in doc.get("columns", []) if c["id"] != col["id"]] + [col]
    cols.sort(key=lambda c: (c["season"], c["week"], c["kind"] == "preview"), reverse=True)
    doc = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "columns": cols}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"Saved {col['id']} ({n} words) to docs/data/column.json")


if __name__ == "__main__":
    main()
