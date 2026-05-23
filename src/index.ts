import { Hono } from "hono";
import { getReading, insertReading, unlockReading } from "./lib/db";
import { generateYildizname } from "./lib/llm";
import { defaultPaymentProvider } from "./lib/payment";
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
  });
});

app.post("/api/unlock", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Geçersiz istek." }, 400);
  }
  const id = (body as { id?: unknown })?.id;
  if (typeof id !== "string" || !id) {
    return c.json({ success: false, error: "id gerekli." }, 400);
  }
  const existing = await getReading(c.env.DB, id);
  if (!existing) {
    return c.json({ success: false, error: "Okuma bulunamadı." }, 404);
  }
  if (existing.unlocked) {
    return c.json({ success: true, transactionId: "already_unlocked" });
  }
  const provider = defaultPaymentProvider();
  const result = await provider.charge({
    readingId: id,
    amount: Number(c.env.READING_PRICE_TRY ?? "250") * 100,
    currency: "TRY",
  });
  if (!result.success) {
    return c.json(
      { success: false, error: result.message ?? "Ödeme başarısız." },
      402,
    );
  }
  const updated = await unlockReading(c.env.DB, id);
  if (!updated) {
    return c.json({ success: false, error: "Okuma açılamadı." }, 500);
  }
  return c.json({ success: true, transactionId: result.transactionId });
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

const CONTENT_PAGES = ["yildizname", "ebced", "muneccim", "menzil", "sss"];
for (const slug of CONTENT_PAGES) {
  app.get(`/${slug}`, async (c) => {
    const url = new URL(c.req.url);
    url.pathname = `/${slug}.html`;
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  });
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
