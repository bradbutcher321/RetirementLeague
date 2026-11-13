# Archive

One-time scripts and notes that already did their job (site audit X #34).
Nothing in the workflows, the Worker or the site uses them. They're kept
here so the history of how the league data was built stays readable, but
out of the folders people search when working on the live pieces.

- `build_history_db.py`, `backfill_draft_positions.py`, `import_season_sackos.py`,
  `export_to_d1_sql.py`, `compare_sheet_vs_d1.py`: the original D1 backfill
  (they import `database/history_lib.py`; run them from `database/` if ever needed again).
- `generate_old_lineup_data.py`: the pre-2019 lineup files, built once.
- `PARLAY_DATA_MIGRATION.md`: the parlay sheet-to-D1 migration notes; all phases done.
