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

// Brand-and-entity attribution. Used in two places:
//   1. Below the Pay button on the Stripe Checkout page (Stripe's only
//      sanctioned spot for custom copy on Checkout).
//   2. As the first line of the auto-generated invoice footer (see
//      INVOICE_FOOTER below).
// Helps the customer connect the yıldızna.me brand to the legal entity
// that will appear on their card statement and at the bottom of their
// invoice PDF. Turkish-only for now — once i18n lands, plumb the
// locale-matched string through here per-session instead of hard-coding;
// both surfaces will pick up the new value automatically.
const BRAND_ATTRIBUTION =
  "Yıldızna.me, Back of the Envelope B.V. tarafından sunulmaktadır.";

// Dutch tax identifiers shown on the invoice footer.
//   KVK = Dutch chamber of commerce registration number.
//   VAT = EU VAT registration number (NL + numeric body + check digits).
// Required on invoices for VAT-registered EU businesses. If these ever
// change (rebrand, restructure, move jurisdictions), update here.
const KVK_NUMBER = "97838810";
const VAT_NUMBER = "NL868254010B01";

const INVOICE_FOOTER = [
  BRAND_ATTRIBUTION,
  `KVK: ${KVK_NUMBER}`,
  `VAT: ${VAT_NUMBER}`,
].join("\n");

// General "digital service" tax classification. When Stripe Tax is enabled
// in the account dashboard, this code drives the per-jurisdiction VAT rate
// lookup. If Stripe Tax is OFF in the dashboard, this is ignored.
const TAX_CODE = "txcd_10000000";

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

// Pre-create a Stripe Customer with preferred_locales=['tr'] so the
// auto-generated invoice (hosted page + PDF + receipt email) renders in
// Turkish. Stripe's Checkout `locale` parameter controls the payment
// page UI only — it does NOT propagate to the invoice. Invoice locale
// is driven by the Customer object's preferred_locales field, which is
// set at customer creation time. By pre-creating the customer here and
// passing it into the Checkout Session, we ensure the customer exists
// with the right locale before Stripe finalizes the invoice. Without
// this, Stripe auto-creates a guest customer with no preferred_locales
// → invoice defaults to English regardless of the Checkout language.
export async function createStripeCustomer(
  env: Env,
  args: { readingId: string },
): Promise<{ id: string }> {
  const params = new URLSearchParams();
  // Tell Stripe to render any future invoice / receipt / hosted page
  // tied to this customer in Turkish. Stripe matches the first locale
  // it supports; falls back to English if none match.
  params.append("preferred_locales[]", "tr");
  // Stamp the reading id in customer metadata so we can trace a Stripe
  // customer back to a reading from the Dashboard if support ever asks.
  params.append("metadata[reading_id]", args.readingId);

  const res = await fetch(`${STRIPE_API_BASE}/customers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[stripe] customer create failed", {
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new Error(`Stripe ${res.status}`);
  }

  const customer = (await res.json()) as { id: string };
  return { id: customer.id };
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
    customerId: string; // pre-created via createStripeCustomer — sets invoice locale
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

  // Use the pre-created Stripe Customer so the invoice inherits the
  // customer's preferred_locales=['tr'] and renders in Turkish (hosted
  // page, PDF, and receipt email). See createStripeCustomer above.
  params.append("customer", args.customerId);
  // Flow the billing details the user enters on the Checkout page back
  // to the Customer object — so the invoice has the right name + address
  // and any future support lookup has them too.
  params.append("customer_update[name]", "auto");
  params.append("customer_update[address]", "auto");

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

  // Brand attribution below the Pay button (see BRAND_ATTRIBUTION above).
  params.append("custom_text[submit][message]", BRAND_ATTRIBUTION);

  // Auto-generate a proper VAT-style invoice (sequential number, PDF,
  // hosted invoice page) and email it to the customer in tr-TR. The
  // webhook handler fetches the resulting invoice and persists the URLs
  // so the result page can offer "Faturayı indir".
  params.append("invoice_creation[enabled]", "true");
  params.append(
    "invoice_creation[invoice_data][description]",
    "Yıldızname tam okuma — kişiye özel dijital içerik.",
  );
  // Brand attribution + Dutch tax identifiers on the invoice footer (see
  // INVOICE_FOOTER above). Lives in code (not Dashboard) because
  // invoice_creation[invoice_data][footer] passed at session creation
  // OVERRIDES the Dashboard default — anything set in Dashboard →
  // Settings → Billing → Invoices is ignored when this param is present.
  // Version-controlled here so test and live invoices match, the footer
  // can't get accidentally cleared from the Dashboard, and i18n can swap
  // BRAND_ATTRIBUTION at the same time as the Checkout-page string.
  params.append("invoice_creation[invoice_data][footer]", INVOICE_FOOTER);

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

// Fetch a Checkout Session's customer email — used by the admin "Sync
// email" op to backfill `customer_email` on older paid readings (new
// payments capture it directly off the webhook event, no fetch needed).
// Returns null if the session has no email or the lookup fails.
export async function fetchSessionEmail(
  env: Env,
  sessionId: string,
): Promise<string | null> {
  const res = await fetch(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
  );
  if (!res.ok) {
    console.warn("[stripe] session fetch failed", {
      sessionId,
      status: res.status,
    });
    return null;
  }
  const session = (await res.json()) as {
    customer_details?: { email?: string | null } | null;
    customer_email?: string | null;
  };
  return session.customer_details?.email ?? session.customer_email ?? null;
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
