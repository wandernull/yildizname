import type { Env } from "./types";

// Stripe REST API helpers — direct fetch + URLSearchParams + Web Crypto.
// No SDK. Pattern mirrors the wayfarer/jounee implementation; same shape
// works fine on Cloudflare Workers (we used Pages Functions there, same
// underlying runtime). If you change the price or copy displayed at
// checkout, this is the file to edit.

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const PRODUCT_NAME = "Yıldızname — Tam Okuma";
const PRODUCT_DESCRIPTION =
  "Kişiye özel yıldızname okuması — 10 bölüm yazılı içerik ve müneccim sesiyle sesli okuma.";

// General "digital service" tax classification. When Stripe Tax is enabled
// in the account dashboard, this code drives the per-jurisdiction VAT rate
// lookup. If Stripe Tax is OFF in the dashboard, this is ignored.
const TAX_CODE = "txcd_10000000";

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

// Create a Stripe Checkout Session for the given reading. Returns the
// hosted Checkout URL — the caller redirects the user to it. Stripe will
// redirect back to /okuma/:id?paid=1&session={CHECKOUT_SESSION_ID} on
// success or /okuma/:id on cancel.
export async function createCheckoutSession(
  env: Env,
  args: {
    readingId: string;
    origin: string; // e.g. "https://yildizna.me" or "http://localhost:8787"
    amountKurus: number; // 34999 for 349,99 ₺
  },
): Promise<CheckoutSessionResult> {
  const params = new URLSearchParams();

  params.append("mode", "payment");
  params.append("payment_method_types[]", "card");
  params.append("locale", "tr");
  // Both client_reference_id AND metadata so the webhook can locate the
  // reading either way (defense in depth — both fields hold the same id).
  params.append("client_reference_id", args.readingId);
  params.append("metadata[reading_id]", args.readingId);
  params.append("payment_intent_data[metadata][reading_id]", args.readingId);

  // Inline price_data — no pre-configured Stripe Price ID needed. Same
  // call to action that's shown to the user in the modal.
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "try");
  params.append("line_items[0][price_data][unit_amount]", String(args.amountKurus));
  params.append("line_items[0][price_data][product_data][name]", PRODUCT_NAME);
  params.append(
    "line_items[0][price_data][product_data][description]",
    PRODUCT_DESCRIPTION,
  );
  params.append("line_items[0][price_data][product_data][tax_code]", TAX_CODE);
  // Inclusive = the 349,99 ₺ shown to the customer already contains any
  // applicable VAT. Stripe Tax (if enabled at the account level) carves
  // the VAT portion out of that amount.
  params.append("line_items[0][price_data][tax_behavior]", "inclusive");

  // automatic_tax requires Stripe Tax to be enabled in the account
  // dashboard (Dashboard → Tax → Enable Stripe Tax). Until enabled,
  // Stripe responds 400 "Stripe Tax must be enabled for this account."
  // This is a one-time dashboard flip, not a code change.
  params.append("automatic_tax[enabled]", "true");
  params.append("billing_address_collection", "auto");

  // Show a "Promosyon kodu" field on the Checkout page so customers can
  // redeem any active promotion code from Dashboard → Products → Coupons.
  // Works with inline price_data — promo codes apply at the session level,
  // not at the Price/Product level. Percentage-off coupons are currency-
  // agnostic; amount-off coupons must be in TRY. Mutually exclusive with
  // server-side `discounts[]`, which we don't use.
  params.append("allow_promotion_codes", "true");

  // Auto-generate a proper VAT-style invoice (sequential number, PDF,
  // hosted invoice page) and email it to the customer in tr-TR. The
  // webhook handler fetches the resulting invoice and persists the URLs
  // so the result page can offer "Faturayı indir".
  params.append("invoice_creation[enabled]", "true");
  params.append(
    "invoice_creation[invoice_data][description]",
    "Yıldızname tam okuma — kişiye özel dijital içerik.",
  );
  params.append(
    "invoice_creation[invoice_data][footer]",
    "yildizna.me — sorularınız için iletişime geçebilirsiniz.",
  );

  const successUrl =
    `${args.origin}/okuma/${encodeURIComponent(args.readingId)}` +
    `?paid=1&session={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${args.origin}/okuma/${encodeURIComponent(args.readingId)}`;
  params.append("success_url", successUrl);
  params.append("cancel_url", cancelUrl);

  const res = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[stripe] checkout session create failed", {
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new Error(`Stripe ${res.status}`);
  }

  const session = (await res.json()) as { id: string; url: string };
  return { id: session.id, url: session.url };
}

export interface InvoiceMetadata {
  id: string;
  number: string | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

// Look up an invoice by id (called from the webhook handler after a
// checkout.session.completed event). Best-effort — if the lookup fails,
// we still mark the reading as paid; we just don't show the invoice link.
export async function fetchInvoiceMetadata(
  env: Env,
  invoiceId: string,
): Promise<InvoiceMetadata | null> {
  const res = await fetch(
    `${STRIPE_API_BASE}/invoices/${encodeURIComponent(invoiceId)}`,
    {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    },
  );
  if (!res.ok) {
    console.warn("[stripe] invoice fetch failed", {
      invoiceId,
      status: res.status,
    });
    return null;
  }
  const inv = (await res.json()) as {
    id: string;
    number?: string | null;
    hosted_invoice_url?: string | null;
    invoice_pdf?: string | null;
  };
  return {
    id: inv.id,
    number: inv.number ?? null,
    hostedUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
  };
}

// Verify the Stripe webhook signature header. Header format is
// "t=TIMESTAMP,v1=SIG[,v0=...]". The signed payload is
// `${timestamp}.${rawBody}` HMAC-SHA256'd with the webhook signing
// secret. Implementation uses Web Crypto so it runs on Workers without
// any Node shim. Constant-time compare against any v1 signature in the
// header.
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const parts: Record<string, string[]> = {};
  for (const seg of header.split(",")) {
    const [k, v] = seg.split("=");
    if (k && v) (parts[k] = parts[k] || []).push(v);
  }
  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) return false;

  // Reject signatures older than 5 minutes to mitigate replay.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${timestamp}.${payload}`),
  );
  const computed = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  for (const expected of signatures) {
    if (computed.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) {
      diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) return true;
  }
  return false;
}
