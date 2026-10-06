-- Price-modal exit hook (win-back step 2). When a reader opens the price
-- modal and closes it without going to Stripe, a one-time card shows their
-- hook line (+ their own question on the device that created the reading)
-- and a "Devamı burada →" button that re-opens the modal with source
-- 'exit_hook'. Flags are idempotent; timestamps keep the first hit.
--   exit_hook_seen      card was shown (once per reading per device)
--   exit_hook_clicked   "Devamı burada" tapped (→ modal re-opened)
-- Conversion through the hook = clicked_unlock_source / opened source
-- 'exit_hook' (no extra column). 0 / NULL on rows before this migration.
ALTER TABLE readings ADD COLUMN exit_hook_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE readings ADD COLUMN exit_hook_seen_at TEXT;
ALTER TABLE readings ADD COLUMN exit_hook_clicked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE readings ADD COLUMN exit_hook_clicked_at TEXT;
