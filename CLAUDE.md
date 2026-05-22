# Yıldızname

## Elevator pitch
A Turkish mystical astrology web app: an Ottoman astronomer (müneccim) style birth reading, delivered as an animated night-sky experience with prose + Turkish TTS audio. A free "Karakterin Özü" section hooks the user; the remaining nine sections unlock for 250 ₺.

## Plain-language description
- For a 7-year-old: A magical website that whispers your fortune like a storyteller under the stars.
- For a 77-year-old: Eski müneccimlerin sözünü hatırlatan, yıldızname geleneğinden ilham alan, kişiye özel bir okuma sunan bir internet sitesi.

## Persona / target user
Turkish-speaking adults (~25–55) curious about mysticism, family-name and birth-based readings, and willing to pay a small premium for a personalized, beautifully presented experience. Mobile-first — most traffic is expected from Instagram / TikTok referrals.

## Architecture
Single-component web project. The project folder *is* the app folder (no `-api` / `-app` split). One Cloudflare Worker serves both the JSON API (`/api/*`) and the vanilla HTML/CSS/JS frontend (`/`, `/form`, `/loading`, `/result/:id`) through the Workers Assets binding. The frontend is a single SPA shell driven by the History API — no frontend framework, no build step.

Production lives on the apex **https://yildizna.me**. `www.yildizna.me` is also attached as a Worker Custom Domain, but Hono middleware in `src/index.ts` 301s any `www.*` request to the apex with path + query preserved, so the canonical hostname is the bare apex. The `*.workers.dev` URL still resolves as well.

## Tech stack
Strictly the global "Web stack defaults" from `~/.claude/CLAUDE.md`:

- **Compute:** Cloudflare Workers (`compatibility_date = 2025-05-01`, `nodejs_compat`)
- **Framework:** Hono (single `src/index.ts` mounts all routes)
- **Static assets:** Workers Assets binding (`[assets] directory = "./public"`, `not_found_handling = "none"`; SPA fallback handled inside the Worker)
- **Relational data:** D1 — single `readings` table, schema in `migrations/0001_init.sql`
- **Edge state:** KV — not used in v1 (no sessions, rate limits, or caches yet)
- **Object storage:** R2 — bucket `yildizname-tts` caches synthesized audio MP3s at key `tts/{readingId}/{section}.mp3`. 15-day lifecycle rule (set out-of-band via `wrangler r2 bucket lifecycle add`). Free-tier sized: ~600 full readings cached in any 15-day window before storage matters.
- **Language:** TypeScript, strict; `@cloudflare/workers-types` for Worker globals
- **LLM:** `@anthropic-ai/sdk` calling `claude-sonnet-4-5` with the Ottoman-müneccim system prompt in `src/lib/llm.ts`. Output is strict JSON validated against `YildiznameSections`. One automatic retry on parse failure.
- **Frontend UI:** Vanilla HTML/CSS/JS served from `public/`. Cormorant Garamond + Noto Serif loaded from Google Fonts. Canvas star field, CSS keyframes, Web Animations API. No bundler.
- **TTS:** ElevenLabs `eleven_multilingual_v2` via direct streaming `fetch` from the Worker. Voice `J17lijyP1BHYcM7ld0Rg` with slow ritualistic settings (`speed 0.85`, `stability 0.6`, `style 0.4`, speaker boost on). The Worker tees the stream — one branch goes to the client `<audio>` element, the other is buffered into a `Uint8Array` and written to R2 (R2.put requires known content length, can't take a chunked stream directly). Frontend uses a plain `<audio src="/api/tts/{id}/{section}">` element; no Web Speech API. The `karakterinOzu` audio prepends the `kapakSözü` so the autoplay's first words are the literary mısra.
- **Payments:** `PaymentProvider` interface in `src/lib/payment.ts` + `MockPaymentProvider` that always succeeds. The real provider will be **Stripe** (Checkout Session + signed webhook). iyzico is explicitly **not** in scope.

## Routes
- `GET /` — landing
- `GET /form` — multi-step form (SPA route, served via SPA fallback)
- `GET /loading` — mystical wait screen during the LLM call (SPA route)
- `GET /result/:id` — kapakSözü + free section + 9 locked sections + payment CTA (SPA route)
- `GET /result/:id?unlocked=true` — all sections revealed + chained TTS + print/PDF (SPA route)
- `POST /api/generate` — calls Claude, inserts a row into D1, returns `{ id, status, freeSection, kapakSozu }`
- `GET /api/reading/:id` — returns the free preview, plus locked sections only when `reading.unlocked = 1`
- `POST /api/unlock` — runs the mock payment provider, flips `unlocked` to 1, returns `{ success, transactionId }` (idempotent)
- `GET /api/tts/:readingId/:section` — returns `audio/mpeg`. `karakterinOzu` always allowed; the 9 locked sections require `reading.unlocked = 1` (403 otherwise). Cache hits stream from R2 (~1s); cache misses synthesize via ElevenLabs (~15–35s for ~2 minutes of audio), tee the response, and write the buffered bytes to R2 in `waitUntil` for next-call hits.

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

Required env vars:
- `CLOUDFLARE_API_TOKEN` — for `wrangler deploy` and `gh secret set`
- `GH_TOKEN` — for `gh repo create` and `gh secret set` (active account: `wandernull`)
- `ANTHROPIC_API_KEY` — passed to the Worker via `wrangler secret put` (prod) or `.dev.vars` (local)
- `ELEVENLABS_API_KEY` — same handling as Anthropic; Text-to-Speech scope only

Future:
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` once the real payment provider is wired

## Living plan
The living plan, status, and decisions log is `./PROJECT_PLAN.md`. Update it whenever a change has lasting impact so future sessions can pick up where this one left off.

## Update directive
If any decision, architectural change, scope shift, or learning in this session has impact beyond the current task, update this file and/or `PROJECT_PLAN.md` before ending the session.
