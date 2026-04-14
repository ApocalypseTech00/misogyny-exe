import fs from "fs";
import path from "path";

/**
 * MISOGYNY.EXE V6 — Anthropic spend accumulator + daily cap
 *
 * Per V6 spec §14: `ANTHROPIC_DAILY_USD_CAP` (env, default $10) caps daily spend.
 * Every `callClaude` wrapper in the pipeline routes through `gate()` before the
 * API call and `record()` after. State lives in `data/anthropic-spend.json`.
 *
 * Pricing (USD per MTok, as of spec-writing — update in PRICING below if Anthropic changes prices):
 *   claude-sonnet-4-6         in=$3.00   out=$15.00
 *   claude-haiku-4-5          in=$1.00   out=$5.00
 */

const SPEND_PATH = path.join(__dirname, "..", "data", "anthropic-spend.json");

interface SpendState {
  date: string; // YYYY-MM-DD
  usd: number;  // cumulative spend for that date
}

interface PricePerMTok {
  in: number;
  out: number;
}

const PRICING: Record<string, PricePerMTok> = {
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5-20251001": { in: 1.0, out: 5.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): SpendState {
  const day = today();
  if (!fs.existsSync(SPEND_PATH)) return { date: day, usd: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(SPEND_PATH, "utf-8")) as SpendState;
    // Reset on day boundary
    if (raw.date !== day) return { date: day, usd: 0 };
    return raw;
  } catch {
    return { date: day, usd: 0 };
  }
}

function save(state: SpendState): void {
  const dir = path.dirname(SPEND_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SPEND_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, SPEND_PATH);
}

export function cap(): number {
  const raw = process.env.ANTHROPIC_DAILY_USD_CAP;
  const parsed = raw ? parseFloat(raw) : 10;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export function spentToday(): number {
  return load().usd;
}

/**
 * Gate a Claude call by estimated cost. Aborts (throws) if estimated spend would exceed the daily cap.
 * Call `record()` after the API call with actual token counts from the response.
 */
export function gate(model: string, estimatedInTokens: number, estimatedOutTokens: number): void {
  const est = estimateUsd(model, estimatedInTokens, estimatedOutTokens);
  const { usd } = load();
  if (usd + est > cap()) {
    throw new Error(
      `ANTHROPIC_DAILY_USD_CAP would be exceeded: spent ${usd.toFixed(2)} + est ${est.toFixed(2)} > cap ${cap().toFixed(2)}`
    );
  }
}

/** Record actual spend from a completed API response's usage field. */
export function record(model: string, inTokens: number, outTokens: number): number {
  const state = load();
  const cost = estimateUsd(model, inTokens, outTokens);
  state.usd += cost;
  save(state);
  return cost;
}

export function estimateUsd(model: string, inTokens: number, outTokens: number): number {
  const p = PRICING[model] ?? PRICING["claude-sonnet-4-6"];
  return (inTokens / 1_000_000) * p.in + (outTokens / 1_000_000) * p.out;
}

/** One-line footer for Telegram DMs etc. */
export function footer(): string {
  return `Anthropic spend today: $${spentToday().toFixed(2)} / $${cap().toFixed(2)}`;
}
