"""
Parses the informal shared-note format the league actually uses ("Brad:
Spread: Panthers -3 vs. Browns (-115)") into the same structured fields
migrate_parlay_tracker.py's parse_pick() produces from the sheet's own
"{Bet Type}: {details}" convention -- but more lenient, since a fast group
chat/notes-app entry is messier than something already sitting in a sheet:
bet-type abbreviations (ML, Pass Yards, Rec Yards), reversed word order for
player-stat lines ("Brian Thomas Jr o38.5" instead of "Over 38.5 Brian
Thomas Jr"), odds with no explicit "+" sign, extra/uneven whitespace, and
a trailing "Final Odds:"/"Final Payout:" pair for the whole week's combined
parlay.

Anything a line doesn't confidently parse is returned in `unmatched` rather
than guessed at, the same "flag, don't guess" approach as the historical
migration.
"""
import re

BET_TYPE_ALIASES = {
    "ml": "Money Line", "money line": "Money Line",
    "spread": "Spread", "alt spread": "Alt Spread", "1st half spread": "1st Half Spread",
    "anytime td": "Anytime TD",
    "total points": "Total Points", "total goals": "Total Goals", "total rounds": "Total Rounds",
    "receiving yards": "Receiving Yards", "receiving yds": "Receiving Yards", "rec yards": "Receiving Yards",
    "rec yds": "Receiving Yards",
    "passing td": "Passing TD", "pass td": "Passing TD",
    "passing yards": "Passing Yards", "passing yds": "Passing Yards", "pass yards": "Passing Yards",
    "pass yds": "Passing Yards",
    "receptions": "Receptions", "recs": "Receptions",
    "total yards": "Total Yards",
    "home runs": "Home Runs", "hrs": "Home Runs",
    "player points": "Player Points", "points": "Player Points",
    "interceptions": "Interceptions", "ints": "Interceptions",
    "coin toss": "Coin Toss",
}

TEAM_LINE_VS = {"Spread", "Alt Spread", "1st Half Spread"}
VS_ONLY = {"Money Line"}
TOTAL_VS = {"Total Points", "Total Goals", "Total Rounds"}
PLAYER_OU = {"Receiving Yards", "Passing TD", "Home Runs", "Player Points",
             "Interceptions", "Total Yards", "Receptions", "Passing Yards"}
PLAYER_ONLY = {"Anytime TD", "Coin Toss"}

TEAM_LINE_VS_RE = re.compile(r"^(.+?)\s+([+-]\d+(?:\.\d+)?)\s+vs\.?\s+(.+)$", re.IGNORECASE)
LINE_TEAM_VS_RE = re.compile(r"^([+-]\d+(?:\.\d+)?)\s+(.+?)\s+vs\.?\s+(.+)$", re.IGNORECASE)
TEAM_VS_TEAM_RE = re.compile(r"^(.+?)\s+vs\.?\s+(.+)$", re.IGNORECASE)
OU_TEAM_VS_TEAM_RE = re.compile(r"^(o|u|over|under)\.?\s*(\.?\d+(?:\.\d+)?)\s+(.+?)\s+vs\.?\s+(.+)$", re.IGNORECASE)
# Player-stat props: try "Over/Under <line> <player>" first, then the
# reversed "<player> o/u<line>" the note actually uses.
OU_PLAYER_RE = re.compile(r"^(o|u|over|under)\.?\s*(\.?\d+(?:\.\d+)?)\s+(.+)$", re.IGNORECASE)
PLAYER_OU_REVERSED_RE = re.compile(r"^(.+?)\s+(o|u|over|under)\.?\s*(\.?\d+(?:\.\d+)?)$", re.IGNORECASE)
ODDS_SUFFIX_RE = re.compile(r"^(.*?)\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*\)\s*$")

SIDE_MAP = {"o": "Over", "over": "Over", "u": "Under", "under": "Under"}

# The note also has a small header block above the picks (year/week, who's
# Sacko, when picks are due, the max combined odds) -- Legs Due/Max Odds
# aren't tracked anywhere in the sheet, so they're recognized and silently
# skipped rather than flagged as unmatched lines needing a human to sort
# out. Sacko and the "<year> Week <n>:" line ARE useful (Sacko already has
# a sheet column, year/week are needed to place the week at all), so those
# get pulled into `final` instead.
HEADER_SKIP_KEYS = {"legs due", "max odds"}
YEAR_WEEK_RE = re.compile(r"^(\d{4})\s+week\s+(\d+):?\s*$", re.IGNORECASE)


def normalize_side(token):
    return SIDE_MAP.get(token.lower())


def normalize_bet_type(raw):
    return BET_TYPE_ALIASES.get(raw.strip().lower())


def match_player(token, players):
    """Case-insensitive match against the known 12 (e.g. "Tj" -> "TJ")."""
    token = token.strip().lower()
    for p in players:
        if p.lower() == token:
            return p
    return None


def parse_signed_number(text):
    """'+ 449263' / '449263' / '-115' -> float, or None if not numeric."""
    text = text.strip().replace(",", "").replace(" ", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_money(text):
    """'$103,353.59' -> 103353.59, or None if not numeric."""
    text = text.strip().replace("$", "").replace(",", "")
    try:
        return float(text)
    except ValueError:
        return None


def parse_odds_token(text):
    """Odds with no explicit sign (e.g. the note's "115") are meant as
    positive/underdog odds by convention -- bare digits imply "+"."""
    n = parse_signed_number(text)
    return n


def parse_bet_details(bet_type, details):
    """Same shape as migrate_parlay_tracker.py's parse_pick, but the
    player-stat branch also tries the reversed "<player> o<line>" order."""
    row = {"team": "", "opponent": "", "player_prop": "", "line": "", "side": ""}
    details = details.strip()

    if bet_type in TEAM_LINE_VS:
        m = TEAM_LINE_VS_RE.match(details)
        if m:
            row["team"], row["line"], row["opponent"] = m.group(1).strip(), m.group(2), m.group(3).strip()
            return row, True
        m = LINE_TEAM_VS_RE.match(details)
        if m:
            row["line"], row["team"], row["opponent"] = m.group(1), m.group(2).strip(), m.group(3).strip()
            return row, True
        m = TEAM_VS_TEAM_RE.match(details)
        if m:
            row["team"], row["opponent"] = m.group(1).strip(), m.group(2).strip()
            return row, False  # missing line -- flagged
        return row, False

    if bet_type in VS_ONLY:
        m = TEAM_VS_TEAM_RE.match(details)
        if m:
            row["team"], row["opponent"] = m.group(1).strip(), m.group(2).strip()
            return row, True
        return row, False

    if bet_type in TOTAL_VS:
        m = OU_TEAM_VS_TEAM_RE.match(details)
        if m:
            row["side"] = normalize_side(m.group(1))
            row["line"] = m.group(2)
            row["team"], row["opponent"] = m.group(3).strip(), m.group(4).strip()
            return row, True
        return row, False

    if bet_type in PLAYER_OU:
        m = OU_PLAYER_RE.match(details)
        if m:
            row["side"] = normalize_side(m.group(1))
            row["line"] = m.group(2)
            row["player_prop"] = m.group(3).strip()
            return row, True
        m = PLAYER_OU_REVERSED_RE.match(details)
        if m:
            row["player_prop"] = m.group(1).strip()
            row["side"] = normalize_side(m.group(2))
            row["line"] = m.group(3)
            return row, True
        return row, False

    if bet_type in PLAYER_ONLY:
        row["player_prop"] = details
        return row, True

    return row, False


def parse_note_text(raw_text, players):
    """Returns (picks, final, unmatched):
      picks: {player: {bet_type, team, opponent, player_prop, line, side,
              odds, result, raw_line, ok}} -- ok is False if anything short
              of the odds couldn't be confidently split, same "write it
              anyway, flag it" approach as the historical migration.
              result defaults to "Pending" -- a freshly parsed pick is for
              a game that hasn't happened yet.
      final: {"odds": float|None, "payout": float|None, "year": str|None,
              "week": str|None, "sacko": str|None}
      unmatched: [raw lines that couldn't be attributed to a player, a
                   Final Odds/Payout line, or a recognized header line]
    """
    picks = {}
    final = {"odds": None, "payout": None, "year": None, "week": None, "sacko": None}
    unmatched = []

    for line in raw_text.splitlines():
        line = line.strip()
        if not line:
            continue

        m_yw = YEAR_WEEK_RE.match(line)
        if m_yw:
            final["year"], final["week"] = m_yw.group(1), m_yw.group(2)
            continue

        m = re.match(r"^([^:]+):\s*(.+)$", line)
        if not m:
            unmatched.append(line)
            continue
        key, rest = m.group(1).strip(), m.group(2).strip()
        key_lower = key.lower()

        if key_lower in HEADER_SKIP_KEYS:
            continue
        if key_lower == "sacko":
            final["sacko"] = match_player(rest, players) or rest
            continue
        if key_lower == "final odds":
            final["odds"] = parse_signed_number(rest)
            continue
        if key_lower == "final payout":
            final["payout"] = parse_money(rest)
            continue

        player = match_player(key, players)
        if not player:
            unmatched.append(line)
            continue

        m2 = re.match(r"^([^:]+):\s*(.+)$", rest)
        if not m2:
            unmatched.append(line)
            continue
        bet_type_raw, details_with_odds = m2.group(1).strip(), m2.group(2).strip()
        bet_type = normalize_bet_type(bet_type_raw)

        odds_match = ODDS_SUFFIX_RE.match(details_with_odds)
        if odds_match:
            details, odds = odds_match.group(1).strip(), parse_odds_token(odds_match.group(2))
        else:
            details, odds = details_with_odds, None

        if bet_type is None:
            picks[player] = {
                "bet_type": bet_type_raw, "team": "", "opponent": "", "player_prop": "",
                "line": "", "side": "", "odds": odds, "result": "Pending",
                "raw_line": line, "ok": False,
            }
            continue

        parsed, ok = parse_bet_details(bet_type, details)
        picks[player] = {
            "bet_type": bet_type, **parsed, "odds": odds, "result": "Pending",
            "raw_line": line, "ok": ok and odds is not None,
        }

    return picks, final, unmatched
