import { Hono } from "hono";
import {
  attachStripeSession,
  captureClientKind,
  captureViewerIp,
  countPaidReadings,
  getReading,
  insertReading,
  listReadingsForAdmin,
  listReadingsWithFeedback,
  markEvent,
  markReadingPaid,
  submitFeedback,
} from "./lib/db";
import { generateYildizname } from "./lib/llm";
import {
  createCheckoutSession,
  createStripeCustomer,
  fetchInvoiceMetadata,
  verifyStripeSignature,
} from "./lib/stripe";
import { getKarakterinOzuTeaser, splitKarakterinOzu } from "./lib/text";
import {
  fetchCachedAudio,
  isRestEmptyFor,
  synthesizeStream,
  ttsKey,
  type TtsSection,
} from "./lib/tts";
import {
  LOCKED_SECTION_KEYS,
  TRACK_EVENTS,
  type Env,
  type FormData,
  type Reading,
  type TrackEvent,
} from "./lib/types";

const app = new Hono<{ Bindings: Env }>();

// ----- canonical host: www → apex 301 ---------------------------------------
// Both yildizna.me and www.yildizna.me are attached as Worker Custom Domains
// in Cloudflare. Inside the Worker we redirect any www.* traffic to the
// apex so there's one canonical hostname for SEO and shares.
app.use(async (c, next) => {
  const host = c.req.header("host");
  if (host && host.toLowerCase().startsWith("www.")) {
    const apex = host.slice(4);
    const url = new URL(c.req.url);
    url.host = apex;
    url.protocol = "https:";
    return c.redirect(url.toString(), 301);
  }
  return next();
});

// ----- input validation -----------------------------------------------------

// Classify the visitor's browser environment from the User-Agent header
// into one of three buckets. Order matters: in-app webviews (Instagram,
// Facebook, etc.) usually report "Mobile" in their UA too, so we check
// those patterns first and only fall through to "mobile" if none match.
// The regex mirrors isInAppBrowser() in public/js/views.js so a row
// classified as "inapp" here is the same population that gets the
// clipboard-fallback share path on the client.
function classifyClient(ua: string | null): "web" | "inapp" | "mobile" {
  if (!ua) return "web";
  if (
    /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Twitter|TikTok|musical_ly|Bytedance|Snapchat|LinkedInApp|MicroMessenger|KAKAOTALK|Line\//i.test(
      ua,
    )
  ) {
    return "inapp";
  }
  if (/Mobile|iPhone|iPad|Android/i.test(ua)) {
    return "mobile";
  }
  return "web";
}

function isValidForm(body: unknown): body is FormData {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.name === "string" &&
    b.name.trim().length > 1 &&
    typeof b.motherName === "string" &&
    b.motherName.trim().length > 0 &&
    typeof b.birthDate === "string" &&
    b.birthDate.trim().length > 0 &&
    typeof b.birthPlace === "string" &&
    b.birthPlace.trim().length > 0
  );
}

// ----- API ------------------------------------------------------------------

// /api/generate is synchronous on purpose. Workers Free can't reliably run a
// 2–3 minute background task (waitUntil gets cancelled and there's a 100s
// subrequest cap on non-streaming fetch). Instead we keep the client
// connected for the duration: llm.ts uses Anthropic's SSE streaming API so
// headers come back in <1s (subrequest timeout never fires) and the Worker
// holds the inbound HTTP connection open while it consumes the stream and
// writes the finished row to D1.

app.post("/api/generate", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Geçersiz istek." }, 400);
  }
  if (!isValidForm(body)) {
    return c.json({ error: "Lütfen zorunlu alanları doldurun." }, 400);
  }
  const form = body satisfies FormData;
  const id = crypto.randomUUID();
  try {
    const sections = await generateYildizname(form, c.env.ANTHROPIC_API_KEY);
    await insertReading(c.env.DB, { id, formData: form, sections, unlocked: false });
    // freeSection in the generate response is the preview-portion only;
    // mirrors what /api/reading/:id returns for the free state. The current
    // frontend doesn't actually read this field (it re-fetches via /api/
    // reading/:id once it navigates to /okuma/:id), but trimming it here
    // keeps the boundary clean if a future caller ever does consume it.
    return c.json({
      id,
      status: "done",
      freeSection: splitKarakterinOzu(sections.karakterinOzu).preview,
      kapakSozu: sections.kapakSozu,
    });
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "Yıldızlar şu an okunamıyor, sonra tekrar deneyin.";
    console.error("[generate] failed", { id, error: msg });
    return c.json({ error: msg, status: "error" }, 500);
  }
});

app.get("/api/reading/:id", async (c) => {
  const id = c.req.param("id");
  const reading = await getReading(c.env.DB, id);
  if (!reading) {
    return c.json({ error: "Okuma bulunamadı." }, 404);
  }
  // Funnel analytics: capture the viewer's IP + browser-environment bucket
  // on the first read of this reading. Both helpers only write if the
  // column is still NULL, so subsequent reads (or visits from a different
  // IP / different webview) don't overwrite the first-visit attribution.
  // Fire-and-forget — don't await and don't break the request if either fails.
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;
  if (ip && !reading.viewerIp) {
    c.executionCtx.waitUntil(
      captureViewerIp(c.env.DB, id, ip).catch((err) => {
        console.warn("[reading] viewer_ip capture failed", { id, err });
      }),
    );
  }
  if (!reading.clientKind) {
    const kind = classifyClient(c.req.header("user-agent") ?? null);
    c.executionCtx.waitUntil(
      captureClientKind(c.env.DB, id, kind).catch((err) => {
        console.warn("[reading] client_kind capture failed", { id, err });
      }),
    );
  }
  const sections = reading.sections;
  if (!sections) {
    return c.json({ error: "Okuma boş döndü." }, 500);
  }
  // karakterinOzu is the "free preview" section. Before unlock the client
  // receives only the 1/3 preview (sentence-bounded — see splitKarakterinOzu)
  // PLUS a short `karakterinOzuTeaser` snippet — the first sentence of
  // the locked `rest`. The teaser is rendered inline-blurred at the end
  // of the visible preview as a "fading into more" continuation cue.
  // The bulk of `rest` stays server-side until unlock, same defence-in-
  // depth pattern as the nine fully-locked sections.
  const karakterinOzuForClient = reading.unlocked
    ? sections.karakterinOzu
    : splitKarakterinOzu(sections.karakterinOzu).preview;

  const base = {
    id: reading.id,
    unlocked: reading.unlocked,
    kapakSozu: sections.kapakSozu,
    karakterinOzu: karakterinOzuForClient,
    karakterinOzuTeaser: reading.unlocked
      ? null
      : getKarakterinOzuTeaser(sections.karakterinOzu),
  };
  if (!reading.unlocked) {
    return c.json(base);
  }
  return c.json({
    ...base,
    gizliHuylar: sections.gizliHuylar,
    ruhsalYuk: sections.ruhsalYuk,
    askEvlilik: sections.askEvlilik,
    esinKarakteri: sections.esinKarakteri,
    cocukYuva: sections.cocukYuva,
    rizkKariyer: sections.rizkKariyer,
    nazarAgirlik: sections.nazarAgirlik,
    saglik: sections.saglik,
    donumNoktalari: sections.donumNoktalari,
    // Invoice URLs only present once the webhook has flipped the row to
    // paid + fetched the invoice metadata from Stripe. Null-tolerant on
    // the frontend (we just don't render the link when missing).
    invoiceHostedUrl: reading.invoiceHostedUrl,
    invoicePdfUrl: reading.invoicePdfUrl,
    // Whether this paid reading already has feedback — the frontend uses
    // it to decide whether to show the feedback sticky CTA (one-shot).
    feedbackGiven: reading.feedbackRating !== null,
  });
});

// POST /api/track/:id — funnel analytics. The frontend fires this on
// scroll-past-free, listen-button clicks, and unlock-CTA clicks. Each
// event maps to one boolean flag on the reading row (migration 0004).
// Idempotent — repeated events for the same reading are no-ops.
// Best-effort: a failure here never breaks the user's reading flow,
// so the frontend fires these fire-and-forget without awaiting.
app.post("/api/track/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Geçersiz istek." }, 400);
  }
  const event = (body as { event?: unknown })?.event;
  if (typeof event !== "string" || !TRACK_EVENTS.includes(event as TrackEvent)) {
    return c.json({ error: "Bilinmeyen olay." }, 400);
  }
  // No 404 check on reading existence — saves a DB roundtrip per event.
  // If the id doesn't exist, the UPDATE just affects 0 rows. We trade
  // input-validation strictness for tracking throughput.
  try {
    await markEvent(c.env.DB, id, event as TrackEvent);
    return c.json({ ok: true });
  } catch (err) {
    console.warn("[track] mark event failed", { id, event, err });
    return c.json({ ok: false }, 500);
  }
});

// POST /api/feedback/:id — paid-only rate + feedback. Body:
//   { rating: 1-5 (required), text?: string (optional, <= 2000 chars) }
// Guards: reading must exist AND be unlocked. One-shot — submitFeedback
// no-ops if a rating already exists (first submission wins), so a
// double-submit from a flaky network returns success without clobbering.
const FEEDBACK_TEXT_MAX = 2000;
app.post("/api/feedback/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Geçersiz istek." }, 400);
  }
  const b = (body ?? {}) as { rating?: unknown; text?: unknown };

  // Rating is required, integer 1..5.
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ error: "Puan 1 ile 5 arasında olmalı." }, 400);
  }
  // Text is optional; trim + length-cap if present.
  let text: string | null = null;
  if (typeof b.text === "string") {
    const trimmed = b.text.trim();
    if (trimmed.length > FEEDBACK_TEXT_MAX) {
      return c.json({ error: "Yorum çok uzun." }, 400);
    }
    text = trimmed.length > 0 ? trimmed : null;
  }

  const reading = await getReading(c.env.DB, id);
  if (!reading) {
    return c.json({ error: "Okuma bulunamadı." }, 404);
  }
  // The gate: feedback is a paid-only feature.
  if (!reading.unlocked) {
    return c.json({ error: "Bu özellik yalnızca açılmış okumalar için." }, 403);
  }

  try {
    await submitFeedback(c.env.DB, id, { rating, text });
    return c.json({ success: true });
  } catch (err) {
    console.error("[feedback] submit failed", { id, err });
    return c.json({ error: "Geri bildirim kaydedilemedi." }, 500);
  }
});

// POST /api/unlock — creates a Stripe Checkout Session for the given
// reading and returns the hosted Checkout URL. The frontend redirects
// the user there. The actual unlock happens in the webhook handler
// when Stripe sends `checkout.session.completed`.
//
// Idempotent on already-paid readings: returns `{ alreadyUnlocked: true }`
// without creating a new session.
app.post("/api/unlock", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Geçersiz istek." }, 400);
  }
  const id = (body as { id?: unknown })?.id;
  if (typeof id !== "string" || !id) {
    return c.json({ error: "id gerekli." }, 400);
  }
  const existing = await getReading(c.env.DB, id);
  if (!existing) {
    return c.json({ error: "Okuma bulunamadı." }, 404);
  }
  if (existing.unlocked) {
    return c.json({ alreadyUnlocked: true });
  }

  const amountKurus = Math.round(
    Number(c.env.READING_PRICE_TRY ?? "349.99") * 100,
  );
  const origin = new URL(c.req.url).origin;

  try {
    // Pre-create a Stripe Customer with preferred_locales=['tr'] so the
    // auto-generated invoice (hosted page + PDF + receipt email) renders
    // in Turkish. The Checkout `locale` param controls the payment page
    // UI only; invoice locale is driven by the Customer's preferred_locales.
    // One extra Stripe API call per unlock attempt — cheap and fast.
    const customer = await createStripeCustomer(c.env, { readingId: id });
    const session = await createCheckoutSession(c.env, {
      readingId: id,
      origin,
      amountKurus,
      customerId: customer.id,
    });
    // Persist the session id so the webhook can correlate if the
    // metadata lookup ever fails.
    await attachStripeSession(c.env.DB, id, session.id);
    return c.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stripe hatası.";
    console.error("[unlock] checkout session create failed", { id, msg });
    return c.json({ error: "Ödeme başlatılamadı." }, 502);
  }
});

// POST /api/stripe/webhook — Stripe posts here on every event. We verify
// the signature, act only on `checkout.session.completed`, fetch the
// invoice metadata, and flip the reading row to paid. Every other event
// is acked with 200 so Stripe stops retrying.
//
// Local dev: run
//   stripe listen --forward-to http://localhost:8787/api/stripe/webhook
// then paste the printed `whsec_...` into .dev.vars as STRIPE_WEBHOOK_SECRET.
app.post("/api/stripe/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.text("webhook secret missing", 500);
  }
  const signature = c.req.header("stripe-signature") ?? null;
  if (!signature) {
    return c.text("missing signature header", 400);
  }
  const rawBody = await c.req.text();

  const ok = await verifyStripeSignature(
    rawBody,
    signature,
    c.env.STRIPE_WEBHOOK_SECRET,
  );
  if (!ok) {
    console.warn("[webhook] signature verification failed");
    return c.text("invalid signature", 400);
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.text("invalid JSON", 400);
  }

  if (event.type !== "checkout.session.completed") {
    return c.json({ ok: true, ignored: event.type });
  }

  const session = event.data?.object as
    | {
        id?: string;
        metadata?: { reading_id?: string };
        client_reference_id?: string;
        payment_intent?: string | null;
        invoice?: string | null;
      }
    | undefined;

  const readingId =
    session?.metadata?.reading_id ?? session?.client_reference_id ?? null;
  if (!readingId) {
    console.warn("[webhook] no reading_id on session", session?.id);
    return c.json({ ok: true, warning: "no reading id" });
  }

  // Best-effort invoice lookup. If it fails we still unlock — the user
  // gets their reading; only the "Faturayı indir" link is missing.
  let invoiceMeta: { hostedUrl: string | null; pdfUrl: string | null } = {
    hostedUrl: null,
    pdfUrl: null,
  };
  if (session?.invoice) {
    try {
      const inv = await fetchInvoiceMetadata(c.env, session.invoice);
      if (inv) {
        invoiceMeta = { hostedUrl: inv.hostedUrl, pdfUrl: inv.pdfUrl };
      }
    } catch (err) {
      console.warn("[webhook] invoice lookup threw", {
        invoice: session.invoice,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const updated = await markReadingPaid(c.env.DB, readingId, {
    sessionId: session?.id ?? "",
    paymentIntentId: session?.payment_intent ?? null,
    invoiceHostedUrl: invoiceMeta.hostedUrl,
    invoicePdfUrl: invoiceMeta.pdfUrl,
  });

  if (!updated) {
    console.warn("[webhook] reading not found", readingId);
    // Still ack — TTL expiry or a deleted row. Don't make Stripe retry.
    return c.json({ ok: true, warning: "reading not in D1" });
  }

  console.log("[webhook] reading unlocked", {
    readingId,
    sessionId: session?.id,
    invoice: invoiceMeta.hostedUrl ? "yes" : "no",
  });

  return c.json({ ok: true });
});

// ----- TTS ------------------------------------------------------------------
// GET /api/tts/:readingId/:section
//   - karakterinOzu       free — audio = kapakSözü + 1/3 PREVIEW
//   - karakterinOzuRest   paid — audio = JUST the 2/3 remainder. The
//                          client plays this back-to-back after the
//                          preview to give paid users the full section
//                          without re-synthesising what we already paid
//                          for in the free state.
//   - the 9 locked sections require reading.unlocked = true
//   - response is audio/mpeg, served from R2 cache when present and freshly
//     synthesised via ElevenLabs streaming when not. Cache keys differ for
//     karakterinOzu vs karakterinOzuRest so the two audio variants don't
//     collide.

const FREE_SECTIONS = new Set<TtsSection>(["karakterinOzu"]);
const ALLOWED_TTS_SECTIONS = new Set<TtsSection>([
  "karakterinOzu",
  "karakterinOzuRest",
  ...LOCKED_SECTION_KEYS,
]);

app.get("/api/tts/:readingId/:section", async (c) => {
  const readingId = c.req.param("readingId");
  const section = c.req.param("section") as TtsSection;

  if (!ALLOWED_TTS_SECTIONS.has(section)) {
    return c.json({ error: "Geçersiz bölüm." }, 400);
  }

  const reading = await getReading(c.env.DB, readingId);
  if (!reading || !reading.sections) {
    return c.json({ error: "Okuma bulunamadı." }, 404);
  }
  if (!FREE_SECTIONS.has(section) && !reading.unlocked) {
    return c.json({ error: "Bu bölüm kilitli." }, 403);
  }

  // Edge case: text too short to split into preview + rest (e.g. an
  // unusually terse karakterinOzu). The preview already covers the whole
  // thing; there's no rest audio to play. Return 404 so the client's chain
  // queue / compound-audio player cleanly skips this segment and moves on
  // to the next item without an error toast.
  if (section === "karakterinOzuRest" && isRestEmptyFor(reading.sections)) {
    return c.json({ error: "Bu bölümün devamı yok." }, 404);
  }

  const audioHeaders = {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "public, max-age=1296000, immutable",
    "X-Content-Type-Options": "nosniff",
  };

  // Cache hit — stream the R2 object straight back.
  const cached = await fetchCachedAudio(c.env, readingId, section);
  if (cached) {
    return new Response(cached.body, { headers: audioHeaders });
  }

  // Cache miss — synthesise via ElevenLabs, tee to R2 in the background.
  try {
    const stream = await synthesizeStream(
      c.env,
      c.executionCtx,
      readingId,
      section,
      reading.sections,
    );
    return new Response(stream, { headers: audioHeaders });
  } catch (err) {
    console.error("[tts] synthesize failed", {
      readingId,
      section,
      err: err instanceof Error ? err.message : String(err),
      key: ttsKey(readingId, section),
    });
    return c.json({ error: "Müneccim sesi şu an gelmiyor." }, 502);
  }
});

// ----- Static SEO content pages --------------------------------------------
// Each clean path serves a self-contained static HTML file from public/.
// Defined as explicit Hono routes (rather than relying on the assets
// binding's html_handling) because we disabled html_handling = "auto-
// trailing-slash" earlier to keep the SPA fallback clean. Each route just
// rewrites the URL to `<slug>.html` and lets the ASSETS binding serve it.

const CONTENT_PAGES = [
  "yildizname",
  "ebced",
  "muneccim",
  "menzil",
  "sss",
  "gizlilik",
  "kosullar",
];
for (const slug of CONTENT_PAGES) {
  app.get(`/${slug}`, async (c) => {
    const url = new URL(c.req.url);
    url.pathname = `/${slug}.html`;
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  });
}

// English path aliases for the legal pages. Stripe support, AI agents,
// browser autofill, and ~everyone else guesses /privacy and /terms first.
// 301 redirects to the Turkish canonical URLs so search engines see a
// single source per page (no duplicate-content penalty) while still
// catching anyone who arrives at the English path.
const LEGAL_ALIASES: Record<string, string> = {
  "/privacy": "/gizlilik",
  "/terms": "/kosullar",
};
for (const [from, to] of Object.entries(LEGAL_ALIASES)) {
  app.get(from, (c) => c.redirect(to, 301));
}

// ----- /admin backoffice ---------------------------------------------------
// HTTP Basic Auth guarded analytics dashboard. ADMIN_USER + ADMIN_PASS
// live in Worker secrets (and .dev.vars for local). The browser pops
// up its native credentials dialog on first request and remembers the
// answer for the session. To "log out", close all tabs to this origin.
//
// Why Basic Auth: zero session code, no cookies, no KV. This is a
// single-person admin tool; we don't need a polished login UI.

function checkBasicAuth(c: { req: { header: (n: string) => string | undefined } }, env: Env): boolean {
  // Guard: if admin credentials aren't configured, deny all access and
  // log a warning so the operator notices. Most common cause locally:
  // forgot to add ADMIN_USER / ADMIN_PASS to .dev.vars. In production
  // this means `wrangler secret put ADMIN_USER` / `ADMIN_PASS` wasn't run.
  if (!env.ADMIN_USER || !env.ADMIN_PASS) {
    console.warn("[admin] ADMIN_USER or ADMIN_PASS not set — denying /admin access");
    return false;
  }
  const header = c.req.header("authorization");
  if (!header || !header.toLowerCase().startsWith("basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  // Constant-time compare to deter timing-based password discovery.
  // The credentials are short enough that the practical risk is low
  // but it's three extra lines; cheap.
  if (user.length !== env.ADMIN_USER.length || pass.length !== env.ADMIN_PASS.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < user.length; i++) diff |= user.charCodeAt(i) ^ env.ADMIN_USER.charCodeAt(i);
  for (let i = 0; i < pass.length; i++) diff |= pass.charCodeAt(i) ^ env.ADMIN_PASS.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="yildizna.me admin", charset="UTF-8"',
    },
  });
}

// Tiny HTML escape — sufficient for the four reserved chars that could
// break out of attribute values or text content. We're rendering names,
// places, dates — no rich content. Don't use this on URLs (would
// double-encode &amp;).
function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CHECK = "✓";
const DASH = "·";

// Shared cell renderers used by both admin tables.
function renderKindBadge(kind: string | null): string {
  return kind
    ? `<span class="kind ${kind}">${kind}</span>`
    : `<span class="kind dim">—</span>`;
}
function renderWhoCell(r: Reading): string {
  const f = r.formData;
  return `<td class="who">
    <strong>${esc(f.name)}</strong><br />
    <span class="dim">anne: ${esc(f.motherName)}</span>
  </td>`;
}
function renderBirthCell(r: Reading): string {
  const f = r.formData;
  return `<td class="when2">
    ${esc(f.birthDate)}<br />
    <span class="dim">${esc(f.birthPlace)}</span>
  </td>`;
}
function renderStars(rating: number | null): string {
  if (rating == null) return `<span class="dim">—</span>`;
  const full = "★".repeat(rating);
  const empty = "☆".repeat(Math.max(0, 5 - rating));
  return `<span class="stars">${full}<span class="stars-empty">${empty}</span></span>`;
}
function renderComment(text: string | null): string {
  if (!text) return `<span class="dim">—</span>`;
  const truncated = text.length > 70 ? text.slice(0, 70) + "…" : text;
  // title attr gives the full text on hover.
  return `<span class="comment" title="${esc(text)}">${esc(truncated)}</span>`;
}

// Shared HTML scaffold: head + CSS + tab nav. activeTab highlights the
// current page. Both admin pages render their body through this so the
// styling + nav stay in lockstep.
function renderAdminShell(
  activeTab: "funnel" | "ratings",
  bodyHtml: string,
): string {
  const tab = (href: string, label: string, key: string) =>
    `<a href="${href}" class="${activeTab === key ? "active" : ""}">${label}</a>`;
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>yıldızna.me admin</title>
  <style>
    :root {
      --bg: #0a0e1a; --fg: #e8e4d8; --dim: #8892a3; --gold: #c9a84c;
      --paid: #4ade80; --row: rgba(255,255,255,0.02); --row2: rgba(255,255,255,0.04);
      --border: rgba(201,168,76,0.18);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 2rem; background: var(--bg); color: var(--fg);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px; line-height: 1.5;
    }
    h1 { margin: 0 0 0.4rem; font-size: 1.4rem; color: var(--gold); font-weight: 600; }
    .meta { color: var(--dim); margin-bottom: 1.2rem; font-size: 0.85rem; }
    .admin-nav { display: flex; gap: 0.25rem; margin-bottom: 1.6rem; border-bottom: 1px solid var(--border); }
    .admin-nav a { padding: 0.5rem 1.1rem; color: var(--dim); text-decoration: none; font-size: 0.9rem; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s ease; }
    .admin-nav a:hover { color: var(--fg); }
    .admin-nav a.active { color: var(--gold); border-bottom-color: var(--gold); font-weight: 600; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 2rem; }
    .stat { background: var(--row2); border: 1px solid var(--border); border-radius: 6px; padding: 0.8rem 1rem; }
    .stat-label { color: var(--dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .stat-value { font-size: 1.5rem; color: var(--gold); font-weight: 600; }
    .stat-pct { font-size: 0.85rem; color: var(--dim); margin-left: 0.4rem; }
    .stat-sub { font-size: 0.75rem; color: var(--dim); margin-top: 0.3rem; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 0.6rem 0.5rem; border-bottom: 1px solid var(--border); color: var(--gold); font-weight: 500; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; background: var(--bg); }
    td { padding: 0.75rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
    tr:nth-child(even) td { background: var(--row); }
    .flag { text-align: center; font-size: 1.1rem; color: var(--dim); }
    .flag.paid { color: var(--paid); font-weight: 700; }
    td.when, td.when2 { color: var(--dim); font-size: 0.78rem; white-space: nowrap; }
    td.who strong { color: var(--fg); }
    td.who .dim, td.when2 .dim { color: var(--dim); font-size: 0.78rem; }
    td.ip { color: var(--dim); font-family: ui-monospace, monospace; font-size: 0.78rem; }
    td.kind-cell { white-space: nowrap; }
    .kind { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .kind.web    { background: rgba(136,146,163,0.15); color: var(--dim); }
    .kind.mobile { background: rgba(106,176,255,0.15); color: #6ab0ff; }
    .kind.inapp  { background: rgba(201,168,76,0.18); color: var(--gold); }
    .kind.dim    { background: transparent; color: var(--dim); }
    td.id a { color: var(--gold); text-decoration: none; font-size: 0.78rem; }
    td.id a:hover { text-decoration: underline; }
    .stars { color: var(--gold); letter-spacing: 1px; white-space: nowrap; font-size: 0.95rem; }
    .stars-empty { color: rgba(201,168,76,0.3); }
    td.comment-cell { max-width: 360px; }
    .comment { color: var(--fg); }
    .empty { padding: 3rem 0; text-align: center; color: var(--dim); font-style: italic; }
  </style>
</head>
<body>
  <h1>yıldızna.me admin</h1>
  <nav class="admin-nav">
    ${tab("/admin", "Funnel", "funnel")}
    ${tab("/admin/ratings", "Puanlar", "ratings")}
  </nav>
${bodyHtml}
</body>
</html>`;
}

// Funnel page body — conversion analytics over all readings.
function renderFunnelBody(readings: Reading[]): string {
  const total = readings.length;
  const scrolled = readings.filter((r) => r.scrolledPastFree).length;
  const listenedFree = readings.filter((r) => r.listenedFree).length;
  const listenedLocked = readings.filter((r) => r.listenedLocked).length;
  const clickedUnlock = readings.filter((r) => r.clickedUnlock).length;
  const paid = readings.filter((r) => r.unlocked).length;
  const pct = (n: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);

  const rows = readings
    .map((r) => {
      const created = r.createdAt.replace("T", " ").slice(0, 19);
      return `<tr>
  <td class="when">${esc(created)}</td>
  <td class="ip">${esc(r.viewerIp ?? "—")}</td>
  <td class="kind-cell">${renderKindBadge(r.clientKind)}</td>
  ${renderWhoCell(r)}
  ${renderBirthCell(r)}
  <td class="flag">${r.scrolledPastFree ? CHECK : DASH}</td>
  <td class="flag">${r.listenedFree ? CHECK : DASH}</td>
  <td class="flag">${r.listenedLocked ? CHECK : DASH}</td>
  <td class="flag">${r.listenedChain ? CHECK : DASH}</td>
  <td class="flag">${r.clickedUnlock ? CHECK : DASH}</td>
  <td class="flag ${r.unlocked ? "paid" : ""}">${r.unlocked ? CHECK : DASH}</td>
  <td class="id"><a href="/okuma/${esc(r.id)}" target="_blank">aç →</a></td>
</tr>`;
    })
    .join("\n");

  return `  <p class="meta">Son ${esc(String(total))} okuma. Yenilemek için sayfayı yenile.</p>

  <div class="stats">
    <div class="stat"><div class="stat-label">Toplam</div><div class="stat-value">${esc(String(total))}</div></div>
    <div class="stat"><div class="stat-label">Aşağı kaydırdı</div><div class="stat-value">${esc(String(scrolled))}<span class="stat-pct">${pct(scrolled)}</span></div></div>
    <div class="stat"><div class="stat-label">Karakteri dinledi</div><div class="stat-value">${esc(String(listenedFree))}<span class="stat-pct">${pct(listenedFree)}</span></div></div>
    <div class="stat"><div class="stat-label">Kilitli dinledi</div><div class="stat-value">${esc(String(listenedLocked))}<span class="stat-pct">${pct(listenedLocked)}</span></div></div>
    <div class="stat"><div class="stat-label">"Mührü kır" tıkladı</div><div class="stat-value">${esc(String(clickedUnlock))}<span class="stat-pct">${pct(clickedUnlock)}</span></div></div>
    <div class="stat"><div class="stat-label">Ödedi</div><div class="stat-value">${esc(String(paid))}<span class="stat-pct">${pct(paid)}</span></div></div>
  </div>

  ${total === 0
    ? `<div class="empty">Henüz okuma yok.</div>`
    : `<table>
    <thead>
      <tr>
        <th>Zaman</th>
        <th>IP</th>
        <th>Tür</th>
        <th>Kim</th>
        <th>Doğum</th>
        <th>Scroll</th>
        <th>Dinle: Karakter</th>
        <th>Dinle: Kilitli</th>
        <th>Dinle: Hepsi</th>
        <th>Mührü kır</th>
        <th>Ödedi</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`}`;
}

// Ratings page body — feedback from paid users.
function renderRatingsBody(feedbackReadings: Reading[], paidCount: number): string {
  const total = feedbackReadings.length;
  const avg =
    total === 0
      ? null
      : feedbackReadings.reduce((s, r) => s + (r.feedbackRating ?? 0), 0) / total;
  const responseRate =
    paidCount === 0 ? "—" : `${Math.round((total / paidCount) * 100)}%`;
  // Distribution 5★ → 1★.
  const dist = [5, 4, 3, 2, 1].map(
    (star) => feedbackReadings.filter((r) => r.feedbackRating === star).length,
  );
  const distHtml = [5, 4, 3, 2, 1]
    .map((star, i) => `${star}★ ×${dist[i]}`)
    .join("  ");

  const rows = feedbackReadings
    .map((r) => {
      const rated = (r.feedbackAt ?? "").replace("T", " ").slice(0, 19);
      return `<tr>
  <td class="when">${esc(rated)}</td>
  <td class="ip">${esc(r.viewerIp ?? "—")}</td>
  <td class="kind-cell">${renderKindBadge(r.clientKind)}</td>
  ${renderWhoCell(r)}
  ${renderBirthCell(r)}
  <td>${renderStars(r.feedbackRating)}</td>
  <td class="comment-cell">${renderComment(r.feedbackText)}</td>
</tr>`;
    })
    .join("\n");

  return `  <p class="meta">${esc(String(total))} değerlendirme. Yenilemek için sayfayı yenile.</p>

  <div class="stats">
    <div class="stat"><div class="stat-label">Ortalama puan</div><div class="stat-value">${avg == null ? "—" : avg.toFixed(1)}<span class="stat-pct">${avg == null ? "" : "/ 5"}</span></div><div class="stat-sub">${esc(distHtml)}</div></div>
    <div class="stat"><div class="stat-label">Toplam değerlendirme</div><div class="stat-value">${esc(String(total))}</div></div>
    <div class="stat"><div class="stat-label">Geri bildirim oranı</div><div class="stat-value">${responseRate}</div><div class="stat-sub">${esc(String(total))} / ${esc(String(paidCount))} ödeyen</div></div>
  </div>

  ${total === 0
    ? `<div class="empty">Henüz değerlendirme yok.</div>`
    : `<table>
    <thead>
      <tr>
        <th>Zaman</th>
        <th>IP</th>
        <th>Tür</th>
        <th>Kim</th>
        <th>Doğum</th>
        <th>Puan</th>
        <th>Yorum</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`}`;
}

app.get("/admin", async (c) => {
  if (!checkBasicAuth(c, c.env)) return unauthorized();
  const readings = await listReadingsForAdmin(c.env.DB);
  return c.html(renderAdminShell("funnel", renderFunnelBody(readings)));
});

app.get("/admin/ratings", async (c) => {
  if (!checkBasicAuth(c, c.env)) return unauthorized();
  const [feedbackReadings, paidCount] = await Promise.all([
    listReadingsWithFeedback(c.env.DB),
    countPaidReadings(c.env.DB),
  ]);
  return c.html(
    renderAdminShell("ratings", renderRatingsBody(feedbackReadings, paidCount)),
  );
});

// ----- SPA fallback ---------------------------------------------------------
app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

export default app;
