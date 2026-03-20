import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * MISOGYNY.EXE — Rare Protocol Autonomous Agent
 *
 * Same pipeline as autonomous-agent.ts but uses Rare Protocol CLI
 * for minting and auctions instead of Hardhat.
 *
 * For SuperRare Partner Track (EF Synthesis Hackathon).
 *
 * Usage:
 *   npm run rare:agent                  # Run on Sepolia (default)
 *   npm run rare:agent:dry              # Dry run
 *   npm run rare:agent:once             # Single cycle
 *
 * Uses same env vars as autonomous-agent.ts plus:
 *   RARE_CONTRACT_ADDRESS   — Deployed Rare Protocol ERC-721 contract
 *   RARE_CHAIN              — sepolia or mainnet (default: sepolia)
 *   RARE_AUCTION_DURATION   — Auction duration in seconds (default: 86400)
 *   RARE_STARTING_PRICE     — Starting price in ETH (default: 0.01)
 */

import {
  scrape,
  loadCandidates,
  saveCandidates,
  hashQuote,
  computeQueueHmac,
} from "./scraper";
import type { Candidate, Queue } from "./scraper";
import { guard } from "./quote-guard";

const RARE_QUEUE_PATH = path.join(__dirname, "..", "data", "rare-mint-queue.json");

function loadQueue(): Queue {
  if (!fs.existsSync(RARE_QUEUE_PATH)) return { items: [] };
  return JSON.parse(fs.readFileSync(RARE_QUEUE_PATH, "utf-8"));
}

function saveQueue(queue: Queue) {
  const dir = path.dirname(RARE_QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RARE_QUEUE_PATH, JSON.stringify(queue, null, 2));
}

// --- Config (same as autonomous-agent.ts) ---

const INTERVAL_MIN = parseInt(process.env.AGENT_INTERVAL || "720");
const MIN_SCORE = parseInt(process.env.AGENT_MIN_SCORE || "90");
const MAX_PER_CYCLE = parseInt(process.env.AGENT_MAX_PER_CYCLE || "1");
const DAILY_LIMIT = parseInt(process.env.AGENT_DAILY_LIMIT || "2");
const DRY_RUN = process.env.AGENT_DRY_RUN === "true";
const ONCE = process.env.AGENT_ONCE === "true";
const MAX_PENDING_QUEUE = parseInt(process.env.AGENT_MAX_PENDING || "10");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const LOG_PATH = path.join(__dirname, "..", "logs", "rare-agent.log");
const STATE_PATH = path.join(__dirname, "..", "data", "rare-agent-state.json");
const ROOT = path.join(__dirname, "..");

let cycleCount = 0;
let totalMinted = 0;
let totalScraped = 0;
let totalPromoted = 0;
let totalBlocked = 0;
const startedAt = new Date();

// --- Logging ---

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Daily mint tracking ---

interface AgentState {
  dailyMints: Record<string, number>;
}

function loadState(): AgentState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { dailyMints: {} };
  }
}

function saveState(state: AgentState) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getDailyMintCount(): number {
  const today = new Date().toISOString().slice(0, 10);
  return loadState().dailyMints[today] || 0;
}

function incrementDailyMint(count: number) {
  const today = new Date().toISOString().slice(0, 10);
  const state = loadState();
  state.dailyMints[today] = (state.dailyMints[today] || 0) + count;
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(state.dailyMints)) {
    if (d < cutoff) delete state.dailyMints[d];
  }
  saveState(state);
}

// --- Auto-promote with security guard (same logic as autonomous-agent.ts) ---

async function autoPromote(): Promise<{ promoted: number; blocked: number }> {
  const candidatesFile = loadCandidates();
  const queue = loadQueue();

  const pendingCount = queue.items.filter(
    (i) => i.status !== "done" && i.status !== "failed"
  ).length;

  if (pendingCount >= MAX_PENDING_QUEUE) {
    log(`  Queue has ${pendingCount} pending (max ${MAX_PENDING_QUEUE}) — skipping`);
    return { promoted: 0, blocked: 0 };
  }

  const dailyCount = getDailyMintCount();
  if (dailyCount >= DAILY_LIMIT) {
    log(`  Daily limit reached (${dailyCount}/${DAILY_LIMIT}) — skipping`);
    return { promoted: 0, blocked: 0 };
  }

  const slotsAvailable = Math.min(
    MAX_PER_CYCLE,
    MAX_PENDING_QUEUE - pendingCount,
    DAILY_LIMIT - dailyCount
  );

  const qualifying = candidatesFile.candidates
    .filter((c) =>
      !c.approved &&
      !c.rejected &&
      !c.aiLegalRisk &&
      c.score >= MIN_SCORE
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, slotsAvailable * 2);

  if (qualifying.length === 0) {
    log("  No qualifying candidates (score >= " + MIN_SCORE + ", anonymous)");
    return { promoted: 0, blocked: 0 };
  }

  const queueHashes = new Set(queue.items.map((i) => hashQuote(i.quote)));
  let nextId = queue.items.length > 0
    ? Math.max(...queue.items.map((i) => i.id)) + 1
    : 1;

  let promoted = 0;
  let blocked = 0;

  for (const candidate of qualifying) {
    if (promoted >= slotsAvailable) break;

    const h = hashQuote(candidate.quote);
    if (queueHashes.has(h)) {
      candidate.approved = true;
      continue;
    }

    log(`  Checking: "${candidate.quote.slice(0, 50)}..."`);
    const guardResult = await guard(candidate.quote, ANTHROPIC_API_KEY);

    if (!guardResult.passed) {
      log(`  BLOCKED [${guardResult.stage}]: ${guardResult.reason}`);
      candidate.rejected = true;
      blocked++;
      continue;
    }

    if (DRY_RUN) {
      log(`  [DRY] Would promote: "${guardResult.cleaned.slice(0, 60)}..." (score: ${candidate.score})`);
      promoted++;
      continue;
    }

    const LIST_PRICE = process.env.RARE_STARTING_PRICE || "0.01";
    const newItem = {
      id: nextId,
      quote: guardResult.cleaned,
      attribution: "Anonymous",
      source: candidate.source,
      artworkPath: `./data/artworks/piece-${nextId}.svg`,
      listPrice: LIST_PRICE,
      status: "pending" as const,
      hmac: "",
    };
    newItem.hmac = computeQueueHmac(newItem);
    queue.items.push(newItem);

    candidate.approved = true;
    queueHashes.add(h);
    promoted++;
    log(`  Queued #${nextId}: "${guardResult.cleaned.slice(0, 60)}..." (score: ${candidate.score})`);
    nextId++;
  }

  if (!DRY_RUN && (promoted > 0 || blocked > 0)) {
    saveQueue(queue);
    saveCandidates(candidatesFile);
    if (promoted > 0) incrementDailyMint(promoted);
  }

  return { promoted, blocked };
}

// --- Trigger Rare Protocol minter ---

function runMinter(): boolean {
  if (DRY_RUN) {
    log("  [DRY] Would run rare-mint");
    return true;
  }

  try {
    log("  Running rare-mint...");
    const output = execSync(
      `npx ts-node scripts/rare-mint.ts`,
      {
        cwd: ROOT,
        timeout: 10 * 60 * 1000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const lines = (output || "").trim().split("\n");
    for (const line of lines) {
      log(`  [rare-mint] ${line}`);
    }
    return true;
  } catch (err: any) {
    const output = (err.stdout || "") + (err.stderr || "");
    log(`  Minter error: ${(output || err.message).slice(0, 500)}`);
    return false;
  }
}

// --- Single cycle ---

async function cycle() {
  cycleCount++;
  log("");
  log("=".repeat(60));
  log(`CYCLE ${cycleCount} — ${new Date().toISOString()} [RARE PROTOCOL]`);
  log("=".repeat(60));

  // Step 1: Scrape
  log("\n[1/3] Scraping Reddit...");
  let newCandidates: Candidate[] = [];
  try {
    newCandidates = await scrape();
  } catch (err: any) {
    log(`  Scrape failed: ${err.message}`);
    return;
  }

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

  totalScraped += added;
  log(`  ${newCandidates.length} found, ${added} new`);

  // Step 2: Auto-promote
  log("\n[2/3] Auto-promoting (guard active)...");
  const { promoted, blocked } = await autoPromote();
  totalPromoted += promoted;
  totalBlocked += blocked;
  log(`  ${promoted} promoted, ${blocked} blocked by guard`);

  // Step 3: Mint via Rare Protocol
  const queue = loadQueue();
  const hasPending = queue.items.some(
    (i) => i.status !== "done" && i.status !== "failed"
  );

  if (hasPending) {
    log("\n[3/3] Minting via Rare Protocol...");
    const ok = runMinter();
    if (ok) {
      const after = loadQueue();
      totalMinted = after.items.filter((i) => i.status === "done").length;
    }
  } else {
    log("\n[3/3] Nothing to mint");
  }

  // Summary
  const uptimeMin = Math.floor((Date.now() - startedAt.getTime()) / 60000);
  const dailyCount = getDailyMintCount();
  log("");
  log(`--- Cycle ${cycleCount} done [RARE PROTOCOL] ---`);
  log(`  Uptime:       ${uptimeMin}m`);
  log(`  Scraped:      ${totalScraped} total new`);
  log(`  Promoted:     ${totalPromoted} total`);
  log(`  Blocked:      ${totalBlocked} total (by guard)`);
  log(`  Minted:       ${totalMinted} total`);
  log(`  Daily mints:  ${dailyCount}/${DAILY_LIMIT}`);
  if (!ONCE) log(`  Next cycle in ${INTERVAL_MIN}m`);
}

// --- Main loop ---

async function main() {
  log("");
  log("#".repeat(60));
  log("  MISOGYNY.EXE — RARE PROTOCOL AGENT");
  log("#".repeat(60));
  log(`  Chain:          ${process.env.RARE_CHAIN || "sepolia"}`);
  log(`  Contract:       ${process.env.RARE_CONTRACT_ADDRESS || "NOT SET"}`);
  log(`  Interval:       ${INTERVAL_MIN}m`);
  log(`  Min score:      ${MIN_SCORE}`);
  log(`  Max per cycle:  ${MAX_PER_CYCLE}`);
  log(`  Daily limit:    ${DAILY_LIMIT}`);
  log(`  Starting price: ${process.env.RARE_STARTING_PRICE || "0.01"} ETH`);
  log(`  Dry run:        ${DRY_RUN}`);
  log(`  Once:           ${ONCE}`);
  log(`  Guard:          ACTIVE`);
  log("");

  let running = true;
  const shutdown = () => {
    log("\nShutting down...");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      await cycle();
    } catch (err: any) {
      log(`CYCLE ERROR: ${err.message}`);
    }
    if (ONCE || !running) break;
    log(`\nSleeping ${INTERVAL_MIN}m...\n`);
    const sleepMs = INTERVAL_MIN * 60 * 1000;
    const chunk = 10_000;
    let slept = 0;
    while (slept < sleepMs && running) {
      await sleep(Math.min(chunk, sleepMs - slept));
      slept += chunk;
    }
  }

  log("Agent stopped.");
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
});
