-- Rate + feedback for paid readings. Paid-only feature: the
-- POST /api/feedback/:id endpoint rejects readings where unlocked = 0.
--
--   feedback_rating       1-5 star rating (required on submit)
--   feedback_text         optional free-text comment (<= 2000 chars,
--                          enforced server-side)
--   feedback_at           ISO timestamp set on first submission; its
--                          presence is the "already gave feedback" flag
--                          (one-shot — the sticky CTA never re-renders
--                          for a reading once this is set)
--   viewed_feedback_cta   funnel: sticky CTA became visible
--   clicked_feedback_cta  funnel: user opened the feedback modal
--
-- All nullable / default 0. Existing rows are untouched and simply have
-- no feedback. Surfaced on the /admin/ratings page.

ALTER TABLE readings ADD COLUMN feedback_rating INTEGER;
ALTER TABLE readings ADD COLUMN feedback_text TEXT;
ALTER TABLE readings ADD COLUMN feedback_at TEXT;
ALTER TABLE readings ADD COLUMN viewed_feedback_cta INTEGER DEFAULT 0;
ALTER TABLE readings ADD COLUMN clicked_feedback_cta INTEGER DEFAULT 0;

-- Ratings page sorts by feedback recency; index the submitted-feedback rows.
CREATE INDEX IF NOT EXISTS idx_readings_feedback_at
  ON readings (feedback_at DESC);
