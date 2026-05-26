import { Hono } from "hono";
import {
  attachStripeSession,
  captureViewerIp,
  getReading,
  insertReading,
  listReadingsForAdmin,
  markEvent,
  markReadingPaid,
} from "./lib/db";
import { generateYildizname } from "./lib/llm";
import {
  createCheckoutSession,
  createStripeCustomer,
  fetchInvoiceMetadata,
  verifyStripeSignature,
} from "./lib/stripe";
import { fetchCachedAudio, synthesizeStream, ttsKey } from "./lib/tts";
import {
  LOCKED_SECTION_KEYS,
  TRACK_EVENTS,
  type Env,
  type FormData,
  type Reading,
  type SectionKey,
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
  // Funnel analytics: capture the viewer's IP on the first read of this
  // reading. captureViewerIp only writes if the column is still NULL, so
  // this is a no-op on subsequent reads (or from a different IP for the
  // same reading). Fire-and-forget — don't await this and don't break
  // the request if it fails.
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;
  if (ip && !reading.viewerIp) {
    c.executionCtx.waitUntil(
      captureViewerIp(c.env.DB, id, ip).catch((err) => {
        console.warn("[reading] viewer_ip capture failed", { id, err });
      }),
    );
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

function renderAdminPage(readings: Reading[]): string {
  const total = readings.length;
  const scrolled = readings.filter((r) => r.scrolledPastFree).length;
  const listenedFree = readings.filter((r) => r.listenedFree).length;
  const listenedLocked = readings.filter((r) => r.listenedLocked).length;
  const clickedUnlock = readings.filter((r) => r.clickedUnlock).length;
  const paid = readings.filter((r) => r.unlocked).length;
  const pct = (n: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);

  const rows = readings
    .map((r) => {
      const f = r.formData;
      const created = r.createdAt.replace("T", " ").slice(0, 19);
      return `<tr>
  <td class="when">${esc(created)}</td>
  <td class="ip">${esc(r.viewerIp ?? "—")}</td>
  <td class="who">
    <strong>${esc(f.name)}</strong><br />
    <span class="dim">anne: ${esc(f.motherName)}</span>
  </td>
  <td class="when2">
    ${esc(f.birthDate)}<br />
    <span class="dim">${esc(f.birthPlace)}</span>
  </td>
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

  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>yıldızna.me admin — okuma istatistikleri</title>
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
    .meta { color: var(--dim); margin-bottom: 1.6rem; font-size: 0.85rem; }
    .stats { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 2rem; }
    .stat { background: var(--row2); border: 1px solid var(--border); border-radius: 6px; padding: 0.8rem 1rem; }
    .stat-label { color: var(--dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .stat-value { font-size: 1.5rem; color: var(--gold); font-weight: 600; }
    .stat-pct { font-size: 0.85rem; color: var(--dim); margin-left: 0.4rem; }
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
    td.id a { color: var(--gold); text-decoration: none; font-size: 0.78rem; }
    td.id a:hover { text-decoration: underline; }
    .empty { padding: 3rem 0; text-align: center; color: var(--dim); font-style: italic; }
  </style>
</head>
<body>
  <h1>yıldızna.me — okuma istatistikleri</h1>
  <p class="meta">Son ${esc(String(total))} okuma. Yenilemek için sayfayı yenile.</p>

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
  </table>`}
</body>
</html>`;
}

app.get("/admin", async (c) => {
  if (!checkBasicAuth(c, c.env)) return unauthorized();
  const readings = await listReadingsForAdmin(c.env.DB);
  return c.html(renderAdminPage(readings));
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
