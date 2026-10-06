-- Audit trail for the sentence-level safety net (src/lib/safety.ts). JSON
-- array of {section, original, replacement} — one entry per sentence in
-- Sağlık / Çocuk ve Yuva that contained a not-allowed claim (named
-- disease/organ/cycle, fertility verdict or timing, feelings-block-body).
-- replacement "" = the sentence was dropped. NULL = nothing flagged (or a
-- reading generated before this migration). Shown on the admin Ops page so
-- every automated edit to paid content can be reviewed.
ALTER TABLE readings ADD COLUMN safety_edits TEXT;
