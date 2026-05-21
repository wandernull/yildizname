import { Hono } from "hono";
import { getReading, insertReading, unlockReading } from "./lib/db";
import { generateYildizname } from "./lib/llm";
import { defaultPaymentProvider } from "./lib/payment";
import type { Env, FormData } from "./lib/types";

const app = new Hono<{ Bindings: Env }>();

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
  try {
    const sections = await generateYildizname(form, c.env.ANTHROPIC_API_KEY);
    const id = crypto.randomUUID();
    await insertReading(c.env.DB, {
      id,
      formData: form,
      sections,
      unlocked: false,
    });
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
    return c.json({ error: msg, status: "error" }, 500);
  }
});

app.get("/api/reading/:id", async (c) => {
  const id = c.req.param("id");
  const reading = await getReading(c.env.DB, id);
  if (!reading) {
    return c.json({ error: "Okuma bulunamadı." }, 404);
  }
  const base = {
    id: reading.id,
    unlocked: reading.unlocked,
    kapakSozu: reading.sections.kapakSozu,
    karakterinOzu: reading.sections.karakterinOzu,
  };
  if (!reading.unlocked) {
    return c.json(base);
  }
  return c.json({
    ...base,
    gizliHuylar: reading.sections.gizliHuylar,
    ruhsalYuk: reading.sections.ruhsalYuk,
    askEvlilik: reading.sections.askEvlilik,
    esinKarakteri: reading.sections.esinKarakteri,
    cocukYuva: reading.sections.cocukYuva,
    rizkKariyer: reading.sections.rizkKariyer,
    nazarAgirlik: reading.sections.nazarAgirlik,
    saglik: reading.sections.saglik,
    donumNoktalari: reading.sections.donumNoktalari,
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
    // Idempotent — already unlocked.
    return c.json({ success: true, transactionId: "already_unlocked" });
  }
  const provider = defaultPaymentProvider();
  const result = await provider.charge({
    readingId: id,
    amount: Number(c.env.READING_PRICE_TRY ?? "250") * 100, // kuruş
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
// Any non-API GET that wasn't already served by the Assets binding falls
// through to here. We rewrite to /index.html so client-side routing for
// /form, /loading, /result/:id all hydrate the same SPA shell.

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

export default app;
