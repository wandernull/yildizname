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
  "viewed_feedback_cta",
  "clicked_feedback_cta",
] as const;
export type TrackEvent = (typeof TRACK_EVENTS)[number];

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
  // put RESEND_API_KEY`; locally in .dev.vars. Inbound destek@/support@
  // still route through Cloudflare Email Routing to the real inbox.
  RESEND_API_KEY: string;
}
