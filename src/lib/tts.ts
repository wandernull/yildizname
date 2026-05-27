import { splitKarakterinOzu } from "./text";
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

// Bump this when buildSpeechText() changes in a way that meaningfully alters
// the audio output (different prosody pre-processing, different prompt
// shaping, different text content for a given section key, etc). Old objects
// under earlier prefixes get garbage-collected by the bucket's 15-day
// lifecycle rule, and the next listener triggers a fresh synthesis under the
// new prefix.
//   v2 → v3: karakterinOzu changed from "full audio" to "preview audio";
//            karakterinOzuRest introduced for the post-unlock 2/3, which
//            the client plays back-to-back after the preview.
const TTS_CACHE_PREFIX = "tts/v3";

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

export function ttsKey(readingId: string, section: TtsSection): string {
  return `${TTS_CACHE_PREFIX}/${readingId}/${section}.mp3`;
}

// Shape the text for prosody-friendly speech. Three passes:
//   1. Resolve which text body to read based on the (virtual) section key:
//        karakterinOzu     → kapakSözü + 1/3 preview of karakterinOzu
//        karakterinOzuRest → JUST the 2/3 remainder (no kapakSözü prepend,
//                            it's already in the preview audio that plays
//                            immediately before this clip)
//        anything else     → just sections[section]
//      buildKarakterinOzuRestText returns "" when the text was too short
//      to split (preview already covers the whole thing). The TTS endpoint
//      detects that and returns 404 so the client can skip the rest item
//      in its play queue cleanly.
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

// Helper exposed so the /api/tts route can detect the empty-rest case
// (text too short to split) BEFORE invoking synthesize, and 404 cleanly.
export function isRestEmptyFor(sections: YildiznameSections): boolean {
  return splitKarakterinOzu(sections.karakterinOzu).rest.length === 0;
}

export async function fetchCachedAudio(
  env: Env,
  readingId: string,
  section: TtsSection,
): Promise<R2ObjectBody | null> {
  return env.TTS_BUCKET.get(ttsKey(readingId, section));
}

// Calls ElevenLabs streaming endpoint and tees the response body so one
// branch streams to the client while the other is written to R2 in the
// background. The caller is responsible for passing executionCtx so the
// R2 put can be tracked with waitUntil — but R2 puts on Cloudflare are
// fast and will normally finish well within the client streaming window
// even without it.
export async function synthesizeStream(
  env: Env,
  ctx: ExecutionContext,
  readingId: string,
  section: TtsSection,
  sections: YildiznameSections,
): Promise<ReadableStream<Uint8Array>> {
  const text = buildSpeechText(section, sections);

  const controller = new AbortController();
  const headersTimer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(
      `${ELEVENLABS_BASE}/${env.ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "content-type": "application/json",
          accept: "audio/mpeg",
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
    clearTimeout(headersTimer);
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    console.error("[tts] elevenlabs non-2xx", {
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new Error(`ElevenLabs ${res.status}`);
  }

  // Tee: one branch goes to the client, the other gets buffered and
  // written to R2. R2.put cannot accept a chunked-encoding stream directly
  // (it needs a known content length), so we accumulate the bytes from one
  // branch into a Uint8Array and put that. Both branches drain in parallel
  // so the client streaming UX is unaffected — buffering only adds a tiny
  // amount of memory pressure (~2 MB per concurrent reading).
  const [clientBranch, r2Branch] = res.body.tee();

  ctx.waitUntil(
    bufferAndStore(env, readingId, section, r2Branch).catch((err) => {
      console.error("[tts] R2 put failed", {
        readingId,
        section,
        err: err instanceof Error ? err.message : String(err),
      });
    }),
  );

  return clientBranch;
}

async function bufferAndStore(
  env: Env,
  readingId: string,
  section: TtsSection,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  await env.TTS_BUCKET.put(ttsKey(readingId, section), bytes, {
    httpMetadata: {
      contentType: "audio/mpeg",
      cacheControl: "public, max-age=1296000, immutable",
    },
    customMetadata: {
      section,
      readingId,
      synthesizedAt: new Date().toISOString(),
      bytes: String(total),
    },
  });
}
