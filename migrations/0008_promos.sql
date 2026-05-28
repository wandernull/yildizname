-- Promo codes generated from the /admin Ops page (apology / win-back codes
-- after a low rating or complaint). A reading can have several over time,
-- so promos live in their own table (1 reading → many promos), not a
-- column on `readings`.
--
-- We mirror Stripe's coupon + promotion_code ids so the Ops page can look
-- up live redemption status (times_redeemed) — Stripe stays the source of
-- truth for whether a code was used, we don't track a local `redeemed`
-- flag (it would drift).
--
-- v1 promos are percentage-off, single-use (max_redemptions=1), duration
-- "once", created via Stripe API. Default 25% / 30-day expiry, code
-- format YILDIZ-XXXX.

CREATE TABLE promos (
  id                        TEXT PRIMARY KEY,
  reading_id                TEXT NOT NULL,
  code                      TEXT NOT NULL,
  stripe_coupon_id          TEXT NOT NULL,
  stripe_promotion_code_id  TEXT NOT NULL,
  percent_off               INTEGER,
  expires_at                TEXT,
  max_redemptions           INTEGER,
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_promos_reading_id ON promos (reading_id);
