import type { FormData, YildiznameSections } from "./types";

// We call the Anthropic Messages API directly with Workers' native fetch,
// using server-sent-events streaming.
//
// Why streaming?
//   1) Workers has a 100-second timeout on subrequests that don't return
//      headers in time. A non-streaming call for ~8000 output tokens takes
//      ~2–3 minutes, which trips that timeout. Streaming returns headers
//      immediately, so the timeout never fires.
//   2) Workers Free plan also cuts `executionCtx.waitUntil` short, so we
//      can't do the work in the background — the only way to make this
//      flow reliable on Free is to keep the client connected to the
//      Worker while the Worker keeps the Anthropic stream open.
//
// We still assemble the full text on the server before returning JSON to
// the client — the frontend gets a normal one-shot response, no SSE
// parsing of its own.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-4-5";
// 11 substantial Turkish sections + a poem line need real headroom; at
// 4000 the model truncates mid-JSON and validation fails. 8000 reliably
// fits a full reading with margin.
const MAX_TOKENS = 8000;
// Time-to-first-byte timeout. With streaming, Anthropic responds with
// headers in <1s; anything past 30s here is a clear-cut connection issue.
const HEADERS_TIMEOUT_MS = 30_000;
// Total stream duration cap. A full 8000-token reading runs ~3 minutes;
// 5 minutes is comfortable headroom while still failing fast if something
// stalls.
const STREAM_TIMEOUT_MS = 5 * 60_000;

const SYSTEM_PROMPT = `Sen klasik yıldızname, ebced ve ilm-i hurûf geleneğine vâkıf bir üstad müneccimsin. Osmanlı saray müneccimleri gibi mistik, ağır, sembolik ve edebî konuşursun. Modern numeroloji dili ("enerji, titreşim, evren") asla kullanmazsın; senin dilin harflerin, ayın ve kadim hikmetin dilidir.`;

// Format birthDate (stored as ISO 8601 `YYYY-MM-DD`) as a Turkish-natural
// "9 Mart 1989" string for the LLM prompt. The raw ISO form is ambiguous
// in a Turkish-language context: Turkish dates are conventionally
// DD-first (DD.MM.YYYY), and the model can flip its read of "1989-03-09"
// to "year-day-month" → treat 03 as the day and 09 as Eylül (September).
// Spelling the month name out removes all ambiguity. Parse the string
// literally — do NOT use new Date(), which would apply a timezone offset
// and could shift the day at the boundary. Falls back to the raw string
// for anything that isn't a clean YYYY-MM-DD (defensive; the form always
// composes this format, so the fallback shouldn't fire in practice).
const TURKISH_MONTHS = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
];

function formatBirthDateTurkish(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return iso;
  return `${parseInt(m[3], 10)} ${TURKISH_MONTHS[month - 1]} ${m[1]}`;
}

function buildUserPrompt(form: FormData): string {
  const spouseStr = form.spouseName ? `, eşinin adı: ${form.spouseName}` : "";
  const questionStr = form.question
    ? `. Kişinin en çok merak ettiği: ${form.question}`
    : "";
  const birthDateTr = formatBirthDateTurkish(form.birthDate);

  return `Sana verilen kişi bilgileri: ad-soyad: ${form.name}, anne adı: ${form.motherName}, doğum tarihi: ${birthDateTr}, doğum yeri: ${form.birthPlace}${spouseStr}${questionStr}.

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

// We use Anthropic's tool-use feature to get guaranteed-valid JSON back.
// Asking the model to "output JSON as text" produced invalid escaping on
// long Turkish prose (observed: unescaped quote/newline at ~1400 chars in).
// With a tool, Anthropic constructs the JSON server-side and the streamed
// `input_json_delta` chunks always concatenate to valid JSON.
const SUBMIT_TOOL = {
  name: "submit_reading",
  description:
    "Müneccimin nihai yıldızname okumasını gönderir. Tüm alanlar Türkçe, edebî, en az bir zengin paragraf olmalıdır.",
  input_schema: {
    type: "object",
    properties: {
      kapakSozu: {
        type: "string",
        description: "Kısa, etkileyici bir açılış mısrası.",
      },
      karakterinOzu: { type: "string" },
      gizliHuylar: { type: "string" },
      ruhsalYuk: { type: "string" },
      askEvlilik: { type: "string" },
      esinKarakteri: { type: "string" },
      cocukYuva: { type: "string" },
      rizkKariyer: { type: "string" },
      nazarAgirlik: { type: "string" },
      saglik: { type: "string" },
      donumNoktalari: { type: "string" },
    },
    required: REQUIRED_KEYS,
  },
} as const;

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

// Parse the Anthropic SSE stream. We're using tool_use so we only care about
// content blocks of type "tool_use" — their `input_json_delta` events
// concatenate into a valid JSON document for the tool's input schema.
async function readAnthropicStream(res: Response): Promise<string> {
  if (!res.body) {
    throw new Error("Müneccim cevabı boş geldi.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let toolInputJson = "";
  let inToolUseBlock = false;
  let stopReason: string | null = null;

  const deadline = Date.now() + STREAM_TIMEOUT_MS;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error("Müneccim hâlâ konuşuyor — vakit doldu.");
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("");

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const ev = parsed as {
        type?: string;
        index?: number;
        content_block?: { type?: string };
        delta?: {
          type?: string;
          partial_json?: string;
          stop_reason?: string;
        };
      };

      if (ev.type === "content_block_start") {
        inToolUseBlock = ev.content_block?.type === "tool_use";
      } else if (ev.type === "content_block_delta") {
        if (
          inToolUseBlock &&
          ev.delta?.type === "input_json_delta" &&
          typeof ev.delta.partial_json === "string"
        ) {
          toolInputJson += ev.delta.partial_json;
        }
      } else if (ev.type === "content_block_stop") {
        inToolUseBlock = false;
      } else if (
        ev.type === "message_delta" &&
        typeof ev.delta?.stop_reason === "string"
      ) {
        stopReason = ev.delta.stop_reason;
      }
    }
  }

  if (stopReason === "max_tokens") {
    console.warn("[llm] response truncated at max_tokens", {
      chars: toolInputJson.length,
    });
  }
  if (!toolInputJson) {
    throw new Error(`Müneccim sustu. stop_reason=${stopReason ?? "?"}`);
  }
  return toolInputJson;
}

async function callAnthropicStream(
  apiKey: string,
  userPrompt: string,
): Promise<string> {
  const controller = new AbortController();
  const headersTimer = setTimeout(
    () => controller.abort(),
    HEADERS_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        tools: [SUBMIT_TOOL],
        tool_choice: { type: "tool", name: SUBMIT_TOOL.name },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(headersTimer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[llm] anthropic non-2xx", {
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new Error(`Anthropic ${res.status}`);
  }

  return readAnthropicStream(res);
}

export async function generateYildizname(
  form: FormData,
  apiKey: string,
): Promise<YildiznameSections> {
  if (!apiKey || apiKey === "sk-ant-placeholder") {
    throw new Error("Müneccim suskun: API anahtarı ayarlanmamış.");
  }

  const userPrompt = buildUserPrompt(form);

  // One attempt, plus one retry only on parse/validation failures (an HTTP
  // error or aborted stream means something Anthropic-side is unhappy —
  // immediate retry won't help and burns another 2–3 minutes).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await callAnthropicStream(apiKey, userPrompt);
      return validateSections(JSON.parse(json));
    } catch (err) {
      lastError = err;
      const isTransport =
        err instanceof Error &&
        (err.message.startsWith("Anthropic ") ||
          err.name === "AbortError" ||
          err.message.includes("vakit doldu"));
      if (isTransport) break;
      console.warn("[llm] parse/validation failed, retrying once", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const msg = lastError instanceof Error ? lastError.message : "bilinmeyen hata";
  throw new Error(`Müneccim okuyamadı: ${msg}`);
}
