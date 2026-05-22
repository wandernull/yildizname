import type { Env, SectionKey, YildiznameSections } from "./types";

// On-demand TTS via ElevenLabs streaming API, cached in R2 for 15 days.
//
// One object per (readingId, section) at key `tts/{readingId}/{section}.mp3`.
// The R2 bucket has a 15-day lifecycle rule set out-of-band, so we don't
// need to do age checks on read — anything still in the bucket is fresh.
//
// karakterinOzu is special: at synth time we prepend the kapakSözü so the
// first words the user ever hears are the literary mısra. This shaping only
// happens here, not in D1 — the stored section text stays clean.

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

// Bump this when buildSpeechText() changes in a way that meaningfully alters
// the audio output (different prosody pre-processing, different prompt
// shaping, etc). Old objects under earlier prefixes get garbage-collected by
// the bucket's 15-day lifecycle rule, and the next listener triggers a fresh
// synthesis under the new prefix.
const TTS_CACHE_PREFIX = "tts/v2";

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

export function ttsKey(readingId: string, section: SectionKey): string {
  return `${TTS_CACHE_PREFIX}/${readingId}/${section}.mp3`;
}

// Shape the text for prosody-friendly speech. Three passes:
//   1. Optionally prepend kapakSözü (only for karakterinOzu) so the autoplay's
//      first words are the literary mısra.
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
  section: SectionKey,
  sections: YildiznameSections,
): string {
  let text = sections[section];
  if (section === "karakterinOzu" && sections.kapakSozu) {
    text = `${sections.kapakSozu.trim()}\n\n…\n\n${text}`;
  }
  // 2: strip math-heavy parentheticals.
  text = text.replace(/\s*\([^)]*[+=][^)]*\)/g, "");
  // Collapse the double-spaces and orphaned punctuation that the strip
  // leaves behind. Preserve newlines (paragraph breaks → natural pauses).
  text = text.replace(/[ \t]+/g, " ").replace(/[ \t]+([,.!?…])/g, "$1");
  // 3: em-dash injection for slower prosody.
  return text.replace(/([.!?…])\s+(?=[^—])/g, "$1 — ");
}

export async function fetchCachedAudio(
  env: Env,
  readingId: string,
  section: SectionKey,
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
  section: SectionKey,
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
  section: SectionKey,
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
