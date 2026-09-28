# Parlay data migration — status

Long-term goal: get parlay data off the Google Sheet as the runtime
dependency, the same way league history moved to D1 with ESPN auto-updates,
while keeping manual bet entry (which can never be fully automated — someone
has to type in what they actually bet) as easy and low-error as possible,
and eventually auto-grade results against real game data instead of typing
Win/Loss by hand every week.

Three phases, **all three now done** -- plus a fourth piece folded in along
the way: the site no longer needs a git commit to show fresh parlay data
at all (see "Cloudflare architecture" below).

## Phase 1 — Normalize entry format (DONE)

Added a new tab, **"Auto Parlay Tracker"**, with a tidy one-row-per-pick
layout instead of the old tab's one-column-per-week layout:

```
Year | Week | Sacko | Player | Sport | Bet Type | Team | Opponent |
Player Prop | Line | Side | Odds | Gametime | Result | Raw Pick
```

- **`migrate_parlay_tracker.py`** — one-time historical migration. Reads the
  old "Parlay Tracker" tab, splits each pick's `"{Bet Type}: {details}"` text
  into the structured columns above (Money Line convention: first team
  listed is who was bet on — confirmed with the league). Already run
  successfully: 228 rows (19 weeks × 12 players), 0 currently flagged for
  manual review.
  **Do not re-run this once new picks start being entered directly into
  "Auto Parlay Tracker"** — it only knows about the old tab's history and
  would overwrite whatever's sitting in those same row positions. It also
  never touches column D (Player) or clears the whole sheet, so it can't
  clobber the auto-fill formula or the helper list past column O.

- **`setup_player_autofill.py`** — Player is auto-filled via a formula
  (`=INDEX(PlayerOrder,MOD(ROW()-2,12)+1)`) reading a "Player Order" helper
  list + named range off to the side of the table (column Q), since every
  week is always the same 12 managers in the same fixed order. No typing or
  dropdown needed — a brand new, completely empty row already shows the
  right name. **Re-run this if the 12-player roster ever changes.** It
  assumes every week is a genuine, position-aligned 12-row block; if that's
  ever violated again (see the Chad/Jeff incident below), fix the alignment
  before re-running or every name from that point on will be wrong.

- **`add_parlay_validation.py`** — dropdown validation on Sacko/Sport/Bet
  Type/Side/Result (Sacko/Side/Result strict-reject, Sport/Bet Type
  warn-only since new ones are plausible), plus a strict regex rule on
  Gametime requiring the exact `YYYY-MM-DDTHH:MM:SS` format the rest of the
  pipeline depends on for string-sortable chronological order (or blank).
  Player is intentionally not validated here — see autofill above.
  **Important:** Sheets validation only guards human entry through the UI,
  not API writes — confirmed directly, a malformed API write goes through
  untouched.

- **`format_parlay_sheet.py`** — visual polish: alternating background +
  a top border, both every 12 rows, purely mechanical (computed from row
  position, not from reading any data) so it covers the full 3000-row range
  in one static pass with no re-run ever needed for new weeks. Also freezes
  the header row + Year/Week/Sacko/Player columns, and adds guidance notes
  on the Bet Type/Team/Opponent/Player Prop/Line/Side headers explaining
  which fields matter for which bet type.
  (We tried a *live* conditional-formatting formula for the banding first —
  twice — and both attempts were unreliable in practice. Static/mechanical,
  keyed on the guaranteed-12-rows-per-week fact, is what actually works.)

**Known data fix made along the way:** 2026 week 2 was missing Chad and
Jeff's rows entirely (hadn't picked yet) and the existing rows had shifted
to fill the gap, which would have broken the position-based Player
formula for every row after it. Fixed by inserting blank placeholder rows
for both in their correct positions. If a week is ever short again (someone
hasn't picked by the time you need the sheet fully aligned), do the same:
insert blank rows in the correct position rather than appending at the end.

**Update:** the above described the state when Phase 1 first shipped. The
old "Parlay Tracker" tab has since been fully retired — see Phase 3 below,
which switched the live pipeline over to read "Auto Parlay Tracker"
directly, and the Cloudflare architecture section, which moved the site
off a git-committed JSON file entirely.

**Added since the above was first written:**

- **Final Odds / Final Payout / Final Split columns** (P/Q/R, after Raw
  Pick) — the combined 12-leg parlay's own odds and payout for the week,
  which the tidy layout was missing. Final Odds/Payout are once-per-week
  facts like Sacko; Final Split is a formula (`Final Payout / 12`, verified
  exactly against all 19 historical weeks), not something typed in. The
  "Player Order" helper list moved from column Q to U to make room.
- **`parlay_note_parser.py`** — a lenient parser for the actual shared iOS
  Note format (confirmed with a real sample), which is messier than the
  sheet's own convention: bet-type abbreviations (ML, Pass Yards, Rec
  Yards), reversed word order for player props ("Brian Thomas Jr o38.5"),
  odds with no explicit "+", and a trailing Final Odds/Payout pair. Tested
  against a real week's note two ways: every line round-trips correctly on
  its own, and cross-checked field by field against that week's
  already-transcribed sheet row (every difference found was a legitimate
  human correction, not a parser bug).
- **`parlay_gui.py`** — a simple tkinter desktop tool (for the 2 people who
  do data entry, not all 12 managers) with two tabs: Browse/Grade Past
  Weeks (load a year+week, edit any field including Result, save), and
  Enter New Week (loads whatever's already saved for that week so a
  partially-entered week doesn't start blank, paste the note and Parse it
  in, review/fix, Save). Reads/writes "Auto Parlay Tracker" directly via
  the same API pattern as the other scripts — no new backend.
  **Not yet run interactively** (verified as thoroughly as possible
  without a display: headless widget construction, real sheet reads, a
  full paste-to-save round trip against scratch rows with before/after
  verification) — next step is for you to actually run it and sanity-check
  the layout/usability, since tkinter layouts can surprise you in practice.
  Needs `gspread`, `google-auth`, `customtkinter`, and `tzdata` installed
  (`pip install -r requirements.txt`) and `google_secret.json` present —
  since that's a write-scoped credential, think about how to get it to the
  second person safely rather than just emailing/texting the file. See
  [PARLAY_GUI_SETUP.md](PARLAY_GUI_SETUP.md) for a full line-by-line setup
  guide for a second person starting from a bare Windows PC.
- **`espn_gametime_lookup.py`** — auto-fills Gametime (and Sport, since the
  note never mentions it either) right after Parse, for both team-based
  picks (Spread/Money Line/Totals) and player props (Anytime TD, Receiving
  Yards, etc. — via ESPN's player search, which returns the person's sport
  and current team in one call). Picks are entered Tue-Thu for games that
  can only be Thu through the following Monday, so it just checks ESPN's
  public scoreboard for those 5 days across every sport currently in use,
  rather than needing each sport's own "week number" (confirmed college
  football's doesn't line up with the NFL's). Team matching checks every
  name ESPN exposes (mascot, school/city, abbreviation), not just
  display name, since a pick can reasonably use either half (e.g. "Gators"
  or "Florida", "Knights" or "UCF"). Same-named people across sports are
  narrowed by which sports the bet type itself could plausibly be, and
  left unresolved (not guessed) if genuinely ambiguous.
  Verified end to end against the real shared note: 9 of 12 picks
  resolved automatically; the 3 misses were all legitimate (a genuine
  typo in the note, a real ambiguity between two same-named athletes, and
  a nickname ESPN's own search doesn't recognize) rather than lookup bugs.
  Takes ~30-40s for a full week the first time; the window will look
  unresponsive during that stretch since tkinter is single-threaded.

  All 3 of those misses were then addressed directly:
  - **Single-side fallback matching** — if a team+opponent search finds no
    game matching both sides, it now also tries matching just one side
    (team or opponent alone), and accepts that as a confident answer only
    if it's the *one* game across the whole 5-day window that side
    matches. This handles a misspelled team ("Gaytors") when the opponent
    ("Ole Miss") is spelled correctly — verified live: `find_gametime`
    now correctly resolves that exact real pick, while two intentionally
    bad team names on both sides still correctly returns no match.
  - **Nickname normalization for player search** — ESPN's player-search
    index wants the formal first name (confirmed: "Matt Stafford" finds
    nothing, "Matthew Stafford" finds one clean hit), so a small
    nickname→formal-name table (Matt/Mike/Chris/Nick/Josh/Jon/Zach/etc.)
    is tried as a fallback whenever the literal name from a note comes up
    empty. Verified live against "Matt Stafford" (resolves to Rams/NFL).
  - **NFL-over-NCAAF tiebreak** — when a name resolves to more than one
    real person and the ambiguity is *exactly* an NFL/NCAAF split (the
    common case — a player-prop bet type like "Receiving Yards" is
    plausible for both), it now prefers the NFL player as a last resort,
    per league request. Verified live: "Brian Thomas Jr." (two real
    people share that name — Jacksonville Jaguars NFL, Memphis Tigers
    NCAAF) now resolves to the Jaguars. Any other kind of ambiguity (e.g.
    two different NFL players sharing a name) is still left unresolved
    rather than guessed.
  With all 3 fixes in place, the real week-2 note now resolves 12 of 12
  picks automatically (up from 9 of 12).
- **GUI usability pass on `parlay_gui.py`:**
  - **Gametime displays/edits in human-readable form** ("Sat 09/26/2026
    03:30 PM") instead of the raw ISO the sheet actually needs
    (`2026-09-26T15:30:00`) — converted back to exact ISO right before
    writing (in both `WeekGrid.player_rows()` and, defensively, in
    `SheetClient.save_week()` itself, so it's correct no matter which
    caller builds the row dict). Manually typing a human time is far less
    error-prone than the strict ISO format.
  - **Result defaults to "Pending"** for every freshly parsed pick (a new
    week is for games that haven't been played yet), but only fills a
    still-blank Result — re-parsing a note over an already-graded row
    can't wipe out a real Win/Loss.
  - **Red "needs attention" highlighting** — after Parse (including the
    gametime lookup), any field still needing a human look — an
    unconfidently parsed bet detail, a missing odds value, or a
    gametime/sport the lookup couldn't find — gets a red field
    background. Uses the `clam` ttk theme specifically, since Windows'
    default theme largely ignores custom field colors on Entry/Combobox.
  - **Irrelevant fields grey out (disable) live** as Bet Type changes —
    e.g. Player Prop/Side disable for a Spread pick, Team/Opponent/Line
    disable for a player prop — using the same bet-type-category
    breakdown as `format_parlay_sheet.py`'s header notes.
  - **`parlay_note_parser.py` now understands the note's header block**
    (the "`<year> Week <n>:`" line, `Sacko:`, `Legs Due:`, `Max Odds:`)
    instead of flagging those lines as unmatched — Year/Week/Sacko are
    pulled out and used to prefill the GUI (Legs Due/Max Odds are
    silently skipped, since nothing in the sheet tracks them).
  All verified against the real week-2 note end to end (12/12 picks and
  the full header block parsed cleanly) plus a live scratch-row save
  confirming the gametime round-trips to the exact ISO format the
  sheet's validation requires.
- **Follow-up polish pass, after actually running the GUI:**
  - `find_gametime()` now also hands back ESPN's own clean team names for
    whichever game it matched, and Parse overwrites Team/Opponent with
    them -- fixes typos ("Gaytors" -> "Florida"), non-canonical
    alternates ("Carolina" -> "Panthers"), and prefixes ranked college
    teams with their current AP/CFP-style rank ("#4 Ole Miss"), sourced
    from ESPN's `curatedRank.current` (which uses 99, not 0/null, to mean
    "unranked" -- confirmed directly, filtered out explicitly).
  - Disabled (greyed-out) fields weren't visually distinct enough in
    practice -- fixed with an explicit ttk style map so enabled/disabled/
    needs-attention are three clearly different colors.
  - "Enter New Week" is now the first and default tab.
  - Applied a UCF Knights black-and-gold look to the app chrome, keeping
    every data-entry field white/black for legibility per explicit
    request.
- **Ported the GUI from ttk to CustomTkinter**, after feedback that the
  bright-gold-on-black ttk version looked "kinda bad" -- three palette
  options (muted gold, cool blue/teal, light) were mocked up as an HTML
  comparison first (see the memory this session saved on that workflow),
  muted gold was picked, and then the question came up of whether the
  actual app could look as polished as the HTML mockup. ttk's per-widget
  styling turned out to be the real limiter (state-based colors only work
  through its finicky style-map system, no real rounded corners, fighting
  the OS theme), so the whole widget layer was ported to CustomTkinter
  (`pip install customtkinter`), which takes colors directly per widget
  instance instead. All business logic (SheetClient, note parsing,
  gametime lookup wiring, field relevance/highlighting) is unchanged --
  only the widget classes changed (ttk.Frame/Label/Entry/Combobox/
  Notebook -> CTkFrame/Label/Entry/ComboBox/Tabview). Two behavioral notes
  from the port: CTkLabel doesn't actually support live `textvariable`
  binding (silently a no-op, confirmed directly), so the Split figure is
  pushed in manually via `.configure(text=...)` instead; and CTkTabview's
  segmented-button text color is a single value with no separate
  selected/unselected override, so both tab states share one off-white
  text color rather than the exact dark-on-gold/light-on-charcoal split
  the mockup showed for the active tab. Verified via headless construction,
  a full paste-to-save round trip against the real note (still 12/12
  picks resolved), and a live scratch-row save confirming the gametime
  ISO round-trip still works correctly under the new widget stack.
- **Save now also writes Raw Pick (column O)** -- previously Save only
  wrote E:N, silently dropping the original note line the parser already
  extracts per pick. It's threaded through as a non-visible field (no
  grid widget -- it's an audit trail, not meant to be hand-edited):
  apply_parsed() sets it from the parse, load() reads it back so an
  existing week survives a load-then-resave in Browse/Grade without
  losing it, and the write range extends to E:O. "Load / Start This
  Week" is now just "Load" -- the existing logic already starts fresh
  whenever the entered week has no rows.

**Resolved loose end:** the `Jon, 2025 week 5` pick that used to read
`Bet Type = Pass` (but carried real odds, gametime, and a graded "Win",
so it clearly wasn't a genuine skip) has been fixed at the source in
"Parlay Tracker" -- it was a truncated entry, actually
`Passing TD: Over 1.5 Bryce Young`. Verified live: "Auto Parlay Tracker"
correctly reflects the fix (Bet Type `Passing TD`, Player Prop
`Bryce Young`, Line `1.5`, Side `Over`), and the Raw Pick column and the
source tab agree.

## Phase 2 — Auto-grade results (DONE)

**`auto_grade_results.py`** fills in Result ("Win"/"Loss") for picks still
Pending whose Gametime has passed, using real final scores from ESPN
(`site.api.espn.com`, reusing `espn_gametime_lookup.py`'s fetch/team-
matching machinery directly -- accessible from a plain Python script
without the Workers-IP-blocking problem `cdn.espn.com` was originally
going to work around, since this runs as a script, not inside a Worker).

Only Money Line, Spread/Alt Spread, and Total Points/Goals/Rounds are
graded — fully determined by a final score alone. Everything else (1st
Half Spread needs the halftime score; player props and Anytime TD need a
box score; Coin Toss isn't something ESPN reports) always needs a human,
and is reported separately rather than silently skipped. A push (the
score lands exactly on the line) is also left for manual review rather
than guessed, since the Result column still only has Win/Loss/Pending —
deliberately not extended to a fourth "Push" value for now (a plain
"leave it pending, flag it" approach was chosen over a data-model change
that would also touch the sheet's validation, the GUI, and
`generate_parlay_data.py`'s stats math).

**Now runs automatically every 30 minutes**, as a step in
`refresh_parlay_data.yml` right before that same run republishes stats to
KV and syncs picks to D1 — so any of a week's 12 picks grades within one
cycle of its own game finishing (each pick checked independently; nothing
waits for all 12 games to be done), no manual trigger needed. Uses the
same `GOOGLE_CREDENTIALS` secret every other scheduled script already has
— no new credential was needed, since a service-account key isn't
scope-*restricted* to read-only, the read-only scripts just never asked
for write scope. (Originally this ran by hand only, keeping the
write-scoped credential out of CI while the logic was unproven — promoted
to scheduled after the extensive historical verification below, and
confirmed working live in CI: the "Grade Finished Games" step ran clean
on the very first scheduled run after being added.) Never touches a
Result that's already Win/Loss, and leaves a cell note (final score +
when) on anything it grades. Can still be run by hand too, including
`--dry-run` to preview.

Verified two ways: `--dry-run` against the live sheet's current Pending
picks, and — more thoroughly — by running the grading logic against 165
already-graded historical picks without writing anything: 136 exact
matches, 26 "no score found" (informal historical team names like
"Bucs"/"Pats" that don't match any of ESPN's own team name fields — fails
safe, flagged rather than guessed, and not a concern going forward since
new picks get ESPN-normalized names automatically via the GUI's lookup),
and 3 cases investigated directly against raw ESPN data: one genuine tie
(correctly left unresolved for a money line), one exact push the sheet
recorded as a Loss instead of a push, and **one that looks like a real
pre-existing grading error in the historical sheet** — a 2025 week 15
Ole Miss/Tulane Total Points pick, final score 41-10 (a 51 total),
recorded as a Win for an "Over 52" bet, when 51 is actually under 52 and
should have lost. Not corrected automatically — flagged for a human
decision, same principle as everything else this script does.

**Extended since the above was first written: every bet type except Coin
Toss is now auto-graded**, not just Money Line/Spread/Alt Spread/Totals.
Two more kinds of ESPN data feed this, alongside the plain final score:

- **1st Half Spread** — `find_half_score()` sums the first two periods'
  linescores (ESPN's scoreboard event already includes these, no separate
  fetch needed) to get the score at halftime specifically, since the
  final score can't settle this one.
- **Player props** (Anytime TD, Receiving/Passing Yards, Receptions,
  Interceptions, Total Yards, Player Points, Home Runs) —
  `find_prop_stat()` resolves the player's team via the same ESPN player
  search `find_player_team()` already used at entry time (Team isn't
  recorded on these rows, only Sport and Player Prop), locates that
  team's specific game, and reads the relevant stat off ESPN's box score
  (`.../summary?event=...`, `boxscore.players[].statistics[]` — a set of
  named stat groups for football, one flat group for basketball, batting
  + pitching for baseball; `PROP_STAT_SPECS` in `espn_gametime_lookup.py`
  maps each bet type to the label(s) to sum, e.g. Anytime TD sums rushing
  + receiving + return TDs). "Nx Name" (e.g. "2x Rashee Rice", a 2-or-more
  -TDs leg) is handled by requiring the summed count meet N instead of 1.
  A player who can't be confidently matched in the box score at all is
  left for manual review rather than graded a guessed zero.

  Verified against 49 already-graded historical picks covering every prop
  bet type in real use: 38 confidently regraded, all 38 matching the
  sheet's existing Win/Loss exactly (0 mismatches); the other 11 came back
  "needs review" for a legitimate reason each time — genuine same-name
  ambiguity ESPN's own search doesn't resolve (two different real NFL
  players both named "Josh Allen"), a real pick-entry typo ("Isiah" for
  "Isaiah" Likely), or an ESPN search-index quirk (a punctuation variant
  of a name returning zero hits), not a grading bug. One real bug *was*
  found and fixed along the way: `find_player_team`'s exact-name match
  compared names with punctuation still in them, so "DJ Moore" (as
  entered) never matched ESPN's own "D.J. Moore" search result at all —
  fixed by comparing through the same punctuation-stripped fold used for
  box-score name matching (`_fold_name`), which incidentally also fixed
  this for the entry-time GUI autofill, not just grading.

**Also added: an intermittently-updating live score.** While a pending
pick's game is actually in progress, `publish_parlay_stats.py`'s
`build_live_scores()` (run in the same 30-minute cycle as grading) looks
up its current score (team bets) or current stat (player props) via
`find_live_score()`/`find_prop_stat(..., require_final=False)`, and tints
it green or red by feeding that in-progress number through the exact same
grading math (`grade_pick`/`grade_over_under`) used for the final result
— "currently covering," not just "currently ahead." `docs/parlay-results.html`
re-polls `/parlay-stats` every 2 minutes (independent of the full
30-minute data refresh) and re-renders just the current parlay card, so a
game's score updates without a manual reload.

**Also added: a permanent "why" once a leg is decided.** `auto_grade_results.py`
now writes the score/stat it actually graded a pick from into a "Grade
Detail" sheet column (e.g. "17-10 final" or "Matt Stafford: 390"), so
`docs/parlay-results.html` can show it next to the Win/Loss pill for the
current week and every past week the picker can reach, not just while the
game's live. `--backfill` fills this in for picks graded before the
column existed, without touching their already-correct Result; run once
against the full history, covering 204 of 228 picks after the team-name
fixes below (up from 189 the first time).

**Also fixed: several of the "no score found" gaps from the original
verification above weren't genuine ESPN coverage gaps at all.** Working
through the remaining skipped picks one by one against real ESPN
responses found three distinct, fixable causes, not one:
- **Informal team nicknames** ("Bucs"/"Buccs", "Pats", "Jags", "Preds",
  "Man U", "WV") don't appear in any of ESPN's own name fields for that
  team -- confirmed directly for each. `TEAM_NICKNAMES` in
  `espn_gametime_lookup.py` maps them to a name ESPN does expose, checked
  as an additional exact-match candidate in `_team_matches` (not folded
  into the substring fallback, so a short one like "WV" can't accidentally
  match an unrelated team).
- **Punctuation** -- "Hawaii" (as entered) vs ESPN's own "Hawai'i" -- the
  same class of gap already fixed for player names via `_fold_name`, now
  also applied to team matching as a punctuation-stripped fallback
  comparison.
- **NCAAM's default scoreboard only returns a small "featured games"
  subset**, not the full Division I slate -- confirmed directly: a real
  Friday's response had 2 games instead of 26. College football already
  worked around this same behavior for FBS (group 80); `FULL_GROUP_BY_PATH`
  generalizes that to also request college basketball's Division I group
  (50).

Verified against the real historical data these fixes apply to: all 15
newly-resolvable picks matched the sheet's already-recorded Win/Loss
exactly before anything was written.

**Remaining known gaps, categorized (not yet fixed):**
- **Missing soccer leagues** -- Ligue 1 (France), Eliteserien (Norway),
  the English Championship/League One, and international/national-team
  friendlies aren't in `SPORT_ESPN_PATHS` at all. Adding a league is
  cheap; the open question is which ones are worth it for how often
  they'd actually come up.
- **Individual sports have a completely different ESPN response shape**
  -- UFC/Boxing use `athlete` competitors instead of `team` ones (not
  just different field names, a different competitor object entirely),
  and Women's Tennis events don't even have the `competitions` key
  `_find_event` assumes every sport has. Fixing this means new matching
  logic, not a name mapping -- a bigger, separate piece of work for very
  few historical picks (one each).
- **At least one pick's recorded Gametime looks stale/wrong** (a "Knicks
  vs Magic" pick whose recorded date has no such game on ESPN's
  schedule at all) -- a data-entry issue to fix in the sheet directly,
  not something a lookup-logic change can paper over.
**Also fixed: the player-name-matching gaps from above turned out to be
mostly one root cause, not several.** Working through them individually
against real ESPN data found that most weren't genuine ambiguity at all --
ESPN's own player-search index returns a **stale "current team"** for a
recently-traded player (confirmed directly for more than one real case:
Hollywood Brown's search hit still listed Philadelphia months after his
real trade to Kansas City; D.J. Moore's still listed Carolina years after
his trade to Chicago; A.J. Brown's search hit resolves to an unrelated
"New England Patriots" entry instead of the real Eagles WR at all). Since
`find_prop_stat` was trusting that team field to know which game's box
score to check, a stale or wrong team meant it always came up empty, even
though the player really did show up in a real box score that week -- just
for a different team than search claimed.

`find_prop_stat` now tries a fast path first (search-resolved team, as
before), and if that doesn't find the player, falls back to
`_sweep_prop_stat`: scan every game the recorded sport played on
Gametime's date directly and check each one's box score for the player by
name, instead of trusting search's team field at all. Slower (one
box-score fetch per game that day instead of one), which is why it's a
fallback and not the primary path -- but it doesn't need
`find_player_team`'s search to have found anything to begin with, so it
also recovers a name ESPN's search returns zero hits for (e.g. "JaMarr
Chase", which only matches search as "Ja'Marr Chase" but matches a real
box score either way once compared through the punctuation-stripped
`_fold_name`). Only trusts a match if the player turns up in exactly one
of that day's games -- a real remaining ambiguity (two different NFL
players sharing a name, both actually playing that day) still stays
unresolved rather than guessing.

Also added "vlad" -> "vladimir" to `NICKNAME_TO_FORMAL` (same pattern as
the existing Matt/Mike/Chris/etc. entries) -- Vlad Guerrero Jr.'s pick
text doesn't match the box score's "Vladimir Guerrero Jr." without it.

Verified against the real historical data: re-ran the full 49-pick
verification from Phase 2's original check afterward -- 48 of 49 now
regrade correctly (up from 38), still 0 mismatches. Ran `--backfill`
again, bringing Grade Detail coverage to 214 of 228 historical picks (up
from 204). The one player case still unresolved, "Isiah Likely" (real
spelling "Isaiah"), is a genuine pick-entry typo -- deliberately not
"fixed" with a generic typo-correction map, since "Isiah" is itself a
real, distinct name for other real people (e.g. NBA Hall-of-Famer Isiah
Thomas), so guessing it always means "Isaiah" risks a wrong resolution
for someone else down the line. Better fixed at the source, in the sheet
-- corrected directly (`Isiah Likely` -> `Isaiah Likely` in row 159's
Player Prop) once confirmed. Its Grade Detail still couldn't be
backfilled even after the correction, though -- the real reason turned
out to be a DNP (he doesn't appear in the Ravens' box score for that
game at all, consistent with a real injury absence that week), not a
name-matching gap, so it's deliberately left blank rather than guessed.

**Also added: UFC (one of the individual sports).** Unlike every other
sport here, an individual-sport ESPN "event" isn't one game -- it's an
entire fight card, with every fight as a separate entry in that event's
`competitions` list (confirmed directly for UFC 320: `competitions[0]`
was an undercard fight, not the Ankalaev/Pereira main event the pick was
actually about). Competitors are `athlete` objects, not `team` ones, and
there's no final-score number for a "Total Rounds" bet -- that's the
round the bout ended in (`status.period`), not a score to sum.
`INDIVIDUAL_SPORTS`, `_find_individual_competition`, and
`find_individual_result` in `espn_gametime_lookup.py` handle this shape;
`auto_grade_results.py` dispatches to them by sport before falling into
the normal team-score path. Matching a fighter also needed to be more
permissive than an exact name compare -- a pick is often entered as just
a last name ("Ankalaev" for "Magomed Ankalaev"), confirmed directly this
matters, so it's matched the same permissive way `_team_matches` checks
a team (exact match against several fields, or a substring of the full
name).

**Boxing and Women's Tennis remain unsupported, for different reasons:**
- **Boxing has no working ESPN scoreboard path at all**, confirmed
  directly -- every candidate tried (`boxing/boxing`, `boxing/mens`,
  `boxing/fight`, `combat/boxing`, bare `boxing`) returns HTTP 400/404,
  not just "no events that day." The previously-listed `boxing/boxing`
  path was removed from `SPORT_ESPN_PATHS` -- it never worked, so a
  Boxing pick now fails fast to manual review instead of burning a full
  retry-with-backoff cycle (up to ~37s) on a request that can never
  succeed.
- **Women's Tennis has a much more complex shape than any other sport
  here**, confirmed directly: one ESPN "event" is an entire ~2-week
  tournament (with a date range, not a single date), containing
  `groupings` (e.g. Women's Singles vs. doubles), each with its own
  `competitions` list spanning every day of the tournament -- nothing
  like the "one event = one game/card on one date" shape every other
  sport (including UFC) fits. Deferred as a separate, larger piece of
  work for what's so far been a single historical pick.

## Phase 3 — Switch the live pipeline (DONE)

`generate_parlay_data.py`'s `load_tracker()` now reads "Auto Parlay
Tracker" directly — the old "Parlay Tracker" tab is no longer read by
anything. Each pick's "pick" text (used for the bet-type breakdown and
over/under stats) is reconstructed from the new tab's structured columns
into the exact same `"{Bet Type}: {details}"` convention the old tab's
Pick column already used, so `compute_stats()` and every per-week
derivation function needed zero changes.

Verified by loading both tabs' current data side by side and diffing the
full computed output: every difference was either cosmetic text
normalization ("vs" vs "vs.") or reflected genuinely fresher data already
corrected in the live sheet (team names/gametime the GUI's ESPN lookup
had already fixed) — zero actual win/loss or stat computation
differences. The league can now stop using "Parlay Tracker" entirely.

## Cloudflare architecture — parlay data no longer needs a git commit

Folded in alongside Phases 2/3, after discussing it directly: the site
used to need a git commit (via the scheduled/on-demand "Refresh Parlay
Data" Action writing `docs/data/parlay.json`) for any data update to
reach it. That's now gone, using the exact pattern the Dashboard rewrite
already proved out for live fantasy data (see `worker/src/index.js`'s own
comments) — a KV-cached payload served by the Worker, no GitHub Pages
rebuild in the loop:

- **`publish_parlay_stats.py`** — reuses `generate_parlay_data.py`'s
  `load_tracker()`/`week_state()`/`compute_stats()` completely unchanged,
  but pushes the resulting JSON straight to Cloudflare KV (`wrangler kv
  key put --remote`, the KV namespace already shared with the Dashboard
  cache) instead of writing a file for git to commit. Reuses the exact
  CI secrets (`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`) the D1
  history sync already has — no new credential needed anywhere.
- **`GET /parlay-stats`** (new Worker route, `worker/src/index.js`) — a
  plain KV read, no live computation in the Worker itself. Reusing the
  proven Python stats logic here (rather than reimplementing win/loss
  tie-break, kill, and highlighting logic in JS) was a deliberate choice
  to avoid a parallel-maintenance risk for a system that's been tuned
  over many iterations.
- **`docs/parlay-results.html`** now fetches from that endpoint instead
  of the static JSON file — identical shape, so nothing downstream of
  the fetch changed.
- **`refresh_parlay_data.yml`** (same scheduled/on-demand Action, same
  filename so the site's existing "Refresh Data" button needed no
  changes) now runs `publish_parlay_stats.py` instead of committing a
  file.
- **`sync_parlay_to_d1.py`** + a new Cloudflare D1 database
  (`retirement-league-parlay`, see `parlay_schema.sql`) additionally
  mirrors every raw pick row into D1 — durable, queryable storage for
  the picks themselves, the same Sheet-is-source-of-truth /
  D1-is-a-synced-mirror relationship league history already has. Not
  what the site actually reads day to day (that's still the KV blob
  above) — this is for durability and whatever queries the future wants,
  wired into the same scheduled Action.
- Read/write volume at this project's actual scale (a private 12-person
  league site) is roughly 0.01–1% of either service's free tier no
  matter how this is built — confirmed by walking through the actual
  numbers (picks/week, page views/week) before starting, so this wasn't
  a quota-driven decision.

Two real gotchas hit along the way, worth remembering:
- `wrangler kv key put ... --remote` failed with a confusing
  "Authentication error" on a colon-containing key name (e.g.
  `"parlay:stats"`) from this CLI/account, even though the account's
  OAuth token clearly had the right scopes and a plain alphanumeric key
  name worked fine — and even though the Worker's own runtime KV binding
  handles colon-containing keys (like the existing `"dashboard:v2"`)
  without any issue. Not chased further; every key this session writes
  via the CLI just avoids colons.
- **The first live CI run of the KV publish step failed** with the same
  "Authentication error" — this one for a real reason: the
  `CLOUDFLARE_API_TOKEN` GitHub secret is a narrowly-scoped API token
  (not the full-account OAuth login used for local testing), and it only
  had `Account.D1` permission — enough for the D1 sync (and for the
  pre-existing league-history D1 sync, which is presumably what it was
  originally created for) but nothing for KV. Fixed by adding "Workers
  KV Storage: Edit" to that same token in the Cloudflare dashboard and
  updating the GitHub secret with the refreshed value. Also exposed a
  real workflow bug in the process: GitHub Actions skips later steps in a
  job by default once one fails, so the KV failure was silently also
  skipping the unrelated D1 sync step right after it — fixed by adding
  `if: ${{ !cancelled() }}` to the three independent steps (grade,
  publish, sync) so one failing doesn't hide whether the others would
  have worked. Confirmed fixed: both steps ran clean on the next attempt,
  verified live against both the `/parlay-stats` endpoint and a direct
  D1 row count.

## Unrelated but same session: manual refresh button

Not part of this migration, but built in the same session: a "Refresh
Data" button on Jon's Table (`docs/parlay-results.html`) that POSTs to a
new Worker endpoint (`worker/src/parlayRefresh.js`, `POST /refresh-parlay`)
which dispatches the existing `refresh_parlay_data.yml` GitHub Action
on demand via a fine-grained PAT stored as an encrypted Worker secret,
with a 60s KV cooldown. This is done and working, no follow-up needed.
