import fs from "fs";
import * as dotenv from "dotenv";
import { validateRoast } from "./roast-validator";
import { buildCalibrationBlock } from "./roast-calibration";
dotenv.config();

/**
 * Full pipeline dry test with upgraded agent:
 *   - 5 Sonnet candidates (not 3)
 *   - Dynamic calibration from approved-roasts.json
 *   - Validator with 8 criteria (incl. no_assumed_biography, universal_reference)
 */

const batchSrc = fs.readFileSync("scripts/generate-roasts-batch.ts", "utf-8");
const promptMatch = batchSrc.match(/const ROAST_PROMPT = `([\s\S]*?)`;/);
const pickerMatch = batchSrc.match(/const PICKER_PROMPT = \(n: number\) => `([\s\S]*?)`;/);
if (!promptMatch || !pickerMatch) { console.error("prompt extraction failed"); process.exit(1); }
const ROAST_PROMPT_TEMPLATE = promptMatch[1];
const PICKER_PROMPT = (n: number) => pickerMatch[1].replace(/\$\{n\}/g, String(n));

// Dynamic calibration
const calibration = buildCalibrationBlock(12);
const ROAST_PROMPT = ROAST_PROMPT_TEMPLATE.replace("{{CALIBRATION_BLOCK}}", calibration);

const TEST_IDS = [
  "q_4a02ad87f9fc4de4",    // "If female students spent less time worrying about their looks..."
  "q_1e8707f9018061eb",    // "Women who slept with a hundred men are incapable of love"
  "q_82w69z",              // "Men's issues are tied to female privilege..."
  "q_ha338",               // "females are inherently valuable while males are inherently disposable"
  "q_f4a71f687b8266cd",    // "Women just aren't as naturally gifted in logic-based subjects"
  "q_02e936712567df89",    // "Women are desperate to be sexually harassed"
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
  console.log(`Calibration: ${calibration.split("\n").length - 1} examples loaded from approved-roasts.json\n`);

  for (const id of TEST_IDS) {
    const q = scrapedMap[id];
    if (!q) { console.log(`(missing: ${id})`); continue; }
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`SCRAPE: ${q.quote}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const userMsg = `Misogynistic quote: "${q.quote}"`;
    // 5 candidates instead of 3
    const settled = await Promise.allSettled([
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
      call(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 120),
    ]);

    const candidates: string[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.length && s.value.length < 300) candidates.push(s.value);
    }

    const validations = await Promise.all(
      candidates.map(c => validateRoast(q.quote, c).catch(() => ({ pass: false, fails: ["_error"], note: "validator error" })))
    );

    for (let i = 0; i < candidates.length; i++) {
      const v = validations[i];
      const badge = v.pass ? "✓ PASS" : `✗ FAIL [${v.fails.join(", ")}]`;
      console.log(`\n  ${i + 1}. ${candidates[i]}`);
      console.log(`     ${badge}`);
    }

    const passIdxs = validations.map((v, i) => v.pass ? i : -1).filter(i => i >= 0);
    if (passIdxs.length === 0) {
      console.log(`\n  ⚠ ALL FAILED → pending`);
      continue;
    }
    if (passIdxs.length === 1) {
      console.log(`\n  PICKED: #${passIdxs[0] + 1} (only pass)`);
      continue;
    }
    const passing = passIdxs.map(i => candidates[i]);
    try {
      const pick = await call(
        PICKER_PROMPT(passing.length),
        `Original misogynistic quote: "${q.quote}"\n\nCandidates:\n${passing.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\nWhich is best? Reply with ONLY the number.`,
        "claude-haiku-4-5-20251001", 10);
      const n = parseInt((pick.match(/\d+/) || ["1"])[0], 10);
      const origIdx = passIdxs[n - 1];
      console.log(`\n  PICKED: #${origIdx + 1} (from ${passing.length} passing)`);
    } catch { console.log(`\n  PICKED: (picker error)`); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
