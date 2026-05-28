import type {
  FormData,
  Promo,
  Reading,
  ReadingStatus,
  TrackEvent,
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
  customer_email: string | null;
  viewer_ip: string | null;
  client_kind: string | null;
  scrolled_past_free: number;
  listened_free: number;
  listened_locked: number;
  listened_chain: number;
  clicked_unlock: number;
  clicked_unlock_at: string | null;
  feedback_rating: number | null;
  feedback_text: string | null;
  feedback_at: string | null;
  viewed_feedback_cta: number;
  clicked_feedback_cta: number;
}

const READING_COLUMNS = `
  id, form_data, sections, unlocked, status, error, created_at,
  stripe_session_id, stripe_payment_intent_id, paid_at,
  invoice_hosted_url, invoice_pdf_url, customer_email,
  viewer_ip, client_kind,
  scrolled_past_free, listened_free, listened_locked,
  listened_chain, clicked_unlock, clicked_unlock_at,
  feedback_rating, feedback_text, feedback_at,
  viewed_feedback_cta, clicked_feedback_cta
`;

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
    customerEmail: row.customer_email,
    viewerIp: row.viewer_ip,
    clientKind:
      row.client_kind === "web" ||
      row.client_kind === "inapp" ||
      row.client_kind === "mobile"
        ? row.client_kind
        : null,
    scrolledPastFree: row.scrolled_past_free === 1,
    listenedFree: row.listened_free === 1,
    listenedLocked: row.listened_locked === 1,
    listenedChain: row.listened_chain === 1,
    clickedUnlock: row.clicked_unlock === 1,
    clickedUnlockAt: row.clicked_unlock_at,
    feedbackRating: row.feedback_rating,
    feedbackText: row.feedback_text,
    feedbackAt: row.feedback_at,
    viewedFeedbackCta: row.viewed_feedback_cta === 1,
    clickedFeedbackCta: row.clicked_feedback_cta === 1,
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
    .prepare(`SELECT ${READING_COLUMNS} FROM readings WHERE id = ?`)
    .bind(id)
    .first<ReadingRow>();
  return row ? rowToReading(row) : null;
}

// Capture the viewer's IP on first GET /api/reading/:id. Only writes if
// the column is still NULL — so subsequent reads from the same OR a
// different IP don't overwrite the first one. This makes viewer_ip a
// "first-visit attribution" signal, not a "last-visit" one.
export async function captureViewerIp(
  db: D1Database,
  id: string,
  ip: string,
): Promise<void> {
  await db
    .prepare(`UPDATE readings SET viewer_ip = ? WHERE id = ? AND viewer_ip IS NULL`)
    .bind(ip, id)
    .run();
}

// Same first-visit-attribution pattern as captureViewerIp, but for the
// client_kind bucket (web | inapp | mobile) classified from User-Agent.
// Subsequent visits from a different environment (e.g. user clicked the
// shared link first in Instagram, then re-opened in real Safari) keep
// the original attribution.
export async function captureClientKind(
  db: D1Database,
  id: string,
  kind: "web" | "inapp" | "mobile",
): Promise<void> {
  await db
    .prepare(`UPDATE readings SET client_kind = ? WHERE id = ? AND client_kind IS NULL`)
    .bind(kind, id)
    .run();
}

// Flip a funnel-event flag to 1. Idempotent — if already 1, no-op.
// For `clicked_unlock`, also stamps clicked_unlock_at on the first hit
// so we can compute time-to-click later if useful.
export async function markEvent(
  db: D1Database,
  id: string,
  event: TrackEvent,
): Promise<void> {
  if (event === "clicked_unlock") {
    await db
      .prepare(
        `UPDATE readings
            SET clicked_unlock = 1,
                clicked_unlock_at = COALESCE(clicked_unlock_at, ?)
          WHERE id = ?`,
      )
      .bind(new Date().toISOString(), id)
      .run();
    return;
  }
  // Map the event key to the column name. The TS type guarantees event is
  // one of the known keys, so this is a closed set. (clicked_unlock is
  // handled above with its timestamp; it's listed here too so the Record
  // is exhaustive over TrackEvent.)
  const column: Record<TrackEvent, string> = {
    scrolled_past_free: "scrolled_past_free",
    listened_free: "listened_free",
    listened_locked: "listened_locked",
    listened_chain: "listened_chain",
    clicked_unlock: "clicked_unlock",
    viewed_feedback_cta: "viewed_feedback_cta",
    clicked_feedback_cta: "clicked_feedback_cta",
  };
  await db
    .prepare(`UPDATE readings SET ${column[event]} = 1 WHERE id = ?`)
    .bind(id)
    .run();
}

// Backoffice query. Returns rows in newest-first order. Caps at 500 so
// the admin page doesn't blow up if we cross that threshold (rare in v1;
// add pagination when it actually matters).
export async function listReadingsForAdmin(
  db: D1Database,
  limit: number = 500,
): Promise<Reading[]> {
  const result = await db
    .prepare(
      `SELECT ${READING_COLUMNS}
         FROM readings
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<ReadingRow>();
  return (result.results ?? []).map(rowToReading);
}

// Ratings page query. Only readings that submitted feedback, newest
// rating first (by feedback_at, not created_at — we care about when they
// rated). Same 500 cap as the funnel list.
export async function listReadingsWithFeedback(
  db: D1Database,
  limit: number = 500,
): Promise<Reading[]> {
  const result = await db
    .prepare(
      `SELECT ${READING_COLUMNS}
         FROM readings
        WHERE feedback_rating IS NOT NULL
        ORDER BY feedback_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<ReadingRow>();
  return (result.results ?? []).map(rowToReading);
}

// Count of paid readings — the denominator for the ratings page's
// "response rate" stat (feedbacks / paid). Cheap aggregate, accurate
// even past the 500-row table cap.
export async function countPaidReadings(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM readings WHERE unlocked = 1`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Record a paid user's rating + optional comment. Paid-only is enforced
// by the route (checks reading.unlocked). One-shot: the COALESCE keeps
// the first submission's values — a second call can only fill fields
// that were still NULL, never overwrite an existing rating. Returns the
// updated reading, or null if the reading doesn't exist.
export async function submitFeedback(
  db: D1Database,
  id: string,
  feedback: { rating: number; text: string | null },
): Promise<Reading | null> {
  const existing = await getReading(db, id);
  if (!existing) return null;
  // Already rated → no-op (one-shot). Return current state.
  if (existing.feedbackRating !== null) return existing;
  await db
    .prepare(
      `UPDATE readings
          SET feedback_rating = ?,
              feedback_text = ?,
              feedback_at = ?
        WHERE id = ? AND feedback_rating IS NULL`,
    )
    .bind(feedback.rating, feedback.text, new Date().toISOString(), id)
    .run();
  return getReading(db, id);
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
    customerEmail: string | null;
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
             invoice_pdf_url = ?,
             customer_email = ?
       WHERE id = ?`,
    )
    .bind(
      payment.sessionId,
      payment.paymentIntentId,
      new Date().toISOString(),
      payment.invoiceHostedUrl,
      payment.invoicePdfUrl,
      payment.customerEmail,
      id,
    )
    .run();
  return getReading(db, id);
}

// Backfill the customer email on an existing reading (admin "Sync email"
// op). Unlike markReadingPaid this doesn't touch payment state — it only
// sets the email, so it's safe to run on an already-paid reading.
export async function setCustomerEmail(
  db: D1Database,
  id: string,
  email: string,
): Promise<void> {
  await db
    .prepare(`UPDATE readings SET customer_email = ? WHERE id = ?`)
    .bind(email, id)
    .run();
}

interface PromoRow {
  id: string;
  reading_id: string;
  code: string;
  stripe_coupon_id: string;
  stripe_promotion_code_id: string;
  percent_off: number | null;
  expires_at: string | null;
  max_redemptions: number | null;
  created_at: string;
}

function rowToPromo(row: PromoRow): Promo {
  return {
    id: row.id,
    readingId: row.reading_id,
    code: row.code,
    stripeCouponId: row.stripe_coupon_id,
    stripePromotionCodeId: row.stripe_promotion_code_id,
    percentOff: row.percent_off,
    expiresAt: row.expires_at,
    maxRedemptions: row.max_redemptions,
    createdAt: row.created_at,
  };
}

// Persist a generated promo (admin Ops page). Stripe is the source of
// truth for redemption status — we only store the metadata + the Stripe
// ids needed to look that status up later.
export async function insertPromo(
  db: D1Database,
  p: {
    id: string;
    readingId: string;
    code: string;
    stripeCouponId: string;
    stripePromotionCodeId: string;
    percentOff: number | null;
    expiresAt: string | null;
    maxRedemptions: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO promos
         (id, reading_id, code, stripe_coupon_id, stripe_promotion_code_id,
          percent_off, expires_at, max_redemptions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.readingId,
      p.code,
      p.stripeCouponId,
      p.stripePromotionCodeId,
      p.percentOff,
      p.expiresAt,
      p.maxRedemptions,
    )
    .run();
}

// All promos for a reading, newest first (Ops page listing).
export async function listPromosForReading(
  db: D1Database,
  readingId: string,
): Promise<Promo[]> {
  const result = await db
    .prepare(
      `SELECT id, reading_id, code, stripe_coupon_id, stripe_promotion_code_id,
              percent_off, expires_at, max_redemptions, created_at
         FROM promos
        WHERE reading_id = ?
        ORDER BY created_at DESC`,
    )
    .bind(readingId)
    .all<PromoRow>();
  return (result.results ?? []).map(rowToPromo);
}

// Admin op (the /admin Ops page): roll a reading back to its free,
// pre-payment state. Clears unlocked + all Stripe metadata + any feedback
// (an unpaid reading shouldn't carry feedback). Mirrors the
// scripts/reset-paid-one.sh SQL. Does NOT issue a Stripe refund — that's
// a separate Dashboard action. Returns the updated reading, or null if
// the reading doesn't exist.
export async function resetPaymentForAdmin(
  db: D1Database,
  id: string,
): Promise<Reading | null> {
  const existing = await getReading(db, id);
  if (!existing) return null;
  await db
    .prepare(
      `UPDATE readings
          SET unlocked = 0,
              stripe_session_id = NULL,
              stripe_payment_intent_id = NULL,
              paid_at = NULL,
              invoice_hosted_url = NULL,
              invoice_pdf_url = NULL,
              feedback_rating = NULL,
              feedback_text = NULL,
              feedback_at = NULL,
              viewed_feedback_cta = 0,
              clicked_feedback_cta = 0
        WHERE id = ?`,
    )
    .bind(id)
    .run();
  return getReading(db, id);
}
