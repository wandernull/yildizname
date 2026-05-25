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
