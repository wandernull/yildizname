-- Per-reading cost tracking (admin "Maliyet" columns + /admin/credits).
--
-- reading_costs is an append-only ledger: one row per billable upstream
-- call, written at call time from the exact numbers the vendor returns.
--   anthropic  → token counts from the Messages API `usage` object,
--                priced with the official per-MTok rates in src/lib/costs.ts
--                (cost_usd_micros; 1 token × $3/MTok = 3 µ$, so it's exact).
--   elevenlabs → `character-cost` response header = credits charged for
--                that request. cost_usd_micros stays NULL: credits come out
--                of the monthly allowance first, so a $ value is only set
--                once a measured USD-per-credit rate exists.
-- kind:
--   generation   the Sonnet okuma call (one row per attempt, incl. failed
--                parse retries — every attempt is billed)
--   free_audio   karakterinOzu chunks (kapakSözü + 1/3 preview)
--   paid_audio   karakterinOzuRest + the 9 locked sections
--   promo_email  Haiku "Yapay zekayla üret" on the Ops page
-- usd_try is the USD→TRY rate of that day (fx_rates), snapshotted per row
-- so historical TRY amounts never move with the lira.
CREATE TABLE reading_costs (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  reading_id                   TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  provider                     TEXT NOT NULL CHECK (provider IN ('anthropic', 'elevenlabs')),
  kind                         TEXT NOT NULL CHECK (kind IN ('generation', 'free_audio', 'paid_audio', 'promo_email')),
  model                        TEXT,
  section                      TEXT,
  chunk_idx                    INTEGER,
  queue_attempt                INTEGER,
  attempt                      INTEGER,
  outcome                      TEXT,
  input_tokens                 INTEGER,
  output_tokens                INTEGER,
  cache_creation_input_tokens  INTEGER,
  cache_read_input_tokens      INTEGER,
  text_chars                   INTEGER,
  credits                      INTEGER,
  cost_usd_micros              INTEGER,
  usd_try                      REAL
);
CREATE INDEX idx_reading_costs_reading ON reading_costs (reading_id);
CREATE INDEX idx_reading_costs_created ON reading_costs (created_at);

-- Daily ECB reference rates (via api.frankfurter.dev), fetched at most
-- once per day on first use. Keyed by the ECB publication date.
CREATE TABLE fx_rates (
  date        TEXT PRIMARY KEY,
  usd_try     REAL NOT NULL,
  usd_eur     REAL NOT NULL,
  fetched_at  TEXT NOT NULL
);

-- Stripe side of the margin, captured in the webhook (or backfilled from
-- the Ops page):
--   amount_tax_kurus           session.total_details.amount_tax (VAT inside amount_total)
--   stripe_fee_minor           balance_transaction.fee, settlement currency minor units
--   stripe_net_minor           balance_transaction.net (what actually lands in the payout)
--   stripe_settlement_currency balance_transaction.currency (e.g. 'eur')
--   stripe_exchange_rate       balance_transaction.exchange_rate (TRY × rate = settlement)
--   usd_try_at_payment         fx snapshot on the payment day (USD view of revenue/margin)
ALTER TABLE readings ADD COLUMN amount_tax_kurus INTEGER;
ALTER TABLE readings ADD COLUMN stripe_fee_minor INTEGER;
ALTER TABLE readings ADD COLUMN stripe_net_minor INTEGER;
ALTER TABLE readings ADD COLUMN stripe_settlement_currency TEXT;
ALTER TABLE readings ADD COLUMN stripe_exchange_rate REAL;
ALTER TABLE readings ADD COLUMN usd_try_at_payment REAL;
