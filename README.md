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
- **`generate_franchise_data.py`** — reads the sheet's `Game Tracker`,
  `PlayerStats`, `RandomInfo`, `Parlay Tracker`, and `Money Tracker` tabs,
  computes each manager's career stats, and writes `docs/data/franchise.json`.
  Runs Tuesday/Thursday mornings and on-demand
  (`.github/workflows/refresh_franchise_data.yml`).
- **`generate_parlay_data.py`** — reads the sheet's `Parlay Tracker` tab
  (the hand-entered picks and results), reproduces the stats the sheet's
  `Parlay Results` tab computes, and writes `docs/data/parlay.json`. Runs
  every 30 minutes and on-demand
  (`.github/workflows/refresh_parlay_data.yml`), and only commits when the
  data actually changed. A "Refresh Data" button on the Parlay Results page
  can also dispatch this on demand via the Worker
  (`worker/src/parlayRefresh.js`, `POST /refresh-parlay`).
  See [PARLAY_DATA_MIGRATION.md](PARLAY_DATA_MIGRATION.md) for the
  in-progress effort to move this tab's data off the sheet the same way
  league history moved to D1 — Phase 1 (normalized entry format on a new
  "Auto Parlay Tracker" tab, plus a `parlay_gui.py` desktop tool for
  entering/grading picks — see [PARLAY_GUI_SETUP.md](PARLAY_GUI_SETUP.md)
  to set it up) is done; this script itself hasn't changed yet.

- **`generate_league_data.py`** — writes `docs/data/league.json` (the game
  log, per-season rollups, draft order, and earnings) from Game Tracker,
  PlayerStats, RandomInfo, and Money Tracker. Runs every few hours and
  on-demand (`.github/workflows/refresh_league_data.yml`).
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
docs/                   GitHub Pages site (HTML/CSS/JS + franchise.json, parlay.json)
worker/                 Cloudflare Worker powering the live Dashboard
espn_api/               Vendored ESPN Fantasy API client library (Python, used by generate_franchise_data.py)
generate_franchise_data.py    Franchise page data pipeline
generate_parlay_data.py       Parlay Results page data pipeline
generate_league_data.py       Standings / Head to Head / Overview / Game Records data pipeline
generate_rule_changes_data.py Rule Changes page data pipeline
.github/workflows/      Scheduled + manual automation
```
