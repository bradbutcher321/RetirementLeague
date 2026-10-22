"""
The bet-type groups the parlay scripts sort a leg by (which boxes it uses:
a team and a line, two teams, a total, or a player), plus the odds-number
reader they share.

The note parser that used to live here went with the desktop entry tool;
the site parses the shared note itself now (docs/parlay-note.js).
"""
TEAM_LINE_VS = {"Spread", "Alt Spread", "1st Half Spread"}
VS_ONLY = {"Money Line"}
TOTAL_VS = {"Total Points", "Total Goals", "Total Rounds"}
PLAYER_OU = {"Receiving Yards", "Passing TD", "Home Runs", "Player Points",
             "Interceptions", "Total Yards", "Receptions", "Passing Yards"}
PLAYER_ONLY = {"Anytime TD", "Coin Toss"}


def parse_signed_number(text):
    """'+ 449263' / '449263' / '-115' -> float, or None if not numeric."""
    text = text.strip().replace(",", "").replace(" ", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None
