"""
Simple desktop tool for the two people who enter parlay picks, on top of
"Auto Parlay Tracker" -- no new backend, this just reads/writes the same
sheet via the API instead of clicking through cells by hand.

Two tabs:
  - Enter New Week: pick a year + week, loads whatever's already there for
    it (so re-opening a partially-entered week shows what's already saved
    instead of starting blank), paste the shared note's raw text and hit
    Parse to fill in the grid, review/fix anything, then Save.
  - Browse / Grade Past Weeks: pick a year + week, see and edit all 12
    picks (including grading Result), save changes back.

Built on CustomTkinter (a themeable skin over tkinter/ttk, not a separate
toolkit) rather than plain ttk -- ttk's per-widget styling turned out too
limited for the look this needed (state-based colors only apply through
its style-map system, which is finicky, and there's no real way to get
rounded corners or a proper dark theme that isn't fighting the OS theme).
CustomTkinter widgets take color parameters directly per instance instead.

Requires google_secret.json in this directory (same as the other scripts)
with write access to the sheet, and `pip install customtkinter`.

Usage: python parlay_gui.py
"""
import os
import re
import sys
import threading
import tkinter as tk
from datetime import datetime
from tkinter import messagebox

import customtkinter as ctk
import gspread
from google.oauth2.service_account import Credentials

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheets_lib import SHEET_ID, CREDS_PATH
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

# Visible grid columns (E..N) -- what the user actually edits. Raw Pick
# (O) tags along as a data field with no visible widget: it's the original
# note text a pick was parsed from, useful as an audit trail, but not
# something meant to be hand-typed. ROW_FIELDS is the full save/load field
# order matching migrate_parlay_tracker.py's HEADER for columns E..O.
VISIBLE_ROW_FIELDS = ["sport", "bet_type", "team", "opponent", "player_prop", "line", "side", "odds", "gametime", "result"]
ROW_FIELDS = VISIBLE_ROW_FIELDS + ["raw_pick"]
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

# Muted gold on charcoal. Gold is spent only on a few accent spots --
# buttons, the active tab, section titles, and column headers -- while
# everyday text (field labels, player names, status messages) is a soft
# off-white, after feedback that full-saturation gold on pure black
# everywhere read as loud/gaudy on a dense data grid. Data-entry fields
# stay white/black for legibility, per explicit request. Defined at module
# level (not just inside main()) since widgets now take these colors
# directly at construction time rather than looking them up by ttk style
# name at render time.
BG_DARK = "#1b1b1d"
BG_PANEL = "#242426"
TEXT_LIGHT = "#e8e6e1"
GOLD = "#D4AF37"
GOLD_ACTIVE = "#b8952e"
FIELD_WHITE = "#ffffff"
FIELD_TEXT = "#1b1b1d"
DISABLED_BG = "#d8d8d8"
DISABLED_FG = "#8a8a8a"
NEEDS_BG = "#ffb3b3"


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
            self.ws.update([row_values], f"E{row_num}:O{row_num}")


def _add_clipboard_support(widget):
    """Right-click menu and Ctrl+C/X/V/A for a CTkEntry, implemented by
    reading/writing the system clipboard directly rather than relying on
    Tk's native <<Copy>>/<<Paste>> virtual events -- confirmed directly
    those don't actually reach the clipboard for a CTkEntry in this
    environment (a real text selection existed, <<Copy>> fired, the
    clipboard was never updated), and CTkEntry gives no working right-click
    menu at all out of the box. No-ops (via "break", suppressing Tk's own
    broken handling of the same keystroke) if there's nothing to do."""
    def copy(_e=None):
        text = widget.selection_get() if widget.select_present() else widget.get()
        if text:
            widget.clipboard_clear()
            widget.clipboard_append(text)
        return "break"

    def cut(_e=None):
        if widget.select_present():
            copy()
            widget.delete("sel.first", "sel.last")
        return "break"

    def paste(_e=None):
        try:
            text = widget.clipboard_get()
        except tk.TclError:
            return "break"
        if widget.select_present():
            widget.delete("sel.first", "sel.last")
        widget.insert("insert", text)
        return "break"

    def select_all(_e=None):
        widget.select_range(0, "end")
        widget.icursor("end")
        return "break"

    def show_menu(e):
        menu = tk.Menu(widget, tearoff=0)
        menu.add_command(label="Cut", command=cut)
        menu.add_command(label="Copy", command=copy)
        menu.add_command(label="Paste", command=paste)
        menu.add_separator()
        menu.add_command(label="Select All", command=select_all)
        try:
            menu.tk_popup(e.x_root, e.y_root)
        finally:
            menu.grab_release()

    widget.bind("<Control-c>", copy)
    widget.bind("<Control-x>", cut)
    widget.bind("<Control-v>", paste)
    widget.bind("<Control-a>", select_all)
    widget.bind("<Button-3>", show_menu)
    # CTkEntry.bind() (above) only reaches its real, focusable inner Entry
    # (widget._entry) -- but that inner widget is inset from the field's
    # visible edges by padding sized off the corner radius (see CTkEntry's
    # own _create_grid), with CTkEntry's decorative background canvas
    # showing through that border strip. A right-click landing on that
    # border -- easy to do, it runs around every edge of every field --
    # hits the canvas, which had no binding at all, so the menu silently
    # never appeared. Binding the same handler there too covers the whole
    # visible field, not just its text area.
    if hasattr(widget, "_canvas"):
        widget._canvas.bind("<Button-3>", show_menu)
    return widget


def _add_textbox_clipboard_support(widget):
    """Same right-click/Ctrl+C/X/V/A fix as _add_clipboard_support, for a
    CTkTextbox instead of a CTkEntry -- it wraps a real tkinter.Text, not
    an Entry, so selection/cut/paste go through Text's own API (a "sel" tag
    range, not select_present()/selection_get()) even though the
    underlying bug (no working right-click menu, decorative canvas
    covering the border the same way CTkEntry's does) is identical."""
    def has_selection():
        return bool(widget.tag_ranges("sel"))

    def copy(_e=None):
        text = widget.get("sel.first", "sel.last") if has_selection() else widget.get("1.0", "end-1c")
        if text:
            widget.clipboard_clear()
            widget.clipboard_append(text)
        return "break"

    def cut(_e=None):
        if has_selection():
            copy()
            widget.delete("sel.first", "sel.last")
        return "break"

    def paste(_e=None):
        try:
            text = widget.clipboard_get()
        except tk.TclError:
            return "break"
        if has_selection():
            widget.delete("sel.first", "sel.last")
        widget.insert("insert", text)
        return "break"

    def select_all(_e=None):
        widget.tag_add("sel", "1.0", "end-1c")
        widget.mark_set("insert", "end-1c")
        return "break"

    def show_menu(e):
        menu = tk.Menu(widget, tearoff=0)
        menu.add_command(label="Cut", command=cut)
        menu.add_command(label="Copy", command=copy)
        menu.add_command(label="Paste", command=paste)
        menu.add_separator()
        menu.add_command(label="Select All", command=select_all)
        try:
            menu.tk_popup(e.x_root, e.y_root)
        finally:
            menu.grab_release()

    widget.bind("<Control-c>", copy)
    widget.bind("<Control-x>", cut)
    widget.bind("<Control-v>", paste)
    widget.bind("<Control-a>", select_all)
    widget.bind("<Button-3>", show_menu)
    if hasattr(widget, "_canvas"):
        widget._canvas.bind("<Button-3>", show_menu)
    return widget


def _entry(parent, var, width=120):
    return _add_clipboard_support(ctk.CTkEntry(parent, textvariable=var, width=width, height=26,
                                                fg_color=FIELD_WHITE, text_color=FIELD_TEXT, border_width=1))


def _combo(parent, var, values, width=110):
    return ctk.CTkComboBox(parent, variable=var, values=values, width=width, height=26,
                            fg_color=FIELD_WHITE, text_color=FIELD_TEXT,
                            button_color=GOLD, button_hover_color=GOLD_ACTIVE,
                            dropdown_fg_color=FIELD_WHITE, dropdown_text_color=FIELD_TEXT,
                            dropdown_hover_color="#e6e6e6", border_width=1)


def _button(parent, text, command, width=150):
    return ctk.CTkButton(parent, text=text, command=command, width=width, height=30,
                          fg_color=GOLD, text_color=BG_DARK, hover_color=GOLD_ACTIVE,
                          font=("Segoe UI", 10, "bold"))


class WeekGrid(ctk.CTkFrame):
    """12 rows (one per player) of editable fields, plus the week-level
    Sacko/Final Odds/Final Payout/Final Split fields above them. Shared by
    both tabs."""

    COL_WIDTHS = {
        "sport": 85, "bet_type": 130, "team": 120, "opponent": 120,
        "player_prop": 130, "line": 55, "side": 75, "odds": 65,
        "gametime": 190, "result": 90,
    }

    def __init__(self, parent, players):
        super().__init__(parent, fg_color="transparent")
        self.players = players
        self.row_vars = {p: {f: tk.StringVar() for f in ROW_FIELDS} for p in players}
        self.row_widgets = {}
        self.sacko_var = tk.StringVar()
        self.final_odds_var = tk.StringVar()
        self.final_payout_var = tk.StringVar()
        self.final_split_var = tk.StringVar()
        self._build()

    def _build(self):
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x", pady=(0, 10))
        ctk.CTkLabel(top, text="Sacko:", text_color=TEXT_LIGHT).grid(row=0, column=0, padx=4)
        _combo(top, self.sacko_var, [""] + self.players, width=110).grid(row=0, column=1)
        ctk.CTkLabel(top, text="Final Odds:", text_color=TEXT_LIGHT).grid(row=0, column=2, padx=(16, 4))
        _entry(top, self.final_odds_var, width=100).grid(row=0, column=3)
        ctk.CTkLabel(top, text="Final Payout ($):", text_color=TEXT_LIGHT).grid(row=0, column=4, padx=(16, 4))
        _entry(top, self.final_payout_var, width=100).grid(row=0, column=5)
        ctk.CTkLabel(top, text="Split (auto):", text_color=TEXT_LIGHT).grid(row=0, column=6, padx=(16, 4))
        # CTkLabel doesn't actually support live textvariable binding
        # (confirmed directly -- it silently accepts the kwarg but never
        # updates), so the split figure is pushed in manually via
        # _recompute_split() instead of relying on a variable trace alone.
        self.final_split_label = ctk.CTkLabel(top, text="", text_color=GOLD, font=("Segoe UI", 10, "bold"))
        self.final_split_label.grid(row=0, column=7)
        self.final_payout_var.trace_add("write", self._recompute_split)

        headers = ["Player", "Sport", "Bet Type", "Team", "Opponent", "Player Prop",
                   "Line", "Side", "Odds", "Gametime", "Result"]
        grid = ctk.CTkFrame(self, fg_color="transparent")
        grid.pack(fill="both", expand=True)
        for c, h in enumerate(headers):
            # Column 0's header defaults to CTkLabel's own natural width
            # (wider than the row labels below it, which are pinned to
            # width=80/anchor="w"/sticky="w"), so without matching those
            # here too the header centers across the full, wider column
            # while the player names only occupy its left edge -- confirmed
            # directly this is what was making "Player" look misaligned
            # from the names under it.
            kwargs = {"width": 80, "anchor": "w"} if c == 0 else {}
            ctk.CTkLabel(grid, text=h, text_color=GOLD, font=("Segoe UI", 10, "bold"), **kwargs).grid(
                row=0, column=c, padx=3, pady=(0, 4), sticky="w" if c == 0 else None)

        for r, player in enumerate(self.players, start=1):
            ctk.CTkLabel(grid, text=player, width=80, anchor="w",
                         text_color=TEXT_LIGHT, font=("Segoe UI", 10, "bold")).grid(
                row=r, column=0, padx=3, pady=2, sticky="w")
            v = self.row_vars[player]
            w = {
                "sport": _combo(grid, v["sport"], SPORTS, width=self.COL_WIDTHS["sport"]),
                "bet_type": _combo(grid, v["bet_type"], BET_TYPES, width=self.COL_WIDTHS["bet_type"]),
                "team": _entry(grid, v["team"], width=self.COL_WIDTHS["team"]),
                "opponent": _entry(grid, v["opponent"], width=self.COL_WIDTHS["opponent"]),
                "player_prop": _entry(grid, v["player_prop"], width=self.COL_WIDTHS["player_prop"]),
                "line": _entry(grid, v["line"], width=self.COL_WIDTHS["line"]),
                "side": _combo(grid, v["side"], SIDES, width=self.COL_WIDTHS["side"]),
                "odds": _entry(grid, v["odds"], width=self.COL_WIDTHS["odds"]),
                "gametime": _entry(grid, v["gametime"], width=self.COL_WIDTHS["gametime"]),
                "result": _combo(grid, v["result"], RESULTS, width=self.COL_WIDTHS["result"]),
            }
            for c, field in enumerate(VISIBLE_ROW_FIELDS, start=1):
                w[field].grid(row=r, column=c, padx=3, pady=2)
            self.row_widgets[player] = w
            v["bet_type"].trace_add("write", lambda *_a, p=player: self._update_relevance(p))
            self._update_relevance(player)

    def _update_relevance(self, player):
        """Greys out (disables) whichever free-text fields don't apply to
        this row's current Bet Type -- e.g. Player Prop/Side for a Spread
        pick. A blank or unrecognized Bet Type leaves everything enabled
        rather than guessing. Also the single place that resets a field's
        color back to its normal (non-highlighted) state -- unlike ttk,
        CustomTkinter colors are set directly per widget rather than
        automatically derived from widget state, so there's no separate
        "disabled color just works" behavior to lean on."""
        relevant = FIELD_RELEVANCE.get(self.row_vars[player]["bet_type"].get())
        for f in VISIBLE_ROW_FIELDS:
            widget = self.row_widgets[player][f]
            irrelevant = f in GREYABLE_FIELDS and relevant is not None and f not in relevant
            if irrelevant:
                widget.configure(state="disabled", fg_color=DISABLED_BG, text_color=DISABLED_FG)
            else:
                widget.configure(state="normal", fg_color=FIELD_WHITE, text_color=FIELD_TEXT)

    def clear_highlights(self):
        for player in self.players:
            self._update_relevance(player)

    def highlight_needs_attention(self, needs_by_player):
        """needs_by_player: {player: {field, ...}} -- marks each listed
        field red. Always starts from a clean slate (via clear_highlights,
        which also correctly leaves irrelevant/disabled fields grey rather
        than white) so highlights from a previous Parse don't linger on
        fields that are now fine."""
        self.clear_highlights()
        for player, fields in needs_by_player.items():
            widgets = self.row_widgets.get(player, {})
            for f in fields:
                widget = widgets.get(f)
                if widget is None:
                    continue
                widget.configure(fg_color=NEEDS_BG, text_color=FIELD_TEXT)

    def _recompute_split(self, *_):
        payout = parse_money(self.final_payout_var.get()) if self.final_payout_var.get() else None
        text = f"{payout / PLAYERS_PER_WEEK:,.2f}" if payout is not None else ""
        self.final_split_var.set(text)
        self.final_split_label.configure(text=text)

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
                          "player_prop", "line", "side", "odds", "gametime", "result", "raw_pick"]
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
            v["raw_pick"].set(data.get("raw_line", ""))
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


class BrowseTab:
    """Builds directly into `master` (the CTkFrame CTkTabview hands back
    from .add()) rather than being a widget itself -- CTkTabview owns and
    places that frame, so this is a plain controller object, not a Frame
    subclass added to a notebook the way the ttk version worked."""

    def __init__(self, master, client):
        self.master = master
        self.client = client
        top = ctk.CTkFrame(master, fg_color="transparent")
        top.pack(fill="x", pady=8, padx=6)
        ctk.CTkLabel(top, text="Year:", text_color=TEXT_LIGHT).pack(side="left")
        self.year_var = tk.StringVar(value="2026")
        _entry(top, self.year_var, width=70).pack(side="left", padx=(2, 12))
        ctk.CTkLabel(top, text="Week:", text_color=TEXT_LIGHT).pack(side="left")
        self.week_var = tk.StringVar(value="1")
        _entry(top, self.week_var, width=50).pack(side="left", padx=(2, 12))
        _button(top, "Load", self.load, width=90).pack(side="left")
        _button(top, "Save Changes", self.save, width=140).pack(side="left", padx=8)
        self.status = ctk.CTkLabel(top, text="", text_color=TEXT_LIGHT)
        self.status.pack(side="left", padx=12)

        self.grid_widget = WeekGrid(master, client.players)
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
        self.status.configure(text="Loaded." if block else "That week has no rows yet.")

    def save(self):
        try:
            year, week = int(self.year_var.get()), int(self.week_var.get())
        except ValueError:
            messagebox.showerror("Invalid input", "Year and Week must be numbers.")
            return
        if not self.start_row:
            # Same reasoning as NewWeekTab.save(): find/allocate the row
            # directly rather than calling self.load(), which clears the
            # grid first and would wipe out whatever's been typed in.
            start_row, _block = self.client.find_week(year, week)
            self.start_row = start_row or self.client.next_new_week_row()
        g = self.grid_widget
        self.client.save_week(
            self.start_row, year, week, g.sacko_var.get(),
            parse_signed_number(g.final_odds_var.get()) if g.final_odds_var.get() else None,
            parse_money(g.final_payout_var.get()) if g.final_payout_var.get() else None,
            g.player_rows(),
        )
        self.status.configure(text="Saved.")


class NewWeekTab:
    def __init__(self, master, client):
        self.master = master
        self.client = client
        top = ctk.CTkFrame(master, fg_color="transparent")
        top.pack(fill="x", pady=8, padx=6)
        ctk.CTkLabel(top, text="Year:", text_color=TEXT_LIGHT).pack(side="left")
        self.year_var = tk.StringVar(value="2026")
        _entry(top, self.year_var, width=70).pack(side="left", padx=(2, 12))
        ctk.CTkLabel(top, text="Week:", text_color=TEXT_LIGHT).pack(side="left")
        self.week_var = tk.StringVar(value="")
        _entry(top, self.week_var, width=50).pack(side="left", padx=(2, 12))
        _button(top, "Load", self.load, width=90).pack(side="left")
        _button(top, "Save", self.save, width=90).pack(side="left", padx=8)
        self.status = ctk.CTkLabel(top, text="", text_color=TEXT_LIGHT)
        self.status.pack(side="left", padx=12)

        ctk.CTkLabel(master, text="Paste the shared note's raw text, then Parse",
                     text_color=GOLD, font=("Segoe UI", 11, "bold")).pack(anchor="w", padx=6, pady=(4, 2))
        self.paste_box = _add_textbox_clipboard_support(
            ctk.CTkTextbox(master, height=110, fg_color=FIELD_WHITE, text_color=FIELD_TEXT,
                           wrap="word", border_width=1, border_color=GOLD))
        self.paste_box.pack(fill="x", padx=6, pady=(0, 4))
        btn_row = ctk.CTkFrame(master, fg_color="transparent")
        btn_row.pack(fill="x", padx=6, pady=(0, 6))
        _button(btn_row, "Parse", self.parse_note, width=90).pack(side="left")
        _button(btn_row, "Paste", self.paste_into_box, width=90).pack(side="left", padx=(8, 0))
        self.parse_status = ctk.CTkLabel(btn_row, text="", text_color=TEXT_LIGHT)
        self.parse_status.pack(side="left", padx=8)

        self.grid_widget = WeekGrid(master, client.players)
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
                self.status.configure(text=f"Loaded existing data for week {week}.")
                return
        else:
            week = None
        self.start_row = self.client.next_new_week_row()
        self.grid_widget.load(None)
        if week is not None:
            self.status.configure(text=f"No existing rows for week {week} -- starting fresh at row {self.start_row}.")
        else:
            self.status.configure(text=f"Enter a week number above, then Load. Next free block starts at row {self.start_row}.")

    def paste_into_box(self):
        """Second way in to the same paste_box a right-click/Ctrl+V now
        also reaches -- a dedicated button for whichever still feels more
        reliable, since both land on the same clipboard-reading code
        path."""
        try:
            text = self.master.clipboard_get()
        except tk.TclError:
            messagebox.showinfo("Clipboard empty", "Nothing to paste -- the clipboard doesn't have text in it.")
            return
        self.paste_box.delete("1.0", "end")
        self.paste_box.insert("1.0", text)

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
        self.parse_status.configure(text=msg)
        self.master.update_idletasks()

        self.parse_status.configure(text=msg + " Looking up game times...")
        self.master.update_idletasks()
        window = thursday_to_monday_window()

        # The ESPN lookups below are the slow part (a whole week's worth of
        # scoreboard/search requests per pick, network-bound) -- run them on
        # a background thread so the window stays responsive instead of
        # freezing for the whole parse, same as any other long-running
        # Tkinter operation has to. Tkinter itself isn't thread-safe, so
        # the worker only does the pure network/lookup calls and hands its
        # results back to _apply_gametime_results via self.master.after,
        # which runs on the main thread like any other UI update.
        def lookup_worker():
            results = {}
            for player, data in picks.items():
                attempted = bool(data.get("team") and data.get("opponent")) or bool(data.get("player_prop"))
                gametime = matched_sport = resolved_team = resolved_opp = None
                if attempted:
                    if data.get("team") and data.get("opponent"):
                        gametime, matched_sport, resolved_team, resolved_opp = find_gametime(
                            data["team"], data["opponent"], days=window)
                    else:
                        team, sport = find_player_team(data["player_prop"], data.get("bet_type"))
                        if team:
                            matched_sport = sport
                            gametime = find_gametime_for_team(team, sport, days=window)
                results[player] = (attempted, gametime, matched_sport, resolved_team, resolved_opp)
            self.master.after(0, lambda: self._apply_gametime_results(picks, msg, results))

        threading.Thread(target=lookup_worker, daemon=True).start()

    def _apply_gametime_results(self, picks, msg, results):
        """Main-thread half of parse_note's gametime lookup -- applies
        whatever lookup_worker found to the grid's widgets, which (unlike
        the lookups themselves) have to happen on the main thread."""
        found, tried = 0, 0
        needs_by_player = {}
        for player, data in picks.items():
            relevant = FIELD_RELEVANCE.get(data.get("bet_type"), set())
            needs = set()
            if not data.get("ok"):
                needs |= {f for f in relevant if not data.get(f)}
                if data.get("odds") is None:
                    needs.add("odds")

            attempted, gametime, matched_sport, resolved_team, resolved_opp = results[player]
            if attempted:
                tried += 1
            if resolved_team:
                self.grid_widget.row_vars[player]["team"].set(resolved_team)
            if resolved_opp:
                self.grid_widget.row_vars[player]["opponent"].set(resolved_opp)
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
        self.parse_status.configure(text=msg)

    def save(self):
        try:
            year, week = int(self.year_var.get()), int(self.week_var.get())
        except ValueError:
            messagebox.showerror("Invalid input", "Year and Week must be numbers.")
            return
        auto_started = False
        if not self.start_row:
            # Paste -> Parse -> Save with no explicit Load in between used
            # to just fail here ("Load / Start a week first") even though
            # Parse had already filled the grid in -- Year/Week come from
            # the note itself (see parse_note), so there's always enough
            # here to find/allocate the right row ourselves. Deliberately
            # not just calling self.load(): that always clears the grid
            # first (see WeekGrid.load), which would wipe out the picks
            # Parse just filled in before Save ever got to write them.
            start_row, _block = self.client.find_week(year, week)
            self.start_row = start_row or self.client.next_new_week_row()
            auto_started = True
        g = self.grid_widget
        self.client.save_week(
            self.start_row, year, week, g.sacko_var.get(),
            parse_signed_number(g.final_odds_var.get()) if g.final_odds_var.get() else None,
            parse_money(g.final_payout_var.get()) if g.final_payout_var.get() else None,
            g.player_rows(),
        )
        prefix = f"Started week {week} at row {self.start_row} and saved" if auto_started else "Saved"
        self.status.configure(text=f"{prefix} to row {self.start_row}.")


def main():
    ctk.set_appearance_mode("dark")

    root = ctk.CTk()
    root.title("Retirement League Parlay Entry")
    root.geometry("1500x760")
    root.configure(fg_color=BG_DARK)

    status_label = ctk.CTkLabel(root, text="Connecting to Google Sheets...", text_color=TEXT_LIGHT)
    status_label.pack(pady=20)
    root.update()
    try:
        client = SheetClient()
    except Exception as e:
        status_label.configure(text=f"Failed to connect: {e}")
        return
    status_label.destroy()

    tabview = ctk.CTkTabview(
        root, fg_color=BG_DARK,
        segmented_button_fg_color=BG_DARK,
        segmented_button_selected_color=GOLD,
        segmented_button_selected_hover_color=GOLD_ACTIVE,
        segmented_button_unselected_color=BG_PANEL,
        segmented_button_unselected_hover_color="#333335",
        text_color=TEXT_LIGHT,
    )
    tabview.pack(fill="both", expand=True, padx=6, pady=6)
    new_week_frame = tabview.add("Enter New Week")
    browse_frame = tabview.add("Browse / Grade Past Weeks")
    NewWeekTab(new_week_frame, client)
    BrowseTab(browse_frame, client)

    root.mainloop()


if __name__ == "__main__":
    main()
