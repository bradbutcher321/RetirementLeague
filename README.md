# Retirement League

Companion website for the Retirement League fantasy football league — a
static site (GitHub Pages), a Cloudflare Worker that talks to ESPN directly
for the live Dashboard, and a Python script that keeps the Franchise page's
career stats in sync with the league's Google Sheet.

**Live site:** https://bradbutcher321.github.io/RetirementLeague/

## Pages

- **Live Dashboard** (`docs/index.html`) — current week's median splits,
  matchups, superlatives, and standings. Fetches directly from the
  `worker/` Cloudflare Worker on page load, auto-refreshing every couple
  minutes.
- **Franchise** (`docs/franchise.html`) — career stats per manager, picked
  from a dropdown, in tabs: Performance (streaks, regular season/playoffs),
  Scoring (points, median, money), Efficiency (starters vs. the best lineup
  that could've been set — see below), Rivalries, Draft & Roster, and
  History. Reads a static `docs/data/franchise.json` file, since this data
  only changes when results are entered.
- **Parlay Results** (`docs/parlay-results.html`) — the current week's
  parlay (with a week/year picker for past weeks), plus betting stats,
  breakdowns, and "how far parlays get" charts, each with their own
  year / all-time tabs. Reads live from the Worker's `/parlay-stats` route
  (see the Cloudflare architecture note below), not a committed file.
- **Rule Changes** (`docs/rule-changes.html`) — year tabs (2015, and every
  later year something changed) for a full rules card shown side by side
  with the current rules, each including buy-in/payout amounts and that
  year's managers; plus a timeline below recapping what changed each year
  (format, buy-in, and manager turnover). Reads a static
  `docs/data/rule-changes.json` file.
- **Draft Board** (`docs/draft-board.html`) — every year's snake draft as a
  round-by-round grid, one card per pick (position, positional rank, NFL
  team, keeper flag), with a year picker. Reads a static
  `docs/data/draft-board.json` file.
- **Standings** (`docs/standings.html`) — regular-season or final standings
  for any year.
- **Head to Head** (`docs/head-to-head.html`) — pick two teams to compare
  their all-time and postseason results, with every game listed.
- **Overview** (`docs/overview.html`) — champions, sackos, title games,
  season and weekly scoring records, rankings, earnings, and streaks.
- **Game Records** (`docs/game-records.html`) — top-10 single-game records,
  all-time or for a single season.

Standings, Head to Head, Overview, and Game Records all read
`docs/data/league.json` and share `league.css` / `league-common.js`.

## How it updates

- **`worker/`** — a Cloudflare Worker (`worker/src/`) that the Dashboard
  calls directly. It hits the ESPN Fantasy API itself (JS port of the
  vendored `espn_api/` Python library's logic), computes the same payload
  `index.html` needs, and caches it in Workers KV for two minutes so
  repeated page loads don't hammer ESPN. It also runs on a Cloudflare Cron
  Trigger (see the Parlay bullet below) — the one part of this repo's
  scheduling that isn't GitHub Actions, because GitHub's own `schedule:`
  trigger proved unreliable at 30-minute granularity. See
  `worker/wrangler.toml` for config; `ESPN_SWID`/`ESPN_S2`/`GITHUB_PAT` are
  set via `wrangler secret put` rather than committed.
- **Site analytics** — every page loads `docs/track.js`, which sends an
  anonymous random id plus the page name to the Worker (`worker/src/analytics.js`),
  stored in a D1 database (`worker/schema.sql`). The Live Dashboard's "Site
  Activity" section shows active now, unique visitors and page views today,
  the last 7 days, and top pages. Set `localStorage.setItem('rl-notrack', '1')`
  in a browser to stop counting your own visits.
- **`generate_franchise_data_d1.py`** — reads career stats from D1 (the
  same history the Worker and Standings/Overview pages use) plus the
  sheet's `Money Tracker` tab, and writes `docs/data/franchise.json`. It
  reuses `authorize`, `load_money`, and `SHEET_ID` from the older
  **`generate_franchise_data.py`** (the pre-D1, sheet-only version, kept
  around as a shared module rather than a second pipeline) instead of
  duplicating them. Also computes lineup-efficiency stats (career/season
  starters-vs-optimal percentage, points left on the bench, the single
  worst bench miss, and an "optimal record" recomputing regular-season
  W/L with each week's best possible lineup instead of what was actually
  started) from D1's `roster_entries` table — per-player weekly box scores,
  starters and bench both, only populated 2019 on (see `database/schema.sql`)
  — using a greedy optimal-lineup solver (`optimal_lineup_points`) that
  fills each strict position slot with its best scorer(s) first, then the
  flex slot(s) with the best players left over; provably optimal since
  there's exactly one flex category. Runs Tuesday/Thursday mornings and
  on-demand, in the same workflow as the Draft Board and Rule Changes
  scripts below (`.github/workflows/refresh_franchise_data.yml`).
- **`generate_draft_board_data.py`** — reads `teams`, `draft_picks`, and
  `players` from D1 (plus each player's NFL team, taken from their
  earliest scored `roster_entries` row that year) and writes every year's
  draft as a round × slot grid to `docs/data/draft-board.json`. Runs on
  the same Tuesday/Thursday schedule as the Franchise script above.
- **`generate_parlay_data.py`** — reads the sheet's `Auto Parlay Tracker`
  tab (one row per pick) and reproduces the stats the sheet's old `Parlay
  Results` tab used to compute with formulas. Its output isn't written to
  a committed file anymore — **`publish_parlay_stats.py`** reuses this
  script's stats logic unchanged but pushes the result straight to
  Cloudflare KV, which a Worker route (`GET /parlay-stats`) serves to the
  site directly, no git commit or GitHub Pages rebuild involved. Runs
  every 30 minutes via a **Cloudflare Cron Trigger** (`worker/wrangler.toml`'s
  `[triggers]`, handled by `scheduled()` in `worker/src/index.js`), not
  GitHub Actions' own `schedule:` — that was observed firing every 2.5-5.5
  hours instead of every 30 minutes (a documented GitHub Actions
  limitation: the `schedule` event is best-effort and can be silently
  dropped, worst right at `:00`/`:30` when everyone else's crons also
  fire). The Cron Trigger dispatches
  `.github/workflows/refresh_parlay_data.yml` (`workflow_dispatch`-only
  now) the same way the "Refresh Data" button on the Parlay Results page
  already did — `worker/src/parlayRefresh.js`, `POST /refresh-parlay` —
  so both paths share one dispatch function and its cooldown. Also syncs
  every pick into a dedicated D1 database (`sync_parlay_to_d1.py`) for
  durable, queryable storage. **`auto_grade_results.py`** fills in
  Result (Win/Loss) for finished games using real ESPN final scores; also
  runnable on-demand and with `--dry-run` to preview without writing. It's
  the first step in that same 30-minute cloud workflow run, and grading
  works from there again as of `espn_gametime_lookup.py`'s `_fetch` using
  `site.web.api.espn.com` instead of `site.api.espn.com` — same request
  shape, but not behind the WAF rule that blocked every scoreboard lookup
  from GitHub Actions'/Cloudflare's shared IP ranges outright (confirmed
  directly: HTTP 403 on `site.api.espn.com` from every cloud IP tried,
  unaffected by browser-real headers, an authenticated ESPN session
  cookie, or a 37s retry/backoff schedule; `site.web.api.espn.com` just
  works — `search_player()` in the same file was already on that host).
  **`run_parlay_refresh.ps1`** runs the same three steps (grade, publish,
  sync) locally as a fallback, but isn't currently scheduled — it was a
  Windows Scheduled Task ("RetirementLeague Parlay Refresh") every 30
  minutes while cloud grading was blocked, removed now that it isn't;
  re-register it the same way if `site.web.api.espn.com` ever gets
  blocked too. See [PARLAY_DATA_MIGRATION.md](PARLAY_DATA_MIGRATION.md) for the full
  story of this migration (now complete) and
  [PARLAY_GUI_SETUP.md](PARLAY_GUI_SETUP.md) to set up `parlay_gui.py`,
  the desktop tool for entering/grading picks.

- **`generate_league_data_d1.py`** — writes `docs/data/league.json`'s
  per-season rollups and draft order from D1 (`teams`/`matchups`/
  `draft_picks`), the same way `generate_franchise_data_d1.py` does. The raw
  game log (`games`, with each game's Reg/Play/Champ/3rd/5th/Sacko/Cons/Bye
  type tag) and earnings still come from Game Tracker/Money Tracker — D1
  can't reproduce those bracket-position labels, and Money Tracker has no
  ESPN equivalent. Runs every few hours and on-demand
  (`.github/workflows/refresh_league_data.yml`).
- **`sync_scores_to_sheet.py`** — fills Game Tracker's S1/S2 score cells
  (and, for a still-blank Reg/Bye/Sacko row, the player names too) from D1
  once a game is actually decided there; Winner/Margin/Total/Median are
  sheet formulas derived from S1/S2, so nothing else needs writing. Never
  overwrites a name once it's set, and never guesses at a Play/Cons/3rd/
  5th/Champ row's pairing (same bracket-position limitation as final
  standings below) — but a score that no longer matches D1's current value
  *is* re-written, so it doubles as a correction check, not just a
  first-fill. Only ever looks at the current season; older, settled
  seasons are never re-touched even if D1 and the sheet happen to disagree
  on some long-ago score. Runs twice
  (`.github/workflows/sync_scores_to_sheet.yml`) and on-demand: Tuesday
  12:30am Eastern, shortly after Monday Night Football wraps, and again
  Wednesday 5pm Eastern to catch any score ESPN revises after first
  marking a game final. Run it locally with `--dry-run` first
  to preview a week before trusting a new run, or `--simulate
  YEAR:INTO_WEEK:FROM_WEEK` to exercise the full pipeline against a
  not-yet-played week using an already-final week's real scores (always
  forces `--dry-run` unless `--confirm-write` is also given).
- **Final standings**: both scripts above override ESPN's own
  `final_standing` with the league's actual rule
  (`database/history_lib.compute_final_standings`, one shared function so
  Franchise and Standings/Overview can never disagree) — a team that made
  the real playoff bracket keeps ESPN's result; every other team just keeps
  its regular-season standing, since the "loser's bracket" placement games
  don't mean anything to this league; and from 2025 on, the two worst
  regular-season teams' spots are instead decided by the Sacko game
  (`season_sackos`) — the winner takes 2nd-to-last, the loser is the Sacko,
  dead last.
- **`generate_rule_changes_data.py`** — writes `docs/data/rule-changes.json`
  from D1's `league_settings` and `teams` tables (real ESPN rule and
  manager-roster history, every year 2015-present) plus the sheet's
  `Money Tracker` tab (buy-in and payout amounts, which have no ESPN
  equivalent). Runs on the same Tuesday/Thursday schedule as the Franchise
  and Draft Board scripts above (a rule/buy-in/manager change is rare, but
  riding the existing schedule is free), plus on-demand.
- **`database/update_history_d1.py`** — the daily foundation everything
  above reads from: re-derives the whole current season from ESPN
  (teams/matchups/draft picks/box scores) and writes it straight to D1 via
  `INSERT OR REPLACE`, so finished games and stat corrections show up
  without tracking "which week is new". Runs daily at 9am UTC and on-demand
  (`.github/workflows/update_history_d1.yml`).

All scripts need a Google service account key at
`google_secret.json` (gitignored, not committed) to authenticate with the
Sheets API locally. In GitHub Actions this is written from the
`GOOGLE_CREDENTIALS` secret.

## Manual / one-off tools

Not scheduled anywhere — run by hand when their specific situation comes up.
Each has a full docstring; short version:

- **`database/build_history_db.py`** — builds/updates a local
  `league_history.sqlite` dev/backup copy of full league history. The
  original one-time backfill tool; D1 (via `update_history_d1.py`) is the
  canonical copy now.
- **`database/export_to_d1_sql.py`** — dumps that local `.sqlite` into
  one `.sql` file per year, for pushing to D1 in resumable chunks.
- **`database/backfill_draft_positions.py`** — fills D1's `players` table
  (position per player) from ESPN's full player pool. Run once initially,
  then again roughly yearly after a draft picks up new players.
- **`database/import_season_sackos.py`** — one-time import of
  historical Sacko games into D1's `season_sackos` table from Game
  Tracker's own historical labeling.
- **`database/refresh_league_settings.py`** — re-pushes `league_settings`
  for a range of years; useful after adding a new field to
  `history_lib.league_settings_row()` that existing D1 rows need to pick up.
- **`database/compare_sheet_vs_d1.py`** — cross-checks Game Tracker
  against D1 for weekly matchup discrepancies (wrong scores/opponents,
  missing games in either source).

## Repo layout

```
docs/                   GitHub Pages site (HTML/CSS/JS + franchise.json, league.json, draft-board.json, rule-changes.json)
worker/                 Cloudflare Worker powering the live Dashboard and parlay stats (KV-served, no committed JSON)
espn_api/               Vendored ESPN Fantasy API client library (Python, used by generate_franchise_data.py)
generate_franchise_data_d1.py  Franchise page data pipeline (D1-backed; shares helpers with generate_franchise_data.py)
generate_draft_board_data.py  Draft Board page data pipeline
generate_parlay_data.py       Parlay stats logic, shared by publish_parlay_stats.py (live) and its own local-preview main()
generate_league_data_d1.py    Standings / Head to Head / Overview / Game Records data pipeline (D1-backed)
generate_rule_changes_data.py Rule Changes page data pipeline
database/history_lib.py       Shared D1 row-building + final-standings + wrangler-CLI logic, used by every D1-writing script above
database/update_history_d1.py Daily D1 sync from ESPN -- the foundation every *_d1.py script above reads from
.github/workflows/      Scheduled + manual automation
```
