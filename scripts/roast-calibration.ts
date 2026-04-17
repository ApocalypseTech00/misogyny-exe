import fs from "fs";
import path from "path";

/**
 * Self-improving roast calibration.
 *
 * Maintains a growing library of operator-approved roasts in
 * data/approved-roasts.json. The ROAST_PROMPT dynamically loads
 * the best examples as few-shot calibration — so the model gets
 * better at matching operator taste over time.
 *
 * Flow:
 *   1. Agent generates roast → TG approval
 *   2. Operator ✓ → addApproved(scrape, roast)
 *   3. Operator ✗ → addRejected(scrape, roast, reason?)
 *   4. Next generation: buildCalibrationBlock() picks diverse
 *      approved examples for the prompt
 *
 * The static bangers from Session 13 are seeded as the initial
 * approved set. New approvals accumulate over time.
 */

const APPROVED_PATH = path.join(__dirname, "..", "data", "approved-roasts.json");

export interface ApprovedRoast {
  scrape: string;
  roast: string;
  bucket: "punchy" | "medium" | "long";
  approvedAt: string;
  source: "manual" | "auto" | "seed";
}

interface ApprovedFile {
  version: number;
  approved: ApprovedRoast[];
  rejected: Array<{ scrape: string; roast: string; reason?: string; rejectedAt: string }>;
}

function load(): ApprovedFile {
  if (!fs.existsSync(APPROVED_PATH)) {
    // Seed with the Session 13 confirmed bangers
    const seeded: ApprovedFile = {
      version: 1,
      approved: SEED_BANGERS.map(b => ({
        scrape: b.scrape,
        roast: b.roast,
        bucket: bucketFor(b.scrape),
        approvedAt: "2026-04-17T00:00:00Z",
        source: "seed" as const,
      })),
      rejected: [],
    };
    save(seeded);
    return seeded;
  }
  return JSON.parse(fs.readFileSync(APPROVED_PATH, "utf-8"));
}

function save(file: ApprovedFile): void {
  const dir = path.dirname(APPROVED_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = APPROVED_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, APPROVED_PATH);
}

function bucketFor(q: string): "punchy" | "medium" | "long" {
  const w = q.trim().split(/\s+/).length;
  if (w <= 6) return "punchy";
  if (w <= 15) return "medium";
  return "long";
}

// --- Public API ---

export function addApproved(scrape: string, roast: string, source: "manual" | "auto" = "auto"): void {
  const file = load();
  // Don't dupe
  if (file.approved.some(a => a.roast === roast)) return;
  file.approved.push({
    scrape,
    roast,
    bucket: bucketFor(scrape),
    approvedAt: new Date().toISOString(),
    source,
  });
  save(file);
}

export function addRejected(scrape: string, roast: string, reason?: string): void {
  const file = load();
  file.rejected.push({
    scrape,
    roast,
    reason,
    rejectedAt: new Date().toISOString(),
  });
  save(file);
}

/**
 * Build the calibration block for ROAST_PROMPT.
 * Picks up to `maxExamples` approved roasts, stratified across buckets,
 * preferring diverse scrape topics. Returns a formatted string ready
 * to splice into the prompt.
 */
export function buildCalibrationBlock(maxExamples = 12): string {
  const file = load();
  const pool = [...file.approved];

  // Stratify: try to get ~equal representation per bucket
  const byBucket: Record<string, ApprovedRoast[]> = { punchy: [], medium: [], long: [] };
  for (const a of pool) byBucket[a.bucket].push(a);

  const perBucket = Math.max(2, Math.ceil(maxExamples / 3));
  const picked: ApprovedRoast[] = [];
  for (const bucket of ["punchy", "medium", "long"]) {
    const candidates = byBucket[bucket];
    // Take most recent first (newest approvals = freshest taste signal)
    const sorted = candidates.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
    picked.push(...sorted.slice(0, perBucket));
  }

  // Trim to max
  const final = picked.slice(0, maxExamples);

  if (final.length === 0) return "";

  const lines = final.map(a =>
    `- "${a.scrape.slice(0, 80)}${a.scrape.length > 80 ? "..." : ""}" → "${a.roast}"`
  );

  return `Target calibration (${final.length} operator-approved examples — match the DNA, never reuse the wording):\n${lines.join("\n")}`;
}

/**
 * Get stats for logging.
 */
export function getStats(): { approved: number; rejected: number; byBucket: Record<string, number> } {
  const file = load();
  const byBucket: Record<string, number> = { punchy: 0, medium: 0, long: 0 };
  for (const a of file.approved) byBucket[a.bucket]++;
  return { approved: file.approved.length, rejected: file.rejected.length, byBucket };
}

// --- Seed data (Session 13 confirmed bangers) ---

const SEED_BANGERS = [
  {
    scrape: "Beautiful people and horrible people shall inherit the world. They will always win. If you aren't beautiful, you have to be trash.",
    roast: "The man who built his entire philosophy around not being invited to prom.",
  },
  {
    scrape: "Women are property and therefore loot",
    roast: "A Viking fantasy from a man who has never, once in his life, been anyone's prize.",
  },
  {
    scrape: "She's on her 3rd day of her cycle hence why she's so angry, just ignore her",
    roast: "A clinical diagnosis offered by the demographic most represented on anger-management waitlists.",
  },
  {
    scrape: "wives should obey husbands",
    roast: "A coverture fantasy from a man who's spent his entire adult life being ignored by his own dog.",
  },
  {
    scrape: "Women have ruined the country and should not be allowed to vote.",
    roast: "Men ran the country alone into slavery, two world wars, and a Great Depression. She arrived five minutes ago and it's her fault.",
  },
  {
    scrape: "you are still not safe, and I can still exert power over you by treating you like an object",
    roast: "A power fantasy from a man whose last genuine victory was over a self-checkout machine.",
  },
  {
    scrape: "All I said was that women are inferior and now they won't date me",
    roast: "The entire mystery solved in one sentence, by the detective and the crime.",
  },
  {
    scrape: "Women should not be allowed to vote.",
    roast: "The last time men decided everything alone, they started two world wars. They appear to be working on the third.",
  },
  {
    scrape: "Women are meant to be raped",
    roast: "A worldview offered up by a man no woman has ever voluntarily stayed in the room with.",
  },
  {
    scrape: "Females are old enough to breed once they bleed through their peeholes.",
    roast: "That's not a belief. That's a pedophile announcing himself in public.",
  },
  {
    scrape: "Women exist for male use.",
    roast: "Remarkable theory from someone women clearly had no use for.",
  },
  {
    scrape: "Your ability to bear my heirs",
    roast: "The word \"my\" is doing a lot of heavy lifting for someone whose contribution to the process took eleven minutes, tops.",
  },
];
