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
