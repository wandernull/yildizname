import type { Env } from "./types";

// Outbound transactional email via Resend (direct REST, no SDK — same
// shape as stripe.ts). We send AS destek@yildizna.me: the yildizna.me
// domain is verified in Resend (DKIM on the root) while inbound
// destek@/support@ still route through Cloudflare Email Routing to the
// real inbox. So a reply to one of our sends loops back there — no
// separate Reply-To is needed because the From address is already the
// inbound-routed mailbox.

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

// Converts the plaintext body authored in the Ops compose modal into the
// HTML part: HTML-escaped, blank-line-separated blocks become <p>, single
// newlines become <br>, all wrapped in the brand's serif styling.
export function plainTextToHtml(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map(
      (block) =>
        `<p>${escapeHtml(block.trim()).replace(/\n/g, "<br />")}</p>`,
    )
    .join("\n");
  return `<div style="font-family:Georgia,serif;color:#1a1a2e;line-height:1.6;font-size:16px">
${paragraphs}
</div>`;
}

// Default subject + editable plaintext body for a promo email. The Ops
// compose modal pre-fills these; the operator can edit before sending.
// `name` personalises the greeting (omitted if blank); `expiresLabel` is a
// human date ("2026-06-27") or a fallback like "süresiz".
export function buildPromoEmailDefaults(args: {
  name: string;
  code: string;
  percentOff: number | null;
  expiresLabel: string;
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
    `Bu kodu ödeme adımında girerek indirimden yararlanabilirsiniz. Kod ${args.expiresLabel} tarihine kadar geçerli ve tek kullanımlıktır.`,
    "",
    "Sevgiyle,",
    "Yıldızname",
  ].join("\n");
  return { subject, bodyText };
}
