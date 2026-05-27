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
