# Yıldızname

Klasik yıldızname ve ilm-i hurûf geleneğinden ilham alan, kişiye özel bir mistik okuma sunan Türkçe web uygulaması. Ücretsiz `Karakterin Özü` önizlemesi + 250 ₺'lik tam okuma kilidi.

## Stack
- **Cloudflare Workers** + **Hono** (single Worker; serves both `/api/*` and the static SPA)
- **D1** for the `readings` table
- **Workers Assets** for the vanilla HTML/CSS/JS frontend
- **`@anthropic-ai/sdk`** → `claude-sonnet-4-5` with an Ottoman-müneccim system prompt
- Browser **Web Speech API** (`tr-TR`) for sesli okuma
- Mock `PaymentProvider` interface (Stripe will drop in for the real flow)

## First-time setup

```bash
# 1. Install deps
npm install

# 2. Local env vars
cp .dev.vars.example .dev.vars
# edit .dev.vars and set ANTHROPIC_API_KEY

# 3. Provision the D1 database (one-off)
npx wrangler d1 create yildizname-db
# copy the printed database_id into wrangler.toml under [[d1_databases]]

# 4. Apply migrations to the local SQLite copy
npm run db:migrate:local

# 5. Run
npm run dev
# → http://localhost:8787
```

## Scripts

| Script | What it does |
| ------ | ------------ |
| `npm run dev` | `wrangler dev` — local Worker + bundled assets at http://localhost:8787 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate:local` | Apply all migrations in `./migrations` to the local D1 |
| `npm run db:migrate:remote` | Apply all migrations to the production D1 (run from a clean main) |
| `npm run deploy` | `wrangler deploy` — manual prod deploy (CI does this on push to main) |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.toml` |

## Project layout

```
.
├── src/
│   ├── index.ts                 Hono app — all routes
│   └── lib/
│       ├── types.ts             Shared types (FormData, YildiznameSections, Env, …)
│       ├── db.ts                D1 query helpers (insert / get / unlock)
│       ├── llm.ts               Anthropic SDK call + strict JSON validation + retry
│       └── payment.ts           PaymentProvider interface + MockPaymentProvider
├── public/                       Served via the Workers Assets binding
│   ├── index.html               SPA shell + <template>s for each view
│   ├── styles/main.css          Design tokens, animations, print stylesheet
│   └── js/
│       ├── main.js              Entry + History API router
│       ├── views.js             Renderers for landing / form / loading / result
│       ├── bg.js                Canvas star field + shooting stars
│       ├── tts.js               Web Speech API wrapper
│       ├── api.js               fetch helpers for /api/*
│       └── sections.js          Mirror of SECTION_TITLES (kept in sync with types.ts)
├── migrations/
│   └── 0001_init.sql            readings table
├── .github/workflows/deploy.yml CI: typecheck + wrangler deploy on push to main
├── wrangler.toml                Worker + Assets + D1 bindings
├── .dev.vars.example            Local secret template
├── AGENTS.md                    Pointer for agents
├── CLAUDE.md                    Project context (authoritative over global)
├── PROJECT_PLAN.md              Phases, status, decisions log
└── README.md                    This file
```

## Required env

| Variable | Required when | Notes |
| -------- | ------------- | ----- |
| `ANTHROPIC_API_KEY` | always (LLM call) | `.dev.vars` for local, `wrangler secret put` for prod |
| `CLOUDFLARE_API_TOKEN` | CI deploy | set as a GitHub Actions secret on the repo |
| `STRIPE_SECRET_KEY` | once real payment is live | Phase 2 — not used yet |
| `STRIPE_WEBHOOK_SECRET` | once real payment is live | Phase 2 — not used yet |

## Deploy
Pushing to `main` triggers `.github/workflows/deploy.yml`:
1. install + typecheck
2. `npx wrangler deploy` using `CLOUDFLARE_API_TOKEN`

Migrations are **not** auto-applied. After a schema change, run `npm run db:migrate:remote` manually from a clean `main`.

## Docs for next agents
- [./AGENTS.md](./AGENTS.md)
- [./CLAUDE.md](./CLAUDE.md)
- [./PROJECT_PLAN.md](./PROJECT_PLAN.md)
