import type { FormData, YildiznameSections } from "./types";

// We call the Anthropic Messages API directly with Workers' native fetch
// instead of going through @anthropic-ai/sdk. Two reasons:
//   1) The SDK retries internally with exponential backoff on top of our
//      own retry; on a slow LLM call this can stack to >120s and Cloudflare
//      closes the client connection. Direct fetch gives us a single, bounded
//      retry policy that's predictable to debug.
//   2) Smaller bundle and one less Node-shim dependency to reason about
//      inside the Workers runtime.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4000;
// A full müneccim reading is ~4000 output tokens of Turkish prose. At
// Sonnet's generation rate (~60–80 tok/s) that's a ~50–60s call, so 60s
// is right at the edge — observed in production. 90s gives headroom
// without holding the client connection long enough for Cloudflare or
// most browsers to give up.
const REQUEST_TIMEOUT_MS = 90_000;

const SYSTEM_PROMPT = `Sen klasik yıldızname, ebced ve ilm-i hurûf geleneğine vâkıf bir üstad müneccimsin. Osmanlı saray müneccimleri gibi mistik, ağır, sembolik ve edebî konuşursun. Modern numeroloji dili ("enerji, titreşim, evren") asla kullanmazsın; senin dilin harflerin, ayın ve kadim hikmetin dilidir.`;

function buildUserPrompt(form: FormData): string {
  const spouseStr = form.spouseName ? `, eşinin adı: ${form.spouseName}` : "";
  const questionStr = form.question
    ? `. Kişinin en çok merak ettiği: ${form.question}`
    : "";

  return `Sana verilen kişi bilgileri: ad-soyad: ${form.name}, anne adı: ${form.motherName}, doğum tarihi: ${form.birthDate}, doğum yeri: ${form.birthPlace}${spouseStr}${questionStr}.

Yorumdan önce sessizce isimdeki baskın harfleri, ad ile anne adının birleşimini, doğum tarihinin sayısal indirgemesini hesapla; her hükmü kişinin kendi harflerine ve ismine bağla — genel fal cümleleri kurma, ona özel konuş. İsme uyan istiâreler kullan (ay, yağmur, demir, kök, nur, kapı, örs gibi). İyi ve karanlık tarafları birlikte, dürüstçe söyle; ne sadece pohpohla ne de korkut. Üslup edebî, derin, akıcı; liste değil, kader okuyan bir hikâye gibi aksın.

Çıktıyı yalnızca geçerli bir JSON nesnesi olarak, başka hiçbir metin olmadan döndür. Anahtarlar ve her birinin değeri en az bir zengin paragraf olsun: kapakSozu (kısa etkileyici mısra), karakterinOzu, gizliHuylar, ruhsalYuk, askEvlilik, esinKarakteri, cocukYuva, rizkKariyer, nazarAgirlik, saglik, donumNoktalari. Her bölümün sonunda bir müneccim tavsiyesi cümlesi olsun. karakterinOzu ücretsiz önizleme olduğu için en güçlü, en merak uyandıran bölüm olsun.`;
}

const REQUIRED_KEYS: (keyof YildiznameSections)[] = [
  "kapakSozu",
  "karakterinOzu",
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

interface AnthropicMessage {
  content?: Array<{ type: string; text?: string }>;
}

function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Cevapta JSON nesnesi yok.");
  }
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

function validateSections(obj: unknown): YildiznameSections {
  if (!obj || typeof obj !== "object") {
    throw new Error("Cevap nesne değil.");
  }
  const record = obj as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (typeof record[key] !== "string" || !record[key]) {
      throw new Error(`Eksik bölüm: ${key}`);
    }
  }
  return record as unknown as YildiznameSections;
}

async function callAnthropic(
  apiKey: string,
  userPrompt: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[llm] anthropic non-2xx", {
        status: res.status,
        body: body.slice(0, 500),
      });
      throw new Error(`Anthropic ${res.status}`);
    }

    const data = (await res.json()) as AnthropicMessage;
    const textBlock = data.content?.find((b) => b.type === "text");
    if (!textBlock || typeof textBlock.text !== "string" || !textBlock.text) {
      console.error("[llm] no text block in response", { data });
      throw new Error("Müneccim sustu.");
    }
    return textBlock.text;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateYildizname(
  form: FormData,
  apiKey: string,
): Promise<YildiznameSections> {
  if (!apiKey || apiKey === "sk-ant-placeholder") {
    throw new Error("Müneccim suskun: API anahtarı ayarlanmamış.");
  }

  const userPrompt = buildUserPrompt(form);

  // One attempt, plus one retry only on JSON-parse / validation failures
  // (network errors with a real status code mean something Anthropic-side
  // is unhappy — retrying immediately won't help).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callAnthropic(apiKey, userPrompt);
      return validateSections(extractJson(text));
    } catch (err) {
      lastError = err;
      const isNetwork =
        err instanceof Error &&
        (err.message.startsWith("Anthropic ") || err.name === "AbortError");
      if (isNetwork) break; // don't retry transport errors
      console.warn("[llm] parse/validation failed, retrying once", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const msg = lastError instanceof Error ? lastError.message : "bilinmeyen hata";
  throw new Error(`Müneccim okuyamadı: ${msg}`);
}
