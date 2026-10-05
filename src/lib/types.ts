// Shared types between the Worker and the vanilla frontend.
// Keep this file pure (no Worker / DOM imports) so the same file can be
// referenced from documentation; the frontend imports the section-title
// table from /public/js/sections.js (mirror of the SECTION_TITLES below).

export interface FormData {
  name: string;
  motherName: string;
  birthDate: string;
  birthPlace: string;
  spouseName?: string;
  question?: string;
}

export interface YildiznameSections {
  kapakSozu: string;
  karakterinOzu: string;
  gizliHuylar: string;
  ruhsalYuk: string;
  askEvlilik: string;
  esinKarakteri: string;
  cocukYuva: string;
  rizkKariyer: string;
  nazarAgirlik: string;
  saglik: string;
  donumNoktalari: string;
}

export type SectionKey = Exclude<keyof YildiznameSections, "kapakSozu">;

// What the reader asked about (form.question), classified by the same
// generation call (migration 0013). When no question was given, the model
// picks the topic the reading makes most compelling — whether they asked
// is read from form.question, not from the topic.
export const QUESTION_TOPICS = [
  "ask",
  "aile",
  "kariyer",
  "para",
  "saglik",
  "ruhsal",
  "genel",
] as const;
export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

// The locked section that answers each topic — the target of the free
// preview's closing open loop, the modal exit hook and the win-back email.
export const TOPIC_SECTION: Record<QuestionTopic, SectionKey> = {
  ask: "askEvlilik",
  aile: "cocukYuva",
  kariyer: "rizkKariyer",
  para: "rizkKariyer",
  saglik: "saglik",
  ruhsal: "ruhsalYuk",
  genel: "donumNoktalari",
};

export const QUESTION_TOPIC_LABEL: Record<QuestionTopic, string> = {
  ask: "Aşk",
  aile: "Aile",
  kariyer: "Kariyer",
  para: "Para",
  saglik: "Sağlık",
  ruhsal: "Ruhsal",
  genel: "Genel",
};

// Non-section outputs of the generation call (migration 0013).
export interface ReadingMeta {
  questionTopic: QuestionTopic;
  hookLine: string;
}

export const SECTION_TITLES: Record<SectionKey, string> = {
  karakterinOzu: "Karakterin Özü",
  gizliHuylar: "Gizli Huylar",
  ruhsalYuk: "Ruhsal Yük",
  askEvlilik: "Aşk ve Evlilik",
  esinKarakteri: "İlham ve Esin",
  cocukYuva: "Çocuk ve Yuva",
  rizkKariyer: "Rızk ve Kariyer",
  nazarAgirlik: "Nazar Ağırlığı",
  saglik: "Sağlık",
  donumNoktalari: "Dönüm Noktaları",
};

export const LOCKED_SECTION_KEYS: SectionKey[] = [
  "gizliHuylar",
  "ruhsalYuk",
  "askEvlilik",
  "esinKarakteri",
  "cocukYuva",
  "rizkKariyer",
  "nazarAgirlik",
  "saglik",
  "donumNoktalari",
];

export type ReadingStatus = "pending" | "done" | "error";

// Funnel-event keys accepted by POST /api/track/:id. Kept in sync with
// the column names in migration 0004; each one maps to one boolean flag
// on the reading row. The flags are idempotent — once a flag is set,
// repeated tracking calls are no-ops. Used by the /admin backoffice to
// compute funnel conversion rates.
export const TRACK_EVENTS = [
  "scrolled_past_free",
  "listened_free",
  "listened_locked",
  "listened_chain",
  "clicked_unlock",
  "opened_unlock",
  "viewed_feedback_cta",
  "clicked_feedback_cta",
] as const;
export type TrackEvent = (typeof TRACK_EVENTS)[number];

// Which unlock entry point opened the price modal (migration 0012). Sent
// with opened_unlock and clicked_unlock; anything else is stored as NULL.
export const UNLOCK_SOURCES = ["devamini_oku", "unlock_card", "action_bar"] as const;
export type UnlockSource = (typeof UNLOCK_SOURCES)[number];

export interface Reading {
  id: string;
  formData: FormData;
  sections: YildiznameSections | null;
  status: ReadingStatus;
  error: string | null;
  unlocked: boolean;
  createdAt: string;
  // Stripe payment metadata, populated by the webhook after a successful
  // checkout.session.completed event. Null in the pre-paid state.
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  paidAt: string | null;
  invoiceHostedUrl: string | null;
  invoicePdfUrl: string | null;
  // Real paid amount + any promo applied (migration 0010). Drives the
  // accurate `value` + `coupon` parameters on the GA4 `report_unlocked`
  // event. Null on pre-0010 paid rows. amountTotalKurus = Stripe's
  // session.amount_total (already post-discount); amountDiscountKurus =
  // sum of discounts on the session; stripePromotionCodeId is the Stripe
  // promo_id — the readable code (e.g. YILDIZ-X3K9) is looked up at read
  // time by joining to the `promos` table.
  amountTotalKurus: number | null;
  amountDiscountKurus: number | null;
  stripePromotionCodeId: string | null;
  // Stripe side of the margin (migration 0011). amountTaxKurus is the VAT
  // inside amountTotalKurus; the fee/net come from the payment's balance
  // transaction in the settlement currency (minor units), with Stripe's
  // own TRY→settlement exchange rate. usdTryAtPayment is the fx snapshot
  // used for the USD view of revenue + margin. All null until captured.
  amountTaxKurus: number | null;
  stripeFeeMinor: number | null;
  stripeNetMinor: number | null;
  stripeSettlementCurrency: string | null;
  stripeExchangeRate: number | null;
  usdTryAtPayment: number | null;
  // Customer email from the Stripe Checkout Session (migration 0007).
  // Auto-captured at webhook time; backfillable via the admin Ops page.
  customerEmail: string | null;
  // Funnel-analytics fields (migrations 0004 + 0005). Populated by the
  // server on first read (viewer_ip, client_kind) and by POST /api/track/:id
  // (the event flags).
  viewerIp: string | null;
  // Client environment bucket, classified server-side from User-Agent on
  // first visit. Null for pre-0005 rows. See classifyClient in src/index.ts.
  clientKind: "web" | "inapp" | "mobile" | null;
  scrolledPastFree: boolean;
  listenedFree: boolean;
  listenedLocked: boolean;
  listenedChain: boolean;
  clickedUnlock: boolean;
  clickedUnlockAt: string | null;
  // Unlock intent (migration 0012): the price modal was opened (any entry
  // point), how often, first-open source, and the source of the open that
  // led to the go-to-Stripe click. Null/0 on rows before 0012.
  openedUnlock: boolean;
  openedUnlockAt: string | null;
  openedUnlockCount: number;
  openedUnlockSource: UnlockSource | null;
  clickedUnlockSource: UnlockSource | null;
  // Generation meta (migration 0013). Null on readings generated before it.
  questionTopic: QuestionTopic | null;
  hookLine: string | null;
  // Rate + feedback (migration 0006). Paid-only — populated via
  // POST /api/feedback/:id. feedbackAt's presence is the "already gave
  // feedback" flag the sticky CTA checks. viewed/clicked are funnel flags.
  feedbackRating: number | null;
  feedbackText: string | null;
  feedbackAt: string | null;
  viewedFeedbackCta: boolean;
  clickedFeedbackCta: boolean;
}

// A promo code generated for a reading from the /admin Ops page
// (migration 0008). Mirrors the Stripe coupon + promotion_code ids so the
// Ops page can fetch live redemption status. One reading → many promos.
export interface Promo {
  id: string;
  readingId: string;
  code: string;
  stripeCouponId: string;
  stripePromotionCodeId: string;
  percentOff: number | null;
  expiresAt: string | null;
  maxRedemptions: number | null;
  createdAt: string;
  // When/where the code was emailed to the customer via the Ops page
  // (migration 0009). Null until sent. sentTo is the recipient address.
  sentAt: string | null;
  sentTo: string | null;
}

// Worker bindings, declared via wrangler.toml. The wrangler types generator
// can produce a worker-configuration.d.ts but we keep this hand-rolled mirror
// so the file is reviewable in the repo.
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TTS_BUCKET: R2Bucket;
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ELEVENLABS_MODEL_ID: string;
  READING_PRICE_TRY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  // HTTP Basic Auth credentials for the /admin backoffice. Set via
  // `npx wrangler secret put ADMIN_USER` and `npx wrangler secret put
  // ADMIN_PASS`. Locally, put them in .dev.vars.
  ADMIN_USER: string;
  ADMIN_PASS: string;
  // Resend API key for outbound email sent AS destek@yildizna.me (promo /
  // win-back codes from the admin Ops page). Set via `npx wrangler secret
  // put RESEND_API_KEY`; locally in .dev.vars. Inbound destek@ routes
  // through Cloudflare Email Routing to the real inbox (a support@ alias
  // also routes there silently, but destek@ is the only public address).
  RESEND_API_KEY: string;
  // Read-only ElevenLabs key (user_read scope only) for the /admin/credits
  // tab — reads the monthly credit allowance. Deliberately separate from
  // ELEVENLABS_API_KEY, which can only synthesize. Optional: the tab shows
  // a notice instead of numbers when it's unset.
  ELEVENLABS_ADMIN_KEY?: string;
  // Background generation queue (Workers Paid). Producer side of the
  // async refactor: /api/generate enqueues a {readingId} and returns
  // immediately; the Worker's queue() handler picks it up and runs the
  // ~2-min Anthropic call independently of any client connection. See
  // wrangler.toml [[queues.producers]] / [[queues.consumers]] for the
  // binding + retry config; miniflare simulates the queue locally.
  GENERATION_QUEUE: Queue<GenerateJob>;
}

// Payload for the GENERATION_QUEUE. The reading id is the canonical
// pointer (form data + status all live in D1, so a re-delivery is
// idempotent — the consumer rechecks status before doing work). The
// baseUrl is captured at enqueue time so the consumer can put a real
// link in the "hazır" email; the consumer has no inbound request, so
// it can't compute `new URL(c.req.url).origin` itself. Origin matches
// whatever host the producer was hit on: `https://yildizna.me` in prod,
// `http://localhost:8787` in local dev.
export interface GenerateJob {
  readingId: string;
  baseUrl: string;
}
