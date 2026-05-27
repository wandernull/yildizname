-- Add client_kind for funnel-analytics: classifies the visitor's browser
-- environment as one of three buckets, captured server-side from the
-- User-Agent header on the first GET /api/reading/:id (idempotent first-
-- visit attribution, same as viewer_ip).
--
--   'inapp'  — Instagram/Facebook/TikTok/X/Snapchat/LinkedIn/WeChat/etc.
--               in-app webview. Detected first because these UAs usually
--               also contain "Mobile" and would otherwise misclassify.
--   'mobile' — real mobile browser (UA contains Mobile/iPhone/iPad/
--               Android and matches no in-app pattern).
--   'web'    — everything else (desktop browsers, bots, unknown UAs).
--
-- Nullable, no default: existing rows stay NULL and render as "—" in the
-- /admin table. Only first-visit reads from this point forward populate
-- the column.

ALTER TABLE readings ADD COLUMN client_kind TEXT;
