-- Customer email, captured from the Stripe Checkout Session.
--   • Auto-captured at webhook time (checkout.session.completed carries
--     customer_details.email) so every NEW payment gets it for free.
--   • Backfilled for older paid readings via the /admin Ops page
--     "Sync email" action (GET /v1/checkout/sessions/{id} → email).
-- Nullable; existing rows stay NULL until synced. Surfaced in the admin
-- Funnel + Puanlar tables, and is the recipient address for the
-- (Phase 2) outbound apology/promo emails.

ALTER TABLE readings ADD COLUMN customer_email TEXT;
