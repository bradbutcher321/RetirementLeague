"""
The "Auto Parlay Tracker" tab's week writer, used by enter_parlay.py (run by
the enter_parlay.yml and sync_legs.yml Actions the Worker dispatches when a
week or a leg is saved on the site's Parlay Legs page).
"""
import gspread
from google.oauth2.service_account import Credentials

from sheets_lib import SHEET_ID, CREDS_PATH
from parlay_note_parser import parse_signed_number

TARGET_TAB = "Auto Parlay Tracker"
PLAYERS_PER_WEEK = 12

# Columns E..O in save/load order, matching the Auto Parlay Tracker
# header. Raw Pick (O) is the note text a pick was parsed from, kept as an
# audit trail.
ROW_FIELDS = ["sport", "bet_type", "team", "opponent", "player_prop", "line", "side", "odds", "gametime", "result",
              "raw_pick"]

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
        what the sheet's historical rows were written with for the exact
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
            self.ws.update([_row_values(player_rows.get(player, {}))], f"E{start_row + i}:O{start_row + i}")

    def save_meta(self, start_row, sacko, final_odds, final_payout):
        """Only the week's Sacko, Final Odds and Final Payout (the first row's
        C, P and Q), for the Commissioner page's bet card. Every pick stays."""
        assert (start_row - 2) % PLAYERS_PER_WEEK == 0, f"start_row {start_row} isn't aligned to a 12-row week block"
        self.ws.update([[sacko or ""]], f"C{start_row}")
        self.ws.update([[final_odds if final_odds is not None else ""]], f"P{start_row}")
        self.ws.update([[final_payout if final_payout is not None else ""]], f"Q{start_row}")

    def save_rows(self, start_row, player_rows):
        """Rewrites only the given players' rows of a week already in the
        sheet (Parlay Legs' sync), leaving everyone else's, and the week's
        Sacko and final odds, alone."""
        assert (start_row - 2) % PLAYERS_PER_WEEK == 0, f"start_row {start_row} isn't aligned to a 12-row week block"
        for player, data in player_rows.items():
            row_num = start_row + self.players.index(player)
            self.ws.update([_row_values(data)], f"E{row_num}:O{row_num}")


def _row_values(data):
    """One player's E..O cells, in ROW_FIELDS order. Game times arrive as
    the sheet's ISO text already (enter_parlay.py rejects anything else)."""
    row_values = []
    for f in ROW_FIELDS:
        v = data.get(f, "")
        if f == "odds" and v != "":
            v = parse_signed_number(v)
            v = v if v is not None else ""
        row_values.append(v)
    return row_values
