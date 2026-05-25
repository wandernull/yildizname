import type {
  FormData,
  Reading,
  ReadingStatus,
  YildiznameSections,
} from "./types";

interface ReadingRow {
  id: string;
  form_data: string;
  sections: string;
  unlocked: number;
  status: ReadingStatus;
  error: string | null;
  created_at: string;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  paid_at: string | null;
  invoice_hosted_url: string | null;
  invoice_pdf_url: string | null;
}

function rowToReading(row: ReadingRow): Reading {
  let sections: YildiznameSections | null = null;
  if (row.sections && row.sections !== "{}" && row.sections !== "") {
    try {
      sections = JSON.parse(row.sections) as YildiznameSections;
    } catch {
      sections = null;
    }
  }
  return {
    id: row.id,
    formData: JSON.parse(row.form_data) as FormData,
    sections,
    status: row.status,
    error: row.error,
    unlocked: row.unlocked === 1,
    createdAt: row.created_at,
    stripeSessionId: row.stripe_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    paidAt: row.paid_at,
    invoiceHostedUrl: row.invoice_hosted_url,
    invoicePdfUrl: row.invoice_pdf_url,
  };
}

// /api/generate is synchronous so we write the finished row in one go.
// status/error columns default to ('done', NULL); Stripe metadata columns
// default to NULL (populated later by the webhook handler).
export async function insertReading(
  db: D1Database,
  reading: { id: string; formData: FormData; sections: YildiznameSections; unlocked: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO readings (id, form_data, sections, unlocked)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      reading.id,
      JSON.stringify(reading.formData),
      JSON.stringify(reading.sections),
      reading.unlocked ? 1 : 0,
    )
    .run();
}

export async function getReading(
  db: D1Database,
  id: string,
): Promise<Reading | null> {
  const row = await db
    .prepare(
      `SELECT id, form_data, sections, unlocked, status, error, created_at,
              stripe_session_id, stripe_payment_intent_id, paid_at,
              invoice_hosted_url, invoice_pdf_url
       FROM readings WHERE id = ?`,
    )
    .bind(id)
    .first<ReadingRow>();
  return row ? rowToReading(row) : null;
}

// Called from POST /api/unlock when we create a Stripe Checkout session —
// pre-stores the session id so the webhook can correlate even if the
// session.metadata.reading_id lookup somehow fails (defense in depth).
export async function attachStripeSession(
  db: D1Database,
  id: string,
  sessionId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE readings SET stripe_session_id = ? WHERE id = ?`)
    .bind(sessionId, id)
    .run();
}

// Called from the webhook on checkout.session.completed. Idempotent — a
// duplicate webhook delivery for the same reading is a no-op.
export async function markReadingPaid(
  db: D1Database,
  id: string,
  payment: {
    sessionId: string;
    paymentIntentId: string | null;
    invoiceHostedUrl: string | null;
    invoicePdfUrl: string | null;
  },
): Promise<Reading | null> {
  const existing = await getReading(db, id);
  if (!existing) return null;
  if (existing.unlocked) {
    // Already paid — no-op, return current state for the webhook's logs.
    return existing;
  }
  await db
    .prepare(
      `UPDATE readings
         SET unlocked = 1,
             stripe_session_id = ?,
             stripe_payment_intent_id = ?,
             paid_at = ?,
             invoice_hosted_url = ?,
             invoice_pdf_url = ?
       WHERE id = ?`,
    )
    .bind(
      payment.sessionId,
      payment.paymentIntentId,
      new Date().toISOString(),
      payment.invoiceHostedUrl,
      payment.invoicePdfUrl,
      id,
    )
    .run();
  return getReading(db, id);
}
