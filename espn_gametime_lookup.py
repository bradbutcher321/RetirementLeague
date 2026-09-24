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

Player props (Anytime TD, Receiving Yards, etc.) are also covered: ESPN's
player search returns both the person's sport and current team in one
call, which then feeds the same team-matching logic. Same-named people in
different sports (confirmed directly, e.g. multiple "Josh Jacobs") get
narrowed using what sports the bet type itself could plausibly be
(a "Receiving Yards" prop can only be NFL/NCAAF) -- if that still leaves
more than one person, it's left unresolved rather than guessing.
"""
import re
import unicodedata
import urllib.parse
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

# Player-prop bet types -> the sport(s) they could plausibly be. ESPN's
# player search often returns several same-named people across different
# sports (confirmed directly: "Josh Jacobs" matches an NFL running back,
# an NCAAM player, a misspelled NCAAF hit, and an NHL player) -- the bet
# type itself is a strong, already-available signal for which one is
# actually meant, without needing anything fancier.
BET_TYPE_SPORTS = {
    "Anytime TD": {"NFL", "NCAAF"},
    "Passing TD": {"NFL", "NCAAF"},
    "Passing Yards": {"NFL", "NCAAF"},
    "Receiving Yards": {"NFL", "NCAAF"},
    "Receptions": {"NFL", "NCAAF"},
    "Interceptions": {"NFL", "NCAAF"},
    "Total Yards": {"NFL", "NCAAF"},
    "Player Points": {"NBA", "NCAAM"},
    "Home Runs": {"MLB"},
}

_scoreboard_cache = {}
_search_cache = {}


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
    """Checks every name ESPN exposes for a team, not just displayName/
    shortDisplayName -- confirmed directly this was needed: for "Florida
    Gators", shortDisplayName is "Florida" (the school) while the mascot
    "Gators" only appears in the separate `name` field, and for "UCF
    Knights", shortDisplayName is "UCF" while the mascot "Knights" is
    again only in `name`. A pick can reasonably use either half."""
    candidate = _fold(candidate)
    if not candidate:
        return False
    fields = ["shortDisplayName", "displayName", "name", "location", "abbreviation"]
    exact = {_fold(espn_team.get(f) or "") for f in fields}
    if candidate in exact:
        return True
    display = _fold(espn_team.get("displayName") or "")
    return candidate in display


def _to_eastern_iso(espn_date):
    """'2026-09-27T17:00Z' -> '2026-09-27T13:00:00' (naive Eastern), matching
    the format the rest of the pipeline already uses everywhere else."""
    dt_utc = datetime.strptime(espn_date, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    dt_eastern = dt_utc.astimezone(EASTERN)
    return dt_eastern.strftime("%Y-%m-%dT%H:%M:00")


def search_player(name):
    """Every ESPN "player" search hit for this name: [{name, sport,
    team}]. `sport` is already spelled the way SPORT_ESPN_PATHS expects
    (ESPN's own "NFL"/"NCAAF"/"NBA"/etc.), so a hit's sport can be used
    directly. Never raises -- an ESPN hiccup just means no hits."""
    if name in _search_cache:
        return _search_cache[name]
    url = "https://site.web.api.espn.com/apis/search/v2?query=" + urllib.parse.quote(name)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    hits = []
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        for group in data.get("results", []):
            if group.get("type") == "player":
                for c in group.get("contents", []):
                    hits.append({"name": c.get("displayName"), "sport": c.get("description"),
                                 "team": c.get("subtitle")})
    except Exception:
        pass
    _search_cache[name] = hits
    return hits


def find_player_team(player_name, bet_type=None):
    """Returns (team_name, sport), or (None, None) if the name wasn't
    found or multiple same-named people remain ambiguous even after
    narrowing by what sports this bet type could plausibly be (e.g.
    "Receiving Yards" -> NFL/NCAAF only) -- ambiguous stays unresolved
    rather than guessing which same-named person was actually meant."""
    hits = search_player(player_name)
    if not hits:
        return None, None
    # ESPN's search is fuzzy (confirmed directly: searching "Josh Jacobs"
    # also returns a "Josh Jacobson"), which can turn a genuinely
    # resolvable name into a falsely-ambiguous one once mixed in with the
    # real hits -- narrow to hits whose own name actually matches first.
    exact = [h for h in hits if _fold(h.get("name") or "") == _fold(player_name)]
    hits = exact or hits
    plausible = BET_TYPE_SPORTS.get(bet_type)
    if plausible:
        hits = [h for h in hits if h["sport"] in plausible] or hits
    # Still ambiguous if more than one distinct (sport, team) remains.
    distinct = {(h["sport"], h["team"]) for h in hits if h["sport"] and h["team"]}
    if len(distinct) != 1:
        return None, None
    sport, team = next(iter(distinct))
    return team, sport if sport in SPORT_ESPN_PATHS else None


def find_gametime_for_team(team, sport, days=None):
    """Like find_gametime, but for a single known team (no opponent to
    check against) -- used for player props, where we only know which
    team the player is on, not who they're playing."""
    if not team or not sport:
        return None
    team = re.sub(r"^#\d+\s*", "", team)
    days = days or thursday_to_monday_window()

    for d in days:
        date_str = d.strftime("%Y%m%d")
        for espn_path in SPORT_ESPN_PATHS.get(sport, []):
            data = _fetch(espn_path, date_str)
            if not data:
                continue
            for event in data.get("events", []):
                try:
                    comp = event["competitions"][0]
                    competitors = comp["competitors"]
                except (KeyError, IndexError):
                    continue
                if any(_team_matches(team, c.get("team", {})) for c in competitors):
                    try:
                        return _to_eastern_iso(comp["date"])
                    except (KeyError, ValueError):
                        continue
    return None


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
