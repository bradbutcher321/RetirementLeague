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
- **Franchise** (`docs/franchise.html`) — career stats per manager (record,
  streaks, rivalries, scoring extremes, money, season-by-season history).
  Reads a static `docs/data/franchise.json` file, since this data only
  changes when results are entered.
- **Parlay Results** (`docs/parlay-results.html`) — the current week's
  parlay (with a week/year picker for past weeks), plus betting stats,
  breakdowns, and "how far parlays get" charts, each with their own
  year / all-time tabs. Reads a static `docs/data/parlay.json` file.
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
  repeated page loads don't hammer ESPN. See `worker/wrangler.toml` for
  config; `ESPN_SWID`/`ESPN_S2` are set via `wrangler secret put` rather
  than committed.
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
  duplicating them. Runs Tuesday/Thursday mornings and on-demand, in the
  same workflow as the Draft Board and Rule Changes scripts below
  (`.github/workflows/refresh_franchise_data.yml`).
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
  every 30 minutes and on-demand
  (`.github/workflows/refresh_parlay_data.yml`, also dispatchable via the
  "Refresh Data" button on the Parlay Results page —
  `worker/src/parlayRefresh.js`, `POST /refresh-parlay`), and also syncs
  every pick into a dedicated D1 database (`sync_parlay_to_d1.py`) for
  durable, queryable storage. **`auto_grade_results.py`** fills in
  Result (Win/Loss) for finished games using real ESPN final scores —
  run by hand, not scheduled, since it needs write access to the sheet.
  See [PARLAY_DATA_MIGRATION.md](PARLAY_DATA_MIGRATION.md) for the full
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
  overwrites an existing name or score, and never guesses at a Play/Cons/
  3rd/5th/Champ row's pairing (same bracket-position limitation as final
  standings below). Runs Tuesday 12:30am Eastern — after Monday Night
  Football wraps, so the whole week should be decided by then — and
  on-demand (`.github/workflows/sync_scores_to_sheet.yml`). Unlike
  `auto_grade_results.py`, which stays manual-only, this one's scheduled;
  run it locally with `--dry-run` first to preview a week before trusting
  a new run.
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
  equivalent). Run on-demand whenever a rule, the buy-in, or the league's
  managers change — there's no schedule for it since that's rare.

All scripts need a Google service account key at
`google_secret.json` (gitignored, not committed) to authenticate with the
Sheets API locally. In GitHub Actions this is written from the
`GOOGLE_CREDENTIALS` secret.

## Repo layout

```
docs/                   GitHub Pages site (HTML/CSS/JS + franchise.json, parlay.json, draft-board.json)
worker/                 Cloudflare Worker powering the live Dashboard
espn_api/               Vendored ESPN Fantasy API client library (Python, used by generate_franchise_data.py)
generate_franchise_data_d1.py  Franchise page data pipeline (D1-backed; shares helpers with generate_franchise_data.py)
generate_draft_board_data.py  Draft Board page data pipeline
generate_parlay_data.py       Parlay Results page data pipeline
generate_league_data_d1.py    Standings / Head to Head / Overview / Game Records data pipeline (D1-backed)
generate_rule_changes_data.py Rule Changes page data pipeline
database/history_lib.py       Shared D1 row-building + final-standings logic, used by every *_d1.py script above
.github/workflows/      Scheduled + manual automation
```
