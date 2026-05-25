-- Migration 0003 — Stripe payment metadata.
--
-- When a reading is unlocked via Stripe Checkout we persist enough metadata
-- to surface a "Faturayı indir" link on the result page and to support
-- future support / reconciliation work. All columns nullable — they only
-- populate on the post-paid update from the webhook handler.

ALTER TABLE readings ADD COLUMN stripe_session_id TEXT;
ALTER TABLE readings ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE readings ADD COLUMN paid_at TEXT;
ALTER TABLE readings ADD COLUMN invoice_hosted_url TEXT;
ALTER TABLE readings ADD COLUMN invoice_pdf_url TEXT;

-- Indexed because the webhook handler looks up readings by session id when
-- the metadata.reading_id is missing (defense in depth — should never
-- happen since we always set metadata, but the lookup is free with the
-- index in place).
CREATE INDEX idx_readings_stripe_session_id ON readings (stripe_session_id);
