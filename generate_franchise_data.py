"""
Computes career/franchise stats for every manager who has ever played in the
league and writes them to docs/data/franchise.json for franchise.html to load.

Unlike the live Dashboard (update_page_and_sheets.py), this data doesn't need
to refresh every couple minutes — it's driven by Game Tracker, which is
updated manually once a week — so this is meant to run occasionally (a
schedule + a manual button in GitHub Actions), not continuously. The page
reads the committed JSON directly; there's no live Google Sheets dependency
at page-load time.

Three tabs feed this:
  - Game Tracker: the raw game-by-game log since 2015. Used directly for
    streaks, single-game extremes (highest/lowest score, win/loss margins),
    rivalries, and scoring consistency — anything that needs individual
    games rather than season totals.
  - PlayerStats: per-player-per-year rollups plus a "Lifetime" row per
    player. Used for career records, standings extremes, and the
    season-by-season timeline — anything already correctly aggregated there.
  - RandomInfo: team names, roster moves, and draft position, one row per
    player with one column per year.
  - Parlay Tracker: row 4 ("Sacko") names that week's parlay Sacko, used for
    a manager's "Weekly Sacko" count — unrelated to fantasy performance.
"""
import json
import os
import statistics
import sys
from datetime import datetime, timezone

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "1WghofPfu0Df9eEuePopV8Y0LJbPUYRdMOsPE-fZUtb4")
CREDS_PATH = os.environ.get("GOOGLE_CREDS_PATH", "google_secret.json")
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "franchise.json")

# The weekly "median" game was added starting this season; before it, there
# was nothing to compare a Median-only or Combined streak against.
MEDIAN_ERA_START_YEAR = 2025


def authorize():
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
    ]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def to_float(value):
    """Handles plain numbers as well as the formatted text gspread's default
    get_values() returns for percentage cells (e.g. "55.63%"), dollar
    amounts (e.g. "$60"), thousands-separator commas, and the "-" placeholder
    Money Tracker uses for "didn't play that year" — all of which would
    otherwise silently fail to parse and fall through to a wrong default."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("$", "")
    if text.endswith("%"):
        text = text[:-1]
    if text in ("", "-"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def to_int(value, default=None):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------
# Game Tracker: raw game log
# --------------------------------------------------------------------------

def load_games(spreadsheet):
    """Returns every real (played) game as a dict, in original sheet order.
    Excludes placeholder rows for not-yet-played/undetermined future games
    (blank players, Winner == "In Progress")."""
    ws = spreadsheet.worksheet("Game Tracker")
    rows = ws.get_values("A4:L")
    games = []
    for r in rows:
        r = r + [""] * (12 - len(r))
        year, week, gtype, p1, p2, s1, s2, winner, margin, total, gid, median = r
        if not gid or not p1:
            continue
        if winner == "In Progress":
            continue
        games.append({
            "year": to_int(year),
            "week": to_int(week),
            "type": gtype,
            "p1": p1,
            "p2": p2 or None,
            "s1": to_float(s1),
            "s2": to_float(s2),
            "winner": winner,
            "margin": to_float(margin),
            "gid": to_int(gid),
            "median": to_float(median),
        })
    return games


def player_perspectives(games):
    """Long-format: one entry per player per game they played in (so a
    normal game contributes two entries, a bye contributes one), each
    carrying that player's own score, their opponent's score (None on a
    bye), whether the game type is a Bye, and whether that game is part of
    the 'median era' regular season. Sorted chronologically to match the
    order the sheet's own streak formula processes games in."""
    perspectives = []
    for g in games:
        if g["s1"] is not None:
            perspectives.append({
                "player": g["p1"], "own": g["s1"], "opp": g["s2"], "opponent": g["p2"],
                "year": g["year"], "week": g["week"], "type": g["type"],
                "median": g["median"], "gid": g["gid"], "winner": g["winner"],
            })
        if g["p2"] and g["s2"] is not None:
            perspectives.append({
                "player": g["p2"], "own": g["s2"], "opp": g["s1"], "opponent": g["p1"],
                "year": g["year"], "week": g["week"], "type": g["type"],
                "median": g["median"], "gid": g["gid"], "winner": g["winner"],
            })
    perspectives.sort(key=lambda p: (p["year"], p["week"], p["gid"]))
    return perspectives


def longest_and_current_streak(outcomes):
    """outcomes: ordered list of True (win) / False (loss). Returns
    (longest_win_streak, longest_loss_streak, current_streak) where current
    streak is positive for an active win streak, negative for a loss streak,
    0 if there are no outcomes at all."""
    if not outcomes:
        return 0, 0, 0
    longest_win = longest_loss = 0
    run = 0
    prev = None
    for outcome in outcomes:
        if outcome == prev:
            run += 1
        else:
            run = 1
            prev = outcome
        if outcome:
            longest_win = max(longest_win, run)
        else:
            longest_loss = max(longest_loss, run)
    current = run if prev else -run
    return longest_win, longest_loss, current


def compute_streaks(perspectives_for_player):
    """Three trackers, matching the league's own definitions:
      - head_to_head: strictly W/L against the opponent, every non-Bye game,
        all years.
      - combined: the same opponent-only outcomes, but from the median era
        onward a regular-season week contributes a SECOND outcome (did they
        beat the median) immediately after the opponent outcome for that
        week — so beating both in the same week extends the streak by 2.
      - median: strictly W/L against the median, median-era regular season
        only, completely independent of the opponent result.
    """
    h2h_outcomes = []
    combined_outcomes = []
    median_outcomes = []

    for p in perspectives_for_player:
        if p["type"] == "Bye":
            continue
        if p["opp"] is None:
            continue
        beat_opponent = p["own"] > p["opp"]
        h2h_outcomes.append(beat_opponent)
        combined_outcomes.append(beat_opponent)

        is_median_era = p["type"] == "Reg" and p["year"] >= MEDIAN_ERA_START_YEAR
        if is_median_era and p["median"] is not None:
            beat_median = p["own"] > p["median"]
            combined_outcomes.append(beat_median)
            median_outcomes.append(beat_median)

    h2h_w, h2h_l, h2h_cur = longest_and_current_streak(h2h_outcomes)
    comb_w, comb_l, comb_cur = longest_and_current_streak(combined_outcomes)
    med_w, med_l, med_cur = longest_and_current_streak(median_outcomes)

    return {
        "head_to_head": {"longest_win": h2h_w, "longest_loss": h2h_l, "current": h2h_cur},
        "combined": {"longest_win": comb_w, "longest_loss": comb_l, "current": comb_cur},
        "median": {"longest_win": med_w, "longest_loss": med_l, "current": med_cur},
    }


def compute_extremes(perspectives_for_player):
    """Highest/lowest score and win/loss margins, scanning every game the
    player appeared in (any type, matching the sheet's own formulas — these
    aren't restricted to regular season). Lowest score and lowest win margin
    exclude zero, same as the sheet (a 0 usually just means a stray blank
    cell, not a real result)."""
    scores = [p["own"] for p in perspectives_for_player if p["own"] is not None]
    win_margins = []
    loss_margins = []
    for p in perspectives_for_player:
        if p["opp"] is None or p["own"] is None:
            continue
        margin = round(p["own"] - p["opp"], 2)
        if margin > 0:
            win_margins.append(margin)
        elif margin < 0:
            loss_margins.append(-margin)

    nonzero_scores = [s for s in scores if s > 0]
    return {
        "highest_score": max(scores) if scores else None,
        "lowest_score": min(nonzero_scores) if nonzero_scores else None,
        "biggest_win_margin": max(win_margins) if win_margins else None,
        "lowest_win_margin": min(win_margins) if win_margins else None,
        "biggest_loss_margin": max(loss_margins) if loss_margins else None,
        "lowest_loss_margin": min(loss_margins) if loss_margins else None,
        "score_stdev": round(statistics.pstdev(scores), 2) if len(scores) > 1 else None,
    }


def compute_rivalries(perspectives_for_player, active_players):
    """Best/worst head-to-head records against each opponent ever faced
    (any game type, matching how the sheet's own H2H tab pulls from Game
    Tracker with no type filter). Requires at least 3 meetings so a single
    early blowout doesn't crown a "nemesis" off one game.

    If the top pick has left the league, it's a lot less fun — there's no
    one left to needle about it — so we also surface the best-qualifying
    opponent who's still active this season alongside it ("but also"),
    determined dynamically from who actually has a season row this year
    rather than a hardcoded list of retired names."""
    records = {}
    for p in perspectives_for_player:
        if not p["opponent"] or p["opp"] is None or p["own"] is None:
            continue
        rec = records.setdefault(p["opponent"], {"w": 0, "l": 0})
        if p["own"] > p["opp"]:
            rec["w"] += 1
        elif p["own"] < p["opp"]:
            rec["l"] += 1

    qualifying = {opp: r for opp, r in records.items() if r["w"] + r["l"] >= 3}
    if not qualifying:
        return {"nemesis": None, "favorite_opponent": None}

    def win_pct(rec):
        total = rec["w"] + rec["l"]
        return rec["w"] / total if total else 0

    def package(opp):
        rec = qualifying[opp]
        return {"opponent": opp, "wins": rec["w"], "losses": rec["l"], "win_pct": round(win_pct(rec) * 100, 1)}

    def build(pick_fn):
        top_opp = pick_fn(qualifying)
        result = package(top_opp)
        if top_opp not in active_players:
            active_qualifying = {o: r for o, r in qualifying.items() if o in active_players and o != top_opp}
            if active_qualifying:
                result["also"] = package(pick_fn(active_qualifying))
        return top_opp, result

    nemesis_opp, nemesis = build(lambda pool: min(pool, key=lambda o: win_pct(pool[o])))
    favorite_opp, favorite = build(lambda pool: max(pool, key=lambda o: win_pct(pool[o])))

    # If one qualifying opponent is both the best and worst (only one played
    # 3+ times), don't show the same record twice as if it were two facts.
    if nemesis_opp == favorite_opp:
        favorite = None
    return {"nemesis": nemesis, "favorite_opponent": favorite}


# --------------------------------------------------------------------------
# PlayerStats: per-player-per-year rollups + Lifetime row
# --------------------------------------------------------------------------

def load_player_stats(spreadsheet):
    ws = spreadsheet.worksheet("PlayerStats")
    values = ws.get_all_values()
    header = {name: idx for idx, name in enumerate(values[0]) if name}
    return header, values[1:]


def stat(header, row, name, cast=to_float, default=None):
    idx = header.get(name)
    if idx is None or idx >= len(row) or row[idx] == "":
        return default
    result = cast(row[idx])
    return result if result is not None else default


def player_year_rows(header, rows, player):
    name_col, year_col = header["Player"], header["Year"]
    return [r for r in rows if len(r) > name_col and r[name_col] == player and r[year_col] not in ("", "Lifetime")]


def player_lifetime_row(header, rows, player):
    name_col, year_col = header["Player"], header["Year"]
    for r in rows:
        if len(r) > name_col and r[year_col] == "Lifetime" and r[name_col] == player:
            return r
    return None


def compute_career_from_playerstats(header, lifetime):
    if lifetime is None:
        return None
    return {
        "record": {
            "reg_w": stat(header, lifetime, "Reg W", to_int, 0),
            "reg_l": stat(header, lifetime, "Reg L", to_int, 0),
            "reg_t": stat(header, lifetime, "Reg T", to_int, 0),
            "playoff_w": stat(header, lifetime, "Playoff W", to_int, 0),
            "playoff_l": stat(header, lifetime, "Playoff L", to_int, 0),
        },
        "win_rates": {
            "reg_pct": stat(header, lifetime, "Reg %", to_float, 0),
            "playoff_pct": stat(header, lifetime, "Playoff %", to_float, 0),
            "median_pct": stat(header, lifetime, "Median %", to_float, None),
        },
        "median": {
            "wins": stat(header, lifetime, "Median W", to_int, 0),
            "losses": stat(header, lifetime, "Median L", to_int, 0),
            "pct": stat(header, lifetime, "Median %", to_float, None),
        },
        "points": {
            "total_pf": stat(header, lifetime, "Total PF", to_float, 0),
            "total_pa": stat(header, lifetime, "Total PA", to_float, 0),
            "avg_pf": stat(header, lifetime, "Total Avg PF", to_float, 0),
            "avg_pa": stat(header, lifetime, "Total Avg PA", to_float, 0),
        },
        "standings": {
            # reg_season_champs/best_regular_finish/worst_regular_finish are
            # filled in by the caller from compute_standings_extremes(),
            # which needs every year row, not just the Lifetime row.
            "playoff_appearances": stat(header, lifetime, "Playoff Appearances", to_int, 0),
            "champ_appearances": stat(header, lifetime, "Champ Appearances", to_int, 0),
            "championships": stat(header, lifetime, "Champ Wins", to_int, 0),
            "sackos": stat(header, lifetime, "Sacko Counts", to_int, 0),
            "byes": stat(header, lifetime, "Bye Counts", to_int, 0),
        },
    }


def compute_median_era_reg_pct(header, year_rows_for_player):
    """Regular-season win% restricted to years >= MEDIAN_ERA_START_YEAR —
    the same window Median % is scoped to, since median games only exist
    from that year on. Used for the luck index so it compares like-for-like
    (recent-season win% vs. recent-season median win%) instead of a
    lifetime win% against a median% that can only ever reflect a season or
    two, which would wildly overstate "luck" for anyone whose recent form
    differs from their career average."""
    w = l = 0
    for r in year_rows_for_player:
        year = to_int(r[header["Year"]])
        if year is None or year < MEDIAN_ERA_START_YEAR:
            continue
        w += stat(header, r, "Reg W", to_int, 0)
        l += stat(header, r, "Reg L", to_int, 0)
    total = w + l
    return round(w / total * 100, 1) if total else None


def compute_standings_extremes(header, year_rows_for_player):
    """Reg Szn Champs / Best / Worst regular-season finish — computed across
    every year row for the player (mirrors the Franchise sheet's own
    COUNTIFS/MINIFS/MAXIFS against the Regular Season Standings column)."""
    placements = [stat(header, r, "Regular Season Standings", to_int) for r in year_rows_for_player]
    placements = [p for p in placements if p is not None]
    champs = sum(1 for p in placements if p == 1)
    return {
        "reg_season_champs": champs,
        "best_regular_finish": min(placements) if placements else None,
        "worst_regular_finish": max(placements) if placements else None,
    }


def compute_season_history(header, year_rows_for_player):
    history = []
    for r in sorted(year_rows_for_player, key=lambda r: to_int(r[header["Year"]]) or 0):
        year = to_int(r[header["Year"]])
        reg_w = stat(header, r, "Reg W", to_int, 0)
        reg_l = stat(header, r, "Reg L", to_int, 0)
        playoff_w = stat(header, r, "Playoff W", to_int, 0)
        playoff_l = stat(header, r, "Playoff L", to_int, 0)
        final_standing = stat(header, r, "Final Standings", to_int)
        made_playoffs = (playoff_w + playoff_l) > 0
        history.append({
            "year": year,
            "team_name": stat(header, r, "Team Names", str, "") or None,
            "reg_record": f"{reg_w}-{reg_l}",
            "reg_standing": stat(header, r, "Regular Season Standings", to_int),
            "made_playoffs": made_playoffs,
            "playoff_record": f"{playoff_w}-{playoff_l}" if made_playoffs else None,
            "final_standing": final_standing,
            "champion": final_standing == 1,
            "points_for": stat(header, r, "Total PF", to_float),
        })
    return history


# --------------------------------------------------------------------------
# RandomInfo: team names / moves / draft order, one row per player
# --------------------------------------------------------------------------

def load_random_info_block(spreadsheet, label):
    """RandomInfo has three stacked blocks (Moves, Draft Order, Team Names),
    each starting with a row whose first cell is the block's label followed
    by a year in every subsequent column, then one row per player."""
    ws = spreadsheet.worksheet("RandomInfo")
    values = ws.get_all_values()
    header_row_idx = next(i for i, r in enumerate(values) if r and r[0] == label)
    years = values[header_row_idx][1:]
    block = {}
    for r in values[header_row_idx + 1:]:
        if not r or not r[0]:
            break
        player = r[0]
        block[player] = dict(zip(years, r[1:]))
    return block


def compute_identity(team_names_block, player):
    by_year = team_names_block.get(player, {})
    ordered_years = sorted((y for y, name in by_year.items() if name and name != "-"), key=lambda y: int(y))
    if not ordered_years:
        return {"current_team_name": None, "previous_team_names": []}
    names_in_order = [by_year[y] for y in ordered_years]
    current = names_in_order[-1]
    seen = []
    for name in names_in_order[:-1]:
        if name != current and name not in seen:
            seen.append(name)
    return {"current_team_name": current, "previous_team_names": seen}


def compute_moves(moves_block, player):
    by_year = moves_block.get(player, {})
    values = [to_int(v) for v in by_year.values() if v not in ("", "-", None)]
    values = [v for v in values if v is not None]
    if not values:
        return {"total": 0, "avg_per_season": 0, "busiest_season": None}
    busiest_year = max((y for y, v in by_year.items() if to_int(v) == max(values)), default=None)
    return {
        "total": sum(values),
        "avg_per_season": round(sum(values) / len(values), 1),
        "busiest_season": {"year": int(busiest_year), "moves": max(values)} if busiest_year else None,
    }


def compute_draft(draft_block, player):
    by_year = draft_block.get(player, {})
    values = [to_int(v) for v in by_year.values() if v not in ("", "-", None)]
    values = [v for v in values if v is not None]
    if not values:
        return {"avg_position": None, "best_position": None, "worst_position": None}
    return {
        "avg_position": round(sum(values) / len(values), 1),
        "best_position": min(values),
        "worst_position": max(values),
    }


# --------------------------------------------------------------------------
# Parlay Tracker: weekly Sacko row
# --------------------------------------------------------------------------

def load_weekly_sacko_counts(spreadsheet):
    ws = spreadsheet.worksheet("Parlay Tracker")
    sacko_row = ws.get_values("A4:4")[0]
    names = [c for c in sacko_row if c and c != "Sacko"]
    counts = {}
    for name in names:
        counts[name] = counts.get(name, 0) + 1
    return counts


# --------------------------------------------------------------------------
# Money Tracker: three side-by-side blocks (Buy In, Earnings, Parlays) plus
# Total/Result summary rows under the Buy In block
# --------------------------------------------------------------------------

def load_money(spreadsheet):
    """Buy In and Earnings are each one column per player, one row per year,
    with a "Total" summary row. Parlays is a completely different shape — a
    plain two-column (Team, Amount) list, one row per player, not
    year-indexed. "Result" (net career profit/loss) is already computed on
    the sheet and lives in the Buy In block's columns even though it
    reflects all three blocks combined — verified it equals
    Earnings - Buy In - Parlays for every player checked, so it's read
    directly rather than recomputed here."""
    ws = spreadsheet.worksheet("Money Tracker")
    values = ws.get_values("A1:AB60")
    block_header = values[0]
    names_row = values[1]

    def find_col(label):
        for i, v in enumerate(block_header):
            if v == label:
                return i
        return None

    def find_label_row(label):
        for i, r in enumerate(values):
            if r and r[0] == label:
                return i
        return None

    buy_in_col = find_col("Buy In")
    earnings_col = find_col("Earnings")
    parlays_col = find_col("Parlays")
    total_row = find_label_row("Total")
    result_row = find_label_row("Result")

    money = {}

    if buy_in_col is not None and earnings_col is not None:
        for col in range(buy_in_col, earnings_col):
            player = names_row[col] if col < len(names_row) else None
            if not player:
                continue
            entry = money.setdefault(player, {})
            entry["total_dues"] = (to_float(values[total_row][col]) if total_row is not None else None) or 0
            entry["net_result"] = (to_float(values[result_row][col]) if result_row is not None else None) or 0

    if earnings_col is not None and parlays_col is not None:
        for col in range(earnings_col, parlays_col):
            player = names_row[col] if col < len(names_row) else None
            if not player:
                continue
            entry = money.setdefault(player, {})
            entry["total_earnings"] = (to_float(values[total_row][col]) if total_row is not None else None) or 0

    if parlays_col is not None:
        for row in values[2:]:
            if len(row) <= parlays_col + 1:
                continue
            player, amount = row[parlays_col], row[parlays_col + 1]
            if not player:
                continue
            entry = money.setdefault(player, {})
            entry["parlays_purchased"] = to_float(amount) or 0

    return money


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    print("Connecting to Google Sheets API...")
    client = authorize()
    spreadsheet = client.open_by_key(SHEET_ID)

    print("Loading Game Tracker...")
    games = load_games(spreadsheet)

    print("Loading PlayerStats...")
    ps_header, ps_rows = load_player_stats(spreadsheet)

    print("Loading RandomInfo...")
    moves_block = load_random_info_block(spreadsheet, "Moves")
    draft_block = load_random_info_block(spreadsheet, "Draft Order")
    team_names_block = load_random_info_block(spreadsheet, "Team Names")

    print("Loading Parlay Tracker...")
    weekly_sacko_counts = load_weekly_sacko_counts(spreadsheet)

    print("Loading Money Tracker...")
    money_block = load_money(spreadsheet)

    all_perspectives = player_perspectives(games)
    perspectives_by_player = {}
    for p in all_perspectives:
        perspectives_by_player.setdefault(p["player"], []).append(p)

    all_players = sorted(set(perspectives_by_player) | set(team_names_block))

    # Whoever has a row for the most recent year anywhere in PlayerStats is
    # still active this season — used to keep Rivalries relevant instead of
    # crowning someone who left the league years ago, without hardcoding
    # names.
    year_col, name_col = ps_header["Year"], ps_header["Player"]
    all_years = [to_int(r[year_col]) for r in ps_rows if r[year_col] not in ("", "Lifetime")]
    current_year = max((y for y in all_years if y is not None), default=None)
    active_players = {r[name_col] for r in ps_rows if to_int(r[year_col]) == current_year}

    players_out = []
    for player in all_players:
        perspectives = perspectives_by_player.get(player, [])
        year_rows = player_year_rows(ps_header, ps_rows, player)
        lifetime = player_lifetime_row(ps_header, ps_rows, player)
        if not year_rows and not perspectives:
            continue  # name appears somewhere but never actually played

        years_played = sorted(to_int(r[ps_header["Year"]]) for r in year_rows)
        career = compute_career_from_playerstats(ps_header, lifetime) or {}
        standings_extra = compute_standings_extremes(ps_header, year_rows)
        if "standings" in career:
            career["standings"]["reg_season_champs"] = standings_extra["reg_season_champs"]
            career["standings"]["best_regular_finish"] = standings_extra["best_regular_finish"]
            career["standings"]["worst_regular_finish"] = standings_extra["worst_regular_finish"]

        median_era_reg_pct = compute_median_era_reg_pct(ps_header, year_rows)
        median_pct = career.get("win_rates", {}).get("median_pct")
        median_luck = None
        if median_era_reg_pct is not None and median_pct is not None:
            median_luck = round(median_pct - median_era_reg_pct, 1)

        players_out.append({
            "name": player,
            **compute_identity(team_names_block, player),
            "founded_year": years_played[0] if years_played else None,
            "seasons": len(years_played),
            "career": career,
            "extremes": compute_extremes(perspectives),
            "streaks": compute_streaks(perspectives),
            "rivalries": compute_rivalries(perspectives, active_players),
            "moves": compute_moves(moves_block, player),
            "draft": compute_draft(draft_block, player),
            "weekly_sackos": weekly_sacko_counts.get(player, 0),
            "median_luck": median_luck,
            "money": money_block.get(player),
            "season_history": compute_season_history(ps_header, year_rows),
        })

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "median_era_start_year": MEDIAN_ERA_START_YEAR,
        "players": players_out,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(players_out)} franchises to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
