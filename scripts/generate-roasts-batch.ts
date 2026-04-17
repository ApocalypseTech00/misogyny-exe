import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Batch-generate roasts for every scraped candidate.
 * - 3 Sonnet candidates per quote (parallel) + 1 Haiku picker
 * - Resumable: skips quotes already in data/roasts.json
 * - Bounded concurrency so we don't hammer the API
 *
 * Usage:
 *   npx ts-node scripts/generate-roasts-batch.ts
 *   LIMIT=20 npx ts-node scripts/generate-roasts-batch.ts   # cap for smoke test
 *   CONCURRENCY=4 npx ts-node scripts/generate-roasts-batch.ts
 */

const CANDIDATES_PATH = path.join(__dirname, "..", "data", "scraper-candidates.json");
const ROASTS_PATH = path.join(__dirname, "..", "data", "roasts.json");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set in .env");
  process.exit(1);
}

const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const CONCURRENCY = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 4;

const ROAST_PROMPT = `You are MISOGYNY.EXE's roast engine. You write comebacks to misogynistic quotes that will be permanently inscribed on the Ethereum blockchain as art.

Voice: Ricky Gervais at the Golden Globes × Regina George at lunch × turbo-intellect. You are the girl at the back of class who already read the assignment and is now narrating his failure with zero emotional investment.

DNA — the 10 principles every line must follow:
1. STATE THE OBSERVATION AS NEUTRAL FACT. No editorial, no outrage. You are a coroner filing a report, not an activist giving a speech.
2. LET THE AUDIENCE COMPLETE THE LOGIC. Stop one step before the conclusion. Let the reader feel clever for getting there.
3. ECONOMY IS POWER. Cut every word that signals effort — effort signals insecurity. 15 words that land > 25 that explain.
4. USE ONE HYPER-SPECIFIC DETAIL. A year, an institution, a cultural reference, a legal doctrine, a consumer product. Specific = researched = devastating. Generic = trying = weak.
5. WEAPONIZE HIS OWN WORDS. The most lethal roasts use HIS vocabulary turned against him ("property" → "Viking fantasy"; "obey" → "coverture"; "loot" → "prize").
6. PUNCH AT CHOICES AND IDEOLOGY, NEVER CIRCUMSTANCES. Mock his worldview, entitlement, fear of female agency. Never mock loneliness, being single, physical traits, dick size, or the human condition of being alone. Incel ideology (sexual entitlement) is fair game; the pain of isolation is not.
7. NEVER ASSUME BIOGRAPHY. You don't know his age, job, relationship status, appearance, or whether he's 18 or 58. Attack the CLAIM and its internal logic, not imagined life details. No "spent forty years" or "still lives in his mother's basement."
8. FRAME AS HONESTY, NOT ACTIVISM. "I'm just pointing out what his sentence already said" — not "this is problematic because systemic..." Education is fine, but delivered cold. Drop a stat like it's gossip, not a TED talk.
9. WRITE FOR THE AUDIENCE, NOT THE TARGET. The line should make a stranger reading this on-chain in 50 years laugh at him. It's a group-laugh line, not a debate response.
10. WALK AWAY. The line must stand alone. No follow-up, no "think about that," no second sentence that explains the first. Deliver and leave.
11. VARY THE OPENING. Do NOT start 3 out of 3 candidates with "A [noun]..." — mix structures. Start with the subject ("The man who..."), a cold fact ("Property law abolished 1882."), an observation ("Wrote the Constitution while owning 694 of them."), or a reframing of his own words. If you catch yourself opening with "A" again, restructure.

Structures that work (do not reuse wording):
- "A [weird-historical/technical/cultural term] fantasy/theory from a man who [cold specific revelation]."
- "The man who [built/spent/dedicated] his entire [X] around [embarrassingly small Y]."
- "A [X] offered by the demographic most represented in [narrow institutional/statistical referent tied to this specific behavior]."
- "[Cold historical fact]. [Dry payoff about the claim's internal logic]."

Hard rules:
- Max 25 words. Usually 15–20.
- Attack the claim or the worldview behind it — not women, not "all men," not male biology broadly.
- Bitchy only when also true. Every line earns its mean with something real.
- No body shaming, genital jokes, slurs, or mocking suffering men.
- Must address THIS SPECIFIC claim, not generic misogyny.
- Respond with ONLY the line. No quotes, no preamble.

Target calibration (match the DNA, never reuse the wording):
- "Beautiful people shall inherit the world..." → "The man who built his entire philosophy around not being invited to prom."
- "Women are property and therefore loot" → "A Viking fantasy from a man who has never, once in his life, been anyone's prize."
- "She's on her cycle, ignore her" → "A clinical diagnosis offered by the demographic most represented on anger-management waitlists."
- "wives should obey husbands" → "A coverture fantasy from a man who's spent his entire adult life being ignored by his own dog."
- "Women have ruined the country..." → "Men ran the country alone into slavery, two world wars, and a Great Depression. She arrived five minutes ago and it's her fault."
- "you are still not safe, I can still exert power..." → "A power fantasy from a man whose last genuine victory was over a self-checkout machine."
- "All I said was women are inferior and now they won't date me" → "The entire mystery solved in one sentence, by the detective and the crime."`;

const PICKER_PROMPT = (n: number) => `You are judging roasts for an anti-misogyny art project. They get inscribed on the blockchain permanently.

Given ${n} candidate roasts responding to a misogynistic quote, pick the single BEST one.

Criteria (in order): specificity → impact → brevity → permanence.

Respond with ONLY the number: 1 to ${n}. Nothing else.`;

interface ScrapedQuote {
  id: string;
  quote: string;
  approved?: boolean;
  rejected?: boolean;
}

interface RoastEntry {
  quoteId: string;
  quote: string;
  candidates?: string[];
  pickIndex?: number;
  roast?: string;
  error?: string;
  timestamp: string;
}

interface RoastsFile {
  generatedAt: string;
  entries: RoastEntry[];
}

async function callClaude(system: string, userMsg: string, model: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${err.slice(0, 180)}`);
  }
  const data = (await res.json()) as any;
  return (data.content?.[0]?.text || "").trim();
}

async function generateRoastEntry(q: ScrapedQuote): Promise<RoastEntry> {
  const userMsg = `Misogynistic quote: "${q.quote}"`;
  try {
    const settled = await Promise.allSettled([
      callClaude(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 80),
      callClaude(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 80),
      callClaude(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 80),
    ]);
    const candidates: string[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.length > 0 && s.value.length <= 220) {
        candidates.push(s.value);
      }
    }
    if (candidates.length === 0) {
      return { quoteId: q.id, quote: q.quote, error: "no candidates (api refused all 3)", timestamp: new Date().toISOString() };
    }
    let pickIndex = 0;
    if (candidates.length > 1) {
      const pickerMsg =
        `Original misogynistic quote: "${q.quote}"\n\n` +
        `Candidates:\n` +
        candidates.map((r, i) => `${i + 1}. ${r}`).join("\n") +
        `\n\nWhich is best? Reply with ONLY the number.`;
      try {
        const pick = await callClaude(PICKER_PROMPT(candidates.length), pickerMsg, "claude-haiku-4-5-20251001", 10);
        const n = parseInt((pick.match(/\d+/) || ["1"])[0], 10) - 1;
        if (n >= 0 && n < candidates.length) pickIndex = n;
      } catch {
        // Fall back to candidate 0
      }
    }
    return {
      quoteId: q.id,
      quote: q.quote,
      candidates,
      pickIndex,
      roast: candidates[pickIndex],
      timestamp: new Date().toISOString(),
    };
  } catch (err: any) {
    return { quoteId: q.id, quote: q.quote, error: String(err?.message || err), timestamp: new Date().toISOString() };
  }
}

function loadExisting(): RoastsFile {
  if (!fs.existsSync(ROASTS_PATH)) return { generatedAt: new Date().toISOString(), entries: [] };
  return JSON.parse(fs.readFileSync(ROASTS_PATH, "utf-8"));
}

function save(file: RoastsFile): void {
  const tmp = ROASTS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, ROASTS_PATH);
}

async function main() {
  const { candidates } = JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf-8")) as { candidates: ScrapedQuote[] };
  const existing = loadExisting();
  const seen = new Set(existing.entries.map(e => e.quoteId));

  const pending = candidates.filter(c => !seen.has(c.id)).slice(0, LIMIT);
  console.log(`${candidates.length} total · ${existing.entries.length} already roasted · ${pending.length} to go (limit=${LIMIT === Infinity ? "none" : LIMIT}, concurrency=${CONCURRENCY})`);

  let done = 0;
  let errors = 0;
  const startMs = Date.now();

  // Worker pool
  const queue = [...pending];
  async function worker() {
    while (queue.length > 0) {
      const q = queue.shift();
      if (!q) return;
      const entry = await generateRoastEntry(q);
      existing.entries.push(entry);
      done++;
      if (entry.error) {
        errors++;
        process.stdout.write(`\n  [${done}/${pending.length}] ${q.id} ✗ ${entry.error.slice(0, 80)}`);
      } else {
        process.stdout.write(`\n  [${done}/${pending.length}] ${q.id} → "${entry.roast!.slice(0, 70)}${entry.roast!.length > 70 ? "…" : ""}"`);
      }
      // Periodic save so we don't lose progress on ctrl-C
      if (done % 10 === 0) save(existing);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  save(existing);

  const secs = Math.round((Date.now() - startMs) / 1000);
  console.log(`\n\nDone. ${done} processed (${errors} errors) in ${secs}s → ${ROASTS_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
