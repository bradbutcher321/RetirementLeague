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
- Head to Head, Overview, Game Records, Standings, and Parlay Results are
  placeholder pages, not yet built out.

## How it updates

- **`worker/`** — a Cloudflare Worker (`worker/src/`) that the Dashboard
  calls directly. It hits the ESPN Fantasy API itself (JS port of the
  vendored `espn_api/` Python library's logic), computes the same payload
  `index.html` needs, and caches it in Workers KV for two minutes so
  repeated page loads don't hammer ESPN. See `worker/wrangler.toml` for
  config; `ESPN_SWID`/`ESPN_S2` are set via `wrangler secret put` rather
  than committed.
- **`generate_franchise_data.py`** — reads the sheet's `Game Tracker`,
  `PlayerStats`, `RandomInfo`, `Parlay Tracker`, and `Money Tracker` tabs,
  computes each manager's career stats, and writes `docs/data/franchise.json`.
  Runs Tuesday/Thursday mornings and on-demand
  (`.github/workflows/refresh_franchise_data.yml`).

`generate_franchise_data.py` needs a Google service account key at
`google_secret.json` (gitignored, not committed) to authenticate with the
Sheets API locally. In GitHub Actions this is written from the
`GOOGLE_CREDENTIALS` secret.

## Repo layout

```
docs/                   GitHub Pages site (HTML/CSS/JS + franchise.json)
worker/                 Cloudflare Worker powering the live Dashboard
espn_api/               Vendored ESPN Fantasy API client library (Python, used by generate_franchise_data.py)
generate_franchise_data.py    Franchise page data pipeline
.github/workflows/      Scheduled + manual automation
```
