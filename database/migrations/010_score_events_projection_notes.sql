-- Feed rows (site audit III #7) can also be a projection note: a change to a
-- manager's projected total that no scoring play caused -- a lineup move,
-- injury news, or ESPN revising a projection (worker/src/scoreFeed.js).
-- Before this, that movement landed on whichever play the Worker saw next, so
-- a lineup change at halftime read as a catch moving the projection 13 points.
--   kind: 'proj' for a note, NULL for a play (every row saved before this)
--   note: JSON [{t: "Started DK Metcalf", a: 9.62}, ...] -- what moved it, and by how much
-- A note row keeps its headline ("Lineup change") in `player`, 0 in
-- player_id, and the projection change in `delta`; prev/total/stats are empty.
ALTER TABLE score_events ADD COLUMN kind TEXT;
ALTER TABLE score_events ADD COLUMN note TEXT;
