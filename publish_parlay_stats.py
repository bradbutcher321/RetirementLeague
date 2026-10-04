"""
Computes the same stats payload as generate_parlay_data.py, but pushes it
straight to Cloudflare KV instead of writing docs/data/parlay.json for git
to commit -- so the site gets fresh parlay data without a commit/push
cycle, the same way league history already reaches D1 directly (see
database/update_history_d1.py) and the Dashboard already reads straight
from KV (see worker/src/index.js).

Reuses generate_parlay_data.py's build_payload() completely unchanged for
the stats -- only the output step differs (KV instead of a committed
file). Additionally attaches a "live" block (see build_live_scores below):
for every pick still Pending, an in-progress score/stat pulled straight
from ESPN, so docs/parlay-results.html can show a currently-playing game's
running score next to the pick, tinted green/red by whether it's
currently covering. This runs every 10 minutes (same cadence as
auto_grade_results.py, right before it in the same workflow step order),
so a pick's live score is never more than ~10 minutes stale, and it stops
appearing the moment auto_grade_results.py grades the pick Win/Loss (the
"Pending" filter that selects which rows get a live lookup here is the
same Result column that script fills in).

Talks to KV through `wrangler kv key put --remote`, the same wrangler-CLI
approach database/update_history_d1.py already uses for D1, so it inherits
the same proven CI auth (CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID -- both
already present as GitHub Actions secrets, no new secret needed).

Usage: python publish_parlay_stats.py
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "database"))
from generate_parlay_data import authorize, SHEET_ID, TARGET_TAB, build_payload, cell, to_int
import auto_grade_results as ag
from espn_gametime_lookup import find_live_score, find_live_prop
import history_lib as hl

KV_NAMESPACE_ID = "1521d1a4fe954b00a05b4542c7a44670"  # COOLDOWN_KV, shared with the Dashboard cache
# No colon in the key -- confirmed directly that `wrangler kv key put` fails
# with a confusing "Authentication error" from this CLI/account combo on a
# colon-containing key name (e.g. "parlay:stats"), even though the Worker's
# own runtime KV binding handles colon-containing keys (like "dashboard:v2")
# fine. Not pursued further since avoiding it entirely is free.
KV_KEY = "parlay_stats_v1"


def build_live_scores(spreadsheet):
    """For every currently-Pending pick, looks up that game's live state
    from ESPN and returns it keyed by "{year}:{week}:{player}", so the
    frontend can match it to the pick it's currently rendering.

    Team bets (Money Line/Spread/Alt Spread/Total Points/Goals/Rounds) get
    a real covering tint, reusing the exact grading math
    auto_grade_results.py uses for the final result -- just fed the
    in-progress score instead of the final one. 1st Half Spread shows the
    running score too, but with no tint -- covering it depends on the
    score specifically AT halftime, not knowable before the half ends.
    Player props show the live stat total (via find_live_prop) alongside
    the player's game's own score and clock, tinted like a team bet by
    whether it's covering right now -- an Anytime TD green once the TD is
    in and red until then, an Over/Under by which side of the line the
    stat sits on at the moment. An Anytime TD that's in also carries
    `hit`: a scored TD can't come off the board the way yards can, so the
    page can call it a Win before the game ends and the sheet grades it.

    Only ever looks at rows the sheet itself already marked Pending -- a
    handful at a time, not a full history scan -- and only shows a score
    once ESPN itself reports the game as actually started (state "in"),
    not a scheduled-but-not-yet-kicked-off one. Reuses
    find_player_team/_find_event's own per-process caches (see
    espn_gametime_lookup.py), so multiple players' picks on the same game
    cost one real ESPN fetch between them, not one per pick.

    Returns (live, matchups). matchups maps the same keys to "CHI vs.
    NYJ" for every Pending prop whose game could be found, kicked off or
    not -- a prop row never records its teams the way a team bet's
    Team/Opponent columns do, so this is the only place the page can learn
    which game the player is in."""
    ws = spreadsheet.worksheet(TARGET_TAB)
    rows = ws.get_values("A2:N3000")
    live = {}
    matchups = {}

    for r in rows:
        result = str(cell(r, 13)).strip()
        if result != "Pending":
            continue
        player = str(cell(r, 3)).strip()
        sport = str(cell(r, 4)).strip()
        bet_type = str(cell(r, 5)).strip()
        team = str(cell(r, 6)).strip()
        opponent = str(cell(r, 7)).strip()
        player_prop = str(cell(r, 8)).strip()
        line = str(cell(r, 9)).strip()
        side = str(cell(r, 10)).strip()
        gametime = str(cell(r, 12)).strip()
        if not player or not bet_type or not gametime:
            continue
        key = f"{to_int(cell(r, 0))}:{to_int(cell(r, 1))}:{player}"

        if bet_type in ag.PROP_BET_TYPES:
            if not player_prop:
                continue
            m = ag.MULTI_LEG_PROP_RE.match(player_prop)
            required, name = (int(m.group(1)), m.group(2)) if m else (1, player_prop)
            game = find_live_prop(name, bet_type, sport, gametime)
            if not game:
                continue
            matchups[key] = f"{game['team']} vs. {game['opponent']}"
            if game["state"] == "pre" or game["stat"] is None:
                continue
            total = game["stat"]
            hit = False
            if bet_type in ag.PROP_BINARY_BET_TYPES:
                hit = total >= required
                tone = "up" if hit else "down"
            else:
                outcome = ag.grade_over_under(total, line, side)
                tone = "up" if outcome == "Win" else "down" if outcome == "Loss" else None
            live[key] = {
                "kind": "prop", "stat": total, "team_score": game["team_score"], "opponent_score": game["opponent_score"],
                "period": game["period"], "clock": game["clock"], "detail": game["detail"], "tone": tone, "hit": hit,
            }
            continue

        if not team or not opponent:
            continue
        state = find_live_score(team, opponent, sport, gametime)
        if not state or state["state"] != "in":
            continue
        if bet_type in ag.HALF_SCORE_BET_TYPES:
            tone = None
        else:
            outcome = ag.grade_pick(bet_type, state["team_score"], state["opponent_score"], line, side)
            tone = "up" if outcome == "Win" else "down" if outcome == "Loss" else None
        live[key] = {
            "kind": "team", "team_score": state["team_score"], "opponent_score": state["opponent_score"],
            "period": state["period"], "clock": state["clock"], "detail": state["detail"], "tone": tone,
        }

    return live, matchups


def main():
    print("Connecting to Google Sheets API...")
    spreadsheet = authorize().open_by_key(SHEET_ID)
    output = build_payload(spreadsheet)
    weeks = output["weeks"]

    print("Checking live scores for Pending picks...")
    output["live"], matchups = build_live_scores(spreadsheet)
    # Onto the pick itself rather than the live block: which game a prop is
    # in holds before kickoff too, when there's no live entry yet.
    for w in weeks:
        for player, pick in w["picks"].items():
            matchup = matchups.get(f"{w['year']}:{w['week']}:{player}")
            if matchup:
                pick["matchup"] = matchup

    payload = json.dumps(output)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        f.write(payload)
        path = f.name
    try:
        result = subprocess.run(
            [hl.NPX, "-y", "wrangler", "kv", "key", "put", KV_KEY,
             f"--path={path}", "--namespace-id", KV_NAMESPACE_ID, "--remote"],
            cwd=hl.WORKER_DIR, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr)
            raise SystemExit("wrangler kv key put failed")
    finally:
        os.unlink(path)
    print(f"Published parlay stats to KV ({len(payload)} bytes, {len(weeks)} weeks, "
          f"{len(output['live'])} live pick(s))")


if __name__ == "__main__":
    main()
