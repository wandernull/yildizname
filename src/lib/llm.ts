import Anthropic from "@anthropic-ai/sdk";
import type { FormData, YildiznameSections } from "./types";

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

export async function generateYildizname(
  form: FormData,
  apiKey: string,
): Promise<YildiznameSections> {
  if (!apiKey || apiKey === "sk-ant-placeholder") {
    throw new Error("Müneccim suskun: API anahtarı ayarlanmamış.");
  }

  // The Anthropic SDK supports Workers' fetch runtime out of the box.
  const client = new Anthropic({ apiKey });
  const userPrompt = buildUserPrompt(form);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("Müneccim sustu.");
      }
      return validateSections(extractJson(textBlock.text));
    } catch (err) {
      lastError = err;
      // retry once
    }
  }

  const msg = lastError instanceof Error ? lastError.message : "bilinmeyen hata";
  throw new Error(`Müneccim okuyamadı: ${msg}`);
}
