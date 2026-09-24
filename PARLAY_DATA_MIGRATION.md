# Parlay data migration — status

Long-term goal: get parlay data off the Google Sheet as the runtime
dependency, the same way league history moved to D1 with ESPN auto-updates,
while keeping manual bet entry (which can never be fully automated — someone
has to type in what they actually bet) as easy and low-error as possible,
and eventually auto-grade results against real game data instead of typing
Win/Loss by hand every week.

Three phases. **Phase 1 is done. Phases 2 and 3 have not been started.**

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

**Old "Parlay Tracker" is untouched** and is still what the live site
actually reads (see Phase 3) — nothing about the real pipeline has changed
yet.

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

## Phase 2 — Auto-grade results (NOT STARTED)

Idea, not yet built: reuse `worker/src/espn.js`'s `fetchNflScoreboard()`
pattern — a Workers-compatible, unauthenticated final-score feed at
`cdn.espn.com/core/nfl/scoreboard` (deliberately not `site.api.espn.com`,
which blocks Workers' IPs — see that file's comments). The same
`cdn.espn.com/core/{sport}/scoreboard` URL shape likely exists for other
ESPN-covered sports. Moneyline/Spread/Total bets (~72% of historical picks)
should be resolvable from final score alone; player props need a deeper
box-score endpoint not yet explored, and won't always be gradable that way.

Plan discussed with the user:
- Distinguish "Pending" (game hasn't happened) from "Needs Review" (game's
  over, resolver couldn't confidently grade it) so a human only has to look
  at the flagged handful, not scan every pick every week.
- The resolver can write results back into the sheet (needs the read-write
  Sheets scope, already used by the migration scripts) — but must **only
  fill blank Result cells, never overwrite an existing manual entry**, and
  should mark what it auto-graded (e.g. a cell note) so it's not a black box.
- Categories that will likely always need manual grading: player props
  (until a box-score source is built), sports/leagues ESPN doesn't cover,
  and anything a "push" needs to account for (the data model doesn't have a
  Push result yet, only Win/Loss/Pending — worth deciding if that's needed).

## Phase 3 — Switch the live pipeline (NOT STARTED — do this last)

`generate_parlay_data.py` (and therefore the site, the refresh button, the
scheduled GitHub Action) still reads from the old "Parlay Tracker" tab. The
user explicitly wants this switched **last**, after Phases 1 and 2 have
settled and the league is comfortable entering picks directly into
"Auto Parlay Tracker". When ready: rewrite `load_tracker()` (or a new
loader) to read the tidy layout instead, add dropdown-based sport/bet-type
validation is already in place, and only then tell the league to stop
using the old tab.

## Unrelated but same session: manual refresh button

Not part of this migration, but built in the same session: a "Refresh
Data" button on Jon's Table (`docs/parlay-results.html`) that POSTs to a
new Worker endpoint (`worker/src/parlayRefresh.js`, `POST /refresh-parlay`)
which dispatches the existing `refresh_parlay_data.yml` GitHub Action
on demand via a fine-grained PAT stored as an encrypted Worker secret,
with a 60s KV cooldown. This is done and working, no follow-up needed.
