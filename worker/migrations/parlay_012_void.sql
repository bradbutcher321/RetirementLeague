-- Void legs (2026-11-22): the voided legs a week's final odds/payout already
-- account for, comma-separated players. Set when a commissioner saves new final
-- odds while legs are voided; any other void is estimated at publish
-- (parlayStats.js estimateVoids). Repeated on every row, like final_odds.
ALTER TABLE picks ADD COLUMN priced_voids TEXT;
