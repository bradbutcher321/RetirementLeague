"""
Simple desktop tool for the two people who enter parlay picks, on top of
"Auto Parlay Tracker" -- no new backend, this just reads/writes the same
sheet via the API instead of clicking through cells by hand.

Two tabs:
  - Browse / Grade Past Weeks: pick a year + week, see and edit all 12
    picks (including grading Result), save changes back.
  - Enter New Week: pick a year + week, loads whatever's already there for
    it (so re-opening a partially-entered week shows what's already saved
    instead of starting blank), paste the shared note's raw text and hit
    Parse to fill in the grid, review/fix anything, then Save.

Requires google_secret.json in this directory (same as the other scripts)
with write access to the sheet.

Usage: python parlay_gui.py
"""
import os
import re
import sys
import tkinter as tk
from datetime import datetime
from tkinter import ttk, messagebox, scrolledtext

import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_franchise_data import SHEET_ID, CREDS_PATH
from parlay_note_parser import (
    parse_note_text, parse_signed_number, parse_money,
    TEAM_LINE_VS, VS_ONLY, TOTAL_VS, PLAYER_OU, PLAYER_ONLY,
)
from espn_gametime_lookup import (
    find_gametime, find_player_team, find_gametime_for_team, thursday_to_monday_window,
)

TARGET_TAB = "Auto Parlay Tracker"
PLAYERS_PER_WEEK = 12

SPORTS = ["NFL", "NCAAF", "NBA", "NCAAM", "NHL", "MLB", "Futbol", "UFC", "Boxing", "Womens Tennis"]
BET_TYPES = ["Money Line", "Spread", "Alt Spread", "1st Half Spread", "Anytime TD",
             "Total Points", "Total Goals", "Total Rounds", "Receiving Yards",
             "Passing TD", "Passing Yards", "Receptions", "Total Yards",
             "Home Runs", "Player Points", "Interceptions", "Coin Toss"]
SIDES = ["", "Over", "Under"]
RESULTS = ["", "Pending", "Win", "Loss"]

# Row field order, matching migrate_parlay_tracker.py's HEADER for columns E..N
ROW_FIELDS = ["sport", "bet_type", "team", "opponent", "player_prop", "line", "side", "odds", "gametime", "result"]
COL_LETTERS = {  # field -> its column in Auto Parlay Tracker
    "sacko": "C", "sport": "E", "bet_type": "F", "team": "G", "opponent": "H",
    "player_prop": "I", "line": "J", "side": "K", "odds": "L", "gametime": "M",
    "result": "N", "final_odds": "P", "final_payout": "Q", "final_split": "R",
}

# Which of the free-text fields actually apply to a given Bet Type -- same
# breakdown as format_parlay_sheet.py's HEADER_NOTES, reused here to grey
# out (disable) the ones that don't, e.g. Player Prop/Side for a Spread
# pick. A bet type not in this map (blank, or something new) leaves
# everything enabled rather than guessing.
GREYABLE_FIELDS = ["team", "opponent", "player_prop", "line", "side"]
FIELD_RELEVANCE = {}
for _bt in TEAM_LINE_VS:
    FIELD_RELEVANCE[_bt] = {"team", "opponent", "line"}
for _bt in VS_ONLY:
    FIELD_RELEVANCE[_bt] = {"team", "opponent"}
for _bt in TOTAL_VS:
    FIELD_RELEVANCE[_bt] = {"team", "opponent", "side", "line"}
for _bt in PLAYER_OU:
    FIELD_RELEVANCE[_bt] = {"player_prop", "side", "line"}
for _bt in PLAYER_ONLY:
    FIELD_RELEVANCE[_bt] = {"player_prop"}

GAMETIME_ISO_FMT = "%Y-%m-%dT%H:%M:%S"
GAMETIME_DISPLAY_FMT = "%a %m/%d/%Y %I:%M %p"


def _gametime_to_display(iso_text):
    """'2026-09-26T15:30:00' -> 'Sat 09/26/2026 03:30 PM' for on-screen
    editing -- typing a human time by hand is much less error-prone than
    the sheet's strict ISO format. Text that isn't valid ISO (blank, or
    something a person already typed) is shown as-is rather than hidden,
    since it still needs to round-trip back out unchanged."""
    iso_text = (iso_text or "").strip()
    if not iso_text:
        return ""
    try:
        dt = datetime.strptime(iso_text, GAMETIME_ISO_FMT)
    except ValueError:
        return iso_text
    return dt.strftime(GAMETIME_DISPLAY_FMT)


def _gametime_to_iso(display_text):
    """Inverse of _gametime_to_display -- converts back to the sheet's
    exact ISO format right before writing. Also accepts ISO typed directly
    (a power user, or text that round-tripped through unchanged), and
    tolerates the leading weekday abbreviation being edited out or left
    off, since it's only there for readability."""
    display_text = (display_text or "").strip()
    if not display_text:
        return ""
    stripped = re.sub(r"^[A-Za-z]{3},?\s+", "", display_text)
    for fmt in ("%m/%d/%Y %I:%M %p", GAMETIME_ISO_FMT):
        try:
            dt = datetime.strptime(stripped, fmt)
            return dt.strftime(GAMETIME_ISO_FMT)
        except ValueError:
            continue
    return display_text  # unrecognized -- pass through; sheet validation will flag it


def authorize_write():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


class SheetClient:
    def __init__(self):
        gc = authorize_write()
        self.spreadsheet = gc.open_by_key(SHEET_ID)
        self.ws = self.spreadsheet.worksheet(TARGET_TAB)
        self.players = [v[0] for v in self.ws.get_values("U2:U13") if v]

    def find_week(self, year, week):
        """1-indexed sheet row of the week's first row + its 12 rows of
        columns A:R, or (None, None) if that week has no rows yet."""
        all_rows = self.ws.get_values("A2:R3000")
        for i, r in enumerate(all_rows):
            if len(r) > 1 and r[0] == str(year) and r[1] == str(week):
                block = all_rows[i:i + PLAYERS_PER_WEEK]
                block = [row + [""] * (18 - len(row)) for row in block]  # pad to full width
                return 2 + i, block
        return None, None

    def next_new_week_row(self):
        """1-indexed sheet row right after the last week that has any data."""
        all_rows = self.ws.get_values("A2:A3000")
        last = 0
        for i, r in enumerate(all_rows):
            if r and r[0]:
                last = i + 1
        return 2 + last

    def save_week(self, start_row, year, week, sacko, final_odds, final_payout, player_rows):
        """player_rows: {player: {sport, bet_type, team, opponent,
        player_prop, line, side, odds, gametime, result}} for up to 12
        players, in self.players order. Writes Year/Week to all 12 rows,
        Sacko/Final Odds/Final Payout to just the first, and each
        player's fields to their own row.

        Deliberately does NOT pass value_input_option="USER_ENTERED" --
        that lets Sheets auto-detect and convert ISO-looking strings into
        its own native date type (confirmed directly: Gametime came back
        with a space instead of "T", silently breaking both the strict
        format validation and every downstream string-sort that relies on
        the literal text). gspread's real default (effectively RAW) is
        what migrate_parlay_tracker.py already relies on for the exact
        same reason -- it stores strings exactly as given. Genuinely
        numeric fields (Year/Week/Odds/Final Odds/Final Payout) still come
        through as real numbers because they're passed as actual Python
        int/float, not strings -- RAW only affects how strings are
        interpreted, not values that are already a JSON number."""
        # Every player's row is written by list position (start_row + i),
        # which is only correct if start_row lines up with the Player
        # column's own row-position formula -- confirmed directly: an
        # unaligned start_row silently wrote every player's picks to the
        # wrong row (e.g. Brad's pick landing on the row labeled "Jeff").
        # find_week()/next_new_week_row() are always aligned by
        # construction, so this should never trip in real use.
        assert (start_row - 2) % PLAYERS_PER_WEEK == 0, (
            f"start_row {start_row} isn't aligned to a 12-row week block -- "
            f"writing here would put picks on the wrong player's row."
        )
        self.ws.update([[year, week]] * PLAYERS_PER_WEEK, f"A{start_row}:B{start_row + PLAYERS_PER_WEEK - 1}")
        self.ws.update([[sacko or ""]], f"C{start_row}")
        self.ws.update([[final_odds if final_odds is not None else ""]], f"P{start_row}")
        self.ws.update([[final_payout if final_payout is not None else ""]], f"Q{start_row}")

        for i, player in enumerate(self.players):
            row_num = start_row + i
            data = player_rows.get(player, {})
            row_values = []
            for f in ROW_FIELDS:
                v = data.get(f, "")
                if f == "odds" and v != "":
                    v = parse_signed_number(v)
                    v = v if v is not None else ""
                elif f == "gametime" and v != "":
                    # Converted here too (not just in WeekGrid.player_rows)
                    # so save_week is correct regardless of what shape of
                    # dict a caller hands it -- confirmed directly this
                    # matters: a human-readable display string written
                    # as-is would fail the sheet's strict ISO validation.
                    v = _gametime_to_iso(v)
                row_values.append(v)
            self.ws.update([row_values], f"E{row_num}:N{row_num}")


class WeekGrid(ttk.Frame):
    """12 rows (one per player) of editable fields, plus the week-level
    Sacko/Final Odds/Final Payout/Final Split fields above them. Shared by
    both tabs."""

    def __init__(self, parent, players):
        super().__init__(parent)
        self.players = players
        self.row_vars = {p: {f: tk.StringVar() for f in ROW_FIELDS} for p in players}
        self.row_widgets = {}
        self.sacko_var = tk.StringVar()
        self.final_odds_var = tk.StringVar()
        self.final_payout_var = tk.StringVar()
        self.final_split_var = tk.StringVar()
        self._build()

    def _build(self):
        top = ttk.Frame(self)
        top.pack(fill="x", pady=(0, 8))
        ttk.Label(top, text="Sacko:").grid(row=0, column=0, padx=4)
        ttk.Combobox(top, textvariable=self.sacko_var, values=[""] + self.players, width=10).grid(row=0, column=1)
        ttk.Label(top, text="Final Odds:").grid(row=0, column=2, padx=(16, 4))
        ttk.Entry(top, textvariable=self.final_odds_var, width=12).grid(row=0, column=3)
        ttk.Label(top, text="Final Payout ($):").grid(row=0, column=4, padx=(16, 4))
        ttk.Entry(top, textvariable=self.final_payout_var, width=12).grid(row=0, column=5)
        ttk.Label(top, text="Split (auto):").grid(row=0, column=6, padx=(16, 4))
        ttk.Label(top, textvariable=self.final_split_var, width=12).grid(row=0, column=7)
        self.final_payout_var.trace_add("write", self._recompute_split)

        headers = ["Player", "Sport", "Bet Type", "Team", "Opponent", "Player Prop",
                   "Line", "Side", "Odds", "Gametime", "Result"]
        grid = ttk.Frame(self)
        grid.pack(fill="both", expand=True)
        for c, h in enumerate(headers):
            ttk.Label(grid, text=h, font=("", 9, "bold")).grid(row=0, column=c, padx=2, pady=2)

        for r, player in enumerate(self.players, start=1):
            ttk.Label(grid, text=player, width=9).grid(row=r, column=0, padx=2, pady=1, sticky="w")
            v = self.row_vars[player]
            w = {}
            w["sport"] = ttk.Combobox(grid, textvariable=v["sport"], values=SPORTS, width=9)
            w["bet_type"] = ttk.Combobox(grid, textvariable=v["bet_type"], values=BET_TYPES, width=13)
            w["team"] = ttk.Entry(grid, textvariable=v["team"], width=13)
            w["opponent"] = ttk.Entry(grid, textvariable=v["opponent"], width=13)
            w["player_prop"] = ttk.Entry(grid, textvariable=v["player_prop"], width=14)
            w["line"] = ttk.Entry(grid, textvariable=v["line"], width=6)
            w["side"] = ttk.Combobox(grid, textvariable=v["side"], values=SIDES, width=6)
            w["odds"] = ttk.Entry(grid, textvariable=v["odds"], width=7)
            w["gametime"] = ttk.Entry(grid, textvariable=v["gametime"], width=22)
            w["result"] = ttk.Combobox(grid, textvariable=v["result"], values=RESULTS, width=8)
            for c, field in enumerate(ROW_FIELDS, start=1):
                w[field].grid(row=r, column=c, padx=2)
            self.row_widgets[player] = w
            v["bet_type"].trace_add("write", lambda *_a, p=player: self._update_relevance(p))
            self._update_relevance(player)

    def _update_relevance(self, player):
        """Greys out (disables) whichever free-text fields don't apply to
        this row's current Bet Type -- e.g. Player Prop/Side for a Spread
        pick. A blank or unrecognized Bet Type leaves everything enabled
        rather than guessing."""
        relevant = FIELD_RELEVANCE.get(self.row_vars[player]["bet_type"].get())
        for f in GREYABLE_FIELDS:
            widget = self.row_widgets[player][f]
            if relevant is not None and f not in relevant:
                widget.state(["disabled"])
            else:
                widget.state(["!disabled"])

    def clear_highlights(self):
        for widgets in self.row_widgets.values():
            for field, widget in widgets.items():
                base = "TCombobox" if isinstance(widget, ttk.Combobox) else "TEntry"
                widget.configure(style=base)

    def highlight_needs_attention(self, needs_by_player):
        """needs_by_player: {player: {field, ...}} -- marks each listed
        field red. Always starts from a clean slate so highlights from a
        previous Parse don't linger on fields that are now fine."""
        self.clear_highlights()
        for player, fields in needs_by_player.items():
            widgets = self.row_widgets.get(player, {})
            for f in fields:
                widget = widgets.get(f)
                if widget is None:
                    continue
                style = "Needs.TCombobox" if isinstance(widget, ttk.Combobox) else "Needs.TEntry"
                widget.configure(style=style)

    def _recompute_split(self, *_):
        payout = parse_money(self.final_payout_var.get()) if self.final_payout_var.get() else None
        self.final_split_var.set(f"{payout / PLAYERS_PER_WEEK:,.2f}" if payout is not None else "")

    def load(self, block_rows):
        """block_rows: 12 rows of columns A:R from the sheet, or None to clear."""
        self.sacko_var.set("")
        self.final_odds_var.set("")
        self.final_payout_var.set("")
        for p in self.players:
            for f in ROW_FIELDS:
                self.row_vars[p][f].set("")
        if not block_rows:
            return
        first = block_rows[0]
        self.sacko_var.set(first[2])
        self.final_odds_var.set(first[15])
        self.final_payout_var.set(first[16])
        for row in block_rows:
            player = row[3]
            if player not in self.row_vars:
                continue
            v = self.row_vars[player]
            sheet_cols = ["", "", "", "", "sport", "bet_type", "team", "opponent",
                          "player_prop", "line", "side", "odds", "gametime", "result"]
            for i, field in enumerate(sheet_cols):
                if field:
                    value = row[i] if i < len(row) else ""
                    if field == "gametime":
                        value = _gametime_to_display(value)
                    v[field].set(value)

    def apply_parsed(self, picks):
        """Fills in only the fields a parse actually produced, leaving
        anything already in the grid (from a Load) untouched for players
        the note didn't mention. Result only gets set if it's still blank
        -- re-parsing a note over an already-graded row shouldn't wipe out
        a real Win/Loss back to Pending."""
        for player, data in picks.items():
            if player not in self.row_vars:
                continue
            v = self.row_vars[player]
            # Sport isn't in the note, so it's deliberately left untouched here.
            v["bet_type"].set(data.get("bet_type", ""))
            v["team"].set(data.get("team", ""))
            v["opponent"].set(data.get("opponent", ""))
            v["player_prop"].set(data.get("player_prop", ""))
            v["line"].set(str(data.get("line", "")) if data.get("line") else "")
            v["side"].set(data.get("side", "") or "")
            if data.get("odds") is not None:
                v["odds"].set(_fmt_odds(data["odds"]))
            if not v["result"].get() and data.get("result"):
                v["result"].set(data["result"])

    def player_rows(self):
        rows = {}
        for p in self.players:
            row = {f: self.row_vars[p][f].get().strip() for f in ROW_FIELDS}
            row["gametime"] = _gametime_to_iso(row["gametime"])
            rows[p] = row
        return rows


def _fmt_odds(n):
    n = int(n) if float(n).is_integer() else n
    return f"+{n}" if n > 0 else str(n)


class BrowseTab(ttk.Frame):
    def __init__(self, parent, client):
        super().__init__(parent)
        self.client = client
        top = ttk.Frame(self)
        top.pack(fill="x", pady=6)
        ttk.Label(top, text="Year:").pack(side="left")
        self.year_var = tk.StringVar(value="2026")
        ttk.Entry(top, textvariable=self.year_var, width=6).pack(side="left", padx=(2, 12))
        ttk.Label(top, text="Week:").pack(side="left")
        self.week_var = tk.StringVar(value="1")
        ttk.Entry(top, textvariable=self.week_var, width=4).pack(side="left", padx=(2, 12))
        ttk.Button(top, text="Load", command=self.load).pack(side="left")
        ttk.Button(top, text="Save Changes", command=self.save).pack(side="left", padx=8)
        self.status = ttk.Label(top, text="")
        self.status.pack(side="left", padx=12)

        self.grid_widget = WeekGrid(self, client.players)
        self.grid_widget.pack(fill="both", expand=True, padx=6)
        self.start_row = None

    def load(self):
        try:
            year, week = int(self.year_var.get()), int(self.week_var.get())
        except ValueError:
            messagebox.showerror("Invalid input", "Year and Week must be numbers.")
            return
        self.start_row, block = self.client.find_week(year, week)
        self.grid_widget.load(block)
        self.status.config(text="Loaded." if block else "That week has no rows yet.")

    def save(self):
        if not self.start_row:
            messagebox.showerror("Nothing loaded", "Load a week first.")
            return
        year, week = int(self.year_var.get()), int(self.week_var.get())
        g = self.grid_widget
        self.client.save_week(
            self.start_row, year, week, g.sacko_var.get(),
            parse_signed_number(g.final_odds_var.get()) if g.final_odds_var.get() else None,
            parse_money(g.final_payout_var.get()) if g.final_payout_var.get() else None,
            g.player_rows(),
        )
        self.status.config(text="Saved.")


class NewWeekTab(ttk.Frame):
    def __init__(self, parent, client):
        super().__init__(parent)
        self.client = client
        top = ttk.Frame(self)
        top.pack(fill="x", pady=6)
        ttk.Label(top, text="Year:").pack(side="left")
        self.year_var = tk.StringVar(value="2026")
        ttk.Entry(top, textvariable=self.year_var, width=6).pack(side="left", padx=(2, 12))
        ttk.Label(top, text="Week:").pack(side="left")
        self.week_var = tk.StringVar(value="")
        ttk.Entry(top, textvariable=self.week_var, width=4).pack(side="left", padx=(2, 12))
        ttk.Button(top, text="Load / Start This Week", command=self.load).pack(side="left")
        ttk.Button(top, text="Save", command=self.save).pack(side="left", padx=8)
        self.status = ttk.Label(top, text="")
        self.status.pack(side="left", padx=12)

        paste_frame = ttk.LabelFrame(self, text="Paste the shared note's raw text, then Parse")
        paste_frame.pack(fill="x", padx=6, pady=(0, 6))
        self.paste_box = scrolledtext.ScrolledText(
            paste_frame, height=6, background=FIELD_WHITE, foreground=FIELD_TEXT, insertbackground=FIELD_TEXT)
        self.paste_box.pack(fill="x", padx=4, pady=4)
        btn_row = ttk.Frame(paste_frame)
        btn_row.pack(fill="x", padx=4, pady=(0, 4))
        ttk.Button(btn_row, text="Parse", command=self.parse_note).pack(side="left")
        self.parse_status = ttk.Label(btn_row, text="")
        self.parse_status.pack(side="left", padx=8)

        self.grid_widget = WeekGrid(self, client.players)
        self.grid_widget.pack(fill="both", expand=True, padx=6)
        self.start_row = None

    def load(self):
        try:
            year = int(self.year_var.get())
        except ValueError:
            messagebox.showerror("Invalid input", "Year must be a number.")
            return
        week_text = self.week_var.get().strip()
        if week_text:
            week = int(week_text)
            start_row, block = self.client.find_week(year, week)
            if start_row:
                self.start_row = start_row
                self.grid_widget.load(block)
                self.status.config(text=f"Loaded existing data for week {week}.")
                return
        else:
            week = None
        self.start_row = self.client.next_new_week_row()
        self.grid_widget.load(None)
        if week is not None:
            self.status.config(text=f"No existing rows for week {week} -- starting fresh at row {self.start_row}.")
        else:
            self.status.config(text=f"Enter a week number above, then Load. Next free block starts at row {self.start_row}.")

    def parse_note(self):
        text = self.paste_box.get("1.0", "end")
        picks, final, unmatched = parse_note_text(text, self.client.players)
        self.grid_widget.apply_parsed(picks)
        if final.get("year"):
            self.year_var.set(final["year"])
        if final.get("week"):
            self.week_var.set(final["week"])
        if final.get("sacko"):
            self.grid_widget.sacko_var.set(final["sacko"])
        if final["odds"] is not None:
            self.grid_widget.final_odds_var.set(_fmt_odds(final["odds"]))
        if final["payout"] is not None:
            self.grid_widget.final_payout_var.set(f"{final['payout']:.2f}")
        not_ok = [p for p, d in picks.items() if not d.get("ok")]
        msg = f"Parsed {len(picks)} picks."
        if not_ok:
            msg += f" Needs a look: {', '.join(not_ok)}."
        if unmatched:
            msg += f" Unmatched lines: {len(unmatched)}."
        self.parse_status.config(text=msg)
        self.update_idletasks()

        self.parse_status.config(text=msg + " Looking up game times...")
        self.update_idletasks()
        window = thursday_to_monday_window()
        found, tried = 0, 0
        needs_by_player = {}
        for player, data in picks.items():
            relevant = FIELD_RELEVANCE.get(data.get("bet_type"), set())
            needs = set()
            if not data.get("ok"):
                needs |= {f for f in relevant if not data.get(f)}
                if data.get("odds") is None:
                    needs.add("odds")

            attempted = bool(data.get("team") and data.get("opponent")) or bool(data.get("player_prop"))
            gametime = matched_sport = None
            if attempted:
                tried += 1
                if data.get("team") and data.get("opponent"):
                    gametime, matched_sport, resolved_team, resolved_opp = find_gametime(
                        data["team"], data["opponent"], days=window)
                    if resolved_team:
                        self.grid_widget.row_vars[player]["team"].set(resolved_team)
                    if resolved_opp:
                        self.grid_widget.row_vars[player]["opponent"].set(resolved_opp)
                else:
                    team, sport = find_player_team(data["player_prop"], data.get("bet_type"))
                    if team:
                        matched_sport = sport
                        gametime = find_gametime_for_team(team, sport, days=window)
            if gametime:
                self.grid_widget.row_vars[player]["gametime"].set(_gametime_to_display(gametime))
                self.grid_widget.row_vars[player]["sport"].set(matched_sport)
                found += 1
            elif attempted:
                needs.add("gametime")
                needs.add("sport")

            if needs:
                needs_by_player[player] = needs
        self.grid_widget.highlight_needs_attention(needs_by_player)
        if tried:
            msg += f" Game times: found {found} of {tried} picks (rest need manual entry)."
        self.parse_status.config(text=msg)

    def save(self):
        if not self.start_row:
            messagebox.showerror("Nothing loaded", "Load / Start a week first.")
            return
        try:
            year, week = int(self.year_var.get()), int(self.week_var.get())
        except ValueError:
            messagebox.showerror("Invalid input", "Year and Week must be numbers.")
            return
        g = self.grid_widget
        self.client.save_week(
            self.start_row, year, week, g.sacko_var.get(),
            parse_signed_number(g.final_odds_var.get()) if g.final_odds_var.get() else None,
            parse_money(g.final_payout_var.get()) if g.final_payout_var.get() else None,
            g.player_rows(),
        )
        self.status.config(text=f"Saved to row {self.start_row}.")


# UCF Knights black-and-gold, with data entry kept white/legible per
# explicit request rather than themed to match.
BG_BLACK = "#111111"
GOLD = "#FFC904"
GOLD_DIM = "#9c7d10"
FIELD_WHITE = "#ffffff"
FIELD_TEXT = "#111111"
DISABLED_BG = "#8a8a8a"
DISABLED_FG = "#3a3a3a"
NEEDS_BG = "#ffb3b3"


def main():
    root = tk.Tk()
    root.title("Retirement League Parlay Entry")
    root.geometry("1300x560")
    root.configure(background=BG_BLACK)

    # "clam" is used specifically because it's the one bundled ttk theme
    # that reliably honors custom colors (fieldbackground, state-based
    # maps) on Entry/Combobox/Notebook -- confirmed the default Windows
    # theme ("vista") largely ignores these, which is why the red "needs
    # attention" highlighting was invisible and disabled fields looked
    # almost identical to enabled ones.
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass

    style.configure("TFrame", background=BG_BLACK)
    style.configure("TLabelframe", background=BG_BLACK, bordercolor=GOLD_DIM)
    style.configure("TLabelframe.Label", background=BG_BLACK, foreground=GOLD, font=("Segoe UI", 10, "bold"))
    style.configure("TLabel", background=BG_BLACK, foreground=GOLD)
    style.configure("TButton", background=GOLD, foreground=BG_BLACK, font=("Segoe UI", 9, "bold"), padding=6)
    style.map("TButton", background=[("active", GOLD_DIM)], foreground=[("active", GOLD)])
    style.configure("TNotebook", background=BG_BLACK, bordercolor=GOLD_DIM)
    style.configure("TNotebook.Tab", background=BG_BLACK, foreground=GOLD, padding=(16, 7), font=("Segoe UI", 10, "bold"))
    style.map("TNotebook.Tab", background=[("selected", GOLD)], foreground=[("selected", BG_BLACK)])

    # Data-entry fields stay white/black for legibility (explicit request),
    # just with a visibly distinct grey when disabled -- clam's own default
    # disabled shade turned out too close to white to notice at a glance.
    style.configure("TEntry", fieldbackground=FIELD_WHITE, foreground=FIELD_TEXT)
    style.configure("TCombobox", fieldbackground=FIELD_WHITE, foreground=FIELD_TEXT, arrowsize=14)
    style.map("TEntry", fieldbackground=[("disabled", DISABLED_BG)], foreground=[("disabled", DISABLED_FG)])
    style.map("TCombobox", fieldbackground=[("disabled", DISABLED_BG)], foreground=[("disabled", DISABLED_FG)],
              selectbackground=[("disabled", DISABLED_BG)], selectforeground=[("disabled", DISABLED_FG)])
    style.configure("Needs.TEntry", fieldbackground=NEEDS_BG, foreground=FIELD_TEXT)
    style.configure("Needs.TCombobox", fieldbackground=NEEDS_BG, foreground=FIELD_TEXT)

    status_label = ttk.Label(root, text="Connecting to Google Sheets...")
    status_label.pack(pady=20)
    root.update()
    try:
        client = SheetClient()
    except Exception as e:
        status_label.config(text=f"Failed to connect: {e}")
        return
    status_label.destroy()

    notebook = ttk.Notebook(root)
    notebook.pack(fill="both", expand=True)
    notebook.add(NewWeekTab(notebook, client), text="Enter New Week")
    notebook.add(BrowseTab(notebook, client), text="Browse / Grade Past Weeks")

    root.mainloop()


if __name__ == "__main__":
    main()
