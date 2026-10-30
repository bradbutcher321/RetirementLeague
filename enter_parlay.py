"""
Writes one week of parlay picks to "Auto Parlay Tracker" from the site's
Parlay Legs page (docs/parlay-legs.html; the old Enter Picks address
redirects there). The page parses the note and finds every game on ESPN in
the browser, the Worker checks the commissioner's sign-in (or the PIN) and
dispatches enter_parlay.yml with the result as the PICKS input, and this
writes it with SheetClient.save_week.

PICKS is JSON: {year, week, sacko, final_odds, final_payout, dry_run, mode,
rows: {player: {sport, bet_type, team, opponent, player_prop, line, side,
odds, gametime, raw_pick, result}}}.

A week already in the sheet is overwritten in place, not added again. For a
new week (mode "new", from a pasted note) a player whose pick didn't change
keeps the Result already graded for it and every new or changed pick starts
at Pending. The page's Edit Week view sends mode "edit", and each row's
Result is saved as sent.

Mode "legs" is Parlay Legs (docs/parlay-legs.html), run by sync_legs.yml:
rows holds every leg the managers have entered for the week, or
{removed: true, raw_pick} for one taken back. Only a row whose Raw Pick
differs from the sheet's is written (as Pending), so a pick a commissioner
fixed with Edit pick, which keeps its Raw Pick, is left alone; a removed
leg's row is cleared only if it still holds that leg. Sacko and the final
odds and payout are left alone (a commissioner saves those with the whole
week, mode "new"/"edit", or on their own with mode "meta" from the
Commissioner page's bet card, where rows is empty).

Usage: PICKS='{...}' python enter_parlay.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parlay_sheet import SheetClient, ROW_FIELDS, PLAYERS_PER_WEEK

TEXT_FIELDS = ["sport", "bet_type", "team", "opponent", "player_prop", "line", "side", "gametime", "raw_pick"]
GAMETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")
RESULTS = {"", "Pending", "Win", "Loss"}


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def clean_rows(rows, players, edit):
    unknown = [p for p in rows if p not in players]
    if unknown:
        fail(f"Not players in the sheet: {', '.join(unknown)}")
    out = {}
    for player, row in rows.items():
        clean = {f: str(row.get(f) or "").strip()[:200] for f in TEXT_FIELDS}
        if clean["gametime"] and not GAMETIME_RE.match(clean["gametime"]):
            fail(f"{player}: game time {clean['gametime']!r} isn't YYYY-MM-DDTHH:MM:SS")
        odds = row.get("odds")
        # save_week parses odds from text.
        clean["odds"] = str(odds) if isinstance(odds, (int, float)) else ""
        clean["result"] = "Pending"
        if edit:
            result = str(row.get("result") or "").strip()
            if result not in RESULTS:
                fail(f"{player}: result {result!r} isn't one of Pending/Win/Loss")
            clean["result"] = result if clean["bet_type"] else ""
        out[player] = clean
    return out


def save_legs(client, year, week, rows, dry_run):
    removed = {p for p, r in rows.items() if r.get("removed")}
    unknown = [p for p in rows if p not in client.players]
    if unknown:
        fail(f"Not players in the sheet: {', '.join(unknown)}")
    legs = clean_rows({p: r for p, r in rows.items() if p not in removed}, client.players, False)

    start_row, block = client.find_week(year, week)
    old_raw = {}
    if start_row:
        for i, player in enumerate(client.players[:PLAYERS_PER_WEEK]):
            old = block[i] if i < len(block) else []
            old_raw[player] = old[14] if len(old) > 14 else ""
    writes = {p: r for p, r in legs.items() if old_raw.get(p, "") != r["raw_pick"]}
    for p in removed:
        if old_raw.get(p) and old_raw[p] == str(rows[p].get("raw_pick") or ""):
            writes[p] = {}

    print(f"{year} Week {week}: {len(legs)} legs entered, {len(removed)} removed; "
          f"{len(writes)} row(s) to write ({'existing week, row ' + str(start_row) if start_row else 'new week'})")
    for player, r in writes.items():
        print(f"  {player:8} " + (" | ".join(str(r[f]) for f in ROW_FIELDS) if r else "(cleared)"))
    if dry_run or not writes:
        print("Dry run: nothing written." if dry_run else "Sheet already matches.")
        return
    if start_row:
        client.save_rows(start_row, writes)
    else:
        client.save_week(client.next_new_week_row(), year, week, "", None, None, writes)
    print("Saved.")


def save_meta(client, year, week, payload, num):
    """Mode "meta": the Commissioner page's bet card. Only the week's Sacko,
    final odds and final payout; every pick in the week is left alone."""
    sacko = str(payload.get("sacko") or "").strip()
    if sacko and sacko not in client.players:
        fail(f"Sacko {sacko!r} isn't a player in the sheet.")
    start_row, _ = client.find_week(year, week)
    if not start_row:
        fail(f"{year} Week {week} isn't in the sheet yet, so there's no bet to set.")
    odds, payout = num(payload.get("final_odds")), num(payload.get("final_payout"))
    print(f"{year} Week {week}: Sacko {sacko or '(none)'}, final odds {odds}, payout {payout} -> row {start_row}")
    if payload.get("dry_run"):
        print("Dry run: nothing written.")
        return
    client.save_meta(start_row, sacko, odds, payout)
    print("Saved.")


def main():
    payload = json.loads(os.environ["PICKS"])
    try:
        year, week = int(payload["year"]), int(payload["week"])
    except (KeyError, TypeError, ValueError):
        fail("Year and Week must be numbers.")
    num = lambda v: float(v) if isinstance(v, (int, float)) else None

    if payload.get("mode") == "legs":
        return save_legs(SheetClient(), year, week, payload.get("rows") or {}, payload.get("dry_run"))

    if payload.get("mode") == "meta":
        return save_meta(SheetClient(), year, week, payload, num)

    edit = payload.get("mode") == "edit"
    client = SheetClient()
    rows = clean_rows(payload.get("rows") or {}, client.players, edit)
    if not rows:
        fail("No picks to save.")

    start_row, block = client.find_week(year, week)
    if edit and not start_row:
        fail(f"{year} Week {week} isn't in the sheet, so there's nothing to edit.")
    if start_row and not edit:
        # Same pick as what's saved -> keep its graded Result.
        for i, player in enumerate(client.players[:PLAYERS_PER_WEEK]):
            old = block[i] if i < len(block) else []
            old_raw, old_result = (old[14], old[13]) if len(old) > 14 else ("", "")
            row = rows.get(player)
            if row and old_raw and old_raw == row["raw_pick"] and old_result:
                row["result"] = old_result
    target = start_row or client.next_new_week_row()

    print(f"{year} Week {week}: {len(rows)} picks -> row {target} ({'editing' if edit else 'replacing' if start_row else 'new week'})")
    for player in client.players:
        r = rows.get(player)
        print(f"  {player:8} " + (" | ".join(str(r[f]) for f in ROW_FIELDS) if r else "(no pick)"))

    if payload.get("dry_run"):
        print("Dry run: nothing written.")
        return
    client.save_week(target, year, week, str(payload.get("sacko") or "").strip(),
                     num(payload.get("final_odds")), num(payload.get("final_payout")), rows)
    print("Saved.")


if __name__ == "__main__":
    main()
