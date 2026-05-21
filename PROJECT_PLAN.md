# Project Plan — Yıldızname

## Vision
A premium, mystical, Turkish-language astrology reading experience that feels nothing like a SaaS product. The reader should feel they have walked into an Ottoman observatory, not opened a web form. The free preview must be strong enough that the 250 ₺ unlock feels overdue, not pushy.

## Phases

### Phase 1 — Scaffold + free preview (status: done)
- Goal: end-to-end demo from landing → form → loading → free section + locked previews → mock unlock, all on Workers + Hono + D1.
- Scope: design system, Cormorant + Noto Serif from Google Fonts, canvas star field, Moon + shooting stars, multi-step form, Claude prompt + JSON parsing, D1 `readings` schema, mock `PaymentProvider`, TTS audio with sentence highlighting, print-to-PDF, GitHub Actions deploy on push to `main`.
- Out of scope: real Stripe checkout, KV-based rate limiting, OG share images, email delivery, SEO/analytics.

### Phase 2 — Real payments + persistence hardening (status: not started)
- Goal: durable readings + real payment flow.
- Scope: Stripe Checkout Session + signed webhook → `/api/stripe/webhook` flips `unlocked` in D1; idempotency on `event.id`; receipt email; refund handling stub; basic admin route to inspect a reading.
- Out of scope: subscriptions, refunds UI.

### Phase 3 — Share + polish (status: not started)
- Goal: shareable, viral-ready surface.
- Scope: OG image per reading (Workers can render to PNG via `@cloudflare/workers-types`-compatible image lib or Workers AI), shareable read-only link with locked preview, server-rendered PDF stored in R2 + emailed.

### Phase 4 — TTS upgrade (status: not started)
- Goal: replace browser `speechSynthesis` with a higher-quality Turkish voice (ElevenLabs or similar) so the recording feels like a real müneccim.
- Decision deferred until v1 traffic justifies the cost.

## Current status
**As of 2026-05-21** — Phase 1 freshly scaffolded by Claude Code, *rebuilt* from scratch onto Cloudflare Workers + Hono + D1 per the global standards (a first attempt on Next.js was discarded). Local toolchain installed; `npm run typecheck` passes; `wrangler dev` ready to run once D1 is provisioned. To exercise the full flow: provision the D1 database, run migrations, set `ANTHROPIC_API_KEY` in `.dev.vars`, then `npm run dev`.

## Decisions log
A reverse-chronological log of meaningful decisions. Each entry: date, decision, reasoning, alternatives considered.

- **2026-05-21 — Switched the entire stack from Next.js to Cloudflare Workers + Hono + D1.** Reasoning: the global standards in `~/.claude/CLAUDE.md` specify Workers + Hono as the web default; the first scaffold violated that and the user asked to rebuild strictly to standard. Alternatives considered: keep Next.js (rejected — violates standards), Workers + Hono + Pages for the frontend (rejected — extra deploy surface; Workers Assets serves static fine).
- **2026-05-21 — Vanilla HTML/CSS/JS frontend, no bundler.** Reasoning: global standards say "Vanilla HTML/JS served from the Worker, unless a frontend framework is explicitly requested." User affirmed strict standards. Animations move to canvas + CSS keyframes + Web Animations API. Alternatives: React+Vite SPA (rejected — adds build step and JS payload; standards explicitly say vanilla by default).
- **2026-05-21 — SPA shell via History API, served by SPA fallback in the Worker's `notFound` handler.** Reasoning: keeps the persistent star-field canvas across "screen" changes, which is essential for the mystical atmosphere; otherwise every navigation flashes the background. Alternatives: separate HTML files per route (rejected — kills the persistent atmosphere); `not_found_handling = "single-page-application"` on the assets binding (rejected — would also catch `/api/*` paths, harder to keep clean).
- **2026-05-21 — Stripe (not iyzico) as the eventual payment provider.** Reasoning: user explicitly chose Stripe. Alternatives: iyzico (rejected — user-vetoed).
- **2026-05-21 — Mock payment behind a `PaymentProvider` interface for v1.** Reasoning: lets the full UI flow ship and be tested end-to-end before the user wires real Stripe themselves. Drop-in replacement when Stripe is added.
- **2026-05-21 — `claude-sonnet-4-5` with `max_tokens: 4000` and strict JSON validation + one retry.** Reasoning: Sonnet has the tone for Ottoman-müneccim Turkish; the SDK's `messages.create` works directly inside Workers (it's fetch-based). Alternatives: Opus (overkill cost-wise for one-shot generation), Haiku (lacks the literary depth this needs).
- **2026-05-21 — Browser Web Speech API for TTS in v1.** Reasoning: zero per-request cost, ships everywhere, Turkish voice quality on macOS/iOS is acceptable. Phase 4 will revisit.
- **2026-05-21 — In-app SPA routing (History API), Worker's `notFound` falls back to `/index.html`.** Reasoning: cleanest division of concerns — assets serve real files, Worker serves dynamic API + SPA shell. Alternatives: hash-based routing (rejected — uglier shareable URLs).

## Open questions
- **Stripe account.** Needs a registered TR entity (or international Stripe + TRY currency support). Blocking Phase 2.
- **Domain.** Spec implies `yıldızna.me` — Punycode `xn--yldzna-tcb.me`. Confirm availability and Cloudflare DNS handles the IDN.
- **D1 daily rate.** Free tier is generous; revisit before any paid traffic. KV may be useful as a read-through cache if `/api/reading/:id` becomes hot.
- **Reading retention / GDPR-style erasure.** Decide a retention policy and add a `DELETE /api/reading/:id` (signed) when needed.
- **TTS voice quality on Android Chrome.** Spot-check on at least one Android device — `tr-TR` voices are anecdotally weaker there. May force Phase 4 sooner.
- **PDF download.** Currently `window.print()` + a print stylesheet. Polished PDFs (ornaments, logo, embedded fonts) would need server-side rendering — most likely Phase 3 with R2 storage.
