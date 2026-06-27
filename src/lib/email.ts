import type { Env } from "./types";

// Outbound transactional email via Resend (direct REST, no SDK — same
// shape as stripe.ts). We send AS destek@yildizna.me: the yildizna.me
// domain is verified in Resend (DKIM on the root) while inbound destek@
// still routes through Cloudflare Email Routing to the real inbox (a
// support@ alias also routes there silently, but is no longer advertised
// — destek@ is the one public address). So a reply to one of our sends
// loops back there — no separate Reply-To is needed because the From
// address is already the inbound-routed mailbox.

const RESEND_API_BASE = "https://api.resend.com";

// Default From identity: display name + the verified-domain address.
// If the address ever changes, update here (single source of truth).
export const DEFAULT_FROM = "Yıldızname <destek@yildizna.me>";

export interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  // Plaintext fallback — improves deliverability and accessibility. If
  // omitted, only the HTML part is sent.
  text?: string;
  // Override the From identity (defaults to DEFAULT_FROM).
  from?: string;
  // Optional Reply-To. Usually unnecessary since From already routes
  // replies to our inbox via Cloudflare Email Routing.
  replyTo?: string;
}

export interface SendEmailResult {
  id: string;
}

// Sends one email through Resend. Throws on a non-2xx response so the
// caller can surface failure (e.g. the Ops page redirecting with
// ?email_sent=0). Logs the truncated error body for debugging via tail.
export async function sendEmail(
  env: Env,
  args: SendEmailArgs,
): Promise<SendEmailResult> {
  const body: Record<string, unknown> = {
    from: args.from ?? DEFAULT_FROM,
    to: Array.isArray(args.to) ? args.to : [args.to],
    subject: args.subject,
    html: args.html,
  };
  if (args.text) body.text = args.text;
  if (args.replyTo) body.reply_to = args.replyTo;

  const res = await fetch(`${RESEND_API_BASE}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[resend] send failed", {
      status: res.status,
      body: errBody.slice(0, 300),
    });
    throw new Error(`Resend send failed (${res.status})`);
  }

  const json = (await res.json()) as { id?: string };
  return { id: json.id ?? "" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Escape HTML, then turn bare http(s) URLs into <a> tags styled in brand
// gold. Trailing sentence punctuation (.,;:!?) is kept OUTSIDE the link
// so "...gidip https://yildizna.me. Sonra..." doesn't pull the period
// into the href. Browsers parse `&amp;` in href as `&`, so the
// escape-first / linkify-after order is safe for URLs with query strings.
const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
function linkifyText(text: string): string {
  return escapeHtml(text).replace(URL_RE, (match) => {
    const trail = match.match(/[.,;:!?]+$/);
    const url = trail ? match.slice(0, -trail[0].length) : match;
    const tail = trail ? trail[0] : "";
    return `<a href="${url}" style="color:#c9a84c;text-decoration:underline">${url}</a>${tail}`;
  });
}

// Converts the plaintext body authored in the Ops compose modal into the
// HTML part: HTML-escaped + URLs auto-linkified, blank-line-separated
// blocks become <p>, single newlines become <br>, all wrapped in the
// brand's serif styling.
export function plainTextToHtml(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map(
      (block) =>
        `<p>${linkifyText(block.trim()).replace(/\n/g, "<br />")}</p>`,
    )
    .join("\n");
  return `<div style="font-family:Georgia,serif;color:#1a1a2e;line-height:1.6;font-size:16px">
${paragraphs}
</div>`;
}

// AI-generated promo email via Anthropic Haiku 4.5. Backs the
// "Yapay zekayla üret" button in the Ops compose modal: operator types
// short context notes (e.g. "user born 9 March got a September reading")
// and optionally folds in the customer's feedback (rating + comment from
// the Puanlar table) so the email can address it directly — gracious
// thanks for praise, a real apology for a complaint, etc. Haiku is the
// cost/latency pick: ~$0.001 per generate, ~2–3s response. The operator
// reviews + edits before sending, so we don't need Sonnet-grade voice.
// Uses tool_use for structured {subject, body} output so the response is
// directly fillable into the form without text parsing.

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const EMAIL_MODEL = "claude-haiku-4-5-20251001";

const EMAIL_SYSTEM_PROMPT = `Sen klasik yıldızname, ebced ve ilm-i hurûf geleneğine vâkıf bir üstad müneccimin sesisin. Operatör adına, bir yıldızname müşterisine kısa Türkçe e-posta yazıyorsun.

Üslup: ağırbaşlı, edebî ama sade, mistik ama dürüst. Modern numeroloji jargonu ("enerji, titreşim, evren") kullanma. Pohpohlama, korkutma yok.

Kurallar:
- "Merhaba {ad}," ile başla
- Operatörün verdiği bağlamı doğal bir şekilde işle
- (Verilmişse) müşterinin geri bildirimine uygun şekilde değin: yüksek puana sade bir teşekkür, düşük puana / şikâyete nazik ama gerçek bir kabul
- İndirim kodu önce paragraf içinde anılsın, ardından kendi satırında büyük harflerle yer alsın
- Kodun geçerlilik tarihini açıkça belirt
- Sitenin adresini ({baseUrl}) bağlantı olarak gövdeye dahil et — kullanıcı buradan yeni bir yıldıznameye başlayacak; URL'yi düz metin yaz (HTML değil), gönderim sırasında otomatik tıklanabilir hâle gelecek
- "Sevgiyle,\nYıldızname" ile bitir
- Düz metin (HTML yok), 4–7 cümle
- Konu satırı kısa (en fazla 50 karakter), tek satır`;

export interface GeneratePromoEmailArgs {
  customerName: string;
  code: string;
  percentOff: number | null;
  expiresLabel: string;
  // Site URL the recipient should visit to start a new reading (plain
  // text in the prompt; auto-linkified at send by plainTextToHtml).
  baseUrl: string;
  operatorContext: string;
  // Null when no feedback OR when the operator chose not to include it.
  feedbackRating: number | null;
  feedbackText: string | null;
}

export interface GeneratedPromoEmail {
  subject: string;
  body: string;
}

export async function generatePromoEmail(
  env: Env,
  args: GeneratePromoEmailArgs,
): Promise<GeneratedPromoEmail> {
  const promptLines: string[] = [
    `Müşteri adı: ${args.customerName || "(belirtilmemiş)"}`,
    `Promosyon kodu: ${args.code}`,
    `İndirim: ${args.percentOff != null ? `%${args.percentOff}` : "özel"}`,
    `Son geçerlilik tarihi: ${args.expiresLabel}`,
    `Site bağlantısı: ${args.baseUrl}`,
    "",
    "Operatör bağlamı:",
    args.operatorContext.trim() ||
      "(operatör bağlam vermedi — kısa, sıcak bir hediye-kod e-postası yaz)",
  ];
  if (args.feedbackRating != null) {
    promptLines.push(
      "",
      "Müşteri geri bildirimi:",
      `Puan: ${args.feedbackRating}/5`,
      args.feedbackText
        ? `Yorum: ${args.feedbackText}`
        : "(Yorum yok, sadece puan verilmiş.)",
    );
  }
  const userPrompt = promptLines.join("\n");

  const tool = {
    name: "compose_promo_email",
    description: "Compose a Turkish promo email with subject and body.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "Email subject — short (max ~50 chars), Turkish, single line.",
        },
        body: {
          type: "string",
          description:
            "Email body in plain-text Turkish (no HTML). 4–7 sentences. Includes the promo code on its own line and the expiry date.",
        },
      },
      required: ["subject", "body"],
    },
  };

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: EMAIL_MODEL,
      max_tokens: 1024,
      system: EMAIL_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      tools: [tool],
      tool_choice: { type: "tool", name: "compose_promo_email" },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[anthropic-email] generation failed", {
      status: res.status,
      body: errBody.slice(0, 300),
    });
    throw new Error(`Anthropic email generation failed (${res.status})`);
  }

  const json = (await res.json()) as {
    content?: Array<{
      type: string;
      input?: { subject?: string; body?: string };
    }>;
  };
  const toolUse = json.content?.find((c) => c.type === "tool_use");
  const subject = toolUse?.input?.subject?.trim();
  const body = toolUse?.input?.body?.trim();
  if (!subject || !body) {
    console.error("[anthropic-email] missing tool output", {
      contentTypes: json.content?.map((c) => c.type),
    });
    throw new Error("Anthropic returned no tool output");
  }
  return { subject, body };
}

// Default subject + editable plaintext body for a promo email. The Ops
// compose modal pre-fills these; the operator can edit before sending.
// `name` personalises the greeting (omitted if blank); `expiresLabel` is a
// human date ("2026-06-27") or a fallback like "süresiz". `baseUrl` is
// the site URL the recipient should visit to start a new reading (the
// promo applies at checkout, not retroactively to an existing okuma);
// plainTextToHtml() auto-linkifies it on send.
export function buildPromoEmailDefaults(args: {
  name: string;
  code: string;
  percentOff: number | null;
  expiresLabel: string;
  baseUrl: string;
}): { subject: string; bodyText: string } {
  const greeting = args.name.trim()
    ? `Merhaba ${args.name.trim()},`
    : "Merhaba,";
  const pct = args.percentOff != null ? `%${args.percentOff}` : "özel bir";
  const subject = "Yıldızname'den size özel bir indirim";
  const bodyText = [
    greeting,
    "",
    `Yıldızname'ye gösterdiğiniz ilgi için teşekkür ederiz. Size özel olarak hazırladığımız ${pct} indirim kodunuz:`,
    "",
    args.code,
    "",
    `Yıldıznamenize başlamak için ${args.baseUrl} adresine gidip bilgilerinizi girmeniz, ödeme adımında bu kodu yazmanız yeterli. Kod ${args.expiresLabel} tarihine kadar geçerli ve tek kullanımlıktır.`,
    "",
    "Sevgiyle,",
    "Yıldızname",
  ].join("\n");
  return { subject, bodyText };
}
