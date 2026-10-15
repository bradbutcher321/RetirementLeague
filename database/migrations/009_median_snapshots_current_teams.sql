-- Median Watch / Flow: each team's *current* (actual so far) total at every
-- snapshot, beside the projected totals in `teams`, so the charts can show a
-- week as it was actually scored and not only as it was projected.
--   current_teams: JSON object, manager name -> that team's current total
-- Snapshots from before this column existed have NULL here; their charts
-- can still draw the current median (current_median) but no team lines.
ALTER TABLE median_snapshots ADD COLUMN current_teams TEXT;
