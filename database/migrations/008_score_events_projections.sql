-- Feed rows (site audit III #7) also keep what the change did to the
-- matchup, for the Feed page's detailed view: the scoring manager's
-- projected total before and after, their opponent and the opponent's
-- projected total after, and the league's projected median before and
-- after. "Before" is the dashboard build before the one that saw the
-- change, so two plays seen in the same build share these numbers. Rows
-- saved before this migration have them empty.
ALTER TABLE score_events ADD COLUMN proj_prev REAL;
ALTER TABLE score_events ADD COLUMN proj REAL;
ALTER TABLE score_events ADD COLUMN opp_manager TEXT;
ALTER TABLE score_events ADD COLUMN opp_proj REAL;
ALTER TABLE score_events ADD COLUMN median_prev REAL;
ALTER TABLE score_events ADD COLUMN median REAL;
