import fs from "fs";
import * as dotenv from "dotenv";
import { validateRoast } from "./roast-validator";
dotenv.config();

/**
 * Full pipeline dry test:
 *   1. Generate 3 Sonnet roasts
 *   2. Validate each (Haiku) — pass/fail on hard criteria
 *   3. Picker chooses from passes (Haiku)
 *   4. Print everything for inspection
 */

const batchSrc = fs.readFileSync("scripts/generate-roasts-batch.ts", "utf-8");
const promptMatch = batchSrc.match(/const ROAST_PROMPT = `([\s\S]*?)`;/);
const pickerMatch = batchSrc.match(/const PICKER_PROMPT = \(n: number\) => `([\s\S]*?)`;/);
if (!promptMatch || !pickerMatch) { console.error("prompt extraction failed"); process.exit(1); }
const ROAST_PROMPT = promptMatch[1];
const PICKER_PROMPT = (n: number) => pickerMatch[1].replace(/\$\{n\}/g, String(n));

const TEST_IDS = [
  "q_c3905d1ef3e0d215",    // "You gotta sit on my lap if you want one"
  "q_0793d198ee71cee8",    // "Women fans ruin anime."
  "q_fb1202f3f80b6d7d",    // "The best way to keep a man happy is to respect him"
  "q_42ae1564490f1043",    // "All women are the same"
  "q_8wpugv",              // "Looks matter more than personality..."
  "q_a2964ef5bd507fe1",    // "straight men pretend to be gay just to shit on women"
];

const KEY = process.env.ANTHROPIC_API_KEY!;
const scraped = JSON.parse(fs.readFileSync("data/scraper-candidates.json","utf-8")).candidates;
const scrapedMap: Record<string, any> = {};
for (const c of scraped) scrapedMap[c.id] = c;

async function call(system: string, user: string, model: string, max: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: max, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0,160)}`);
  return ((await res.json()) as any).content?.[0]?.text?.trim() || "";
}

async function main() {
  for (const id of TEST_IDS) {
    const q = scrapedMap[id];
    if (!q) { console.log(`(missing: ${id})`); continue; }
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`SCRAPE: ${q.quote}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const userMsg = `Misogynistic quote: "${q.quote}"`;
    const settled = await Promise.allSettled([
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
    ]);

    const candidates: string[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.length && s.value.length < 300) candidates.push(s.value);
      else if (s.status === "rejected") candidates.push(`(api rejected: ${String(s.reason).slice(0,80)})`);
    }

    // Validate in parallel
    const validations = await Promise.all(
      candidates.map(c => c.startsWith("(api rejected") ? Promise.resolve({ pass: false, fails: ["api_error"], note: c }) : validateRoast(q.quote, c))
    );

    for (let i = 0; i < candidates.length; i++) {
      const v = validations[i];
      const badge = v.pass ? "✓ PASS" : `✗ FAIL [${v.fails.join(", ")}]`;
      console.log(`\n  ${i + 1}. ${candidates[i]}`);
      console.log(`     ${badge} — ${v.note}`);
    }

    const passIdxs = validations.map((v, i) => v.pass ? i : -1).filter(i => i >= 0);
    if (passIdxs.length === 0) {
      console.log(`\n  ⚠ ALL CANDIDATES FAILED → would mark pending`);
      continue;
    }
    if (passIdxs.length === 1) {
      console.log(`\n  PICKED: #${passIdxs[0] + 1} (only passing candidate)`);
      continue;
    }
    const passing = passIdxs.map(i => candidates[i]);
    try {
      const pick = await call(
        PICKER_PROMPT(passing.length),
        `Original misogynistic quote: "${q.quote}"\n\nCandidates:\n${passing.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\nWhich is best? Reply with ONLY the number.`,
        "claude-haiku-4-5-20251001", 10);
      const n = parseInt((pick.match(/\d+/) || ["1"])[0], 10);
      const originalIdx = passIdxs[n - 1];
      console.log(`\n  PICKED: #${originalIdx + 1} (from ${passing.length} passing)`);
    } catch (e: any) { console.log(`\n  PICKED: (picker error: ${String(e?.message).slice(0,60)})`); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
