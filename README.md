# Retirement League

Companion website for the Retirement League fantasy football league — a
static site (GitHub Pages) backed by a Google Sheet, with a couple of
Python scripts that keep the data fresh.

**Live site:** https://bradbutcher321.github.io/RetirementLeague/

## Pages

- **Live Dashboard** (`docs/index.html`) — current week's median splits,
  matchups, superlatives, and standings. Reads live data directly from a
  published Google Sheet CSV, auto-refreshing every couple minutes.
- **Franchise** (`docs/franchise.html`) — career stats per manager (record,
  streaks, rivalries, scoring extremes, money, season-by-season history).
  Reads a static `docs/data/franchise.json` file instead of hitting the
  sheet live, since this data only changes when results are entered.
- Head to Head, Overview, Game Records, Standings, and Parlay Results are
  placeholder pages, not yet built out.

## How it updates

- **`update_page_and_sheets.py`** — pulls the current week's live scores
  from the ESPN Fantasy API (via the vendored `espn_api/` library) and
  writes them to the "Live Weekly Medians" tab of the Google Sheet, which
  `index.html` reads as a published CSV. Runs on a schedule and on-demand
  (via `.github/workflows/refresh_scores.yml`, triggered by a Cloudflare
  Worker proxy the site calls on page load).
- **`generate_franchise_data.py`** — reads the sheet's `Game Tracker`,
  `PlayerStats`, `RandomInfo`, `Parlay Tracker`, and `Money Tracker` tabs,
  computes each manager's career stats, and writes `docs/data/franchise.json`.
  Runs Tuesday/Thursday mornings and on-demand
  (`.github/workflows/refresh_franchise_data.yml`).

Both scripts need a Google service account key at `google_secret.json`
(gitignored, not committed) to authenticate with the Sheets API locally.
In GitHub Actions this is written from the `GOOGLE_CREDENTIALS` secret.

## Repo layout

```
docs/                   GitHub Pages site (HTML/CSS/JS + franchise.json)
espn_api/               Vendored ESPN Fantasy API client library
update_page_and_sheets.py     Live Dashboard data pipeline
generate_franchise_data.py    Franchise page data pipeline
.github/workflows/      Scheduled + manual automation
```
