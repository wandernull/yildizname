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
**As of 2026-05-21** — Phase 1 freshly scaffolded by Claude Code, *rebuilt* from scratch onto Cloudflare Workers + Hono + D1 per the global standards (a first attempt on Next.js was discarded).

Live at the canonical domain: **https://yildizna.me** (apex). `www.yildizna.me` 301s to apex via Hono middleware in the Worker. The original `https://yildizname.gizemderinkok.workers.dev` still works too. Landing, SPA routes (`/form`, `/result/:id`), static assets, and the D1-backed `/api/reading/:id` 404 path all verified end-to-end on the apex. The production `ANTHROPIC_API_KEY` secret is set so `POST /api/generate` will actually call Claude.

D1 database `yildizname-db` (`3c3b716c-0d08-4a67-ad7a-ce45f5668be1`) is provisioned, schema applied to both local and remote. GitHub repo `wandernull/yildizname` is public; CI runs typecheck + `wrangler deploy` on push to main; `CLOUDFLARE_API_TOKEN` is set as a repo secret. The CF zone for `yildizna.me` (`3b339b105307034214223c3e88aa2c3b`) is delegated to `henry.ns.cloudflare.com` + `ursula.ns.cloudflare.com`. Worker Custom Domains for apex and www were attached out-of-band via the CF API because the CI token is scoped narrowly (Workers only, no zone perms).

## Decisions log
A reverse-chronological log of meaningful decisions. Each entry: date, decision, reasoning, alternatives considered.

- **2026-05-21 — Canonical hostname is the bare apex `yildizna.me`; www 301s to apex.** Reasoning: simpler shareable links, one canonical for SEO. Implemented as a Hono middleware that checks the `Host:` header and 301s any `www.*` request to the apex with path + query preserved — no zone-level Redirect Rule needed, so the narrow CI token still works. Alternatives: CF Single Redirect Rule (rejected — needs Zone:Edit perms that the CI token lacks; would have forced a token expansion the user didn't want).
- **2026-05-21 — Worker Custom Domains attached out-of-band via the CF API, not via wrangler.toml `routes`.** Reasoning: the CI's `CLOUDFLARE_API_TOKEN` is scoped to Workers:Edit only. A `routes = [..., custom_domain = true]` block in wrangler.toml would force CI to attempt zone-level reconciliation on every deploy and fail. By creating the bindings via direct `PUT /accounts/{id}/workers/domains` once, the custom domains persist in the CF account and CI deploys just push code without touching them. The decision is documented in `wrangler.toml` itself so future agents don't add a routes block by reflex. Alternatives: expand the CI token (rejected — user opted to keep it narrow).
- **2026-05-21 — Wrangler pinned to v4 (not v3) from day one.** Reasoning: wrangler 3's bundled miniflare pins `zod@3.22.3`, which violates `@anthropic-ai/sdk`'s peer dep `^3.25.0 || ^4.0.0` and breaks `npm ci` on CI. v4 ships with a newer miniflare and resolves cleanly. Alternatives: add a `zod` override in package.json (rejected — masks the root cause), pin `@anthropic-ai/sdk` to an older version (rejected — loses SDK features).
- **2026-05-21 — Workers Assets configured with `html_handling = "none"` + `not_found_handling = "none"`.** Reasoning: the default `auto-trailing-slash` HTML handling 307-redirects non-extension paths like `/form` to `/`, so the Worker's SPA fallback never runs. Explicitly disabling that lets the Worker handle non-asset, non-API paths and serve `/index.html` from the ASSETS binding. Alternatives: `not_found_handling = "single-page-application"` (rejected — also serves index.html for /api/* misses).
- **2026-05-21 — Switched the entire stack from Next.js to Cloudflare Workers + Hono + D1.** Reasoning: the global standards in `~/.claude/CLAUDE.md` specify Workers + Hono as the web default; the first scaffold violated that and the user asked to rebuild strictly to standard. Alternatives considered: keep Next.js (rejected — violates standards), Workers + Hono + Pages for the frontend (rejected — extra deploy surface; Workers Assets serves static fine).
- **2026-05-21 — Vanilla HTML/CSS/JS frontend, no bundler.** Reasoning: global standards say "Vanilla HTML/JS served from the Worker, unless a frontend framework is explicitly requested." User affirmed strict standards. Animations move to canvas + CSS keyframes + Web Animations API. Alternatives: React+Vite SPA (rejected — adds build step and JS payload; standards explicitly say vanilla by default).
- **2026-05-21 — SPA shell via History API, served by SPA fallback in the Worker's `notFound` handler.** Reasoning: keeps the persistent star-field canvas across "screen" changes, which is essential for the mystical atmosphere; otherwise every navigation flashes the background. Alternatives: separate HTML files per route (rejected — kills the persistent atmosphere); `not_found_handling = "single-page-application"` on the assets binding (rejected — would also catch `/api/*` paths, harder to keep clean).
- **2026-05-21 — Stripe (not iyzico) as the eventual payment provider.** Reasoning: user explicitly chose Stripe. Alternatives: iyzico (rejected — user-vetoed).
- **2026-05-21 — Mock payment behind a `PaymentProvider` interface for v1.** Reasoning: lets the full UI flow ship and be tested end-to-end before the user wires real Stripe themselves. Drop-in replacement when Stripe is added.
- **2026-05-21 — `claude-sonnet-4-5` with `max_tokens: 4000` and strict JSON validation + one retry.** Reasoning: Sonnet has the tone for Ottoman-müneccim Turkish; the SDK's `messages.create` works directly inside Workers (it's fetch-based). Alternatives: Opus (overkill cost-wise for one-shot generation), Haiku (lacks the literary depth this needs).
- **2026-05-21 — Browser Web Speech API for TTS in v1.** Reasoning: zero per-request cost, ships everywhere, Turkish voice quality on macOS/iOS is acceptable. Phase 4 will revisit.
- **2026-05-21 — In-app SPA routing (History API), Worker's `notFound` falls back to `/index.html`.** Reasoning: cleanest division of concerns — assets serve real files, Worker serves dynamic API + SPA shell. Alternatives: hash-based routing (rejected — uglier shareable URLs).

## Notes for future sessions

- **Git push auth quirk.** `gh repo create --push` worked first time, but subsequent `git push origin main` was rejected because the macOS Keychain credential helper offered the wrong (`baranbartu`) token. Workaround: `git push "https://x-access-token:${GH_TOKEN}@github.com/wandernull/yildizname.git" main`. This is a one-off URL — not a config change. If this recurs, prefer that form over `gh auth setup-git` (which would modify global git config, against the standards).
- **Production secret is set.** `ANTHROPIC_API_KEY` was uploaded via `wrangler secret put` and confirmed by `wrangler secret list`. CF stores it as `secret_text` — name visible, value never readable back.
- **Re-attaching Worker Custom Domains if they're ever cleared.** Account `ef35eded2f130806ec2824e2920866ee`, zone `3b339b105307034214223c3e88aa2c3b`. Run:
  ```bash
  source ~/.gizem-creds
  for HOST in yildizna.me www.yildizna.me; do
    curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/ef35eded2f130806ec2824e2920866ee/workers/domains" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "{\"environment\":\"production\",\"hostname\":\"$HOST\",\"service\":\"yildizname\",\"zone_id\":\"3b339b105307034214223c3e88aa2c3b\"}"
    echo
  done
  ```
  CF requires that no `A`/`AAAA`/`CNAME` record already exists at the hostname for this to succeed — clear those in the DNS dashboard first if it errors with code 100117.

## Open questions
- **Stripe account.** Needs a registered TR entity (or international Stripe + TRY currency support). Blocking Phase 2.
- **Domain.** Spec implies `yıldızna.me` — Punycode `xn--yldzna-tcb.me`. Confirm availability and Cloudflare DNS handles the IDN.
- **D1 daily rate.** Free tier is generous; revisit before any paid traffic. KV may be useful as a read-through cache if `/api/reading/:id` becomes hot.
- **Reading retention / GDPR-style erasure.** Decide a retention policy and add a `DELETE /api/reading/:id` (signed) when needed.
- **TTS voice quality on Android Chrome.** Spot-check on at least one Android device — `tr-TR` voices are anecdotally weaker there. May force Phase 4 sooner.
- **PDF download.** Currently `window.print()` + a print stylesheet. Polished PDFs (ornaments, logo, embedded fonts) would need server-side rendering — most likely Phase 3 with R2 storage.
