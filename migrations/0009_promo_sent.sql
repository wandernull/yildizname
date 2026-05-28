-- Track when a generated promo was emailed to the customer (admin Ops page
-- "Gönder" compose modal). Lets the Ops page show a "gönderildi" marker +
-- the recipient address, and helps avoid accidental double-sends. Both are
-- nullable: a promo can exist without ever being emailed (e.g. the code was
-- handed out by other means).

ALTER TABLE promos ADD COLUMN sent_at TEXT;
ALTER TABLE promos ADD COLUMN sent_to TEXT;
