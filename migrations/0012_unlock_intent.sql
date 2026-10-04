-- Unlock-intent funnel. Every unlock entry point ("Devamını oku →" inline
-- link, the unlock card under the locked sections, the action-bar pill)
-- opens the same price modal; clicked_unlock (0004) only fires on the
-- modal's CTA that goes to Stripe. These columns capture the step before
-- it — "saw the price" — and which entry point drove each step.
--
--   opened_unlock          1 once the price modal was opened at least once
--   opened_unlock_at       first open (ISO-8601)
--   opened_unlock_count    total opens — repeated opens without paying is
--                          a strong price-hesitation signal
--   opened_unlock_source   entry point of the FIRST open
--   clicked_unlock_source  entry point of the open that led to the first
--                          go-to-Stripe click (which surface converts)
--
-- Sources: 'devamini_oku' | 'unlock_card' | 'action_bar'. Rows from before
-- this migration have no data (0 / NULL) — stats start at ship time.
ALTER TABLE readings ADD COLUMN opened_unlock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE readings ADD COLUMN opened_unlock_at TEXT;
ALTER TABLE readings ADD COLUMN opened_unlock_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE readings ADD COLUMN opened_unlock_source TEXT;
ALTER TABLE readings ADD COLUMN clicked_unlock_source TEXT;
