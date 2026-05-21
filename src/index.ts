import { Hono } from "hono";
import {
  completeReading,
  failReading,
  getReading,
  insertPendingReading,
  unlockReading,
} from "./lib/db";
import { generateYildizname } from "./lib/llm";
import { defaultPaymentProvider } from "./lib/payment";
import type { Env, FormData } from "./lib/types";

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

// ----- background work ------------------------------------------------------

// Runs after the response has been sent. Workers keeps the invocation alive
// for as long as this promise is awaiting (up to the platform's 30-minute
// cap). If the runtime sheds load, the row stays in 'pending' — the client
// keeps polling and either gets the eventual completion, or the user retries
// from /form.
async function runGenerationJob(
  env: Env,
  id: string,
  form: FormData,
): Promise<void> {
  try {
    const sections = await generateYildizname(form, env.ANTHROPIC_API_KEY);
    await completeReading(env.DB, id, sections);
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "Yıldızlar şu an okunamıyor, sonra tekrar deneyin.";
    console.error("[generate] background job failed", { id, error: msg });
    await failReading(env.DB, id, msg);
  }
}

// ----- API ------------------------------------------------------------------

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
    await insertPendingReading(c.env.DB, id, form);
  } catch (err) {
    console.error("[generate] insert pending failed", { id, error: err });
    return c.json({ error: "Okuma kaydedilemedi." }, 500);
  }

  // Fire and forget — Workers will hold the invocation open until the
  // promise settles. The client polls /api/reading/:id to see when it
  // flips out of 'pending'.
  c.executionCtx.waitUntil(runGenerationJob(c.env, id, form));

  return c.json({ id, status: "pending" });
});

app.get("/api/reading/:id", async (c) => {
  const id = c.req.param("id");
  const reading = await getReading(c.env.DB, id);
  if (!reading) {
    return c.json({ error: "Okuma bulunamadı." }, 404);
  }

  if (reading.status === "pending") {
    return c.json({ id: reading.id, status: "pending" });
  }
  if (reading.status === "error") {
    return c.json(
      {
        id: reading.id,
        status: "error",
        error: reading.error ?? "Bilinmeyen hata.",
      },
      // 200 so the client can read the JSON without fetch throwing on !ok.
      200,
    );
  }

  // status === 'done'
  const sections = reading.sections;
  if (!sections) {
    return c.json(
      { id: reading.id, status: "error", error: "Okuma boş döndü." },
      200,
    );
  }
  const base = {
    id: reading.id,
    status: "done" as const,
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
  if (existing.status !== "done") {
    return c.json(
      { success: false, error: "Okuma henüz hazır değil." },
      409,
    );
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
