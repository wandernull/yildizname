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

- **Compute:** Cloudflare Workers (`compatibility_date = 2025-05-01`, `nodejs_compat`)
- **Framework:** Hono (single `src/index.ts` mounts all routes)
- **Static assets:** Workers Assets binding (`[assets] directory = "./public"`, `not_found_handling = "none"`; SPA fallback handled inside the Worker)
- **Relational data:** D1 — `readings` table + a `promos` table (1 reading → many promos). Schema = `migrations/0001_init.sql` + 0002 status/error + 0003 stripe metadata + 0004 funnel analytics + 0005 client_kind + 0006 feedback + 0007 customer_email + 0008 promos + 0009 promo sent_at/sent_to. All applied to local + remote.
- **Email:** outbound transactional email via Resend (direct REST, no SDK) in `src/lib/email.ts`, sent AS `destek@yildizna.me` (domain verified in Resend, DKIM on the root). Inbound `destek@` routes through Cloudflare Email Routing to `baran@botelabs.io`, so replies loop back. **`destek@` is the single public address** — a `support@` alias also routes there silently but is no longer advertised anywhere (legal pages, footer, etc. all use `destek@`). Used for admin promo/win-back emails + a test-send diagnostic. `RESEND_API_KEY` secret (same key local + prod).
- **Edge state:** KV — not used (no sessions, rate limits, or caches yet)
- **Object storage:** R2 — bucket `yildizname-tts` caches synthesized audio MP3s at key `tts/{prefix}/{readingId}/{section}.mp3` (current prefix `tts/v3`). 15-day lifecycle rule (set out-of-band via `wrangler r2 bucket lifecycle add`). Bump the prefix in `src/lib/tts.ts` whenever audio shaping/content changes (old objects age out via the lifecycle rule).
- **Language:** TypeScript, strict; `@cloudflare/workers-types` for Worker globals
- **LLM:** `@anthropic-ai/sdk` calling `claude-sonnet-4-5` with the Ottoman-müneccim system prompt in `src/lib/llm.ts`. Output is strict JSON validated against `YildiznameSections`. One automatic retry on parse failure.
- **Frontend UI:** Vanilla HTML/CSS/JS served from `public/`. Cormorant Garamond + Noto Serif loaded from Google Fonts. Canvas star field, CSS keyframes, Web Animations API. No bundler.
- **TTS:** ElevenLabs `eleven_multilingual_v2` via direct streaming `fetch` from the Worker. Voice `J17lijyP1BHYcM7ld0Rg` (slow ritualistic settings). The Worker tees the stream — one branch to the client `<audio>`, the other buffered into a `Uint8Array` and written to R2 (R2.put needs a known length). `karakterinOzu` is split into two cached audio variants to avoid double-paying ElevenLabs on conversion: **`karakterinOzu`** = kapakSözü + the 1/3 preview (free state); **`karakterinOzuRest`** = just the remaining 2/3, no kapakSözü prepend (synthesized only after unlock). The client plays preview + rest back-to-back. Text shaping lives only in `src/lib/tts.ts → buildSpeechText()`; the split point in `src/lib/text.ts → splitKarakterinOzu()`.
- **Payments:** **Stripe Checkout, LIVE.** Direct Stripe REST (no SDK) in `src/lib/stripe.ts`; Web Crypto HMAC verifies the webhook. `MockPaymentProvider` / the `PaymentProvider` interface were deleted. iyzico explicitly **not** in scope. `/api/unlock` pre-creates a Stripe Customer (`preferred_locales=['tr']` for a Turkish invoice) then a Checkout Session (inline `price_data` 34999 kuruş, `automatic_tax` inclusive `txcd_10000000`, `invoice_creation`, `allow_promotion_codes`, `custom_text` brand attribution). `/api/stripe/webhook` is idempotent. Legal entity on the invoice + Pay button: Back of the Envelope B.V., Almere NL, KVK 97838810, VAT NL868254010B01.

## Routes
SPA (served via the Worker's SPA fallback):
- `GET /` landing · `GET /form` multi-step form · `GET /loading` wait screen
- `GET /okuma/:id` — kapakSözü + 1/3 preview + inline paywall + 9 locked sections + action bar
- `GET /okuma/:id?paid=1&session=…` — post-Stripe redirect; polling overlay → success card
- SEO content pages: `/yildizname`, `/ebced`, `/muneccim`, `/menzil`, `/sss`, `/gizlilik`, `/kosullar` (+ `/privacy`→`/gizlilik`, `/terms`→`/kosullar` 301s)

API:
- `POST /api/generate` — calls Claude, inserts a row, returns `{ id, status, freeSection (preview), kapakSozu }`
- `GET /api/reading/:id` — free state returns preview + `karakterinOzuTeaser` (one blurred sentence); unlocked returns full text + 9 sections + invoice URLs + `feedbackGiven`
- `POST /api/unlock` — pre-creates a Stripe Customer + Checkout Session, returns `{ url, sessionId }` (or `{ alreadyUnlocked: true }`)
- `POST /api/stripe/webhook` — HMAC-verified; on `checkout.session.completed` flips `unlocked`, fetches invoice meta (idempotent)
- `GET /api/tts/:readingId/:section` — `audio/mpeg`. Free: `karakterinOzu`. Paid-only: `karakterinOzuRest` + the 9 locked sections (403 otherwise). R2 cache hit → stream; miss → synth + tee to R2.
- `POST /api/track/:id` — idempotent funnel flags (scrolled_past_free, listened_free/locked/chain, clicked_unlock, viewed/clicked_feedback_cta)
- `POST /api/feedback/:id` — paid-only (403 if locked); `{ rating 1-5 required, text? }`; first-submission-wins

Admin (HTTP Basic Auth via `ADMIN_USER`/`ADMIN_PASS`):
- `GET /admin` — funnel analytics table · `GET /admin/ratings` — feedback/ratings · `GET /admin/ops` — ops (reset-payment + email sync + promo generation)
- `POST /api/admin/reset-payment/:id` — clears unlocked + Stripe metadata + feedback (no Stripe refund); PRG redirect
- `POST /api/admin/sync-email/:id` — backfills `customer_email` from the Stripe session; PRG redirect
- `POST /api/admin/generate-promo/:id` — creates a Stripe coupon + single-use `YILDIZ-XXXX` promotion code (percent from form, 30-day expiry), mirrors into `promos`; PRG redirect. Promo requests pin `Stripe-Version: 2024-06-20` (account default rejects the classic `coupon` param)
- `POST /api/admin/send-promo/:promoId` — emails a generated promo to a customer via Resend (editable compose modal on the Ops page), records `sent_at`/`sent_to`; PRG redirect
- `POST /api/admin/test-email` — sends a test email AS `destek@yildizna.me` (Resend channel diagnostic); PRG redirect

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

Worker secrets (prod via `wrangler secret put`, local via `.dev.vars`) — 6 set in prod:
- `ANTHROPIC_API_KEY` — Claude
- `ELEVENLABS_API_KEY` — TTS
- `STRIPE_SECRET_KEY` — **live** `sk_live_…` (rotated before go-live)
- `STRIPE_WEBHOOK_SECRET` — `whsec_…` from the prod webhook endpoint
- `ADMIN_USER` + `ADMIN_PASS` — HTTP Basic Auth for `/admin*`

Test mode (local `.dev.vars`) uses `sk_test_…` + a `stripe listen` whsec.

**Shell gotcha:** `source ~/.gizem-creds` errors in non-interactive shells (gvm init). Run commands via `/bin/bash --noprofile --norc -c '…'` and extract the one var you need by grepping the file. `git push` needs the one-off token URL (Keychain offers the wrong account): `git -c credential.helper= push "https://wandernull:${GH_TOKEN}@github.com/wandernull/yildizname.git" main`.

## Living plan
The living plan, status, and decisions log is `./PROJECT_PLAN.md`. Update it whenever a change has lasting impact so future sessions can pick up where this one left off.

## Update directive
If any decision, architectural change, scope shift, or learning in this session has impact beyond the current task, update this file and/or `PROJECT_PLAN.md` before ending the session.
