"""
Looks up a team-based pick's real kickoff/start time from ESPN's public
scoreboard API, so parlay_gui.py doesn't need Gametime typed in by hand for
the common case.

Picks are always entered between Tuesday and Thursday for games that can
only be Thursday through the following Monday -- so instead of needing to
know each sport's own "week number" convention (which, confirmed directly,
doesn't line up with the NFL's for college football), this just checks
every date in that 5-day window.

Attempts every sport currently in use, not just NFL/NCAAF -- most either
work directly or fail closed (no match, no crash) if ESPN's endpoint for
that sport doesn't exist or doesn't return the expected shape. Soccer
("Futbol") tries a short list of the leagues the league has actually bet
on rather than every league in the world.

Only works for TEAM-based bets (Spread, Money Line, Totals -- anything
with both Team and Opponent). Player props (Anytime TD, Receiving Yards,
etc.) have no team in the pick text to search on; that needs a separate
player-to-team lookup this doesn't attempt.
"""
import re
import unicodedata
import urllib.request
import json
from datetime import date, timedelta, datetime, timezone
from zoneinfo import ZoneInfo

USER_AGENT = "Mozilla/5.0"
EASTERN = ZoneInfo("America/New_York")

# Sport (as used in Auto Parlay Tracker) -> ESPN site-API sport/league
# path(s) to try, in order. Soccer needs several since there's no single
# "all leagues" scoreboard; anything not listed here (or that errors) just
# falls back to manual entry.
SPORT_ESPN_PATHS = {
    "NFL": ["football/nfl"],
    "NCAAF": ["football/college-football"],
    "NBA": ["basketball/nba"],
    "NCAAM": ["basketball/mens-college-basketball"],
    "NHL": ["hockey/nhl"],
    "MLB": ["baseball/mlb"],
    "UFC": ["mma/ufc"],
    "Boxing": ["boxing/boxing"],
    "Womens Tennis": ["tennis/wta"],
    "Futbol": [
        "soccer/eng.1", "soccer/uefa.champions", "soccer/esp.1",
        "soccer/usa.1", "soccer/ger.1", "soccer/ita.1", "soccer/uefa.europa",
    ],
}
# College football needs every FBS game, not just a default subset.
NEEDS_FBS_GROUP = {"football/college-football"}

_scoreboard_cache = {}


def thursday_to_monday_window(today=None):
    """The upcoming Thursday (today, if today already is one) through the
    following Monday -- the only days a pick entered Tue-Thu can be for."""
    today = today or date.today()
    days_until_thursday = (3 - today.weekday()) % 7  # Mon=0 .. Sun=6, Thu=3
    thursday = today + timedelta(days=days_until_thursday)
    monday = thursday + timedelta(days=4)
    days = []
    d = thursday
    while d <= monday:
        days.append(d)
        d += timedelta(days=1)
    return days


def _fetch(espn_path, date_str):
    key = (espn_path, date_str)
    if key in _scoreboard_cache:
        return _scoreboard_cache[key]
    url = f"https://site.api.espn.com/apis/site/v2/sports/{espn_path}/scoreboard?dates={date_str}"
    if espn_path in NEEDS_FBS_GROUP:
        url += "&groups=80&limit=200"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception:
        data = None
    _scoreboard_cache[key] = data
    return data


def _fold(text):
    """Lowercase and strip accents (e.g. "Atlético" -> "atletico") so
    international team names match regardless of diacritics -- confirmed
    directly this was needed: ESPN's shortDisplayName for a La Liga team
    didn't match the sheet's unaccented spelling otherwise."""
    text = unicodedata.normalize("NFKD", text.strip().lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def _team_matches(candidate, espn_team):
    candidate = _fold(candidate)
    short = _fold(espn_team.get("shortDisplayName") or "")
    display = _fold(espn_team.get("displayName") or "")
    return candidate == short or candidate == display or (candidate and candidate in display)


def _to_eastern_iso(espn_date):
    """'2026-09-27T17:00Z' -> '2026-09-27T13:00:00' (naive Eastern), matching
    the format the rest of the pipeline already uses everywhere else."""
    dt_utc = datetime.strptime(espn_date, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    dt_eastern = dt_utc.astimezone(EASTERN)
    return dt_eastern.strftime("%Y-%m-%dT%H:%M:00")


def find_gametime(team, opponent, sport=None, days=None):
    """Returns (gametime_iso, matched_sport), or (None, None) if no
    confident match was found (never raises -- any ESPN hiccup just means
    no match). Never fed a specific sport -- the shared note doesn't
    mention one -- so this can search across every sport currently in use
    and hand back whichever one actually matched, letting the GUI
    auto-fill Sport too, not just Gametime. Pass sport to restrict the
    search once it's already known (e.g. re-checking one row by hand)."""
    if not team or not opponent:
        return None, None
    team = re.sub(r"^#\d+\s*", "", team)
    opponent = re.sub(r"^#\d+\s*", "", opponent)
    days = days or thursday_to_monday_window()
    sports = [sport] if sport else list(SPORT_ESPN_PATHS)

    for d in days:
        date_str = d.strftime("%Y%m%d")
        for s in sports:
            for espn_path in SPORT_ESPN_PATHS.get(s, []):
                data = _fetch(espn_path, date_str)
                if not data:
                    continue
                for event in data.get("events", []):
                    try:
                        comp = event["competitions"][0]
                        competitors = comp["competitors"]
                        if len(competitors) != 2:
                            continue
                        t0, t1 = competitors[0]["team"], competitors[1]["team"]
                    except (KeyError, IndexError):
                        continue
                    both_match = (
                        (_team_matches(team, t0) and _team_matches(opponent, t1)) or
                        (_team_matches(team, t1) and _team_matches(opponent, t0))
                    )
                    if both_match:
                        try:
                            return _to_eastern_iso(comp["date"]), s
                        except (KeyError, ValueError):
                            continue
    return None, None
