// Per-reading cost ledger (migration 0011). Every billable upstream call
// writes one row to `reading_costs` at call time, from the exact numbers
// the vendor hands back — nothing here is estimated:
//
//   Anthropic   usage.{input,output,cache_*}_tokens × the official per-MTok
//               price below. $/MTok × tokens = micro-dollars, so the
//               stored cost_usd_micros is exact integer arithmetic.
//   ElevenLabs  the `character-cost` response header = billable characters
//               ("credits" in the dashboard) charged for that request
//               (calibrated 2026-10-04: 1,000 raw chars of our shaped
//               Turkish text on eleven_multilingual_v2 → 220 credits,
//               matching the dashboard delta exactly). Valued at the
//               published price per 1K billable characters — see
//               ELEVENLABS_USD_MICROS_PER_CREDIT. The $ value is applied at
//               read time (credits × rate), not stored, so a price change
//               is one constant and every row re-values consistently.
//
// Cost writes are best-effort: a failed ledger insert is logged and
// swallowed, never allowed to break a reading, an audio chunk or a queue
// attempt (a thrown error in the consumer would re-run the LLM call).

import type { Env } from "./types";

// Official Claude API prices, USD per million tokens. Source:
// https://platform.claude.com/docs/en/about-claude/pricing (checked
// 2026-10-04). Update here if Anthropic changes a price; rows already
// written keep the cost they were billed at.
const ANTHROPIC_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheWrite5m: number; cacheRead: number }
> = {
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheWrite5m: 1.25, cacheRead: 0.1 },
};

// ElevenLabs published price for v2 Multilingual: $0.08 per 1K (billable)
// characters = $0.00008 per credit = 80 µ$/credit. Source: ElevenLabs API
// pricing card for "v2 Multilingual · Text to Speech", confirmed by the
// user from the dashboard on 2026-10-04. Credits inside the monthly
// allowance are valued at this same rate (what they'd cost once the
// allowance is gone), so readings stay comparable and margins aren't
// flattered by the allowance. Kept integer so SQL sums stay exact.
export const ELEVENLABS_USD_MICROS_PER_CREDIT = 80;

export const ANTHROPIC_BILLING_URL = "https://platform.claude.com/settings/billing";
export const ELEVENLABS_BILLING_URL = "https://elevenlabs.io/app/subscription";

export type CostKind = "generation" | "free_audio" | "paid_audio" | "promo_email";

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function emptyUsage(): AnthropicUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

// Exact cost of one Messages API call in micro-dollars. Returns null for
// a model missing from the price table (logged so the gap is noticed).
export function anthropicCostMicros(model: string, u: AnthropicUsage): number | null {
  const p = ANTHROPIC_USD_PER_MTOK[model];
  if (!p) {
    console.warn("[costs] no price for model", { model });
    return null;
  }
  return Math.round(
    u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheCreationInputTokens * p.cacheWrite5m +
      u.cacheReadInputTokens * p.cacheRead,
  );
}

// ----- FX -------------------------------------------------------------------
// Daily ECB reference rates via frankfurter (free, no key). Looked up in
// D1 first; fetched at most once per UTC day. Falls back to the most
// recent stored rate if the API is down, and to null if we have never
// fetched one (the TRY column then shows "—" for that row).

const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY,EUR";

export interface FxRate {
  date: string;
  usdTry: number;
  usdEur: number;
}

export async function getFxRate(db: D1Database): Promise<FxRate | null> {
  const today = new Date().toISOString().slice(0, 10);
  const latest = await db
    .prepare(
      `SELECT date, usd_try, usd_eur, fetched_at FROM fx_rates
        ORDER BY date DESC LIMIT 1`,
    )
    .first<{ date: string; usd_try: number; usd_eur: number; fetched_at: string }>();
  // ECB doesn't publish on weekends/holidays, so the newest `date` can lag
  // today; `fetched_at` tells us whether we already asked today.
  if (latest && latest.fetched_at.slice(0, 10) === today) {
    return { date: latest.date, usdTry: latest.usd_try, usdEur: latest.usd_eur };
  }
  try {
    const res = await fetch(FX_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`frankfurter ${res.status}`);
    const json = (await res.json()) as {
      date?: string;
      rates?: { TRY?: number; EUR?: number };
    };
    const usdTry = json.rates?.TRY;
    const usdEur = json.rates?.EUR;
    if (!json.date || !usdTry || !usdEur) throw new Error("frankfurter: bad payload");
    await db
      .prepare(
        `INSERT INTO fx_rates (date, usd_try, usd_eur, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET usd_try = excluded.usd_try,
           usd_eur = excluded.usd_eur, fetched_at = excluded.fetched_at`,
      )
      .bind(json.date, usdTry, usdEur, new Date().toISOString())
      .run();
    return { date: json.date, usdTry, usdEur };
  } catch (err) {
    console.warn("[costs] fx fetch failed, using last stored rate", {
      err: err instanceof Error ? err.message : String(err),
    });
    return latest
      ? { date: latest.date, usdTry: latest.usd_try, usdEur: latest.usd_eur }
      : null;
  }
}

// Historical rate for a past day (YYYY-MM-DD) — used when backfilling the
// USD view of an older payment, so it's valued at its own payment day
// rather than today. ECB returns the last publication on or before that
// date. Not cached: only called from the manual Ops backfill.
export async function getFxRateForDate(date: string): Promise<FxRate | null> {
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/${encodeURIComponent(date)}?base=USD&symbols=TRY,EUR`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`frankfurter ${res.status}`);
    const json = (await res.json()) as {
      date?: string;
      rates?: { TRY?: number; EUR?: number };
    };
    if (!json.date || !json.rates?.TRY || !json.rates?.EUR) {
      throw new Error("frankfurter: bad payload");
    }
    return { date: json.date, usdTry: json.rates.TRY, usdEur: json.rates.EUR };
  } catch (err) {
    console.warn("[costs] historical fx fetch failed", {
      date,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ----- Ledger writes ----------------------------------------------------------

interface CostRow {
  readingId: string;
  provider: "anthropic" | "elevenlabs";
  kind: CostKind;
  model?: string | null;
  section?: string | null;
  chunkIdx?: number | null;
  queueAttempt?: number | null;
  attempt?: number | null;
  outcome?: string | null;
  usage?: AnthropicUsage | null;
  textChars?: number | null;
  credits?: number | null;
  costUsdMicros?: number | null;
}

async function insertCost(db: D1Database, row: CostRow): Promise<void> {
  try {
    const fx = await getFxRate(db);
    await db
      .prepare(
        `INSERT INTO reading_costs (
           reading_id, created_at, provider, kind, model, section, chunk_idx,
           queue_attempt, attempt, outcome,
           input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
           text_chars, credits, cost_usd_micros, usd_try
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.readingId,
        new Date().toISOString(),
        row.provider,
        row.kind,
        row.model ?? null,
        row.section ?? null,
        row.chunkIdx ?? null,
        row.queueAttempt ?? null,
        row.attempt ?? null,
        row.outcome ?? null,
        row.usage?.inputTokens ?? null,
        row.usage?.outputTokens ?? null,
        row.usage?.cacheCreationInputTokens ?? null,
        row.usage?.cacheReadInputTokens ?? null,
        row.textChars ?? null,
        row.credits ?? null,
        row.costUsdMicros ?? null,
        fx?.usdTry ?? null,
      )
      .run();
  } catch (err) {
    console.error("[costs] ledger insert failed", {
      readingId: row.readingId,
      kind: row.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function recordAnthropicCost(
  db: D1Database,
  args: {
    readingId: string;
    kind: "generation" | "promo_email";
    model: string;
    usage: AnthropicUsage;
    queueAttempt?: number;
    attempt?: number;
    outcome?: string;
  },
): Promise<void> {
  const u = args.usage;
  // An HTTP error before any tokens flowed isn't billed — nothing to log.
  if (u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens === 0) {
    return;
  }
  await insertCost(db, {
    readingId: args.readingId,
    provider: "anthropic",
    kind: args.kind,
    model: args.model,
    queueAttempt: args.queueAttempt ?? null,
    attempt: args.attempt ?? null,
    outcome: args.outcome ?? null,
    usage: u,
    costUsdMicros: anthropicCostMicros(args.model, u),
  });
}

export async function recordElevenLabsCost(
  db: D1Database,
  args: {
    readingId: string;
    section: string;
    chunkIdx: number;
    model: string;
    textChars: number;
    credits: number | null;
  },
): Promise<void> {
  if (args.credits == null) {
    // Header missing — log it rather than invent a number; the row still
    // records text_chars so the gap is visible in the breakdown.
    console.warn("[costs] elevenlabs response without character-cost header", {
      readingId: args.readingId,
      section: args.section,
      chunkIdx: args.chunkIdx,
    });
  }
  await insertCost(db, {
    readingId: args.readingId,
    provider: "elevenlabs",
    kind: args.section === "karakterinOzu" ? "free_audio" : "paid_audio",
    model: args.model,
    section: args.section,
    chunkIdx: args.chunkIdx,
    textChars: args.textChars,
    credits: args.credits,
    // $ is derived at read time from credits (see ELEVENLABS_USD_MICROS_PER_CREDIT).
    costUsdMicros: null,
  });
}

// ----- Ledger reads -----------------------------------------------------------

export interface CostTotals {
  claudeUsdMicros: number;
  claudeTry: number | null;
  freeCredits: number;
  paidCredits: number;
  // Per-kind audio in TRY (each row valued with its own day's rate). USD
  // for a kind is credits × ELEVENLABS_USD_MICROS_PER_CREDIT (see usdOfCredits).
  freeTry: number | null;
  paidTry: number | null;
  audioUsdMicros: number;
  audioTry: number | null;
  calls: number;
}

export function usdOfCredits(credits: number): number {
  return credits * ELEVENLABS_USD_MICROS_PER_CREDIT;
}

function emptyTotals(): CostTotals {
  return {
    claudeUsdMicros: 0,
    claudeTry: 0,
    freeCredits: 0,
    paidCredits: 0,
    freeTry: 0,
    paidTry: 0,
    audioUsdMicros: 0,
    audioTry: 0,
    calls: 0,
  };
}

interface TotalsRow {
  reading_id: string;
  claude_micros: number | null;
  claude_try: number | null;
  claude_try_missing: number;
  free_credits: number | null;
  paid_credits: number | null;
  free_try: number | null;
  paid_try: number | null;
  audio_micros: number | null;
  audio_try: number | null;
  audio_try_missing: number;
  calls: number;
}

// TRY is summed per row with that row's own snapshot rate; if any priced
// row lacks a rate the TRY total is null (shown as "—") rather than wrong.
const TOTALS_SELECT = `
  SUM(CASE WHEN provider = 'anthropic' THEN cost_usd_micros END) AS claude_micros,
  SUM(CASE WHEN provider = 'anthropic' THEN cost_usd_micros * usd_try / 1000000.0 END) AS claude_try,
  SUM(CASE WHEN provider = 'anthropic' AND cost_usd_micros IS NOT NULL AND usd_try IS NULL THEN 1 ELSE 0 END) AS claude_try_missing,
  SUM(CASE WHEN kind = 'free_audio' THEN credits END) AS free_credits,
  SUM(CASE WHEN kind = 'paid_audio' THEN credits END) AS paid_credits,
  SUM(CASE WHEN kind = 'free_audio' THEN credits * ${ELEVENLABS_USD_MICROS_PER_CREDIT} * usd_try / 1000000.0 END) AS free_try,
  SUM(CASE WHEN kind = 'paid_audio' THEN credits * ${ELEVENLABS_USD_MICROS_PER_CREDIT} * usd_try / 1000000.0 END) AS paid_try,
  SUM(CASE WHEN provider = 'elevenlabs' THEN credits * ${ELEVENLABS_USD_MICROS_PER_CREDIT} END) AS audio_micros,
  SUM(CASE WHEN provider = 'elevenlabs' THEN credits * ${ELEVENLABS_USD_MICROS_PER_CREDIT} * usd_try / 1000000.0 END) AS audio_try,
  SUM(CASE WHEN provider = 'elevenlabs' AND credits IS NOT NULL AND usd_try IS NULL THEN 1 ELSE 0 END) AS audio_try_missing,
  COUNT(*) AS calls`;

function rowToTotals(r: Omit<TotalsRow, "reading_id">): CostTotals {
  return {
    claudeUsdMicros: r.claude_micros ?? 0,
    claudeTry: r.claude_try_missing > 0 ? null : (r.claude_try ?? 0),
    freeCredits: r.free_credits ?? 0,
    paidCredits: r.paid_credits ?? 0,
    // audio_try_missing covers both kinds; a missing rate nulls both.
    freeTry: r.audio_try_missing > 0 ? null : (r.free_try ?? 0),
    paidTry: r.audio_try_missing > 0 ? null : (r.paid_try ?? 0),
    audioUsdMicros: r.audio_micros ?? 0,
    audioTry: r.audio_try_missing > 0 ? null : (r.audio_try ?? 0),
    calls: r.calls,
  };
}

// Totals per reading, keyed by reading id. Readings without any ledger
// rows are absent from the map (= "not tracked").
export async function getCostTotalsByReading(
  db: D1Database,
): Promise<Map<string, CostTotals>> {
  const result = await db
    .prepare(`SELECT reading_id, ${TOTALS_SELECT} FROM reading_costs GROUP BY reading_id`)
    .all<TotalsRow>();
  const map = new Map<string, CostTotals>();
  for (const r of result.results ?? []) map.set(r.reading_id, rowToTotals(r));
  return map;
}

// Totals over a trailing window (days) or all time (null).
export async function getCostTotalsSince(
  db: D1Database,
  days: number | null,
): Promise<CostTotals> {
  const where =
    days == null
      ? ""
      : // created_at is ISO-8601 ("…T…Z"); compare in the same format.
        `WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Math.floor(days)} days')`;
  const r = await db
    .prepare(`SELECT ${TOTALS_SELECT} FROM reading_costs ${where}`)
    .first<Omit<TotalsRow, "reading_id">>();
  return r ? rowToTotals(r) : emptyTotals();
}

export async function getFirstCostAt(db: D1Database): Promise<string | null> {
  const r = await db
    .prepare(`SELECT MIN(created_at) AS first FROM reading_costs`)
    .first<{ first: string | null }>();
  return r?.first ?? null;
}

// Mean credits per reading among readings that reached paid audio — the
// "one fully-listened paid okuma" yardstick for the Credits tab.
export async function getAvgCreditsPerPaidListen(db: D1Database): Promise<number | null> {
  const r = await db
    .prepare(
      `SELECT AVG(total) AS avg FROM (
         SELECT SUM(credits) AS total FROM reading_costs
          WHERE provider = 'elevenlabs'
          GROUP BY reading_id
         HAVING SUM(CASE WHEN kind = 'paid_audio' THEN 1 ELSE 0 END) > 0
       )`,
    )
    .first<{ avg: number | null }>();
  return r?.avg ?? null;
}

export interface CostLedgerRow {
  createdAt: string;
  provider: string;
  kind: CostKind;
  model: string | null;
  section: string | null;
  chunkIdx: number | null;
  queueAttempt: number | null;
  attempt: number | null;
  outcome: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  textChars: number | null;
  credits: number | null;
  costUsdMicros: number | null;
  usdTry: number | null;
}

export async function listCostsForReading(
  db: D1Database,
  readingId: string,
): Promise<CostLedgerRow[]> {
  const result = await db
    .prepare(
      `SELECT created_at, provider, kind, model, section, chunk_idx, queue_attempt,
              attempt, outcome, input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens,
              text_chars, credits, cost_usd_micros, usd_try
         FROM reading_costs WHERE reading_id = ? ORDER BY id ASC`,
    )
    .bind(readingId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map((r) => ({
    createdAt: r.created_at as string,
    provider: r.provider as string,
    kind: r.kind as CostKind,
    model: (r.model as string | null) ?? null,
    section: (r.section as string | null) ?? null,
    chunkIdx: (r.chunk_idx as number | null) ?? null,
    queueAttempt: (r.queue_attempt as number | null) ?? null,
    attempt: (r.attempt as number | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    cacheCreationInputTokens: (r.cache_creation_input_tokens as number | null) ?? null,
    cacheReadInputTokens: (r.cache_read_input_tokens as number | null) ?? null,
    textChars: (r.text_chars as number | null) ?? null,
    credits: (r.credits as number | null) ?? null,
    // Audio rows: $ derived from credits at the published rate.
    costUsdMicros:
      r.provider === "elevenlabs"
        ? r.credits == null
          ? null
          : (r.credits as number) * ELEVENLABS_USD_MICROS_PER_CREDIT
        : ((r.cost_usd_micros as number | null) ?? null),
    usdTry: (r.usd_try as number | null) ?? null,
  }));
}

// Same totals as the SQL aggregate, computed from an already-loaded
// ledger (Ops page). undefined = no rows = not tracked.
export function summarizeLedger(rows: CostLedgerRow[]): CostTotals | undefined {
  if (rows.length === 0) return undefined;
  const t = emptyTotals();
  for (const r of rows) {
    t.calls++;
    const micros = r.costUsdMicros;
    const tl = micros != null && r.usdTry != null ? (micros / 1_000_000) * r.usdTry : null;
    if (r.provider === "anthropic") {
      t.claudeUsdMicros += micros ?? 0;
      if (micros != null) t.claudeTry = tl == null || t.claudeTry == null ? null : t.claudeTry + tl;
    } else {
      if (r.kind === "free_audio") {
        t.freeCredits += r.credits ?? 0;
        if (micros != null) t.freeTry = tl == null || t.freeTry == null ? null : t.freeTry + tl;
      }
      if (r.kind === "paid_audio") {
        t.paidCredits += r.credits ?? 0;
        if (micros != null) t.paidTry = tl == null || t.paidTry == null ? null : t.paidTry + tl;
      }
      t.audioUsdMicros += micros ?? 0;
      if (micros != null) t.audioTry = tl == null || t.audioTry == null ? null : t.audioTry + tl;
    }
  }
  return t;
}

// ----- ElevenLabs account (Credits tab) ---------------------------------------
// Read-only key (user_read scope only) in ELEVENLABS_ADMIN_KEY. The
// character_* fields are the monthly credit allowance; the prepaid USD
// top-up balance is not exposed by any ElevenLabs endpoint. The counter
// lags real usage by ~1-2 minutes.

export interface ElevenLabsAccount {
  tier: string;
  used: number;
  limit: number;
  resetAt: string | null;
  overageUsd: string | null;
}

export async function fetchElevenLabsAccount(
  env: Env,
): Promise<ElevenLabsAccount | { error: string }> {
  if (!env.ELEVENLABS_ADMIN_KEY) return { error: "ELEVENLABS_ADMIN_KEY ayarlanmamış." };
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": env.ELEVENLABS_ADMIN_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[costs] elevenlabs subscription fetch failed", {
        status: res.status,
        body: body.slice(0, 300),
      });
      return { error: `ElevenLabs ${res.status}` };
    }
    const d = (await res.json()) as {
      tier?: string;
      character_count?: number;
      character_limit?: number;
      next_character_count_reset_unix?: number | null;
      current_overage?: { amount?: string; currency?: string } | null;
    };
    return {
      tier: d.tier ?? "?",
      used: d.character_count ?? 0,
      limit: d.character_limit ?? 0,
      resetAt: d.next_character_count_reset_unix
        ? new Date(d.next_character_count_reset_unix * 1000).toISOString()
        : null,
      overageUsd: d.current_overage?.amount ?? null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ----- Formatting (admin HTML) ------------------------------------------------

const TRY_FMT = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "TRY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const INT_FMT = new Intl.NumberFormat("tr-TR");

export function fmtUsdMicros(micros: number): string {
  if (micros === 0) return "$0.00";
  const usd = micros / 1_000_000;
  const sign = usd < 0 ? "−" : "";
  const abs = Math.abs(usd);
  // Sub-dollar amounts need 3-4 decimals to be meaningful (a Haiku call
  // is ~$0.002); larger ones read better at cents.
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${sign}$${abs.toFixed(digits)}`;
}

export function fmtTry(amount: number): string {
  return TRY_FMT.format(amount).replace("-", "−");
}

export function fmtInt(n: number): string {
  return INT_FMT.format(n);
}
