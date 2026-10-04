# Yıldızname

## Elevator pitch
A Turkish mystical astrology web app: an Ottoman astronomer (müneccim) style birth reading, delivered as an animated night-sky experience with prose + Turkish TTS audio. The free preview shows the kapakSözü + the first ~1/3 of the "Karakterin Özü" section (the rest blurred behind an inline paywall); the full reading — all 10 sections + müneccim-voice audio — unlocks for **349,99 ₺** via Stripe Checkout.

## Plain-language description
- For a 7-year-old: A magical website that whispers your fortune like a storyteller under the stars.
- For a 77-year-old: Eski müneccimlerin sözünü hatırlatan, yıldızname geleneğinden ilham alan, kişiye özel bir okuma sunan bir internet sitesi.

## Persona / target user
Turkish-speaking adults (~25–55) curious about mysticism, family-name and birth-based readings, and willing to pay a small premium for a personalized, beautifully presented experience. Mobile-first — most traffic is expected from Instagram / TikTok referrals.

## Architecture
Single-component web project. The project folder *is* the app folder (no `-api` / `-app` split). One Cloudflare Worker serves both the JSON API (`/api/*`) and the vanilla HTML/CSS/JS frontend (`/`, `/form`, `/loading`, `/okuma/:id`) through the Workers Assets binding. The frontend is a single SPA shell driven by the History API — no frontend framework, no build step. There is also a server-rendered, Basic-Auth-protected backoffice at `/admin`, `/admin/ratings`, and `/admin/ops`.

Production lives on the apex **https://yildizna.me**. `www.yildizna.me` is also attached as a Worker Custom Domain, but Hono middleware in `src/index.ts` 301s any `www.*` request to the apex with path + query preserved, so the canonical hostname is the bare apex. The `*.workers.dev` URL still resolves as well.

## Tech stack
Strictly the global "Web stack defaults" from `~/.claude/CLAUDE.md`:

- **Compute:** Cloudflare Workers **Paid plan** (`compatibility_date = 2025-05-01`, `nodejs_compat`). Required for **Cloudflare Queues** (background generation) — the async refactor's producer/consumer split runs the ~2-min Anthropic LLM call independently of any inbound HTTP connection, so mobile tab switches / in-app browser kills don't abort generations anymore.
- **Framework:** Hono (single `src/index.ts` mounts all routes)
- **Static assets:** Workers Assets binding (`[assets] directory = "./public"`, `not_found_handling = "none"`; SPA fallback handled inside the Worker)
- **Relational data:** D1 — `readings` table + a `promos` table (1 reading → many promos). Schema = `migrations/0001_init.sql` + 0002 status/error + 0003 stripe metadata + 0004 funnel analytics + 0005 client_kind + 0006 feedback + 0007 customer_email + 0008 promos + 0009 promo sent_at/sent_to + 0010 amount_total/amount_discount/stripe_promotion_code_id on readings (real revenue + promo attribution for GA4) + 0011 cost tracking (`reading_costs` ledger, `fx_rates`, Stripe VAT/fee/net/exchange-rate + payment-day USD/TRY on readings). + 0012 unlock intent (`opened_unlock`/`_at`/`_count`/`_source`, `clicked_unlock_source`). All applied to local + remote (0011, 0012 on 2026-10-04).
- **Analytics:** Google Analytics 4 (`G-68ZDSN6LVW`), prod-only loader inlined in every `public/*.html` head. Defines `window.gtag` everywhere so event calls (in `main.js` / `views.js`) are safe no-ops off-prod. Localhost / any non-prod host can opt-in via `localStorage.ga4_debug='1'` (events stream to GA4 DebugView with `debug_mode:true`). Admin mute via `localStorage.ga4_admin='1'`, auto-set on every `/admin` visit, keeps the operator's browser permanently silent across all hosts. Events: `page_view` (auto on content pages, manual on SPA router navigations), `reading_started` (any `/okuma` view, deduped per reading per tab), `unlock_opened` (price modal opened — every open, `source` = `devamini_oku|unlock_card|action_bar`; mirrors D1 `opened_unlock`), `begin_checkout` (GA4-recommended ecommerce event on the modal's go-to-Stripe CTA, `currency`/`value` = list price/`source`; mirrors D1 `clicked_unlock`), `report_unlocked` (Stripe redirect conversion, deduped per `cs_…` session id, payload includes `currency`/`value`/`transaction_id`/`coupon`/`discount`). Funnel: reading_started → unlock_opened → begin_checkout → report_unlocked. **`source` must be registered as an event-scoped Custom Dimension in GA4 Admin** to appear in reports.
- **Email:** outbound transactional email via Resend (direct REST, no SDK) in `src/lib/email.ts`, sent AS `destek@yildizna.me` (domain verified in Resend, DKIM on the root). Inbound `destek@` routes through Cloudflare Email Routing to `baran@botelabs.io`, so replies loop back. **`destek@` is the single public address** — a `support@` alias also routes there silently but is no longer advertised anywhere (legal pages, footer, etc. all use `destek@`). Used for admin promo/win-back emails + a test-send diagnostic. `RESEND_API_KEY` secret (same key local + prod).
- **Cost tracking (migration 0011):** append-only `reading_costs` ledger in `src/lib/costs.ts`, one row per billable upstream call, from vendor-reported numbers only — Claude: stream `usage` tokens × official per-MTok prices (constant in `costs.ts`, exact micro-dollars; every attempt incl. failed parse retries, plus Haiku promo-email calls); ElevenLabs: the `character-cost` response header (exact credits per synthesized chunk, split `free_audio` / `paid_audio`; R2 cache hits cost nothing and aren't logged). Credits (= ElevenLabs "billable characters") are valued at the published v2 Multilingual price **$0.08 / 1K = 80 µ$ per credit** (`ELEVENLABS_USD_MICROS_PER_CREDIT`), applied at read time so a price change is one constant; allowance credits are valued at the same rate so margins aren't flattered by the monthly allowance (which drains before the prepaid $ balance). Stripe VAT + processing fee + net + Stripe's own TRY→settlement rate are captured in the webhook (`fetchPaymentFinancials`, PaymentIntent → latest_charge.balance_transaction). FX: daily ECB rates via `api.frankfurter.dev`, cached in `fx_rates`, snapshotted per ledger row (`usd_try`) and per payment (`usd_try_at_payment`) so history never moves. Every amount shows USD + TRY. Ledger writes are best-effort and never break a reading/chunk/queue attempt.
- **Edge state:** KV — not used (no sessions, rate limits, or caches yet)
- **Background work:** Cloudflare Queues (`yildizname-generation`). `[[queues.producers]]` binding `GENERATION_QUEUE` for /api/generate; `[[queues.consumers]]` for the Worker's `queue()` handler that runs Anthropic + `markReadingDone` + sends the "hazır" email via Resend. `max_batch_size=1`, `max_retries=3`. Status transitions on `readings`: `pending` → `done` (or `error` after 3 failed attempts).
- **Object storage:** R2 — bucket `yildizname-tts` caches synthesized audio MP3s at key `tts/{prefix}/{readingId}/{section}/{chunkIdx}.mp3` (current prefix `tts/v4`; see the TTS bullet for the chunked architecture). 15-day lifecycle rule (set out-of-band via `wrangler r2 bucket lifecycle add`). Bump the prefix in `src/lib/tts.ts` whenever audio shaping/content changes (old objects age out via the lifecycle rule).
- **Language:** TypeScript, strict; `@cloudflare/workers-types` for Worker globals
- **LLM:** `@anthropic-ai/sdk` calling `claude-sonnet-4-5` with the Ottoman-müneccim system prompt in `src/lib/llm.ts`. Output is strict JSON validated against `YildiznameSections`. One automatic retry on parse failure.
- **Frontend UI:** Vanilla HTML/CSS/JS served from `public/`. Cormorant Garamond + Noto Serif loaded from Google Fonts. Canvas star field, CSS keyframes, Web Animations API. No bundler.
- **TTS:** ElevenLabs `eleven_multilingual_v2` via direct `fetch` from the Worker. Voice `J17lijyP1BHYcM7ld0Rg` (slow ritualistic settings). **Chunked architecture (v4)**: each section is split into ~180-char sentence-packed chunks at synth time (`splitIntoChunks` in `src/lib/text.ts`); each chunk is synthesized via ElevenLabs' non-streaming endpoint, returned to the client with an explicit `Content-Length` header (mobile `<audio>` needs this to play long streams to the end without truncating near EOF), and cached per-chunk in R2 at `tts/v4/{readingId}/{section}/{chunkIdx}.mp3`. Short sections (~<60s of estimated audio) stay monolithic via a `shouldChunk()` gate. `karakterinOzu` still splits at the text layer into two variants to avoid double-paying ElevenLabs on conversion: **`karakterinOzu`** = kapakSözü + the 1/3 preview (free state); **`karakterinOzuRest`** = just the remaining 2/3, no kapakSözü prepend (synthesized only after unlock). Client-side prefetch pipeline in `public/js/views.js` (`PREFETCH_AHEAD=2`) primes the next 2 chunks ahead of the playback head via background `fetch()` calls — responses carry `Cache-Control: public, max-age=1296000, immutable` so subsequent `<audio src>` switches hit the browser HTTP cache instantly. Total upstream concurrency capped at 3 (1 playing + 2 prefetching), matching the ElevenLabs Starter plan cap. Text shaping lives in `src/lib/tts.ts → buildSpeechText()`; the karakterinOzu split point in `src/lib/text.ts → splitKarakterinOzu()`; chunk boundaries in `src/lib/text.ts → splitIntoChunks()`.
- **Payments:** **Stripe Checkout, LIVE.** Direct Stripe REST (no SDK) in `src/lib/stripe.ts`; Web Crypto HMAC verifies the webhook. `MockPaymentProvider` / the `PaymentProvider` interface were deleted. iyzico explicitly **not** in scope. `/api/unlock` pre-creates a Stripe Customer (`preferred_locales=['tr']` for a Turkish invoice) then a Checkout Session (inline `price_data` 34999 kuruş, `automatic_tax` inclusive `txcd_10000000`, `invoice_creation`, `allow_promotion_codes`, `custom_text` brand attribution). `/api/stripe/webhook` is idempotent. Legal entity on the invoice + Pay button: Back of the Envelope B.V., Amsterdam NL, KVK 97838810, VAT NL868254010B01.

## Routes
SPA (served via the Worker's SPA fallback):
- `GET /` landing · `GET /form` multi-step form · `GET /loading` wait screen
- `GET /okuma/:id` — kapakSözü + 1/3 preview + inline paywall + 9 locked sections + action bar
- `GET /okuma/:id?paid=1&session=…` — post-Stripe redirect; polling overlay → success card
- SEO content pages: `/yildizname`, `/ebced`, `/muneccim`, `/menzil`, `/sss`, `/gizlilik`, `/kosullar` (+ `/privacy`→`/gizlilik`, `/terms`→`/kosullar` 301s)

API:
- `POST /api/generate` — **producer**: inserts row (`status='pending'`) + enqueues `{readingId, baseUrl}` on `GENERATION_QUEUE` + returns `{id, status:'pending'}` in ~100ms. The Worker's `queue()` handler does the actual LLM call independently of the inbound connection.
- `GET /api/reading/:id` — returns `{id, status, error, hasEmail}` for `status !== 'done'` (frontend polls until terminal); for `status='done'` returns the full payload (preview + teaser for free state; full text + 9 sections + invoice URLs + `feedbackGiven` for unlocked + `chunkCounts` per section for the chunked TTS walk). Every response includes `hasEmail: boolean` (no PII) so the loading-screen escape hatch can open in its "confirmed" state for already-attached emails.
- `POST /api/reading/:id/email` — attaches a customer email to a reading from the loading-screen escape hatch via `setCustomerEmail`. If `status='done'` already (user submitted post-completion), fires the "hazır" email immediately to cover the race.
- `POST /api/unlock` — pre-creates a Stripe Customer + Checkout Session, returns `{ url, sessionId }` (or `{ alreadyUnlocked: true }`)
- `POST /api/stripe/webhook` — HMAC-verified; on `checkout.session.completed` flips `unlocked`, fetches invoice meta (idempotent)
- `GET /api/tts/:readingId/:section/:chunkIdx` — `audio/mpeg`, one chunk of a section. Free: `karakterinOzu`. Paid-only: `karakterinOzuRest` + the 9 locked sections (403 otherwise). R2 cache hit → serve with `Content-Length` from `cached.size`; miss → synth via ElevenLabs non-streaming, return bytes with explicit `Content-Length`, write to R2 via `waitUntil`. Chunk count per section lives on `/api/reading/:id`'s done response (`chunkCounts`).
- `POST /api/track/:id` — idempotent funnel flags (scrolled_past_free, listened_free/locked/chain, clicked_unlock, viewed/clicked_feedback_cta) + `opened_unlock` (counted, not idempotent). Body `{event, source?}`; `source` ∈ `devamini_oku | unlock_card | action_bar` tags the unlock events with the entry point. All three entry points open the same price modal; `opened_unlock` fires on open ("saw the price"), `clicked_unlock` on the modal's go-to-Stripe CTA ("went to payment")
- `POST /api/feedback/:id` — paid-only (403 if locked); `{ rating 1-5 required, text? }`; first-submission-wins

Admin (HTTP Basic Auth via `ADMIN_USER`/`ADMIN_PASS`):
- `GET /admin` — funnel analytics table (+ per-reading cost/margin) · `GET /admin/ratings` — feedback/ratings · `GET /admin/ops` — ops (reset-payment + email sync + promo generation + cost ledger) · `GET /admin/credits` — vendor credits + spend + unit economics
- `POST /api/admin/reset-payment/:id` — clears unlocked + Stripe metadata + feedback (no Stripe refund); PRG redirect
- `POST /api/admin/sync-email/:id` — backfills `customer_email` from the Stripe session; PRG redirect
- `POST /api/admin/generate-promo/:id` — creates a Stripe coupon + single-use `YILDIZ-XXXX` promotion code (percent from form, 30-day expiry), mirrors into `promos`; PRG redirect. Promo requests pin `Stripe-Version: 2024-06-20` (account default rejects the classic `coupon` param)
- `POST /api/admin/send-promo/:promoId` — emails a generated promo to a customer via Resend (editable compose modal on the Ops page), records `sent_at`/`sent_to`; PRG redirect
- `POST /api/admin/test-email` — sends a test email AS `destek@yildizna.me` (Resend channel diagnostic); PRG redirect
- `GET /admin/credits` — ElevenLabs monthly credit allowance (live, via the read-only key), logged Claude spend 7d/30d/all, audio credits spent, unit economics since tracking began; links out for the balances no API exposes (Anthropic Console, ElevenLabs $ top-up)
- `POST /api/admin/sync-costs/:id` — backfills a paid reading's VAT, Stripe fee/net/exchange rate and payment-day USD/TRY from Stripe + ECB; PRG redirect
- `/admin` funnel table also shows per-reading cost split **Ödeme öncesi** (Claude + free-preview audio — what every visitor costs) / **Ödeme sonrası** (paid audio — what a buyer costs on top) / Toplam, plus net revenue, Stripe fee and margin, all in USD + TRY; `/admin/ops?id=` shows the same split with line items plus the full call ledger for one reading

## CI/CD
GitHub Actions workflow at `.github/workflows/deploy.yml`:
1. Run on every push to `main` (and `workflow_dispatch`).
2. Install deps, typecheck, then `npx wrangler deploy`.
3. Auth via the `CLOUDFLARE_API_TOKEN` repo secret.

Migrations are **not** auto-applied. Run `npm run db:migrate:remote` manually when the schema changes (or wire a separate workflow later).

## Local dev
1. `npm install`
2. `cp .dev.vars.example .dev.vars` and fill in `ANTHROPIC_API_KEY`
3. `wrangler d1 create yildizname-db` once (replaces the placeholder `database_id` in `wrangler.toml`)
4. `npm run db:migrate:local`
5. `npm run dev` → http://localhost:8787

## Credentials
This project uses `~/.gizem-creds`.

From `~/.gizem-creds` (machine env): `CLOUDFLARE_API_TOKEN`, `GH_TOKEN` (account: `wandernull`).

Worker secrets (prod via `wrangler secret put`, local via `.dev.vars`) — 8 set in prod (verified 2026-10-04):
- `ANTHROPIC_API_KEY` — Claude
- `ELEVENLABS_API_KEY` — TTS
- `STRIPE_SECRET_KEY` — **live** `sk_live_…` (rotated before go-live)
- `STRIPE_WEBHOOK_SECRET` — `whsec_…` from the prod webhook endpoint
- `ADMIN_USER` + `ADMIN_PASS` — HTTP Basic Auth for `/admin*`
- `RESEND_API_KEY` — outbound email via Resend
- `ELEVENLABS_ADMIN_KEY` — read-only ElevenLabs key, `user_read` permission only, for `/admin/credits`. Same ElevenLabs account as `ELEVENLABS_API_KEY` (verified 2026-10-04 by a calibration synth)

Non-secret config lives in `wrangler.toml` `[vars]`: `READING_PRICE_TRY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`.

Test mode (local `.dev.vars`) uses `sk_test_…` + a `stripe listen` whsec.

**Shell gotcha:** `source ~/.gizem-creds` errors in non-interactive shells (gvm init). Run commands via `/bin/bash --noprofile --norc -c '…'` and extract the one var you need by grepping the file. `git push` needs the one-off token URL (Keychain offers the wrong account): `git -c credential.helper= push "https://wandernull:${GH_TOKEN}@github.com/wandernull/yildizname.git" main`.

## Living plan
The living plan, status, and decisions log is `./PROJECT_PLAN.md`. Update it whenever a change has lasting impact so future sessions can pick up where this one left off.

## Update directive
If any decision, architectural change, scope shift, or learning in this session has impact beyond the current task, update this file and/or `PROJECT_PLAN.md` before ending the session.
