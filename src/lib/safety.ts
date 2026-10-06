// Sentence-level safety net for the two sections where real harm is
// possible: Sağlık and Çocuk ve Yuva.
//
// The line (agreed with the product owner 2026-10-05): a yıldızname tells
// the bad with the good — weaknesses, temperament, tiring seasons, harmful
// habits, traditional body regions (baş, göğüs, boğaz, mide, bel, sırt),
// family burdens all STAY. Only what a müneccim has no authority to say is
// removed: named diseases/conditions, internal & reproductive organs,
// cycles, any fertility verdict or timing (positive or negative), and
// "your feelings/soul cause or block the body / a child".
//
// The prompt (llm.ts) does the heavy lifting with before→after examples.
// This runs after generation in the queue consumer as a precise net:
//   1. split both sections into sentences; flag only offending sentences
//   2. ONE Sonnet call (same model/Turkish quality as the reading) rewrites
//      just those sentences in context — the rest of the text is never
//      touched (a whole-section Haiku rewrite produced broken Turkish)
//   3. if the call fails, or a replacement is still unsafe, that sentence is
//      dropped: removing one sentence beats shipping the claim
//   4. every change is returned as {section, original, replacement} for the
//      audit trail on the admin Ops page (readings.safety_edits)
// Never throws: a failure here must not fail or re-run a ~$0.09 reading.
//
// CONCEPTION MODE (2026-10-05). When the reader's own question is about
// having a child (IVF, "anne olabilecek miyim"… — ~1-2% of readings), the
// damage of a wrong sentence is highest, so the net gets stricter and
// fails CLOSED:
//   • the SAME single call reviews every sentence of the free preview,
//     Sağlık and Çocuk ve Yuva for meaning, not just word patterns
//   • if that call fails → every child/body sentence in those parts is
//     dropped; after review, any remaining child + promise sentence
//     ("kapı… açılacak", "geç gelecek") is dropped deterministically
//   • the preview ends with a FIXED honest sentence and the hook is a fixed
//     template — what they pay for is stated before payment (the API also
//     sends conceptionMode so the price modal shows "öngörmez")
// Triggered by a fixed rule on form.question (isConceptionQuestion), so it
// needs no stored flag.

import { emptyUsage, type AnthropicUsage } from "./costs";
import { KARAKTER_SPLIT_MARKER } from "./text";
import { SECTION_TITLES, type YildiznameSections } from "./types";

// ---- conception mode -------------------------------------------------------

// Matched on an ASCII-folded, lowercased question so "cocuk sahibi
// olabilecek miyim" (no Turkish keyboard) triggers too. Parenting questions
// ("iyi bir baba olacak mıyım") are about raising children, not conceiving —
// those phrases are removed before matching.
const CONCEPTION_PATTERNS = [
  "cocuk sahibi", "cocugum olur", "cocugum olacak", "cocugumuz ol", "cocuk yap",
  "cocuk olur mu", "cocugum olmuyor", "cocugumuz olmuyor", "bebek sahibi",
  "bebegim olur", "bebegimiz ol", "bebek ist", "hamile", "gebe", "tup bebek",
  "ivf", "asilama", "anne olabil", "anne olacak mi", "anne olur mu", "annelik nasip",
  "baba olabil", "baba olacak mi", "baba olur mu", "kisir", "dusuk yap", "dogurgan",
];
const PARENTING_PHRASES = ["iyi bir anne", "iyi bir baba", "nasil bir anne", "nasil bir baba"];

function asciiFold(s: string): string {
  return s
    .toLocaleLowerCase("tr-TR")
    .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i")
    .replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
    .replace(/[âà]/g, "a").replace(/[îì]/g, "i").replace(/[ûù]/g, "u");
}

export function isConceptionQuestion(question: string | null | undefined): boolean {
  if (!question) return false;
  let q = ` ${asciiFold(question)} `;
  for (const p of PARENTING_PHRASES) q = q.split(p).join(" ");
  return CONCEPTION_PATTERNS.some((p) => q.includes(p));
}

// Fixed, honest wording for unpaid-visible text in conception mode.
export const CONCEPTION_PREVIEW_CLOSER =
  "Sorduğun çocuk meselesinin hükmü hekimin ve Rabbin elindedir; müneccim onu söyleyemez. Ama bu yolun yükünü, sevdiklerinle bağını ve yuvanın sırrını Çocuk ve Yuva bölümünde yalnızca senin için açtım.";
export const CONCEPTION_HOOK =
  "Bu yolun yükünü ve yuvanın sırrını Çocuk ve Yuva bölümünde yalnızca senin için yazdım — çocuğun hükmünü değil, gönlünün yolunu.";

// Deterministic final pass in conception mode: a sentence that talks about
// a child/parenthood/treatment AND contains promise/timing/readiness
// language is dropped even after review.
const CHILD_TOPIC_RE = /(^|[^a-zçğıöşüâîû])(çocu[kğ]|bebe[kğ]|anne ol|annelik|annen ol|baba ol|babalık|evlat|gebe|hamile|tüp bebek|tedavi)/;
const PROMISE_RE = /(açılacak|kapalı değil|gelecek|gelmeyecek|olacak|olmayacak|kavuşacak|nasip olacak|müjde|kucağına|hazır değil|hazır olacak|geç kal|zamanı gel|vakti gel)/;
// Fail-closed scope when the review call fails: anything about a child or
// the body in the reviewed parts.
const CHILD_OR_BODY_RE = /(^|[^a-zçğıöşüâîû])(çocu[kğ]|bebe[kğ]|anne ol|annelik|baba ol|babalık|evlat|gebe|hamile|tüp bebek|tedavi|beden|rahim|rahm)/;

function lowerTr(s: string): string {
  return (s ?? "").toLocaleLowerCase("tr-TR");
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
export const SAFETY_MODEL = "claude-sonnet-4-5";

const SENSITIVE_SECTIONS = ["saglik", "cocukYuva"] as const;
type SensitiveSection = (typeof SENSITIVE_SECTIONS)[number];

// Word-start stems (Turkish appends suffixes). "adet" alone also means
// "piece", so only its menstrual forms; "rahme" alone would hit "rahmet".
const MEDICAL_STEMS = [
  // reproductive organs / cycles / pregnancy
  "rahim", "rahmin", "rahmi ", "rahmi,", "rahme dek", "rahme kadar", "rahmine",
  "dölyata", "yumurtal", "sperm", "kadın organ", "kadınlık organ", "karın altı",
  "adet düzen", "adet dönem", "adetler", "aylık hâl", "aylık hal", "regl", "menopoz",
  "gebe", "gebelik", "hamile", "düşük yap", "düşük riski",
  // fertility verdicts, either direction
  "kısırlı", "kısır kal", "doğurgan", "kaderinde annelik", "kaderinde babalık",
  "anne olacaksın", "baba olacaksın", "çocuğun olacak", "çocuğun olmayacak",
  "çocuğun olmaz", "çocuk sahibi olacak", "çocuk sahibi olama",
  // feelings/soul cause or block the body
  "ruhun onu kilit", "ruhun kilit", "bedenin kilit",
  // named diseases / conditions / internal organs / treatment
  "kadın hastal", "kist", "ur gibi", "tümör", "kanser", "tiroid", "tiroit", "hormon",
  "tansiyon", "bronşit", "nefes darlığ", "migren", "iltihap", "enfeksiyon",
  "şeker hastal", "kalp hastal", "kalp kriz", "böbrek", "karaciğer", "akciğer",
  // ("ilaç" dropped 2026-10-05: "uyku senin ilacın" is a common, harmless
  // metaphor and a false positive removed a good sentence)
  "safra", "idrar yol", "teşhis", "tedavi et", "tedavi ol", "tedavisi",
];
// Harmless disclaimers that contain a stem ("müneccim teşhis koymaz").
const BENIGN_PHRASES = ["teşhis koymaz", "teşhis koyamaz", "teşhisi hekim", "teşhis hekim"];
const TR_LETTER = "a-zçğıöşüâîû";
const MEDICAL_RE = new RegExp(
  `(^|[^${TR_LETTER}])(${MEDICAL_STEMS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
);
// Child timing / child causation inside one sentence — stems can't see
// these ("ilk çocuk biraz geç gelecek", "…ki ona çocuk verebilesin",
// "çocuk sahibi olmayı düşünüyorsan… geç kalmadın").
const CHILD_RE = /(^|[^a-zçğıöşüâîû])(çocu[kğ]|bebe[kğ])/;
const CHILD_CLAIM_RE =
  /(ilk çocu|çocu[kğ]\S* (biraz |çok )?(geç|erken) |geç gelecek|erken gelecek|gelmeyecek|çocu[kğ]\S* gelecek|çocuk ver|doğuracak|doğacak|geç kalmadın|geç kalmış|vakti geçmedi|zamanı geçmedi|bekleyeceksin)/;

function normalise(text: string): string {
  let t = (text ?? "").toLocaleLowerCase("tr-TR");
  for (const p of BENIGN_PHRASES) t = t.split(p).join(" ");
  return t;
}

export function isUnsafeSentence(sentence: string): boolean {
  const t = normalise(sentence);
  return MEDICAL_RE.test(t) || (CHILD_RE.test(t) && CHILD_CLAIM_RE.test(t));
}

// Sentence pieces that concatenate back to the exact original text
// (terminator + any closing quote + trailing whitespace stay with the
// sentence). Falls back to one piece if the split doesn't round-trip.
export function splitSentences(text: string): string[] {
  const pieces = text.match(/[^.!?…]*[.!?…]+["'”’)\]»]*\s*|[^.!?…]+$/g) ?? [text];
  return pieces.join("") === text ? pieces : [text];
}

export function hasMedicalClaims(text: string): boolean {
  return splitSentences(text ?? "").some(isUnsafeSentence);
}

const FIX_SYSTEM = `Sen klasik yıldızname, ebced ve ilm-i hurûf geleneğine vâkıf bir üstad müneccimsin. Osmanlı saray müneccimleri gibi mistik, ağır, sembolik ve edebî konuşursun.`;

const FIX_RULES = `Yıldızname iyiyi de kötüyü de söyler: cümledeki zaafı, uyarıyı, zor mevsimi, mizacı (ateş fazlası, soğuk yapı), geleneksel beden bölgelerini (baş, göğüs, boğaz, mide, bel, sırt) ve aile yükünü KORU. Yalnızca şunları çıkar:
– hastalık ya da durum adları (kist, ur, tiroid, tansiyon, hormon, migren, "kadın hastalıkları"…), iç organlar ve üreme organları, adet ve döngüler;
– kişinin çocuk sahibi olup olamayacağına ya da çocuğun NE ZAMAN geleceğine dair her hüküm, olumlu ya da olumsuz;
– duyguların, güvenin ya da ruhun bedeni, sağlığı ya da çocuk sahibi olmayı kilitlediği/açtığı fikri.
Gerekirse "bir yerin sana tekrar tekrar seslenirse erteleme, bir hekime göster" ya da "bunun zamanı ve yolu hekimin ve Rabbin bileceği iştir" çizgisinde kal. Cümle kurtarılamıyorsa boş metin döndür (cümle silinir). Kusursuz, doğal Türkçe yaz.`;

const CONCEPTION_RULES = `Bu okumanın sahibi çocuk sahibi olmaya çalışıyor; tedavi görüyor olabilir. Yanlış bir cümle ona çok derin acı verir. Aşağıdaki cümlelerin HER BİRİNİ anlamına göre değerlendir ve yalnızca kurala aykırı olanlar için yerine-geçecek cümle döndür (uygun olanları döndürme). Kurala aykırı sayılanlar, en dolaylı ve en şiirsel biçimleri dahil:
– çocuğun olacağına ya da olmayacağına dair her ima ("kapı açılacak", "kapalı değil", "nasip olacak", "kucağına gelecek", "anneliğin bir hediye olacak");
– zamanlama ("geç gelecek", "geç kalmadın", "vakti yakın");
– bedenin ya da ruhun "hazır olmadığı", "kilitli olduğu", "durgunluk", "su ağırlığı" gibi açıklamalar; kısırlığı ya da tedavinin sonucunu harflere, unsurlara, duygulara bağlamak;
– tedavinin sonucuna dair her tahmin.
Uygun olan: yolun yükü, sabır, eşle ve sevdiklerle bağ, kendine şefkat, hekime güven, yuvanın havası, anne-baba ilişkisi; "çocuğun hükmü hekimin ve Rabbin elindedir" çizgisi. Değiştirdiğin cümlelerde zaafı ve uyarıyı koru; umut vaadi değil, gönül tesellisi ver.`;

function fixPrompt(
  items: { id: number; section: string; context: string; sentence: string; mustFix: boolean }[],
  conception: boolean,
): string {
  const blocks = items
    .map(
      (it) =>
        `[${it.id}] Bölüm: ${it.section}${it.mustFix ? " (mutlaka düzelt)" : ""}\nBağlam: …${it.context}…\nCümle: ${it.sentence.trim()}`,
    )
    .join("\n\n");
  const intro = conception
    ? `${CONCEPTION_RULES}\n\nAyrıca genel kural:\n${FIX_RULES}`
    : `Bir yıldızname okumasının Sağlık ve Çocuk ve Yuva bölümlerinde, müneccimin söyleme yetkisi olmayan ifadeler içeren cümleler var. Her cümle için, bağlama oturan, aynı üslupta TEK bir yerine-geçecek cümle yaz.\n\n${FIX_RULES}`;
  return `${intro}\n\n${blocks}`;
}

const FIX_TOOL = {
  name: "submit_fixes",
  description: "Değiştirilmesi gereken numaralı cümleler için yerine geçecek cümleleri gönderir.",
  input_schema: {
    type: "object",
    properties: {
      fixes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            text: { type: "string", description: "Yerine geçecek tek cümle; silinecekse boş." },
          },
          required: ["id", "text"],
        },
      },
    },
    required: ["fixes"],
  },
} as const;

type FixItem = {
  id: number;
  part: Part;
  idx: number;
  section: string;
  context: string;
  sentence: string;
  mustFix: boolean;
};

async function requestFixes(
  apiKey: string,
  items: FixItem[],
  conception: boolean,
): Promise<{ fixes: Map<number, string> | null; usage: AnthropicUsage }> {
  const usage = emptyUsage();
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SAFETY_MODEL,
        max_tokens: conception ? 4096 : 2048,
        system: FIX_SYSTEM,
        messages: [{ role: "user", content: fixPrompt(items, conception) }],
        tools: [FIX_TOOL],
        tool_choice: { type: "tool", name: FIX_TOOL.name },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[safety] fix call non-2xx", { status: res.status, body: body.slice(0, 300) });
      return { fixes: null, usage };
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; input?: { fixes?: Array<{ id?: number; text?: string }> } }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
    };
    usage.inputTokens = json.usage?.input_tokens ?? 0;
    usage.outputTokens = json.usage?.output_tokens ?? 0;
    usage.cacheCreationInputTokens = json.usage?.cache_creation_input_tokens ?? 0;
    usage.cacheReadInputTokens = json.usage?.cache_read_input_tokens ?? 0;
    const tool = json.content?.find((c) => c.type === "tool_use");
    if (!tool) return { fixes: null, usage };
    const fixes = new Map<number, string>();
    for (const f of tool.input?.fixes ?? []) {
      if (typeof f.id === "number" && typeof f.text === "string") fixes.set(f.id, f.text.trim());
    }
    return { fixes, usage };
  } catch (err) {
    console.error("[safety] fix call failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { fixes: null, usage };
  }
}

type Part = "onizleme" | SensitiveSection;
const PART_TITLE: Record<Part, string> = {
  onizleme: "Karakterin Özü (ücretsiz önizleme)",
  saglik: SECTION_TITLES.saglik,
  cocukYuva: SECTION_TITLES.cocukYuva,
};

export interface SafetyEdit {
  section: Part;
  original: string;
  replacement: string; // "" = sentence removed
}

// Returns the (possibly) edited sections, the audit trail, and the usage
// of the single fix call (null when no call was made → no cost).
export async function sanitizeSensitiveSections(
  apiKey: string,
  sections: YildiznameSections,
  opts: { conception?: boolean } = {},
): Promise<{ sections: YildiznameSections; edits: SafetyEdit[]; usage: AnthropicUsage | null }> {
  const conception = opts.conception === true;
  const ko = sections.karakterinOzu;
  const markerAt = ko.indexOf(KARAKTER_SPLIT_MARKER);
  const giris = markerAt >= 0 ? ko.slice(0, markerAt) : "";
  const rest = markerAt >= 0 ? ko.slice(markerAt) : ko;

  const pieces: Record<Part, string[]> = {
    onizleme: conception && giris ? splitSentences(giris.trimEnd()) : [],
    saglik: splitSentences(sections.saglik),
    cocukYuva: splitSentences(sections.cocukYuva),
  };
  const parts: Part[] = conception ? ["onizleme", "saglik", "cocukYuva"] : ["saglik", "cocukYuva"];

  // Normal mode: only pattern-flagged sentences. Conception mode: every
  // sentence goes to the meaning review (pattern hits marked "must fix").
  const items: FixItem[] = [];
  for (const part of parts) {
    pieces[part].forEach((sentence, idx) => {
      const flagged = isUnsafeSentence(sentence);
      if (!conception && !flagged) return;
      if (!sentence.trim()) return;
      const context = pieces[part].slice(Math.max(0, idx - 1), idx + 2).join("").trim();
      items.push({ id: items.length + 1, part, idx, section: PART_TITLE[part], context, sentence, mustFix: flagged });
    });
  }

  const edits: SafetyEdit[] = [];
  let usage: AnthropicUsage | null = null;
  const replace = (part: Part, idx: number, replacement: string) => {
    const original = pieces[part][idx];
    if (!original.trim()) return;
    const trailing = original.match(/\s*$/)?.[0] ?? "";
    pieces[part][idx] = replacement ? replacement + (trailing || " ") : "";
    edits.push({ section: part, original: original.trim(), replacement });
  };

  if (items.length > 0) {
    const res = await requestFixes(apiKey, items, conception);
    usage = res.usage;
    if (res.fixes === null) {
      // Call failed. Normal mode: drop the flagged sentences. Conception
      // mode fails CLOSED: drop every child/body sentence that was reviewed.
      for (const it of items) {
        if (it.mustFix || (conception && CHILD_OR_BODY_RE.test(lowerTr(it.sentence)))) {
          replace(it.part, it.idx, "");
        }
      }
    } else {
      for (const it of items) {
        if (!res.fixes.has(it.id)) {
          // Not returned = judged fine — unless a pattern flagged it.
          if (it.mustFix) replace(it.part, it.idx, "");
          continue;
        }
        let candidate = res.fixes.get(it.id) ?? "";
        const original = pieces[it.part][it.idx];
        if (candidate && (isUnsafeSentence(candidate) || candidate.length > original.length * 3 + 80)) {
          console.warn("[safety] replacement rejected, dropping sentence", { part: it.part });
          candidate = "";
        }
        replace(it.part, it.idx, candidate);
      }
    }
  }

  if (conception) {
    // Deterministic last pass: child/parenthood/treatment + promise/timing.
    for (const part of parts) {
      pieces[part].forEach((sentence, idx) => {
        const t = lowerTr(sentence);
        if (CHILD_TOPIC_RE.test(t) && PROMISE_RE.test(t)) replace(part, idx, "");
      });
    }
  }

  const clean = (arr: string[]) => arr.join("").replace(/[ \t]{2,}/g, " ").trim();
  let karakterinOzu = ko;
  if (conception && markerAt >= 0) {
    // Fixed honest closer: states before payment what the paid part will
    // and won't say.
    const newGiris = `${clean(pieces.onizleme)} ${CONCEPTION_PREVIEW_CLOSER}`.trim();
    karakterinOzu = `${newGiris}\n\n${rest}`;
  }
  const out: YildiznameSections = {
    ...sections,
    karakterinOzu,
    saglik: clean(pieces.saglik),
    cocukYuva: clean(pieces.cocukYuva),
  };
  return { sections: out, edits, usage };
}
