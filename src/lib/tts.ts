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
  return `tts/${readingId}/${section}.mp3`;
}

// Shape the text for prosody-friendly speech. Em-dashes after sentence
// terminators give Eleven's model an extra pause beat. The kapakSözü gets
// prepended only when synthesising karakterinOzu.
function buildSpeechText(
  section: SectionKey,
  sections: YildiznameSections,
): string {
  let text = sections[section];
  if (section === "karakterinOzu" && sections.kapakSozu) {
    text = `${sections.kapakSozu.trim()}\n\n…\n\n${text}`;
  }
  // Insert em-dash + space after end-of-sentence punctuation that isn't
  // already followed by an em-dash. Slows the model's prosody noticeably.
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

  // Tee: one branch goes to the client, the other to R2.
  const [clientBranch, r2Branch] = res.body.tee();

  // R2 put consumes its branch asynchronously while the client reads.
  // waitUntil keeps the invocation alive long enough for R2 to finish even
  // if the client finishes reading first. R2 puts on the Cloudflare edge are
  // fast (<1s for ~300 KB), so this is well within any plan's budget.
  ctx.waitUntil(
    env.TTS_BUCKET.put(ttsKey(readingId, section), r2Branch, {
      httpMetadata: {
        contentType: "audio/mpeg",
        cacheControl: "public, max-age=1296000, immutable",
      },
      customMetadata: {
        section,
        readingId,
        synthesizedAt: new Date().toISOString(),
      },
    }).catch((err) => {
      console.error("[tts] R2 put failed", { readingId, section, err: String(err) });
    }),
  );

  return clientBranch;
}
