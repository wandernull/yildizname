// Text utilities used at request time on the server.
//
// splitKarakterinOzu cuts the free-tier preview at the sentence boundary
// closest to the 33% character mark. Both halves are returned so the
// caller can decide which goes where:
//   - GET /api/reading/:id (free state)    → returns only `preview`
//   - GET /api/reading/:id (unlocked)      → returns the full text
//                                              (preview + rest concatenated)
//   - GET /api/tts/:id/karakterinOzu       → synthesises `preview` audio
//                                              (kapakSözü + preview text)
//   - GET /api/tts/:id/karakterinOzuRest   → synthesises `rest` audio
//                                              (no kapakSözü prepend); the
//                                              client plays it back-to-back
//                                              after the preview so the
//                                              preview audio is never
//                                              re-synthesised on unlock
//
// Edge cases handled:
//   - very short text (<100 chars) → no split, preview = original
//   - no sentence boundary anywhere near the 33% mark → hard-cut fallback,
//     padded with an ellipsis so the cut still reads gracefully
//
// "Sentence boundary" = one of [.!?…] optionally followed by a closing
// quote / bracket, then whitespace. Conservative regex — won't fire on
// abbreviations like "Dr. " (rare in müneccim prose anyway) but if it
// does, the only consequence is a slightly earlier cut.

export function splitKarakterinOzu(text: string): {
  preview: string;
  rest: string;
} {
  const trimmed = (text ?? "").trim();
  if (trimmed.length < 100) {
    return { preview: trimmed, rest: "" };
  }

  const target = Math.floor(trimmed.length / 3);
  const boundaryRe = /[.!?…]["')\]»]?\s+/g;

  let bestEnd = -1;
  let bestDelta = Infinity;
  for (let m: RegExpExecArray | null; (m = boundaryRe.exec(trimmed)); ) {
    const end = m.index + m[0].length;
    if (end >= trimmed.length) break; // boundary at the very end isn't useful
    const delta = Math.abs(end - target);
    if (delta < bestDelta) {
      bestEnd = end;
      bestDelta = delta;
    }
  }

  if (bestEnd <= 0) {
    // No sentence boundary found in the searchable range. Fall back to a
    // hard cut at the 33% mark, prefer a word boundary if one is near so
    // we don't slice mid-word.
    let cut = target;
    const space = trimmed.lastIndexOf(" ", target);
    if (space > target - 40) cut = space; // within ~40 chars, snap to space
    return {
      preview: trimmed.slice(0, cut).trimEnd() + "…",
      rest: trimmed.slice(cut).trimStart(),
    };
  }

  return {
    preview: trimmed.slice(0, bestEnd).trimEnd(),
    rest: trimmed.slice(bestEnd).trimStart(),
  };
}

// Chunked-TTS support — used by the per-chunk synthesis path in tts.ts
// (mobile <audio> + chunked transfer without Content-Length cuts off
// playback near the end of long streams; we work around by splitting
// long sections into smaller pieces whose R2-cached MP3s always have a
// known Content-Length).
//
// Tuning (Turkish TTS at ElevenLabs `eleven_multilingual_v2` default
// rate ≈ 13.3 chars/sec → 0.075 sec/char):
//   - Target chunk: 180 chars  (~13.5s of audio)
//   - Min chunk:    60 chars   (avoid sub-5s clips)
//   - Max chunk:    350 chars  (~26s — stays well under the
//                                mobile-cut-off threshold; per the
//                                empirical observation that the 33%
//                                karakterinOzu preview, which is also
//                                short, never cuts off on mobile)
//   - Chunk-or-monolith gate: 60s. Short sections (free preview, brief
//                              locked sections) stay as one MP3 — no
//                              chunk seams introduced where they aren't
//                              needed.
const CHUNK_TARGET_CHARS = 180;
const CHUNK_MIN_CHARS = 60;
const CHUNK_MAX_CHARS = 350;
const CHUNK_THRESHOLD_SECONDS = 60;
const SECONDS_PER_CHAR = 0.075;

// Rough audio-duration estimate from text length. Drives the
// chunk-or-monolith decision (shouldChunk) and the per-chunk size
// targeting. ~13.3 chars/sec is a conservative middle for Turkish at
// the voice/model settings configured in wrangler.toml.
export function estimateAudioSeconds(text: string): number {
  return text.length * SECONDS_PER_CHAR;
}

// Should this section's text be chunked, or synthesized as one MP3?
// Short sections (< CHUNK_THRESHOLD_SECONDS of estimated audio) stay
// monolithic so we don't introduce chunk seams where they aren't
// needed. karakterinOzu's free preview (~30–50s) and any brief locked
// sections fall here. Long locked sections (60s+) chunk so mobile
// browsers don't cut off the end of the stream.
export function shouldChunk(text: string): boolean {
  return estimateAudioSeconds(text) >= CHUNK_THRESHOLD_SECONDS;
}

// Greedy sentence-pack: walks sentence by sentence using the same
// boundary regex as splitKarakterinOzu, accumulating into the current
// chunk until either (a) adding the next sentence would exceed MAX or
// (b) the current chunk has reached TARGET. Both rules combined keep
// chunks close to TARGET while preventing single chunks from growing
// past MAX. Edge cases:
//   - empty input            → []
//   - text < MIN              → [text] as single tiny chunk
//   - single sentence > MAX  → that sentence is its own chunk; we'd
//                              rather lose chunk-size discipline than
//                              shred a single utterance mid-thought
//
// Greedy packing biases toward filling each chunk to target, which
// means natural sentence boundaries (and paragraph breaks, which are
// also sentence boundaries) tend to land at chunk seams — masking the
// imperceptible MP3-encoder padding gap between consecutive files.
export function splitIntoChunks(
  text: string,
  opts: {
    targetChars?: number;
    minChars?: number;
    maxChars?: number;
  } = {},
): string[] {
  const target = opts.targetChars ?? CHUNK_TARGET_CHARS;
  const minChars = opts.minChars ?? CHUNK_MIN_CHARS;
  const maxChars = opts.maxChars ?? CHUNK_MAX_CHARS;
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= minChars) return [trimmed];

  // Same regex as splitKarakterinOzu — `[.!?…]` optionally followed by
  // a closing quote/bracket, then whitespace. Conservative: won't fire
  // on abbreviations like "Dr." (rare in müneccim prose anyway).
  const boundaryRe = /[.!?…]["')\]»]?\s+/g;
  const sentences: string[] = [];
  let cursor = 0;
  for (let m: RegExpExecArray | null; (m = boundaryRe.exec(trimmed)); ) {
    const end = m.index + m[0].length;
    sentences.push(trimmed.slice(cursor, end));
    cursor = end;
  }
  if (cursor < trimmed.length) {
    // Tail: anything after the last sentence terminator (or the entire
    // string if no boundary fired — single very long utterance).
    sentences.push(trimmed.slice(cursor));
  }

  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (current.length === 0) {
      current = s;
      continue;
    }
    // Would adding this sentence exceed max? Flush, start a new chunk.
    if (current.length + 1 + s.length > maxChars) {
      chunks.push(current);
      current = s;
      continue;
    }
    // It fits — but if current has already crossed target, flush so
    // we don't keep growing past the sweet spot.
    if (current.length >= target) {
      chunks.push(current);
      current = s;
      continue;
    }
    current = `${current} ${s}`;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Returns the first sentence of the locked `rest` portion — short enough
// to render inline-blurred at the bottom of the visible preview as a
// "fading into more" teaser. The full `rest` stays server-side and is
// only sent to the client after unlock; this teaser is the controlled
// information leak that makes the cut feel continuous instead of cliff-
// edged. Falls back to the first ~15 words if the sentence boundary is
// too far away (single very long opening sentence in rest).
export function getKarakterinOzuTeaser(text: string): string {
  const { rest } = splitKarakterinOzu(text);
  if (!rest) return "";
  // Match up to the first sentence terminator; cap length so we don't
  // accidentally expose a 300-character sentence.
  const sentenceMatch = rest.match(/^[\s\S]{1,200}?[.!?…]["')\]»]?(?=\s|$)/);
  if (sentenceMatch) {
    return sentenceMatch[0].trim();
  }
  const words = rest.split(/\s+/).slice(0, 15);
  return words.join(" ") + (rest.split(/\s+/).length > 15 ? "…" : "");
}
