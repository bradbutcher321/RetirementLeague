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

Also holds the box-score/half-score lookups auto_grade_results.py uses to
grade a finished game -- find_final_score (full-game score, the common
case), find_half_score (1st Half Spread), and find_prop_stat (every player
prop, via PROP_STAT_SPECS). All three are built on the same underlying
event lookup (_find_event/_find_event_for_team) as the gametime functions
above, just checking a specific already-known game instead of searching a
whole week's window.
"""
import re
import time
import unicodedata
import urllib.parse
import urllib.request
import json
from datetime import date, timedelta, datetime, timezone
from zoneinfo import ZoneInfo

# A bare "Mozilla/5.0" doesn't match any real browser's actual UA string,
# which is itself a common bot-detection signal -- a full, current desktop
# Chrome UA plus the headers a real browser sends alongside it.
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
}
EASTERN = ZoneInfo("America/New_York")
# Confirmed directly: ESPN's scoreboard/search API intermittently 403s even
# from a residential IP under rapid repeated requests, then recovers within
# under a minute on its own -- an intermittent rate-limit/bot-heuristic
# window, not a hard IP ban. It triggers far more often from GitHub
# Actions/Cloudflare specifically because those IPs are shared across many
# unrelated callers, so the aggregate request volume crosses whatever
# threshold much more often than a lightly-used residential IP does. A
# 1-second retry wasn't patient enough to ride that window out; this one is.
FETCH_ATTEMPTS = 5
FETCH_RETRY_DELAYS = [2, 5, 10, 20]  # seconds between attempts (len == FETCH_ATTEMPTS - 1)

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
    # No working path found for boxing -- every candidate tried
    # ("boxing/boxing", "boxing/mens", "boxing/fight", "combat/boxing", and
    # bare "boxing") returns HTTP 400/404, confirmed directly, not just "no
    # events that day." ESPN doesn't appear to expose a public boxing
    # scoreboard the way it does for the other sports here. Deliberately
    # left out of this dict (rather than pointed at a guessed/broken path)
    # so a Boxing pick fails fast to manual entry/review instead of
    # burning a full FETCH_ATTEMPTS retry-with-backoff cycle on a request
    # that can never succeed.
    "Womens Tennis": ["tennis/wta"],
    "Futbol": [
        "soccer/eng.1", "soccer/uefa.champions", "soccer/esp.1",
        "soccer/usa.1", "soccer/ger.1", "soccer/ita.1", "soccer/uefa.europa",
    ],
}

# Sports whose ESPN scoreboard is shaped completely differently from a
# team sport's "one event = one game": UFC's events are whole fight
# cards, with every fight on the card as a separate `competitions` entry
# under one event (not `competitions[0]`, the only index every team-sport
# function above assumes) -- confirmed directly for UFC 320, where
# `competitions[0]` was an undercard fight, not the main event the pick
# was actually about. Competitors are `athlete` objects, not `team` ones,
# and there's no separate final-score number for a bet like "Total
# Rounds" -- that's the round the bout ended in (status.period), not a
# score to sum. _find_individual_competition/find_individual_result below
# handle this shape instead of _find_event/find_final_score.
INDIVIDUAL_SPORTS = {"UFC"}
# Some sports' default scoreboard only returns a small "featured games"
# subset for a date, not the full slate -- confirmed directly for both:
# college football needs every FBS game (group 80), and college
# basketball needs every Division I game (group 50) -- a real Friday's
# NCAAM scoreboard came back with only 2 games without this, 26 with it.
# (group id, limit) per path that needs the wider request.
FULL_GROUP_BY_PATH = {
    "football/college-football": (80, 200),
    "basketball/mens-college-basketball": (50, 300),
}

# Common informal team nicknames/abbreviations a pick is sometimes entered
# with, that don't appear in any of ESPN's own name fields for that team
# (see _team_matches) -- confirmed directly for each of these that a plain
# "Bucs" or "Man U" pick couldn't be matched against ESPN's "Buccaneers"/
# "Man United" otherwise. Checked as an additional exact-match candidate,
# not folded into the substring fallback, so short ones (like "WV") stay
# precise instead of accidentally matching an unrelated team whose name
# happens to contain those letters.
TEAM_NICKNAMES = {
    "bucs": "buccaneers", "buccs": "buccaneers",
    "pats": "patriots",
    "jags": "jaguars",
    "preds": "predators",
    "man u": "man united",
    "wv": "west virginia",
    "cavs": "cavaliers",
}

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

# Common nickname -> formal-name first names. ESPN's player search index is
# strict about this direction (confirmed directly: "Matt Stafford" -> 0
# hits, "Matthew Stafford" -> 1 clean hit) -- when the literal name a note
# used comes back empty or ambiguous, the first token is also tried
# expanded to its formal form. Not the reverse (formal -> nickname): no
# case has needed it, and guessing an extra informal spelling per formal
# name would just add noise to an already-fuzzy search.
NICKNAME_TO_FORMAL = {
    "matt": "matthew", "mike": "michael", "chris": "christopher", "nick": "nicholas",
    "josh": "joshua", "sam": "samuel", "alex": "alexander", "will": "william",
    "tom": "thomas", "tommy": "thomas", "bob": "robert", "bobby": "robert", "rob": "robert",
    "dan": "daniel", "danny": "daniel", "ben": "benjamin", "zach": "zachary", "zack": "zachary",
    "joe": "joseph", "joey": "joseph", "charlie": "charles", "chuck": "charles",
    "nate": "nathaniel", "andy": "andrew", "steve": "steven", "jon": "jonathan",
    "jim": "james", "jimmy": "james", "jack": "john", "ed": "edward", "eddie": "edward",
    "tony": "anthony", "greg": "gregory", "pat": "patrick", "ken": "kenneth",
    "larry": "lawrence", "ron": "ronald", "rich": "richard", "ricky": "richard",
    "dave": "david", "abe": "abraham", "vlad": "vladimir",
}

_scoreboard_cache = {}
_search_cache = {}
_summary_cache = {}

# Player-prop bet type -> [(stat label, group hint), ...] to sum from a box
# score (see find_prop_stat below). "Anytime TD" sums across every way a
# skill player scores; "Total Yards" sums rushing + receiving. The hint
# disambiguates a label that appears in more than one stat group for the
# same sport -- it's checked against both a group's `name` (football's
# groups are named "passing"/"rushing"/etc.) and its `labels` (basketball
# and baseball's groups aren't named at all, so e.g. MLB's "HR" needs "AB",
# an at-bats column that's batting-only, to avoid matching a pitcher's HR-
# allowed line instead of a batter's HR-hit line). None means "only one
# group will ever have this label anyway" (true for every sport currently
# in BET_TYPE_SPORTS except football and MLB).
PROP_STAT_SPECS = {
    "Anytime TD": [("TD", "rushing"), ("TD", "receiving"), ("TD", "kickReturns"), ("TD", "puntReturns")],
    "Passing TD": [("TD", "passing")],
    "Passing Yards": [("YDS", "passing")],
    "Receiving Yards": [("YDS", "receiving")],
    "Receptions": [("REC", "receiving")],
    "Interceptions": [("INT", "passing")],
    "Total Yards": [("YDS", "rushing"), ("YDS", "receiving")],
    "Player Points": [("PTS", None)],
    "Home Runs": [("HR", "AB")],
}


def _nickname_variant(name):
    """'Matt Stafford' -> 'Matthew Stafford', or None if the first name
    isn't a known nickname."""
    parts = name.split(None, 1)
    if not parts:
        return None
    first = parts[0].lower()
    formal = NICKNAME_TO_FORMAL.get(first)
    if not formal:
        return None
    rest = parts[1] if len(parts) > 1 else ""
    return f"{formal.capitalize()} {rest}".strip()


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
    # site.web.api.espn.com, not site.api.espn.com -- confirmed directly:
    # identical path/query shape, correctly date-filtered (unlike
    # cdn.espn.com's core scoreboard, which silently ignores dates= and
    # only respects week=+year=), and not behind the block site.api.espn.com
    # is (HTTP 403 from every cloud IP tried, headers/cookies/retries all
    # made no difference). search_player() below was already on this host.
    url = f"https://site.web.api.espn.com/apis/site/v2/sports/{espn_path}/scoreboard?dates={date_str}"
    group_limit = FULL_GROUP_BY_PATH.get(espn_path)
    if group_limit:
        group_id, limit = group_limit
        url += f"&groups={group_id}&limit={limit}"
    req = urllib.request.Request(url, headers=REQUEST_HEADERS)
    # A transient failure (timeout, or ESPN's intermittent rate-limit --
    # see FETCH_ATTEMPTS above) shouldn't read as "no such game" the same
    # way a genuine 0 results does -- confirmed directly: a scheduled run
    # reported a real, already-final game as ungradeable, then an
    # identical call moments later succeeded.
    data = None
    for attempt in range(FETCH_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            break
        except Exception as e:
            # Swallowed by every caller (a lookup failure just means "no
            # match" to them), but printed here so a real cause -- rate
            # limiting, a genuine timeout -- shows up in the run's own log
            # instead of looking identical to a game that's simply not
            # final yet.
            print(f"  [espn_gametime_lookup] fetch failed ({espn_path} {date_str}, "
                  f"attempt {attempt + 1}/{FETCH_ATTEMPTS}): {type(e).__name__}: {e}")
            data = None
            if attempt < FETCH_ATTEMPTS - 1:
                time.sleep(FETCH_RETRY_DELAYS[attempt])
    if data is not None:
        print(f"  [espn_gametime_lookup] fetched {espn_path} {date_str}: {len(data.get('events', []))} event(s)")
    _scoreboard_cache[key] = data
    return data


def _fetch_summary(espn_path, event_id):
    """Fetches ESPN's per-event summary (box score, linescores, and more)
    for one specific already-known game -- unlike _fetch's scoreboard
    (a whole day/league at once), this is scoped to a single event.
    Same host and retry behavior as _fetch, for the same reason (see
    _fetch's own comment on why site.web.api.espn.com, not
    site.api.espn.com)."""
    key = (espn_path, event_id)
    if key in _summary_cache:
        return _summary_cache[key]
    url = f"https://site.web.api.espn.com/apis/site/v2/sports/{espn_path}/summary?event={event_id}"
    req = urllib.request.Request(url, headers=REQUEST_HEADERS)
    data = None
    for attempt in range(FETCH_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            break
        except Exception as e:
            print(f"  [espn_gametime_lookup] summary fetch failed ({espn_path} event {event_id}, "
                  f"attempt {attempt + 1}/{FETCH_ATTEMPTS}): {type(e).__name__}: {e}")
            data = None
            if attempt < FETCH_ATTEMPTS - 1:
                time.sleep(FETCH_RETRY_DELAYS[attempt])
    _summary_cache[key] = data
    return data


def _fold(text):
    """Lowercase and strip accents (e.g. "Atlético" -> "atletico") so
    international team names match regardless of diacritics -- confirmed
    directly this was needed: ESPN's shortDisplayName for a La Liga team
    didn't match the sheet's unaccented spelling otherwise."""
    text = unicodedata.normalize("NFKD", text.strip().lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def _fold_name(name):
    """Loose player-name comparison key: _fold (case/accent-insensitive)
    plus punctuation stripped and a trailing suffix dropped -- confirmed
    needed directly: the same real player appears as both "Ja'Marr Chase"
    and "JaMarr Chase" across different weeks' picks, and a box score's
    "Michael Penix Jr." should still match a pick that just says "Michael
    Penix"."""
    folded = re.sub(r"[^a-z0-9 ]", "", _fold(name))
    return re.sub(r"\s+(jr|sr|ii|iii|iv)$", "", folded).strip()


def _team_matches(candidate, espn_team):
    """Checks every name ESPN exposes for a team, not just displayName/
    shortDisplayName -- confirmed directly this was needed: for "Florida
    Gators", shortDisplayName is "Florida" (the school) while the mascot
    "Gators" only appears in the separate `name` field, and for "UCF
    Knights", shortDisplayName is "UCF" while the mascot "Knights" is
    again only in `name`. A pick can reasonably use either half.

    Also tries TEAM_NICKNAMES ("Bucs" -> "Buccaneers") and a punctuation-
    stripped comparison ("Hawaii" vs ESPN's own "Hawai'i") as additional
    exact-match candidates -- confirmed directly both were needed, the
    second the same class of gap already fixed for player names via
    _fold_name."""
    candidate = _fold(candidate)
    if not candidate:
        return False
    fields = ["shortDisplayName", "displayName", "name", "location", "abbreviation"]
    exact = {_fold(espn_team.get(f) or "") for f in fields}
    candidates = {candidate}
    mapped = TEAM_NICKNAMES.get(candidate)
    if mapped:
        candidates.add(mapped)
    if candidates & exact:
        return True
    loose = lambda s: re.sub(r"[^a-z0-9 ]", "", s)
    if {loose(c) for c in candidates} & {loose(e) for e in exact}:
        return True
    display = _fold(espn_team.get("displayName") or "")
    return any(c in display for c in candidates)


def _canonical_name(team_obj, competitor):
    """The team's clean, correctly-spelled short name (e.g. "Florida",
    "Ole Miss", "Panthers") -- matches the sheet's own naming convention
    better than whatever a note happened to type, so a matched pick's
    Team/Opponent get overwritten with this rather than left as-is (fixes
    typos like "Gaytors" and non-canonical alternates like "Carolina" for
    the Panthers in one move). Prefixed with the current AP/CFP-style
    ranking when ESPN has one for this game -- ESPN uses 99 to mean
    "unranked" (confirmed directly), not 0 or null, so that has to be
    filtered out explicitly or every team would show "#99"."""
    name = team_obj.get("shortDisplayName") or team_obj.get("displayName") or ""
    rank = (competitor.get("curatedRank") or {}).get("current")
    if rank and rank <= 25:
        return f"#{rank} {name}".strip()
    return name


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
    req = urllib.request.Request(url, headers=REQUEST_HEADERS)
    hits = []
    for attempt in range(FETCH_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            for group in data.get("results", []):
                if group.get("type") == "player":
                    for c in group.get("contents", []):
                        hits.append({"name": c.get("displayName"), "sport": c.get("description"),
                                     "team": c.get("subtitle")})
            break
        except Exception:
            hits = []
            if attempt < FETCH_ATTEMPTS - 1:
                time.sleep(FETCH_RETRY_DELAYS[attempt])
    _search_cache[name] = hits
    return hits


def find_player_team(player_name, bet_type=None):
    """Returns (team_name, sport), or (None, None) if the name wasn't
    found or multiple same-named people remain ambiguous even after
    narrowing by what sports this bet type could plausibly be (e.g.
    "Receiving Yards" -> NFL/NCAAF only) and preferring NFL over NCAAF as
    a last-resort tiebreak (user-requested default: when a name genuinely
    matches one real NFL player and one real NCAAF player -- confirmed,
    e.g. two different people both named "Brian Thomas Jr." -- the NFL
    one is the far more likely bet). Any other kind of ambiguity (e.g.
    two different NFL players sharing a name) is still left unresolved
    rather than guessed."""
    hits = search_player(player_name)
    # ESPN's search is fuzzy (confirmed directly: searching "Josh Jacobs"
    # also returns a "Josh Jacobson"), which can turn a genuinely
    # resolvable name into a falsely-ambiguous one once mixed in with the
    # real hits -- narrow to hits whose own name actually matches first.
    exact = [h for h in hits if _fold_name(h.get("name") or "") == _fold_name(player_name)]
    if not exact:
        # ESPN's index wants the formal first name (confirmed: "Matt
        # Stafford" -> 0 hits, "Matthew Stafford" -> 1 clean hit) -- retry
        # with the nickname expanded before giving up.
        variant = _nickname_variant(player_name)
        if variant:
            variant_hits = search_player(variant)
            exact = [h for h in variant_hits if _fold_name(h.get("name") or "") == _fold_name(variant)]
    hits = exact or hits
    if not hits:
        return None, None
    plausible = BET_TYPE_SPORTS.get(bet_type)
    if plausible:
        hits = [h for h in hits if h["sport"] in plausible] or hits
    # Still ambiguous if more than one distinct (sport, team) remains.
    distinct = {(h["sport"], h["team"]) for h in hits if h["sport"] and h["team"]}
    if len(distinct) != 1:
        distinct_sports = {sport for sport, _ in distinct}
        if distinct_sports == {"NFL", "NCAAF"}:
            nfl_only = [d for d in distinct if d[0] == "NFL"]
            if len(nfl_only) == 1:
                sport, team = nfl_only[0]
                return team, sport
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
    """Returns (gametime_iso, matched_sport, resolved_team, resolved_opponent),
    or (None, None, None, None) if no confident match was found (never
    raises -- any ESPN hiccup just means no match). Never fed a specific
    sport -- the shared note doesn't mention one -- so this can search
    across every sport currently in use and hand back whichever one
    actually matched, letting the GUI auto-fill Sport too, not just
    Gametime. Pass sport to restrict the search once it's already known
    (e.g. re-checking one row by hand).

    resolved_team/resolved_opponent are ESPN's own clean names for
    whichever real game was matched (see _canonical_name) -- overwriting
    the note's raw text with these fixes typos, non-canonical alternates
    ("Carolina" -> "Panthers"), and adds a ranking prefix for ranked
    college teams, all in one pass, rather than just confirming the note's
    text was directionally right.

    A full team+opponent match is always preferred. But a note can
    misspell one side (confirmed directly: "Gaytors" for "Gators") while
    getting the other side right -- so if nothing matches both sides,
    fall back to whichever single side (team or opponent) does match,
    as long as that side matches exactly one game across the whole
    window. That uniqueness check is what keeps this safe: a misspelled
    "Gaytors" paired with a correctly-spelled, one-game-this-week "Ole
    Miss" still confidently identifies the game, but a single-side match
    that could mean more than one real game stays unresolved rather than
    guessed."""
    if not team or not opponent:
        return None, None, None, None
    team = re.sub(r"^#\d+\s*", "", team)
    opponent = re.sub(r"^#\d+\s*", "", opponent)
    days = days or thursday_to_monday_window()
    sports = [sport] if sport else list(SPORT_ESPN_PATHS)

    # [(gametime_iso, sport, resolved_team, resolved_opponent)] for games
    # matching exactly one side.
    partial_matches = []
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
                        c0, c1 = competitors
                        t0, t1 = c0["team"], c1["team"]
                    except (KeyError, IndexError):
                        continue

                    team_t0, team_t1 = _team_matches(team, t0), _team_matches(team, t1)
                    opp_t0, opp_t1 = _team_matches(opponent, t0), _team_matches(opponent, t1)

                    if team_t0 and opp_t1:
                        try:
                            return (_to_eastern_iso(comp["date"]), s,
                                    _canonical_name(t0, c0), _canonical_name(t1, c1))
                        except (KeyError, ValueError):
                            continue
                    if team_t1 and opp_t0:
                        try:
                            return (_to_eastern_iso(comp["date"]), s,
                                    _canonical_name(t1, c1), _canonical_name(t0, c0))
                        except (KeyError, ValueError):
                            continue

                    if team_t0 or opp_t1:
                        team_side, opp_side = (t0, c0), (t1, c1)
                    elif team_t1 or opp_t0:
                        team_side, opp_side = (t1, c1), (t0, c0)
                    else:
                        continue
                    try:
                        partial_matches.append((
                            _to_eastern_iso(comp["date"]), s,
                            _canonical_name(*team_side), _canonical_name(*opp_side),
                        ))
                    except (KeyError, ValueError):
                        continue

    if len(partial_matches) == 1:
        return partial_matches[0]
    return None, None, None, None


def _find_event(team, opponent, sport, gametime_iso):
    """Locates the ESPN event for a specific already-known team-vs-opponent
    game (full match only, no single-side fallback -- by this point the
    names should already be the corrected, ESPN-normalized ones from when
    the pick was first resolved). Shared by every function below that needs
    "the one game a sheet row is about," given how it's actually
    recorded -- as a specific sport+gametime, not an ESPN event id.
    Returns (event, team_competitor, opponent_competitor), or
    (None, None, None) if no match is found on gametime_iso's date."""
    if not team or not opponent or not sport or not gametime_iso:
        return None, None, None
    team = re.sub(r"^#\d+\s*", "", team)
    opponent = re.sub(r"^#\d+\s*", "", opponent)
    try:
        game_date = datetime.strptime(gametime_iso[:10], "%Y-%m-%d").date()
    except ValueError:
        return None, None, None

    for espn_path in SPORT_ESPN_PATHS.get(sport, []):
        data = _fetch(espn_path, game_date.strftime("%Y%m%d"))
        if not data:
            continue
        for event in data.get("events", []):
            try:
                comp = event["competitions"][0]
                competitors = comp["competitors"]
                if len(competitors) != 2:
                    continue
                c0, c1 = competitors
                t0, t1 = c0["team"], c1["team"]
            except (KeyError, IndexError):
                continue
            if _team_matches(team, t0) and _team_matches(opponent, t1):
                return event, c0, c1
            if _team_matches(team, t1) and _team_matches(opponent, t0):
                return event, c1, c0
    return None, None, None


def _find_event_for_team(team, sport, gametime_iso):
    """Like _find_event, but for a single known team with no opponent to
    check against -- player-prop picks only record the player (and the
    Sport their search hit resolved to), not a Team/Opponent, so the
    specific game has to be found from the team side alone. Returns
    (event, team_competitor), or (None, None)."""
    if not team or not sport or not gametime_iso:
        return None, None
    team = re.sub(r"^#\d+\s*", "", team)
    try:
        game_date = datetime.strptime(gametime_iso[:10], "%Y-%m-%d").date()
    except ValueError:
        return None, None

    for espn_path in SPORT_ESPN_PATHS.get(sport, []):
        data = _fetch(espn_path, game_date.strftime("%Y%m%d"))
        if not data:
            continue
        for event in data.get("events", []):
            try:
                competitors = event["competitions"][0]["competitors"]
            except (KeyError, IndexError):
                continue
            for c in competitors:
                if _team_matches(team, c.get("team", {})):
                    return event, c
    return None, None


def find_final_score(team, opponent, sport, gametime_iso):
    """Returns (team_score, opponent_score, team_won) for a specific
    already-known game, or (None, None, None) if the game can't be found
    or hasn't finished yet. team_won comes directly from ESPN's own
    `winner` field (confirmed directly it's present and handles overtime
    etc. correctly) rather than a hand-rolled score comparison, so a
    genuine tie -- where ESPN sets neither side's `winner` true -- is
    reported as such (team_won=False for both, but scores equal) rather
    than guessed."""
    event, team_c, opp_c = _find_event(team, opponent, sport, gametime_iso)
    if event is None:
        return None, None, None
    comp = event["competitions"][0]
    if not comp.get("status", {}).get("type", {}).get("completed"):
        return None, None, None  # found the game, but it isn't final yet
    team_score = to_num(team_c.get("score"))
    opp_score = to_num(opp_c.get("score"))
    if team_score is None or opp_score is None:
        return None, None, None
    return team_score, opp_score, bool(team_c.get("winner"))


def _find_individual_competition(name_a, name_b, sport, gametime_iso):
    """Like _find_event, but for INDIVIDUAL_SPORTS: one ESPN "event" here
    is a whole fight card (e.g. "UFC 320"), not one game, with every fight
    on the card as its own entry in that event's `competitions` list -- so
    every competition of every event has to be checked, not just
    `competitions[0]` the way every team-sport function above does.
    Competitors are `athlete` objects (fullName/displayName/shortName),
    not `team` ones -- matched the same permissive way _team_matches
    checks a team (exact match against any of several fields, or a
    substring of the full name), not just an exact _fold_name compare,
    since a pick is often entered as just a fighter's last name (e.g.
    "Ankalaev" for "Magomed Ankalaev") -- confirmed directly this was
    needed, an exact-full-name-only compare missed the real UFC 320
    main event entirely. Returns (competition, competitor_a,
    competitor_b) -- competitor_a always the one matching name_a -- or
    (None, None, None)."""
    if not name_a or not name_b or not sport or not gametime_iso:
        return None, None, None
    try:
        game_date = datetime.strptime(gametime_iso[:10], "%Y-%m-%d").date()
    except ValueError:
        return None, None, None
    date_str = game_date.strftime("%Y%m%d")

    def athlete_matches(candidate, athlete):
        candidate = _fold_name(candidate)
        if not candidate:
            return False
        fields = {_fold_name(athlete.get(f) or "") for f in ("fullName", "displayName", "shortName")}
        if candidate in fields:
            return True
        return candidate in _fold_name(athlete.get("fullName") or "")

    for espn_path in SPORT_ESPN_PATHS.get(sport, []):
        data = _fetch(espn_path, date_str)
        if not data:
            continue
        for event in data.get("events", []):
            for comp in event.get("competitions", []):
                competitors = comp.get("competitors", [])
                if len(competitors) != 2 or any("athlete" not in c for c in competitors):
                    continue
                c0, c1 = competitors
                a0, a1 = c0["athlete"], c1["athlete"]
                if athlete_matches(name_a, a0) and athlete_matches(name_b, a1):
                    return comp, c0, c1
                if athlete_matches(name_a, a1) and athlete_matches(name_b, a0):
                    return comp, c1, c0
    return None, None, None


def find_individual_result(name_a, name_b, sport, gametime_iso):
    """Returns {a_won, rounds} for a specific already-known individual-
    sport matchup (e.g. one UFC fight), or None if it can't be found or
    hasn't finished yet. `rounds` is the round/period the bout ended in
    (ESPN's status.period) -- what a "Total Rounds" bet needs to grade
    against, since there's no separate final-score number for a fight the
    way team sports have one. `a_won` comes directly from ESPN's own
    `winner` field, same reasoning as find_final_score above."""
    comp, ca, cb = _find_individual_competition(name_a, name_b, sport, gametime_iso)
    if comp is None:
        return None
    status = comp.get("status") or {}
    if not (status.get("type") or {}).get("completed"):
        return None
    return {"a_won": bool(ca.get("winner")), "rounds": status.get("period")}


def find_live_score(team, opponent, sport, gametime_iso):
    """Returns a dict describing this specific team-vs-opponent game's
    current state -- score so far (0-0 before kickoff), period/clock, and
    whether it's finished -- or None if the game can't be found at all.
    Unlike find_final_score, this works no matter the game's state (still
    scheduled, in progress, or already final); used to show a live score
    next to a still-Pending pick while its game is being played (see
    publish_parlay_stats.py and docs/parlay-results.html), not to grade
    anything."""
    event, team_c, opp_c = _find_event(team, opponent, sport, gametime_iso)
    if event is None:
        return None
    status = event["competitions"][0].get("status") or {}
    type_ = status.get("type") or {}
    return {
        "state": type_.get("state"),  # "pre" | "in" | "post"
        "completed": bool(type_.get("completed")),
        "period": status.get("period"),
        "clock": status.get("displayClock"),
        "team_score": to_num(team_c.get("score")),
        "opponent_score": to_num(opp_c.get("score")),
    }


def find_half_score(team, opponent, sport, gametime_iso):
    """Returns (team_half_score, opponent_half_score) -- the sum of the
    first two periods' linescores, i.e. the score at halftime -- for
    grading a "1st Half Spread" pick, which find_final_score's full-game
    score can't settle. (None, None) if the game can't be found, isn't
    final yet, or doesn't have at least two periods of linescore data."""
    event, team_c, opp_c = _find_event(team, opponent, sport, gametime_iso)
    if event is None:
        return None, None
    comp = event["competitions"][0]
    if not comp.get("status", {}).get("type", {}).get("completed"):
        return None, None

    def half(competitor):
        lines = competitor.get("linescores") or []
        if len(lines) < 2:
            return None
        values = [l.get("value") for l in lines[:2]]
        if any(v is None for v in values):
            return None
        return sum(values)

    team_half, opp_half = half(team_c), half(opp_c)
    if team_half is None or opp_half is None:
        return None, None
    return team_half, opp_half


def _group_matches_hint(group, hint):
    """A stat group is a match for `hint` if it's the group's own name
    (football's groups are named "passing"/"rushing"/etc.) or one of its
    other labels (basketball/baseball's groups aren't named, so e.g. MLB's
    batting table is told apart from its pitching table by the presence of
    an "AB" label, batting-only)."""
    if hint is None:
        return True
    if group.get("name") == hint:
        return True
    return hint in (group.get("labels") or [])


def _read_prop_stat_from_team_block(team_block, player_name, bet_type):
    """The box-score-reading half of find_prop_stat: given one team's
    block from a box-score summary, sums PROP_STAT_SPECS[bet_type] for
    player_name. Split out so both the fast (search-resolved team) path
    and the sweep-every-game-that-day fallback below share the exact same
    reading/matching logic.

    Returns (total, found). `found` is True only if the player was
    confidently located somewhere in this team's box score at all -- so a
    caller can tell "recorded a genuine zero in this stat" (found=True,
    total=0) apart from "not on this team's box score" (found=False)."""
    # Same nickname fallback find_player_team relies on (ESPN's own search
    # wants the formal first name) -- confirmed directly this matters here
    # too: "Matt Stafford" resolves to the Rams via the search's nickname
    # fallback, but the box score itself lists him as "Matthew Stafford",
    # so the name match below needs the same two spellings to try, not
    # just the one the pick was entered as.
    targets = {_fold_name(player_name)}
    variant = _nickname_variant(player_name)
    if variant:
        targets.add(_fold_name(variant))
    found_anywhere = False

    def stat_value(group, label):
        nonlocal found_anywhere
        labels = group.get("labels") or []
        if label not in labels:
            return None
        idx = labels.index(label)
        for ath in group.get("athletes", []):
            if _fold_name((ath.get("athlete") or {}).get("displayName") or "") not in targets:
                continue
            found_anywhere = True
            stats = ath.get("stats") or []
            return to_num(stats[idx]) if idx < len(stats) else None
        return None

    total = 0.0
    for label, hint in PROP_STAT_SPECS[bet_type]:
        groups = [g for g in team_block.get("statistics", []) if label in (g.get("labels") or [])]
        groups = [g for g in groups if _group_matches_hint(g, hint)] or groups
        value = next((v for g in groups for v in [stat_value(g, label)] if v is not None), None)
        if value is not None:
            total += value

    if not found_anywhere:
        # Never showed up under any of this stat's own labels -- confirm
        # they're in the box score at all (any group, any label) before
        # trusting a 0, since "didn't play" and "played, recorded a real
        # zero here" would otherwise look identical.
        for group in team_block.get("statistics", []):
            if any(_fold_name((a.get("athlete") or {}).get("displayName") or "") in targets
                   for a in group.get("athletes", [])):
                found_anywhere = True
                break
        if not found_anywhere:
            return None, False

    return round(total, 2), True


def _prop_stat_for_team(team, sport, gametime_iso, player_name, bet_type, require_final):
    """Looks up player_name's stat from one specific, already-known team's
    game -- the fast path find_prop_stat tries first. Returns (total, found)."""
    event, team_c = _find_event_for_team(team, sport, gametime_iso)
    if event is None:
        return None, False
    comp = event["competitions"][0]
    if require_final and not comp.get("status", {}).get("type", {}).get("completed"):
        return None, False

    summary = None
    for espn_path in SPORT_ESPN_PATHS.get(sport, []):
        summary = _fetch_summary(espn_path, event["id"])
        if summary and (summary.get("boxscore") or {}).get("players"):
            break
    if not summary:
        return None, False

    team_abbrev = (team_c.get("team") or {}).get("abbreviation")
    team_block = next(
        (p for p in summary["boxscore"]["players"] if (p.get("team") or {}).get("abbreviation") == team_abbrev),
        None,
    )
    if not team_block:
        return None, False
    return _read_prop_stat_from_team_block(team_block, player_name, bet_type)


def _sweep_prop_stat(player_name, bet_type, sport, gametime_iso, require_final):
    """Fallback for find_prop_stat when the fast (search-resolved team)
    path can't find the player: scans every game `sport` played on
    gametime_iso's date directly and checks each one's box score for
    player_name by name, instead of trusting find_player_team's search-
    based "current team" -- confirmed stale for more than one real
    recently-traded player (e.g. a WR's ESPN search hit still listing
    their old team months after a real trade). Doesn't need find_player_team
    to have found anything at all, either -- it only needs a name to
    fold-compare against real box-score athlete names, so this also
    recovers a player ESPN's own search returns zero hits for.

    Slower (one box-score fetch per game that day instead of one), which
    is exactly why it's a fallback, not the primary path. Only trusts a
    match if the player turns up in exactly one of that day's games -- if
    the same name shows up in two different teams' box scores that day,
    this stays unresolved rather than guessing which one was meant."""
    try:
        game_date = datetime.strptime(gametime_iso[:10], "%Y-%m-%d").date()
    except ValueError:
        return None, False
    date_str = game_date.strftime("%Y%m%d")

    hits = []
    for espn_path in SPORT_ESPN_PATHS.get(sport, []):
        data = _fetch(espn_path, date_str)
        if not data:
            continue
        for event in data.get("events", []):
            comp = (event.get("competitions") or [{}])[0]
            if require_final and not comp.get("status", {}).get("type", {}).get("completed"):
                continue
            summary = _fetch_summary(espn_path, event.get("id"))
            if not summary or not (summary.get("boxscore") or {}).get("players"):
                continue
            for team_block in summary["boxscore"]["players"]:
                total, found = _read_prop_stat_from_team_block(team_block, player_name, bet_type)
                if found:
                    hits.append(total)

    if len(hits) == 1:
        return hits[0], True
    return None, False


def find_prop_stat(player_name, bet_type, sport, gametime_iso, require_final=True):
    """Sums the box-score stat(s) PROP_STAT_SPECS maps bet_type to (e.g.
    Anytime TD sums rushing + receiving + return TDs) for player_name on
    gametime_iso's date.

    Two-tier lookup: first the fast path -- resolve player_name's team via
    find_player_team (the same ESPN player search this bet type's Sport/
    Gametime were originally resolved with) and check just that team's
    game. If that doesn't find the player (including if find_player_team
    itself found nothing), fall back to _sweep_prop_stat, which checks
    every game the sport played that date directly by name -- slower, but
    doesn't depend on search's "current team" field being accurate (it
    isn't, always -- confirmed directly for more than one real recently-
    traded player) or even returning a hit at all.

    Returns (total, found). `found` is True only if the player was
    confidently located somewhere in a box score at all -- so a caller
    can tell "recorded a genuine zero in this stat" (found=True, total=0)
    apart from "couldn't find this player" (found=False, needs a human
    instead of a guessed zero -- could be a real DNP, a name that doesn't
    match ESPN's box score spelling, genuine same-name ambiguity, or the
    game not being final yet).

    require_final=False skips the "is this game actually over" check, for
    showing a live in-progress stat (see find_live_score) rather than
    grading a final one -- auto_grade_results.py never passes this, since
    grading a still-in-progress stat as a final answer would be wrong."""
    team, resolved_sport = find_player_team(player_name, bet_type)
    if team:
        total, found = _prop_stat_for_team(team, resolved_sport or sport, gametime_iso, player_name, bet_type, require_final)
        if found:
            return total, found
    return _sweep_prop_stat(player_name, bet_type, sport, gametime_iso, require_final)


def to_num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
