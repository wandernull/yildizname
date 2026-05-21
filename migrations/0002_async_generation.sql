-- Migration 0002 — async generation support.
-- POST /api/generate now returns immediately with a pending row; the LLM
-- call runs in the background (Workers executionCtx.waitUntil) and later
-- updates the row to 'done' or 'error'. The frontend polls /api/reading/:id.

ALTER TABLE readings
  ADD COLUMN status TEXT NOT NULL DEFAULT 'done'
  CHECK (status IN ('pending', 'done', 'error'));

ALTER TABLE readings
  ADD COLUMN error TEXT;

CREATE INDEX idx_readings_status ON readings (status);
