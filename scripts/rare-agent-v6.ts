import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  scrape,
  loadCandidates,
  saveCandidates,
  hashQuote,
  computeQueueHmac,
} from "./scraper";
import type { Candidate, Queue, QueueItem } from "./scraper";
import { guard } from "./quote-guard";
import * as spendCap from "./spend-cap";
import * as tg from "./telegram";

dotenv.config();

/**
 * MISOGYNY.EXE V6 — Agent
 *
 * Per V6 spec §8.1, one 12h cycle does:
 *   1. Scrape Reddit
 *   2. Run the two-layer guard
 *   3. Generate 3 roast candidates per quote (Sonnet, parallel) + Haiku picker label
 *   4. Send Telegram DM with all 3 — operator taps 1 / 2 / 3 / Regenerate / Reject
 *   5. Poll TG callbacks from previous cycles and process them
 *   6. Fire 48h nag / 72h expiry for pending approvals
 *   7. Sunday weekly digest
 *
 * The mint script (rare-mint-v6.ts) runs 5 minutes after this, processes items
 * whose status is "approved".
 */

// -------------------------------------------------------
// Paths + config
// -------------------------------------------------------

const QUEUE_PATH = path.join(__dirname, "..", "data", "v6-mint-queue.json");
const LOG_PATH = path.join(__dirname, "..", "logs", "rare-agent-v6.log");
const DIGEST_STATE_PATH = path.join(__dirname, "..", "data", "agent-digest-state.json");
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const MIN_SCORE = parseInt(process.env.AGENT_MIN_SCORE || "80");
const DAILY_LIMIT = parseInt(process.env.AGENT_DAILY_LIMIT || "2");
const MAX_PENDING = parseInt(process.env.AGENT_MAX_PENDING || "10");
const MAX_PER_CYCLE = parseInt(process.env.AGENT_MAX_PER_CYCLE || "1");
const REGEN_CAP = 3;
const APPROVAL_NAG_H = 48;
const APPROVAL_EXPIRE_H = 72;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const DRY_RUN = process.env.AGENT_DRY_RUN === "true";

// -------------------------------------------------------
// Roast prompts (V6 spec §8.1 step 7)
// -------------------------------------------------------

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

// -------------------------------------------------------
// Logging
// -------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) {
        const rotated = LOG_PATH + ".1";
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(LOG_PATH, rotated);
      }
    } catch {}
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}

// Scrub any secrets that might show up in error messages
function scrubSecrets(s: string): string {
  return s
    .replace(/sk-ant-[\w-]+/g, "sk-ant-***")
    .replace(/eyJ[\w.-]+/g, "JWT-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}

// -------------------------------------------------------
// Queue I/O
// -------------------------------------------------------

function loadQueue(): Queue {
  if (!fs.existsSync(QUEUE_PATH)) return { items: [] };
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
}

function saveQueue(queue: Queue): void {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = QUEUE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
  fs.renameSync(tmp, QUEUE_PATH);
}

// -------------------------------------------------------
// Claude call (spend-capped)
// -------------------------------------------------------

async function callClaude(
  system: string,
  userMessage: string,
  model = "claude-sonnet-4-6",
  maxTokens = 120
): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  // Estimate cost before the call (gate)
  const estIn = Math.ceil((system.length + userMessage.length) / 4);
  spendCap.gate(model, estIn, maxTokens);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Claude API error (${res.status}): ${scrubSecrets(err.slice(0, 200))}`);
  }

  const data = (await res.json()) as any;
  const inTok = data.usage?.input_tokens ?? estIn;
  const outTok = data.usage?.output_tokens ?? 0;
  spendCap.record(model, inTok, outTok);

  return (data.content?.[0]?.text || "").trim();
}

// -------------------------------------------------------
// Roast generation
// -------------------------------------------------------

async function generateRoasts(quote: string): Promise<string[]> {
  log(`  generating 3 roast candidates (Sonnet)`);
  const userMsg = `Misogynistic quote: "${quote}"`;

  // Gate for ALL THREE parallel calls upfront — avoids the race where 3
  // `Promise.allSettled` children each pass their individual gate() but
  // collectively overshoot the daily cap.
  const estIn = Math.ceil((ROAST_PROMPT.length + userMsg.length) / 4);
  spendCap.gate("claude-sonnet-4-6", estIn * 3, 80 * 3);

  const settled = await Promise.allSettled([
    callClaude(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 80),
    callClaude(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 80),
    callClaude(ROAST_PROMPT, userMsg, "claude-sonnet-4-6", 80),
  ]);
  const candidates: string[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.length > 0 && s.value.length <= 200) {
      candidates.push(s.value);
    }
  }
  return candidates;
}

async function pickBestRoastIndex(originalQuote: string, roasts: string[]): Promise<number> {
  if (roasts.length <= 1) return 0;
  const pickerMsg =
    `Original misogynistic quote: "${originalQuote}"\n\n` +
    `Candidates:\n` +
    roasts.map((r, i) => `${i + 1}. ${r}`).join("\n") +
    `\n\nWhich is best? Reply with ONLY the number.`;
  try {
    const pick = await callClaude(
      PICKER_PROMPT(roasts.length),
      pickerMsg,
      "claude-haiku-4-5-20251001",
      10
    );
    const parsed = parseInt(pick.trim());
    if (parsed >= 1 && parsed <= roasts.length) return parsed - 1;
  } catch {
    // fall through
  }
  return 0;
}

// -------------------------------------------------------
// Telegram approval send / edit
// -------------------------------------------------------

function buildApprovalText(
  quote: string,
  score: number,
  source: string,
  roasts: string[],
  pickerIdx: number,
  regenCount: number
): string {
  const header = `MISOGYNY.EXE — approval needed`;
  const qLine = `Quote: "${quote.slice(0, 200)}"`;
  const meta = `Score: ${score} / Source: ${source}`;
  const roastLines = roasts
    .map((r, i) => `${i + 1}.${i === pickerIdx ? " ★" : ""} "${r}"`)
    .join("\n");
  const regen = regenCount > 0 ? `\n(regenerated ${regenCount}/${REGEN_CAP})` : "";
  const footer = `\n— ${spendCap.footer()}`;
  return [
    header,
    qLine,
    meta,
    "",
    "Roast (fires when it sells):",
    roastLines,
    regen,
    footer,
  ].join("\n");
}

function buildApprovalKeyboard(itemId: number, regenCount: number) {
  const pickRow = [1, 2, 3].map((n) => ({
    text: String(n),
    callback_data: `pick:${itemId}:${n}`,
  }));
  const controlRow: tg.InlineKeyboardButton[] = [];
  if (regenCount < REGEN_CAP) {
    controlRow.push({ text: "🔄 Regenerate", callback_data: `regen:${itemId}` });
  }
  controlRow.push({ text: "❌ Reject", callback_data: `reject:${itemId}` });
  return { inline_keyboard: [pickRow, controlRow] };
}

// -------------------------------------------------------
// Callback polling + processing
// -------------------------------------------------------

async function pollCallbacks(): Promise<void> {
  if (!tg.isConfigured()) {
    log("  TG not configured, skipping callback poll");
    return;
  }

  const updates = await tg.pollCallbacks();
  if (updates.length === 0) return;
  log(`  TG callbacks: ${updates.length} pending`);

  const queue = loadQueue();

  for (const u of updates) {
    const [kind, idStr, extra] = u.data.split(":");
    const itemId = parseInt(idStr);
    if (isNaN(itemId)) continue;

    const item = queue.items.find((i) => i.id === itemId);
    if (!item) {
      await tg.answerCallbackQuery(u.callbackQueryId, "Item not found");
      continue;
    }

    // Parse candidate roasts from the attached roast triplet. We stored them as
    // item.roast (the winner) once approved — but for regen we need to replay.
    // Simpler model: store all candidates on the item temporarily.
    const roasts: string[] = (item as any).roastCandidates || [];

    if (kind === "pick") {
      const pickN = parseInt(extra || "0");
      if (pickN >= 1 && pickN <= 3 && roasts[pickN - 1]) {
        item.roast = roasts[pickN - 1];
        item.status = "approved";
        item.approvedAt = new Date().toISOString();
        delete (item as any).roastCandidates;
        item.hmac = computeQueueHmac(item);
        saveQueue(queue);
        await tg.editMessageText(
          u.messageId,
          `✅ Approved (#${pickN}):\n"${item.roast}"\n\nWill fire on sale of MISOGYNY.EXE #${itemId}.`
        );
        await tg.answerCallbackQuery(u.callbackQueryId, "Approved");
        log(`  #${itemId} approved with roast ${pickN}: "${item.roast?.slice(0, 60)}..."`);
      }
    } else if (kind === "regen") {
      if ((item.regenCount || 0) >= REGEN_CAP) {
        await tg.answerCallbackQuery(u.callbackQueryId, `Regen cap (${REGEN_CAP}) reached`);
        continue;
      }
      try {
        const newRoasts = await generateRoasts(item.quote);
        if (newRoasts.length === 0) {
          await tg.answerCallbackQuery(u.callbackQueryId, "Regen failed");
          continue;
        }
        const pickerIdx = await pickBestRoastIndex(item.quote, newRoasts);
        (item as any).roastCandidates = newRoasts;
        item.regenCount = (item.regenCount || 0) + 1;
        saveQueue(queue);
        await tg.editMessageText(
          u.messageId,
          buildApprovalText(
            item.quote,
            0, // score metadata not re-derived; show 0 in regen
            item.source || "",
            newRoasts,
            pickerIdx,
            item.regenCount
          ),
          { replyMarkup: buildApprovalKeyboard(itemId, item.regenCount) }
        );
        await tg.answerCallbackQuery(u.callbackQueryId, "Regenerated");
        log(`  #${itemId} regenerated (${item.regenCount}/${REGEN_CAP})`);
      } catch (err: any) {
        await tg.answerCallbackQuery(u.callbackQueryId, `Regen error: ${scrubSecrets(err.message).slice(0, 60)}`);
      }
    } else if (kind === "reject") {
      item.status = "rejected";
      saveQueue(queue);
      await tg.editMessageText(u.messageId, `❌ Rejected: "${item.quote.slice(0, 100)}"`);
      await tg.answerCallbackQuery(u.callbackQueryId, "Rejected");
      log(`  #${itemId} rejected`);
    }
  }
}

// -------------------------------------------------------
// Nag / expiry
// -------------------------------------------------------

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (3600 * 1000);
}

async function nagAndExpire(): Promise<void> {
  if (!tg.isConfigured()) return;
  const queue = loadQueue();
  let touched = false;

  for (const item of queue.items) {
    if (item.status !== "awaiting_approval") continue;
    if (!item.approvalSentAt) continue;
    const hours = hoursSince(item.approvalSentAt);

    if (hours >= APPROVAL_EXPIRE_H) {
      item.status = "expired";
      touched = true;
      try {
        await tg.sendMessage(`⏳ Expired after ${APPROVAL_EXPIRE_H}h: "${item.quote.slice(0, 100)}"`);
      } catch {}
      log(`  #${item.id} expired`);
    } else if (hours >= APPROVAL_NAG_H && !(item as any).nagged) {
      (item as any).nagged = true;
      touched = true;
      try {
        await tg.sendMessage(
          `⏰ Reminder: approval pending for MISOGYNY.EXE candidate #${item.id} — expires in ${Math.round(APPROVAL_EXPIRE_H - hours)}h.`
        );
      } catch {}
      log(`  #${item.id} nag sent`);
    }
  }

  if (touched) saveQueue(queue);
}

// -------------------------------------------------------
// Weekly digest (Sunday 18:00 local, once per week)
// -------------------------------------------------------

function loadDigestState(): { lastSentISO?: string } {
  if (!fs.existsSync(DIGEST_STATE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(DIGEST_STATE_PATH, "utf-8")); } catch { return {}; }
}

function saveDigestState(s: { lastSentISO?: string }): void {
  const dir = path.dirname(DIGEST_STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DIGEST_STATE_PATH, JSON.stringify(s, null, 2));
}

async function maybeWeeklyDigest(): Promise<void> {
  if (!tg.isConfigured()) return;
  const now = new Date();
  if (now.getDay() !== 0) return; // only on Sundays
  if (now.getHours() < 18) return; // only after 18:00

  const state = loadDigestState();
  if (state.lastSentISO && hoursSince(state.lastSentISO) < 24 * 6) return;

  const queue = loadQueue();
  const counts = {
    awaiting: queue.items.filter((i) => i.status === "awaiting_approval").length,
    expired7d: queue.items.filter((i) => i.status === "expired").length,
    approved: queue.items.filter((i) => i.status === "approved").length,
    done: queue.items.filter((i) => i.status === "done").length,
  };

  const text = [
    `MISOGYNY.EXE — weekly digest`,
    ``,
    `Awaiting approval: ${counts.awaiting}`,
    `Expired (lifetime): ${counts.expired7d}`,
    `Approved (lifetime): ${counts.approved}`,
    `Minted (lifetime): ${counts.done}`,
    ``,
    spendCap.footer(),
  ].join("\n");

  try {
    await tg.sendMessage(text);
    saveDigestState({ lastSentISO: new Date().toISOString() });
    log("  weekly digest sent");
  } catch (err: any) {
    log(`  weekly digest failed: ${scrubSecrets(err.message).slice(0, 200)}`);
  }
}

// -------------------------------------------------------
// Promote: scrape + guard + roast + TG send
// -------------------------------------------------------

async function promoteNewCandidates(): Promise<{ promoted: number; blocked: number }> {
  const candidatesFile = loadCandidates();
  const queue = loadQueue();

  const pendingCount = queue.items.filter((i) =>
    ["awaiting_approval", "approved", "uploading", "minting", "registering", "listing"].includes(i.status)
  ).length;
  if (pendingCount >= MAX_PENDING) {
    log(`  queue has ${pendingCount} pending (cap ${MAX_PENDING}) — skipping promotion`);
    return { promoted: 0, blocked: 0 };
  }

  // Daily rate limit on NEW approval DMs. Resets at midnight UTC. If operator
  // takes days to approve, old items stay "awaiting_approval" — counted in
  // pendingCount (MAX_PENDING) above, not here. Here we only count approvals
  // sent today to avoid flooding the operator's chat with more than N/day.
  const today = new Date().toISOString().slice(0, 10);
  const promotedToday = queue.items.filter((i) =>
    i.approvalSentAt && i.approvalSentAt.slice(0, 10) === today
  ).length;
  if (promotedToday >= DAILY_LIMIT) {
    log(`  daily approval-send limit reached (${promotedToday}/${DAILY_LIMIT}) — skipping`);
    return { promoted: 0, blocked: 0 };
  }

  const slots = Math.min(MAX_PER_CYCLE, MAX_PENDING - pendingCount, DAILY_LIMIT - promotedToday);

  const qualifying = candidatesFile.candidates
    .filter((c) => !c.approved && !c.rejected && !c.aiLegalRisk && c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, slots * 2);

  if (qualifying.length === 0) {
    log("  no qualifying candidates");
    return { promoted: 0, blocked: 0 };
  }

  const queueHashes = new Set(queue.items.map((i) => hashQuote(i.quote)));
  let nextId = queue.items.length > 0 ? Math.max(...queue.items.map((i) => i.id)) + 1 : 1;

  let promoted = 0;
  let blocked = 0;

  for (const candidate of qualifying) {
    if (promoted >= slots) break;
    const h = hashQuote(candidate.quote);
    if (queueHashes.has(h)) {
      candidate.approved = true;
      continue;
    }

    log(`  checking: "${candidate.quote.slice(0, 50)}..."`);
    const g = await guard(candidate.quote, ANTHROPIC_API_KEY);
    if (!g.passed) {
      log(`  BLOCKED [${g.stage}]: ${g.reason}`);
      candidate.rejected = true;
      blocked++;
      continue;
    }

    // Generate roasts
    let roasts: string[];
    let pickerIdx: number;
    try {
      roasts = await generateRoasts(g.cleaned);
      if (roasts.length === 0) {
        log("  roast generation returned 0 candidates — skipping");
        continue;
      }
      pickerIdx = await pickBestRoastIndex(g.cleaned, roasts);
    } catch (err: any) {
      log(`  roast generation failed: ${scrubSecrets(err.message).slice(0, 200)}`);
      continue;
    }

    const newItem: QueueItem = {
      id: nextId,
      quote: g.cleaned,
      attribution: "Anonymous",
      source: candidate.source,
      artworkPath: `./data/artworks/piece-${nextId}.svg`,
      listPrice: process.env.RARE_STARTING_PRICE || "0.01",
      status: "awaiting_approval",
      regenCount: 0,
      hmac: "",
    };
    (newItem as any).roastCandidates = roasts;
    newItem.hmac = computeQueueHmac(newItem);

    if (DRY_RUN) {
      log(`  [DRY] would send TG for #${nextId}`);
      log(`     roast#${pickerIdx + 1}★: "${roasts[pickerIdx]}"`);
      promoted++;
      nextId++;
      continue;
    }

    if (!tg.isConfigured()) {
      log(`  TG not configured — cannot send approval. Item #${nextId} remains un-promoted.`);
      continue;
    }

    try {
      const messageId = await tg.sendMessage(
        buildApprovalText(
          g.cleaned,
          candidate.score,
          candidate.source,
          roasts,
          pickerIdx,
          0
        ),
        { replyMarkup: buildApprovalKeyboard(nextId, 0) }
      );
      newItem.approvalMessageId = messageId;
      newItem.approvalSentAt = new Date().toISOString();
    } catch (err: any) {
      log(`  TG send failed: ${scrubSecrets(err.message).slice(0, 200)} — skipping`);
      continue;
    }

    queue.items.push(newItem);
    candidate.approved = true;
    queueHashes.add(h);
    promoted++;
    log(`  queued #${nextId} (awaiting approval)`);
    nextId++;
  }

  saveQueue(queue);
  saveCandidates(candidatesFile);
  return { promoted, blocked };
}

// -------------------------------------------------------
// Main cycle
// -------------------------------------------------------

async function cycle(): Promise<void> {
  log("");
  log("=".repeat(60));
  log(`CYCLE — ${new Date().toISOString()}`);
  log("=".repeat(60));

  // Preflight: spend cap must be configured correctly
  log(`Anthropic spend: $${spendCap.spentToday().toFixed(2)} / $${spendCap.cap().toFixed(2)} today`);

  // 1. Scrape + persist new candidates
  log("\n[1/5] scraping Reddit");
  try {
    const newCandidates = await scrape();
    const existing = loadCandidates();
    const existingIds = new Set(existing.candidates.map((c) => c.id));
    let added = 0;
    for (const c of newCandidates) {
      if (!existingIds.has(c.id)) {
        existing.candidates.push(c);
        added++;
      }
    }
    existing.lastScrape = new Date().toISOString();
    existing.totalScraped += newCandidates.length;
    existing.candidates.sort((a, b) => b.score - a.score);
    saveCandidates(existing);
    log(`  ${newCandidates.length} found, ${added} new`);
  } catch (err: any) {
    log(`  scrape failed: ${scrubSecrets(err.message).slice(0, 200)}`);
  }

  // 2. Poll TG callbacks from prior cycles (approve/regen/reject)
  log("\n[2/5] polling Telegram callbacks");
  try {
    await pollCallbacks();
  } catch (err: any) {
    log(`  poll failed: ${scrubSecrets(err.message).slice(0, 200)}`);
  }

  // 3. Fire nag / expiry on pending approvals
  log("\n[3/5] nag + expiry checks");
  try {
    await nagAndExpire();
  } catch (err: any) {
    log(`  nag/expiry failed: ${scrubSecrets(err.message).slice(0, 200)}`);
  }

  // 4. Promote new candidates to TG approval
  log("\n[4/5] promoting new candidates");
  try {
    const { promoted, blocked } = await promoteNewCandidates();
    log(`  promoted ${promoted}, blocked ${blocked}`);
  } catch (err: any) {
    log(`  promote failed: ${scrubSecrets(err.message).slice(0, 200)}`);
  }

  // 5. Weekly digest (Sunday 18:00)
  log("\n[5/5] weekly digest check");
  try {
    await maybeWeeklyDigest();
  } catch (err: any) {
    log(`  digest failed: ${scrubSecrets(err.message).slice(0, 200)}`);
  }
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

async function main() {
  log("#".repeat(60));
  log("  MISOGYNY.EXE V6 — Agent");
  log("#".repeat(60));
  log(`  min score:   ${MIN_SCORE}`);
  log(`  per cycle:   ${MAX_PER_CYCLE}`);
  log(`  daily limit: ${DAILY_LIMIT}`);
  log(`  pending cap: ${MAX_PENDING}`);
  log(`  TG:          ${tg.isConfigured() ? "configured" : "NOT CONFIGURED"}`);
  log(`  dry run:     ${DRY_RUN}`);

  await cycle();

  log("agent done.");
}

main().catch((err) => {
  log(`FATAL: ${scrubSecrets(err.message)}`);
  console.error(err);
  process.exitCode = 1;
});
