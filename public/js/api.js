// Thin wrappers around fetch for the /api/* endpoints. Centralised so the
// view code never touches fetch directly.

async function jsonRequest(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error ? data.error : `İstek başarısız (${res.status}).`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function generateReading(formData) {
  return jsonRequest("/api/generate", {
    method: "POST",
    body: JSON.stringify(formData),
  });
}

export function fetchReading(id) {
  return jsonRequest(`/api/reading/${encodeURIComponent(id)}`);
}

// Attach a customer email to a still-generating (or already-done) reading.
// Backs the loading-screen "hazır olunca yaz" escape hatch — lets users
// who don't want to wait leave an address and bounce safely. Hits the
// /api/reading/:id/email route which (server-side) calls setCustomerEmail
// and, if the row is already status=done, fires the "hazır" email
// immediately to cover the post-completion race.
export function attachEmail(readingId, email) {
  return jsonRequest(`/api/reading/${encodeURIComponent(readingId)}/email`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// Creates a Stripe Checkout Session server-side and returns the hosted
// Checkout URL. The caller is responsible for redirecting the browser
// to that URL. If the reading is already paid, the server returns
// { alreadyUnlocked: true } with no `url` — the caller should treat that
// as a no-op or refresh.
export function startCheckout(id) {
  return jsonRequest("/api/unlock", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

// Audio URL for a (reading, section) pair. Server handles unlock checks +
// R2 cache + ElevenLabs fallback. Consumer just slaps this on an <audio src>.
export function ttsUrl(readingId, section) {
  return `/api/tts/${encodeURIComponent(readingId)}/${encodeURIComponent(section)}`;
}

// Funnel analytics — fires a single funnel event for the given reading.
// Fire-and-forget: returns a promise that resolves with the response
// (or null on failure) but the caller almost always discards it. Failures
// must never break the user's reading flow. Repeated calls for the same
// event are no-ops server-side (idempotent flags).
//
// Valid events: 'scrolled_past_free', 'listened_free', 'listened_locked',
// 'listened_chain', 'clicked_unlock', 'viewed_feedback_cta',
// 'clicked_feedback_cta'.
export function trackEvent(readingId, event) {
  if (!readingId) return Promise.resolve(null);
  return fetch(`/api/track/${encodeURIComponent(readingId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
    // Keepalive ensures the request survives a page navigation (e.g. user
    // clicks "Mührü kır" — we want the click event to land before the
    // browser redirects to Stripe).
    keepalive: true,
  }).catch(() => null);
}

// Submit a paid user's rating (1-5, required) + optional comment.
// Throws on non-2xx (caller shows the error in the modal). Paid-only —
// the server returns 403 for unlocked=0 readings. One-shot server-side:
// a second submit is a silent no-op that still returns success.
export function submitFeedback(readingId, rating, text) {
  return jsonRequest(`/api/feedback/${encodeURIComponent(readingId)}`, {
    method: "POST",
    body: JSON.stringify({ rating, text }),
  });
}
