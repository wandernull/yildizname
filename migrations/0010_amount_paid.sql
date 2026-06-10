-- Capture the real Stripe-side payment amount + any promo applied, so the
-- GA4 `report_unlocked` event can report accurate revenue + promo
-- attribution (instead of the hardcoded list price 349,99 ₺, which
-- overstated revenue on promo-discounted purchases).
--
--   amount_total_kurus       = session.amount_total (post-discount paid amount)
--   amount_discount_kurus    = session.total_details.amount_discount (sum of discounts)
--   stripe_promotion_code_id = session.discounts[0].promotion_code (e.g. promo_1Tc39C...)
--
-- The readable promo code (e.g. YILDIZ-X3K9) is NOT stored here — it lives
-- on the `promos` table and is joined at read time in /api/reading/:id.
-- That keeps this migration to a clean three columns and means we don't
-- need to backfill anything if the promo code changes upstream (unlikely
-- but conceptually cleaner).
--
-- All three columns are nullable: legacy paid rows + non-promo purchases
-- (where amount_discount = 0 and there's no promotion_code) coexist.

ALTER TABLE readings ADD COLUMN amount_total_kurus INTEGER;
ALTER TABLE readings ADD COLUMN amount_discount_kurus INTEGER;
ALTER TABLE readings ADD COLUMN stripe_promotion_code_id TEXT;
