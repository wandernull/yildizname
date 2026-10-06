import {
  QUESTION_TOPICS,
  SECTION_TITLES,
  TOPIC_SECTION,
  type FormData,
  type QuestionTopic,
  type ReadingMeta,
  type YildiznameSections,
} from "./types";
import { KARAKTER_SPLIT_MARKER } from "./text";
import { isConceptionQuestion } from "./safety";
import { emptyUsage, type AnthropicUsage } from "./costs";

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
export const LLM_MODEL = "claude-sonnet-4-5";
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
  // Conception mode (see safety.ts): the reader is trying to have a child.
  const conceptionStr = isConceptionQuestion(form.question)
    ? `

HASSAS DURUM — ÇOCUK SAHİBİ OLMAYA ÇALIŞAN KİŞİ: Bu kişi çocuk sahibi olmaya çalışıyor; tedavi görüyor olabilir. Okumanın HİÇBİR yerinde (önizleme, kancaCumlesi, Sağlık, Çocuk ve Yuva dahil) çocuğun olacağını ya da olmayacağını, ne zaman olacağını ima etme — "kapı açılacak", "kapalı değil", "nasip olacak", "anneliğin bir hediye olacak", "geç gelecek" gibi umut vaatleri de yasak. Bedenin ya da ruhun "hazır olmadığı", "kilitli", "durgun" olduğu, ya da kısırlığın harflerden, unsurlardan, duygulardan geldiği gibi açıklamalar yapma; tedavinin sonucunu tahmin etme. Bunun yerine bu yolun yükünü, sabrı, eşle ve sevdiklerle bağı, kendine şefkati, hekime güveni ve yuvanın havasını derinlemesine anlat; zaafları ve zor yanları yine dürüstçe söyle. Çocuk ve Yuva bölümü şu çizgiyle açılsın: "Sorduğun çocuk meselesinin hükmü hekimin ve Rabbin elindedir; müneccim onu söyleyemez." ÖNİZLEME KAPANIŞI: Bu kişi için karakterinOzuGiris'in sonuna kapanış cümlesini BİZ ekliyoruz (çocuk meselesinin hükmünü ve Çocuk ve Yuva bölümünü o cümle anlatıyor). Bu yüzden karakterinOzuGiris'i hiçbir bölüme işaret etmeden, çocuk meselesine değinmeden, son tanıma gözleminle bitir — genel "son cümle bir merak kapısı açsın" kuralı bu kişi için geçerli değil.`
    : "";

  return `Sana verilen kişi bilgileri: ad-soyad: ${form.name}, anne adı: ${form.motherName}, doğum tarihi: ${birthDateTr}, doğum yeri: ${form.birthPlace}${spouseStr}${questionStr}.${conceptionStr}

Yorumdan önce sessizce isimdeki baskın harfleri, ad ile anne adının birleşimini, doğum tarihinin sayısal indirgemesini hesapla; her hükmü kişinin kendi harflerine ve ismine bağla — genel fal cümleleri kurma, ona özel konuş. İsme uyan istiâreler kullan (ay, yağmur, demir, kök, nur, kapı, örs gibi). İyi ve karanlık tarafları birlikte, dürüstçe söyle; ne sadece pohpohla ne de korkut. Üslup edebî, derin, akıcı; liste değil, kader okuyan bir hikâye gibi aksın.

Okumayı submit_reading aracıyla gönder. Bölümler: kapakSozu (kısa etkileyici mısra), karakterinOzuGiris, karakterinOzuDevam, gizliHuylar, ruhsalYuk, askEvlilik, esinKarakteri, cocukYuva, rizkKariyer, nazarAgirlik, saglik, donumNoktalari. kapakSozu ve karakterinOzuGiris dışındaki her bölüm en az bir zengin paragraf olsun ve sonunda bir müneccim tavsiyesi cümlesi bulunsun.

KARAKTERİN ÖZÜ — EN ÖNEMLİ KISIM. Kişi okumanın yalnızca karakterinOzuGiris kısmını ücretsiz görür; geri kalan her şeyi açıp açmamaya buna bakarak karar verir. İnsan, kendisi hakkında doğru bir şey duymadan güvenmez. Bu yüzden:
• karakterinOzuGiris (4-6 cümle, yaklaşık 450-700 harf): İlk iki-üç cümle, kişinin "bunu nereden biliyor" diyeceği, kendini hemen tanıyacağı iç dünya gözlemleri olsun — dışarıya gösterdiği ile içinde taşıdığı arasındaki fark, kimseye tam anlatmadığı bir yorgunluk ya da özlem, insanların onu nasıl yanlış anladığı, verdiği ile aldığı arasındaki dengesizlik gibi. Bu gözlemleri ismindeki harflere, anne adına ya da doğum gününe bağla ki genel fal cümlesi değil, ona özel bir hüküm gibi dursun. Harf ve ebced hesabını uzun uzun dökme; hikmetin kaynağını bir cümleyle an, yeter. Son cümle bir merak kapısı açsın: kişinin sorusuna (varsa) ya da en çok merak edeceği konuya değin ve cevabın okumanın hangi bölümünde yazılı olduğunu sezdir — ama cevabı ASLA burada verme. Bu kısmın sonunda tavsiye cümlesi olmasın.
• karakterinOzuDevam: Karakterin özünün devamı, girişin doğal sürdürülmesi (girişi tekrar etme). Burada derinleş; harf ve ebced hikmetini burada aç; sonunda müneccim tavsiyesi olsun.

SORU VE KANCA:
• soruKonusu: Kişinin en çok merak ettiğini şu konulardan birine ata — ask (aşk, sevgili, evlilik, eş), aile (anne-baba, çocuk, yuva, akraba), kariyer (iş, meslek, okul, başarı), para (rızk, borç, maddi durum), saglik, ruhsal (iç huzur, yük, kaygı, inanç, nazar), genel (kader, gelecek, hayatın gidişatı ya da birden çok konu). Kişi bir şey sormadıysa, okumanın ona en çok merak ettireceği konuyu seç; karakterinOzuGiris'in son cümlesi de o konunun bölümünü işaret etsin.
• Soruyu cevaplayan bölüm: ask→Aşk ve Evlilik (askEvlilik), aile→Çocuk ve Yuva (cocukYuva), kariyer ve para→Rızk ve Kariyer (rizkKariyer), saglik→Sağlık (saglik), ruhsal→Ruhsal Yük (ruhsalYuk), genel→Dönüm Noktaları (donumNoktalari). Bir soru varsa o bölüm soruya doğrudan, dürüstçe cevap versin.
• kancaCumlesi: O bölümde gerçekten yazdığın bir şeye dayanan tek bir cümle (en fazla 160 harf), "sen" diye hitap eden. Görevi bir KAPI ARALAMAK: cevabın var olduğunu ve kişiye özel olduğunu sezdirsin, ama hükmü, sonucu ya da "evet/hayır"ı ASLA söylemesin. Kesinlikle yasak: ilişkinin biteceği ya da mutsuz edeceği gibi hükümler; hastalık, kısırlık, çocuk olmayacağı, ölüm, kaza gibi sağlık ya da felaket iddiaları; "şu kadar ay içinde yoksa sonsuza dek" gibi süre baskısı, tehdit ya da korkutma. Ton sıcak, davetkâr ve umut veren bir merak olsun: kişiyi ödüle çağırsın, cezayla korkutmasın. Uyarı ya da şart kipi kullanma ("…bilmezsen", "…yapmazsan", "…yoksa", "yarıda kalır", "kaçırırsın"); "uğursuz", "sonu", "bitiş" gibi karanlık sözcükler kullanma. Örnek ruh: "Sorduğun ilişkinin seyrini değiştirecek olan şey, senin henüz kimseye söylemediğin o tek cümlede saklı." ya da "Rızkının açılacağı kapı, sandığın yerde değil; harflerin onu çoktan işaret etmiş."

KAPAK SÖZÜ: kapakSozu herkesin ücretsiz gördüğü ve sesli dinlediği ilk cümledir. Gizemli, davetkâr ve ismine özel bir mısra olsun; kişiyi okumaya çağırsın. Aşk, sağlık, aile ya da kader hakkında karanlık hüküm, mahkûmiyet, ayrılık ya da yalnızlık kehaneti içermesin.

SAĞLIK VE ÇOCUK-YUVA BÖLÜMLERİ — MÜNECCİM GİBİ KONUŞ, HEKİM GİBİ DEĞİL. Yıldızname iyiyi de kötüyü de söyler; bu bölümlerde de zaafı, zor mevsimi, zararlı huyu, aile yükünü açıkça söyle. Ama teşhisi hekime bırak.
• SÖYLE (zor olanı da): mizaç (ateş fazlası, soğuk ve rutubetli yapı, su ağırlığı), zaaflar, bedeni yoran huylar (öfkeyi yutmak, kendini ihmal etmek, düzensizlik), yorucu mevsimler ve dönemler, geleneksel beden bölgeleri (baş, göğüs, boğaz, mide, bel, sırt) — "bedelini başın ve göğsün öder" gibi; aile içi gerginlik, ana-baba yükü, ebeveynlik sınavları. Uygun yerde "erteleme, bir hekime göster" de.
• SÖYLEME: hastalık ya da durum adı (kist, ur, tiroid, tansiyon, bronşit, migren, hormon, "kadın hastalıkları" gibi); iç organ ya da üreme organları, adet ve döngüler; kişinin çocuk sahibi olup olamayacağına ya da çocuğun NE ZAMAN geleceğine ("ilk çocuk geç gelecek", "geç kalmadın") dair HER hüküm, olumlu ("bereketli rahim", "kaderinde annelik var") ya da olumsuz; çocuk sormamış birine çocuk kehaneti; duygularının ya da ruhunun bedeni, sağlığı ya da çocuk sahibi olmayı kilitlediği/açtığı fikri.
• ÖRNEK DÖNÜŞÜMLER (ruhu bu olsun):
  – Yanlış: "Kadın hastalıkları tarafında düzensizlik, ağrı, kist, ur gibi belirtiler var." Doğru: "İsminle anne adın arasında ateş fazlası var; bu ateş içeride birikir. Senin bedenin sessiz ama ısrarla konuşur; bir yerin sana tekrar tekrar seslenirse onu erteleme, bir hekime göster. Senin zaafın, kendine en son bakman."
  – Yanlış: "Hormon dengesizlikleri, tiroid sorunları görülebilir." Doğru: "Haritanda Ay ile Merkür gergin duruyor; bir hafta coşkulu, bir hafta bitkin olduğun bir mizaç bu. Bu dalgalanmayı kader sanma; uyku, güneş ve düzenle yatışır."
  – Yanlış: "Tansiyon, sinir krizi… bronşit, nefes darlığı görürsün." Doğru: "Adındaki ısı harfleri sana fazladan ateş verir. Hiddet senin en pahalı huyundur; öfkeni her yuttuğunda bedelini başın ve göğsün öder. Soğuk mevsimde kendini koru, sıcak öfkede kendini serinlet."
  – Yanlış: "Adının mirası sana bereketli bir rahim vaat eder." Doğru: "Adının mirası sana bereketli bir yuva vaat eder: kalabalık sofralar, sana dayanan insanlar. Ama sen bereketi bazen yük gibi görürsün; yuvan, yükü paylaşmayı öğrendiğinde bereketlenir."
  – Kişi çocuk sahibi olmayı sorduysa: "Çocuk meselesini sordun; bunun zamanı ve yolu hekimin ve Rabbin bileceği iştir, müneccimin değil. Müneccimin gördüğü şu: sende bir anne yüreği çoktan var…" — sonra yuvayı, bağları ve gönül hazırlığını anlat.

GENEL SINIR: Okumanın hiçbir yerinde kesin tıbbi teşhis, kısırlık, ölüm ya da felaket kehaneti yapma; bir ilişkinin biteceğini ya da kişinin yalnız kalacağını hüküm olarak söyleme. Zorlukları eğilim ve sınav olarak anlat, kapıyı her zaman açık bırak.`;
}

// Tool fields the model fills. karakterinOzu is written as two fields —
// the free preview (Giris) and its paid continuation (Devam) — so the
// free/paid boundary is exact; validateSections joins them back into
// sections.karakterinOzu with KARAKTER_SPLIT_MARKER between.
const TOOL_SECTION_KEYS = [
  "kapakSozu",
  "karakterinOzuGiris",
  "karakterinOzuDevam",
  "gizliHuylar",
  "ruhsalYuk",
  "askEvlilik",
  "esinKarakteri",
  "cocukYuva",
  "rizkKariyer",
  "nazarAgirlik",
  "saglik",
  "donumNoktalari",
] as const;

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
        description:
          "Kısa, gizemli, davetkâr ve isme özel bir açılış mısrası; karanlık hüküm, ayrılık ya da yalnızlık kehaneti içermez.",
      },
      karakterinOzuGiris: {
        type: "string",
        description:
          "Ücretsiz önizleme: 4-6 cümle. Önce kişinin kendini tanıyacağı iç dünya gözlemleri, sonunda cevabı vermeden merak kapısı açan cümle.",
      },
      karakterinOzuDevam: {
        type: "string",
        description: "Karakterin özünün ücretli devamı; girişi tekrar etmeden derinleşir.",
      },
      gizliHuylar: { type: "string" },
      ruhsalYuk: { type: "string" },
      askEvlilik: { type: "string" },
      esinKarakteri: { type: "string" },
      cocukYuva: { type: "string" },
      rizkKariyer: { type: "string" },
      nazarAgirlik: { type: "string" },
      saglik: { type: "string" },
      donumNoktalari: { type: "string" },
      soruKonusu: {
        type: "string",
        enum: QUESTION_TOPICS,
        description:
          "Kişinin en çok merak ettiği konunun kategorisi; soru yoksa okumanın ona en çok merak ettireceği konu.",
      },
      kancaCumlesi: {
        type: "string",
        description:
          "Soruyu cevaplayan bölümün gerçek içeriğine dayanan tek cümle (en fazla 160 harf): sıcak ve davetkâr, kapıyı aralar, hüküm/sonuç vermez; uyarı-şart kipi, sağlık-kısırlık-ölüm iddiası, süre baskısı ya da korkutma içermez.",
      },
    },
    required: [...TOOL_SECTION_KEYS, "soruKonusu", "kancaCumlesi"],
  },
} as const;

// Lines shown to UNPAID readers (kapakSözü: top of page + start of the free
// audio; the hook line: price-modal exit hook, win-back email) get a
// deterministic guard on top of the prompt rules — in testing the model
// ignored prompt bans and wrote a fertility claim ("…rahmini de kilitleyen
// aynı düğüm") and a doom cover line ("ayrılığa mahkûm bir lâm…"). A hit →
// fixed neutral fallback. Stems match at the START of a word only (Turkish
// appends suffixes), so "kazanç", "rahmet", "bölüm" don't false-positive;
// a few benign idioms are removed before matching. Word lists can't catch
// every phrasing — erring toward the neutral fallback is the safe side.
const UNSAFE_STEMS = [
  // health / fertility / death
  "rahim", "rahmin", "rahmi", "dölyata", "kısır", "gebe", "hamile", "düşük yap",
  "düşük riski", "doğuramaz", "doğuramayacak", "çocuğun olmaz", "çocuğun olmayacak",
  "çocuk sahibi olama", "hastalık", "hastalan", "kanser", "tümör", "teşhis",
  "ameliyat", "ölüm", "ölece", "öleceğ", "vefat", "kaza ", "kazada", "kazaya",
  "kazası", "felaket",
  // breakup / doom
  "ayrıl", "boşan", "terk ed", "aldat", "mahkûm", "mahkum", "yalnız kal",
  "yalnız öl", "bitecek",
  // deadlines / pressure
  "sonsuza dek", "sonsuza kadar", "son şans", "ay içinde", "yıl içinde",
  // flat negative verdicts ("…seni mutlu etmeyecek")
  "mutsuz", "mutlu etme", "mutlu olama", "etmeyecek", "olmayacak",
  "gelmeyecek", "bulamayacak", "olamayacak", "asla",
  // conditional threats / dark framing ("…bilmezsen köprü yarıda kalır",
  // "…bu bağın sonunu gösterir") — hooks should invite, not warn
  "bilmezsen", "yapmazsan", "etmezsen", "görmezsen", "anlamazsan", "çözmezsen",
  "kaçırırsan", "kaçırırsın", "yarıda kal", "uğursuz", "sonunu", "sonu gel",
  // parenthood promises — hooks are shown to unpaid readers from step 2 on
  // ("…senin anneliğin bir sınav kadar bir hediye olacağını gördüm")
  "anneliğin", "babalığın", "anne olaca", "baba olaca", "çocuğun ola",
  "bebeğin ola", "evladın ola", "kucağına",
];
const BENIGN_IDIOMS = ["kısır döngü"];
const TR_LETTER = "a-zçğıöşüâîû";
const UNSAFE_RE = new RegExp(
  `(^|[^${TR_LETTER}])(${UNSAFE_STEMS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
);

export function isUnsafeForUnpaid(text: string): boolean {
  let hay = (text ?? "").toLocaleLowerCase("tr-TR");
  for (const idiom of BENIGN_IDIOMS) hay = hay.split(idiom).join(" ");
  return UNSAFE_RE.test(hay);
}

export function safeHookLine(raw: string, topic: QuestionTopic): string {
  const template = `Sorduğun sorunun cevabı ${SECTION_TITLES[TOPIC_SECTION[topic]]} bölümünde, yalnızca senin için yazıldı.`;
  if (!raw) return template;
  return isUnsafeForUnpaid(raw) ? template : raw;
}

const SAFE_KAPAK_SOZU = "Adının harflerinde bir kapı var; ardında yalnızca sana yazılmış bir yol.";

export function safeKapakSozu(raw: string): string {
  return !raw || isUnsafeForUnpaid(raw) ? SAFE_KAPAK_SOZU : raw;
}

export interface GeneratedReading {
  sections: YildiznameSections;
  meta: ReadingMeta;
}

function validateSections(obj: unknown): GeneratedReading {
  if (!obj || typeof obj !== "object") {
    throw new Error("Cevap nesne değil.");
  }
  const record = obj as Record<string, unknown>;
  for (const key of TOOL_SECTION_KEYS) {
    if (typeof record[key] !== "string" || !(record[key] as string).trim()) {
      throw new Error(`Eksik bölüm: ${key}`);
    }
  }
  const giris = (record.karakterinOzuGiris as string).trim();
  const devam = (record.karakterinOzuDevam as string).trim();
  const sections = {} as Record<string, string>;
  for (const key of REQUIRED_KEYS) {
    sections[key] =
      key === "karakterinOzu"
        ? `${giris}\n\n${KARAKTER_SPLIT_MARKER}${devam}`
        : key === "kapakSozu"
          ? safeKapakSozu((record[key] as string).trim())
          : (record[key] as string);
  }
  // The free preview can't be swapped for a template (it's the product),
  // so it relies on the prompt; a hit is logged for review in CF Logs.
  if (isUnsafeForUnpaid(giris)) {
    console.warn("[llm] free preview contains unsafe wording", {
      excerpt: giris.slice(0, 160),
    });
  }
  // Meta is best-effort: a missing/odd topic or hook must never fail a
  // reading (that would re-run a ~$0.08, 2-minute generation).
  const rawTopic = record.soruKonusu;
  const questionTopic: QuestionTopic =
    typeof rawTopic === "string" && (QUESTION_TOPICS as readonly string[]).includes(rawTopic)
      ? (rawTopic as QuestionTopic)
      : "genel";
  // "Asked or not" is a form fact (form.question), not a topic — the model
  // picks the most compelling topic either way so the preview's open loop
  // and the hook always point at a real section.
  const rawHook =
    typeof record.kancaCumlesi === "string" ? record.kancaCumlesi.trim().slice(0, 300) : "";
  const hookLine = safeHookLine(rawHook, questionTopic);
  return {
    sections: sections as unknown as YildiznameSections,
    meta: { questionTopic, hookLine },
  };
}

// Parse the Anthropic SSE stream. We're using tool_use so we only care about
// content blocks of type "tool_use" — their `input_json_delta` events
// concatenate into a valid JSON document for the tool's input schema.
// Token usage is written into `usage` as it arrives (message_start carries
// the input/cache counts, message_delta the cumulative output count), so
// the caller still sees what was billed if the stream dies midway.
async function readAnthropicStream(
  res: Response,
  usage: AnthropicUsage,
): Promise<string> {
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
        message?: { usage?: RawUsage };
        usage?: RawUsage;
      };

      if (ev.type === "message_start" && ev.message?.usage) {
        applyUsage(usage, ev.message.usage);
      } else if (ev.type === "message_delta" && ev.usage) {
        applyUsage(usage, ev.usage);
      }

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

interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

// Usage fields in a later event are cumulative totals, so take the
// latest non-null value for each rather than adding.
function applyUsage(target: AnthropicUsage, raw: RawUsage): void {
  if (typeof raw.input_tokens === "number") target.inputTokens = raw.input_tokens;
  if (typeof raw.output_tokens === "number") target.outputTokens = raw.output_tokens;
  if (typeof raw.cache_creation_input_tokens === "number") {
    target.cacheCreationInputTokens = raw.cache_creation_input_tokens;
  }
  if (typeof raw.cache_read_input_tokens === "number") {
    target.cacheReadInputTokens = raw.cache_read_input_tokens;
  }
}

async function callAnthropicStream(
  apiKey: string,
  userPrompt: string,
  usage: AnthropicUsage,
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
        model: LLM_MODEL,
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

  return readAnthropicStream(res, usage);
}

// One billed Messages API attempt, reported to the caller for the cost
// ledger. outcome: "ok" | "parse_error" | "transport_error".
export interface LlmAttempt {
  attempt: number;
  outcome: "ok" | "parse_error" | "transport_error";
  usage: AnthropicUsage;
}

export async function generateYildizname(
  form: FormData,
  apiKey: string,
  onAttempt?: (a: LlmAttempt) => Promise<void>,
): Promise<GeneratedReading> {
  if (!apiKey || apiKey === "sk-ant-placeholder") {
    throw new Error("Müneccim suskun: API anahtarı ayarlanmamış.");
  }

  const userPrompt = buildUserPrompt(form);

  // One attempt, plus one retry only on parse/validation failures (an HTTP
  // error or aborted stream means something Anthropic-side is unhappy —
  // immediate retry won't help and burns another 2–3 minutes).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const usage = emptyUsage();
    try {
      const json = await callAnthropicStream(apiKey, userPrompt, usage);
      const generated = validateSections(JSON.parse(json));
      await onAttempt?.({ attempt: attempt + 1, outcome: "ok", usage });
      return generated;
    } catch (err) {
      lastError = err;
      const isTransport =
        err instanceof Error &&
        (err.message.startsWith("Anthropic ") ||
          err.name === "AbortError" ||
          err.message.includes("vakit doldu"));
      // Every attempt that streamed tokens is billed, failed or not.
      await onAttempt?.({
        attempt: attempt + 1,
        outcome: isTransport ? "transport_error" : "parse_error",
        usage,
      });
      if (isTransport) break;
      console.warn("[llm] parse/validation failed, retrying once", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const msg = lastError instanceof Error ? lastError.message : "bilinmeyen hata";
  throw new Error(`Müneccim okuyamadı: ${msg}`);
}
