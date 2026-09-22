-- Fixes is_playoff, which was wrongly true for ESPN's consolation-ladder
-- placement games (WINNERS_CONSOLATION_LADDER / LOSERS_CONSOLATION_LADDER),
-- not just the real championship bracket (WINNERS_BRACKET). Adds the raw
-- classification so the distinction is preserved going forward; existing
-- rows get a placeholder that update_history_d1.py / build_history_db.py
-- overwrite with the real value on their next run for every year.
ALTER TABLE matchups ADD COLUMN bracket_type TEXT NOT NULL DEFAULT 'NONE';
