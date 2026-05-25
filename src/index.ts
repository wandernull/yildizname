import { Hono } from "hono";
import {
  attachStripeSession,
  getReading,
  insertReading,
  markReadingPaid,
} from "./lib/db";
import { generateYildizname } from "./lib/llm";
import {
  createCheckoutSession,
  fetchInvoiceMetadata,
  verifyStripeSignature,
} from "./lib/stripe";
import { fetchCachedAudio, synthesizeStream, ttsKey } from "./lib/tts";
import {
  LOCKED_SECTION_KEYS,
  type Env,
  type FormData,
  type SectionKey,
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
    return c.json({
      id,
      status: "done",
      freeSection: sections.karakterinOzu,
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
  const sections = reading.sections;
  if (!sections) {
    return c.json({ error: "Okuma boş döndü." }, 500);
  }
  const base = {
    id: reading.id,
    unlocked: reading.unlocked,
    kapakSozu: sections.kapakSozu,
    karakterinOzu: sections.karakterinOzu,
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
  });
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
    const session = await createCheckoutSession(c.env, {
      readingId: id,
      origin,
      amountKurus,
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
//   - karakterinOzu is always free (the audio prepends the kapakSözü so the
//     first words the user hears are the literary mısra)
//   - the 9 locked sections require reading.unlocked = true
//   - response is audio/mpeg, served from R2 cache when present and
//     freshly synthesized via ElevenLabs streaming when not

const FREE_SECTION: SectionKey = "karakterinOzu";
const ALLOWED_SECTIONS = new Set<SectionKey>([
  FREE_SECTION,
  ...LOCKED_SECTION_KEYS,
]);

app.get("/api/tts/:readingId/:section", async (c) => {
  const readingId = c.req.param("readingId");
  const section = c.req.param("section") as SectionKey;

  if (!ALLOWED_SECTIONS.has(section)) {
    return c.json({ error: "Geçersiz bölüm." }, 400);
  }

  const reading = await getReading(c.env.DB, readingId);
  if (!reading || !reading.sections) {
    return c.json({ error: "Okuma bulunamadı." }, 404);
  }
  if (section !== FREE_SECTION && !reading.unlocked) {
    return c.json({ error: "Bu bölüm kilitli." }, 403);
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
