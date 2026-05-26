-- Adds funnel-analytics columns to readings. Captured by:
--   • GET /api/reading/:id      → viewer_ip (server-side, from CF-Connecting-IP)
--   • POST /api/track/:id        → scrolled_past_free / listened_free /
--                                   listened_locked / listened_chain /
--                                   clicked_unlock + clicked_unlock_at
-- All event flags are idempotent: a duplicate POST is a no-op once the
-- flag is set. The backoffice at /admin queries these columns to render
-- the conversion-funnel table.

ALTER TABLE readings ADD COLUMN viewer_ip TEXT;
ALTER TABLE readings ADD COLUMN scrolled_past_free INTEGER DEFAULT 0;
ALTER TABLE readings ADD COLUMN listened_free INTEGER DEFAULT 0;
ALTER TABLE readings ADD COLUMN listened_locked INTEGER DEFAULT 0;
ALTER TABLE readings ADD COLUMN listened_chain INTEGER DEFAULT 0;
ALTER TABLE readings ADD COLUMN clicked_unlock INTEGER DEFAULT 0;
ALTER TABLE readings ADD COLUMN clicked_unlock_at TEXT;

-- Backoffice sort key — newest first.
CREATE INDEX IF NOT EXISTS idx_readings_created_at_desc
  ON readings (created_at DESC);
