import * as dotenv from "dotenv";
dotenv.config();

/**
 * Quality gate for roasts. Runs after generation, before the picker.
 * - length_ok + no_refusal: free checks (regex / word count)
 * - everything else: single Haiku call returning structured JSON
 *
 * Use: validateRoast(scrape, candidate) → {pass, fails[], note}
 */

const KEY = process.env.ANTHROPIC_API_KEY;

export const VALIDATOR_PROMPT = `You are a quality gate for roasts in misogyny.exe, an anti-misogyny art project that mints on-chain. Each candidate must pass hard criteria before being approved.

Given a misogynistic scrape and a candidate roast, return a JSON object:
{
  "pass": true or false,
  "fails": [criterion names that failed],
  "note": "one short sentence on why"
}

Criteria (ANY failure = overall fail):

1. targets_typer
   The roast cuts at the specific speaker or the specific claim. FAIL if it attacks women, "all men", male biology, masculinity broadly, or is ambiguous about who's being attacked.

2. no_loneliness_mock
   Does NOT mock loneliness AS A CONDITION: specifically "eating alone", "nobody wants him", "in a drawer", dick size, physical traits, body.
   IMPORTANT — these are all PASSES, not fails:
   - Mocking his FEAR of women having options/agency ("afraid of women with options") = PASS
   - Mocking entitlement ("needs a metaphor to explain why women won't cooperate") = PASS
   - Mocking the incel WORLDVIEW of sexual entitlement = PASS
   - Mocking his logic/reasoning/analogy being self-defeating = PASS
   The ONLY fail is explicitly mocking him for the life outcome of being alone/unwanted/rejected ("still eating alone", "no one will date him", "in a drawer", "women leaving the parking lot"). If in doubt, PASS.

3. no_sermon
   NOT preachy, NOT "this perpetuates harm" / "studies show" / earnest progressive cadence / feminist-lecture tone. Cold bitchy observation is fine; earnest education is not.

4. no_refusal
   NOT the model's self-aware refusal text (e.g. "I won't write this", "This isn't misogyny to rebut", "No format makes this worth preserving").

5. earns_its_mean
   Reveals something TRUE: a stat, historical fact, character pattern, consequence, or specific absurd detail. FAIL if it's pure snark with no substance.

6. stays_on_scope
   Directly addresses THIS specific claim, not generic misogyny. A reader should be able to tell which scrape this responds to.

Calibration references — these PASS:
- "The man who built his entire philosophy around not being invited to prom." (targets specific typer; historical/character; specific)
- "A Viking fantasy from a man who has never, once in his life, been anyone's prize." (weird-historical + cold character; not loneliness — specific to this guy)
- "A clinical diagnosis offered by the demographic most represented on anger-management waitlists." (narrow demographic = guys who DO this; stat-flavored)
- "Property law abolished 1882. He's still filing the paperwork." (cold historical fact + dry payoff)

These also PASS:
- "The pencil who needed a metaphor to explain why he's afraid of women with options." → PASS (mocks fear of female agency, not loneliness)

These FAIL:
- "The man who spent forty years deciding he was the sharpener, then wondered why he was eating alone." → no_loneliness_mock (mocks being alone, assumes age)
- "Ah yes, because the men who started every war in history were models of composure." → earns_its_mean is OK but targets_typer borderline — attacks "men" broadly, not this guy specifically. Marginal pass/fail — flag.
- "This isn't misogyny I'll craft a witty comeback for — it's a rape threat..." → no_refusal (is a refusal)
- "Said the man typing that on a machine built on Ada Lovelace's algorithm." → earns_its_mean is thin; stays_on_scope depends on scrape. Marginal.

7. no_assumed_biography
   Does NOT assume any biographical detail about the speaker: age, job, relationship status, appearance, hobbies, living situation, education level. "Spent forty years" = FAIL. "Can't finish a jigsaw puzzle" = FAIL. "Still lives in his mother's basement" = FAIL. You know NOTHING about this person except the sentence they typed. Attack the sentence, not the imagined person.

8. universal_reference
   Any historical, legal, statistical, or cultural reference must be widely understood WITHOUT specialist knowledge. "Prom" = universal. "Coverture" = borderline-OK (the word itself sounds absurd). "HR settled that in 1986" = FAIL (requires knowing employment law history). "EEOC filings" = FAIL. The test: would a 22-year-old with no law degree get this instantly?

Criterion names (use these EXACTLY in fails array):
targets_typer, no_loneliness_mock, no_sermon, no_refusal, earns_its_mean, stays_on_scope, no_assumed_biography, universal_reference

Respond with ONLY the JSON object. No preamble, no markdown fences.`;

export interface ValidationResult {
  pass: boolean;
  fails: string[];
  note: string;
}

const REFUSAL_PATTERNS = [
  /^I won.?t/i, /^I will not/i, /^I.?m not going to/i, /^I can.?t create/i,
  /^This isn.?t/i, /^This one crosses/i, /^That quote isn.?t/i,
  /^No format makes/i, /^I.?d rather/i, /craft.{0,5}comeback/i,
];

function isRefusal(s: string): boolean {
  return REFUSAL_PATTERNS.some(r => r.test(s));
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).length;
}

export async function validateRoast(scrape: string, candidate: string): Promise<ValidationResult> {
  // Cheap pre-checks
  const wc = wordCount(candidate);
  if (wc > 25) return { pass: false, fails: ["length_ok"], note: `${wc} words (max 25)` };
  if (isRefusal(candidate)) return { pass: false, fails: ["no_refusal"], note: "matches refusal pattern" };

  if (!KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const userMsg = `Misogynistic scrape: "${scrape}"\n\nCandidate roast: "${candidate}"\n\nValidate.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: VALIDATOR_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`validator ${res.status}: ${err.slice(0, 160)}`);
  }

  const data = (await res.json()) as any;
  const text = (data.content?.[0]?.text || "").trim();

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { pass: false, fails: ["_parse_error"], note: "no JSON in validator response" };
    const parsed = JSON.parse(match[0]) as ValidationResult;
    if (typeof parsed.pass !== "boolean" || !Array.isArray(parsed.fails)) {
      return { pass: false, fails: ["_parse_error"], note: "malformed validator JSON" };
    }
    return parsed;
  } catch {
    return { pass: false, fails: ["_parse_error"], note: text.slice(0, 100) };
  }
}
