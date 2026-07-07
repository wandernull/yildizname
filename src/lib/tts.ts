import { shouldChunk, splitIntoChunks, splitKarakterinOzu } from "./text";
import type { Env, SectionKey, YildiznameSections } from "./types";

// On-demand TTS via ElevenLabs streaming API, cached in R2 for 15 days.
//
// One object per (readingId, section) at key `tts/{prefix}/{readingId}/
// {section}.mp3`. The R2 bucket has a 15-day lifecycle rule set out-of-band,
// so we don't need to do age checks on read — anything still in the bucket
// is fresh.
//
// karakterinOzu is special — split across two audio files to avoid
// double-paying ElevenLabs on the free→paid conversion:
//   "karakterinOzu"     → kapakSözü + 1/3 PREVIEW of karakterinOzu text.
//                          Served on free-state autoplay and the per-section
//                          Dinle button before unlock. Cheap to synthesise.
//   "karakterinOzuRest" → ONLY the remaining 2/3 of karakterinOzu, no
//                          kapakSözü prepend (it's already at the start of
//                          the preview audio). Served only after unlock.
//                          The client plays preview + rest back-to-back as
//                          one logical track for paid playback — no
//                          re-synthesis of the preview portion, so per
//                          converted reading total spend is preview (1/3)
//                          + rest (2/3) = 1.0× full text, identical to the
//                          old single-synthesis flow but spread across the
//                          free→paid funnel.
//
// TtsSection extends SectionKey with the virtual "karakterinOzuRest" key.
// Not a YildiznameSections field — it's a TTS-layer derivation only. The
// shaping happens here at synth time, not in D1 — D1 always holds the full
// original text.

export type TtsSection = SectionKey | "karakterinOzuRest";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

// Bump this when buildSpeechText() or chunking changes in a way that
// meaningfully alters the audio output (different prosody pre-processing,
// different chunk sizes, etc). Old objects under earlier prefixes get
// garbage-collected by the bucket's 15-day lifecycle rule.
//   v2 → v3: karakterinOzu changed from "full audio" to "preview audio";
//            karakterinOzuRest introduced for the post-unlock 2/3.
//   v3 → v4: per-section single MP3 → per-(section, chunkIdx) MP3s.
//            Long sections split into ~12-15s chunks (cap ~26s) so every
//            served file has a known Content-Length and stays well under
//            the mobile <audio> chunked-EOF cutoff threshold. Short
//            sections (< 60s estimated; karakterinOzu's free preview)
//            stay as a single chunk to avoid seams in the funnel-critical
//            first impression.
const TTS_CACHE_PREFIX = "tts/v4";

const VOICE_SETTINGS = {
  stability: 0.6,
  similarity_boost: 0.75,
  style: 0.4,
  use_speaker_boost: true,
  speed: 0.85,
} as const;

// Time-to-first-byte cap. With streaming, ElevenLabs returns headers in
// under a second; anything past 30s here means the connection is sick.
const HEADERS_TIMEOUT_MS = 30_000;

// Shape the text for prosody-friendly speech. Three passes:
//   1. Resolve which text body to read based on the (virtual) section key:
//        karakterinOzu     → kapakSözü + 1/3 preview of karakterinOzu
//        karakterinOzuRest → JUST the 2/3 remainder (no kapakSözü prepend,
//                            it's already in the preview audio that plays
//                            immediately before this clip). May be "" when
//                            the text was too short to split (preview
//                            already covers the whole thing); getChunkCount
//                            returns 0 in that case so the route never
//                            tries to synthesize anything.
//        anything else     → just sections[section]
//   2. Strip numerology parentheticals — the müneccim prompt deliberately
//      invokes ebced math and the model loves to show its work in parens
//      like "(1+9+8+9=27, 2+7=9)". ElevenLabs reads that as "one plus nine
//      plus eight…" which breaks the literary cadence. The displayed text
//      in D1 keeps these breakdowns (they look impressive on screen); only
//      the audio version drops them. Heuristic: a "+" or "=" inside a paren
//      flags it as math. Prose parens like "(yani, eski bir kapı)" pass
//      through untouched.
//   3. Insert em-dashes after sentence terminators for slower prosody.
function buildSpeechText(
  section: TtsSection,
  sections: YildiznameSections,
): string {
  let text: string;
  if (section === "karakterinOzu") {
    const { preview } = splitKarakterinOzu(sections.karakterinOzu);
    text = sections.kapakSozu
      ? `${sections.kapakSozu.trim()}\n\n…\n\n${preview}`
      : preview;
  } else if (section === "karakterinOzuRest") {
    const { rest } = splitKarakterinOzu(sections.karakterinOzu);
    text = rest; // may be "" — caller (TTS route) handles that as 404
  } else {
    text = sections[section];
  }
  // 2: strip math-heavy parentheticals.
  text = text.replace(/\s*\([^)]*[+=][^)]*\)/g, "");
  // Collapse the double-spaces and orphaned punctuation that the strip
  // leaves behind. Preserve newlines (paragraph breaks → natural pauses).
  text = text.replace(/[ \t]+/g, " ").replace(/[ \t]+([,.!?…])/g, "$1");
  // 3: em-dash injection for slower prosody.
  return text.replace(/([.!?…])\s+(?=[^—])/g, "$1 — ");
}

export function chunkKey(
  readingId: string,
  section: TtsSection,
  chunkIdx: number,
): string {
  return `${TTS_CACHE_PREFIX}/${readingId}/${section}/${chunkIdx}.mp3`;
}

// Build the chunk list for a given section, applying the chunk-or-monolith
// rule from text.ts:
//   - shouldChunk(shapedText)=false (short section) → 1 chunk (whole text)
//   - shouldChunk(shapedText)=true  (long section)  → splitIntoChunks output
// Combines buildSpeechText's text shaping (kapakSözü prepend for
// karakterinOzu, math-paren strip, em-dash injection) with the chunker;
// callers should always go through this, never call splitIntoChunks
// directly on a raw section body.
function buildChunks(
  section: TtsSection,
  sections: YildiznameSections,
): string[] {
  const shaped = buildSpeechText(section, sections);
  if (!shaped) return [];
  if (!shouldChunk(shaped)) return [shaped];
  return splitIntoChunks(shaped);
}

// How many chunks does this section produce? Used by the route handler
// to build the manifest (`chunkCounts` field on /api/reading/:id done
// response) so the client knows the queue length.
export function getChunkCount(
  section: TtsSection,
  sections: YildiznameSections,
): number {
  return buildChunks(section, sections).length;
}

export async function fetchCachedChunk(
  env: Env,
  readingId: string,
  section: TtsSection,
  chunkIdx: number,
): Promise<R2ObjectBody | null> {
  return env.TTS_BUCKET.get(chunkKey(readingId, section, chunkIdx));
}

// Synthesize one chunk via ElevenLabs' NON-streaming endpoint (no
// `/stream` suffix) — returns the full MP3 as one buffer, which gives
// us a known Content-Length for the response (the entire point of the
// v4 architecture; mobile <audio> needs Content-Length to play long
// streams to the end).
//
// Cost note: ElevenLabs charges by characters synthesized, NOT by API
// calls — so chunking has zero extra API cost beyond the per-call HTTP
// overhead. Total characters synthesized are identical to the v3 path.
//
// Returns null if chunkIdx is out of range (route 404s in that case).
// Throws on ElevenLabs error; the route catches and 502s.
export async function synthesizeChunk(
  env: Env,
  ctx: ExecutionContext,
  readingId: string,
  section: TtsSection,
  chunkIdx: number,
  sections: YildiznameSections,
): Promise<Uint8Array | null> {
  const chunks = buildChunks(section, sections);
  if (chunkIdx < 0 || chunkIdx >= chunks.length) return null;
  const text = chunks[chunkIdx];

  // Abort guard against a stuck ElevenLabs connection. Non-streaming
  // response time is bounded by synthesis duration (~3-4s per ~12-15s
  // chunk) so 30s here is plenty of headroom; anything slower indicates
  // the upstream is sick.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(
      `${ELEVENLABS_BASE}/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: env.ELEVENLABS_MODEL_ID,
          voice_settings: VOICE_SETTINGS,
        }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[tts] elevenlabs chunk non-2xx", {
      readingId,
      section,
      chunkIdx,
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new Error(`ElevenLabs ${res.status}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  // Write to R2 in the background — caller already has the bytes to
  // return to the client. Idempotent on duplicate writes (e.g. two
  // listeners hitting the same uncached chunk concurrently).
  ctx.waitUntil(
    env.TTS_BUCKET.put(chunkKey(readingId, section, chunkIdx), bytes, {
      httpMetadata: {
        contentType: "audio/mpeg",
        cacheControl: "public, max-age=1296000, immutable",
      },
      customMetadata: {
        section,
        readingId,
        chunkIdx: String(chunkIdx),
        synthesizedAt: new Date().toISOString(),
        bytes: String(bytes.byteLength),
      },
    }).catch((err) => {
      console.error("[tts] R2 chunk put failed", {
        readingId,
        section,
        chunkIdx,
        err: err instanceof Error ? err.message : String(err),
      });
    }),
  );

  return bytes;
}

