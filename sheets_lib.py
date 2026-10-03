"""
Shared Google Sheets access for every script that reads the league's
spreadsheet: credentials, the sheet id, number parsing for the formatted text
gspread hands back, and the two tabs that have no ESPN equivalent and so can
only come from the sheet (Game Tracker's raw game log, Money Tracker's
buy-ins and payouts).

This was `generate_franchise_data.py`, the original sheet-only pipeline behind
the Franchise page. That pipeline is gone -- `generate_franchise_data_d1.py`
computes the same output from D1 now, and did so by reimplementing every one
of its compute_* functions, leaving ~490 lines here that nothing called. What
survived is only the part other scripts were importing all along, which is
what the file is named for.

Nothing here writes to the sheet. `authorize()` asks for read-only scopes; the
handful of scripts that do write (auto_grade_results.py, sync_scores_to_sheet.py,
parlay_gui.py and the one-off sheet-setup tools) build their own read/write
client and take only SHEET_ID/CREDS_PATH from here.
"""
import os

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = os.environ.get("GOOGLE_SHEET_ID", "1WghofPfu0Df9eEuePopV8Y0LJbPUYRdMOsPE-fZUtb4")
CREDS_PATH = os.environ.get("GOOGLE_CREDS_PATH", "google_secret.json")


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


# --------------------------------------------------------------------------
# Game Tracker: the raw game log since 2015. Kept here rather than read from
# D1 because its Reg/Play/Champ/3rd/5th/Sacko/Cons/Bye type tag is a league
# convention ESPN has no equivalent for -- see generate_league_data_d1.py.
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
