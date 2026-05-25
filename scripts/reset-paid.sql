-- Roll back the paid state on every reading in LOCAL D1.
-- Use case: testing the Stripe payment flow repeatedly without having to
-- generate a fresh reading (which takes ~2 minutes of LLM call) each time.
--
-- Resets the row to free-preview state: clears unlocked + all the Stripe
-- metadata columns from migration 0003. The reading content (form_data,
-- sections) is untouched.
--
-- Run via: npm run db:reset-paid
-- This is LOCAL ONLY — the npm script wires it to `wrangler d1 execute
-- --local` so it can never accidentally touch production data.

UPDATE readings
   SET unlocked = 0,
       stripe_session_id = NULL,
       stripe_payment_intent_id = NULL,
       paid_at = NULL,
       invoice_hosted_url = NULL,
       invoice_pdf_url = NULL
 WHERE unlocked = 1
    OR stripe_session_id IS NOT NULL;
