import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { uploadFile, uploadJSON, buildMetadata } from "./upload-to-ipfs";
import { generatePlaceholder, convertToPng } from "./generate-artwork";
import { generateAnimation } from "./generate-animation";
import { postToSocials } from "./post-to-socials";

/**
 * Auto-mint pipeline for the V3 autonomous bot.
 *
 * Reads from a queue file, uploads artwork + metadata to IPFS,
 * mints on MisogynyNFT, and lists on MisogynyMarketplace.
 *
 * Features:
 *   - Gas management: checks balance before each step, aborts if insufficient
 *   - Retry logic: exponential backoff for failed items (max 3 retries)
 *   - Watch mode: polls queue on interval (--watch or MINT_WATCH=true)
 *   - Auto-artwork: generates placeholder B&W checkerboard if artwork file missing
 *
 * Usage:
 *   npx hardhat run scripts/auto-mint.ts --network base-sepolia
 *   npx hardhat run scripts/auto-mint.ts --network base-mainnet
 *   MINT_WATCH=true MINT_INTERVAL=300 npx hardhat run scripts/auto-mint.ts --network base-mainnet
 */

interface QueueItem {
  id: number;
  quote: string;
  attribution: string;
  source?: string;
  artworkPath: string;
  listPrice: string; // ETH
  status: "pending" | "uploading" | "minting" | "listing" | "done" | "failed";
  tokenId?: number;
  imageCid?: string;
  metadataCid?: string;
  mintTx?: string;
  listTx?: string;
  error?: string;
  retries?: number;
  lastAttempt?: string;
  hmac?: string;
  counterQuote?: string;
}

// HMAC verification for queue integrity (must match scraper.ts)
const QUEUE_HMAC_KEY = process.env.QUEUE_HMAC_SECRET || process.env.PRIVATE_KEY || "misogyny-exe-queue-integrity";
function verifyQueueHmac(item: QueueItem): boolean {
  if (!item.hmac) return true; // Backward compat: old items without HMAC pass
  const expected = crypto.createHmac("sha256", QUEUE_HMAC_KEY)
    .update(`${item.id}:${item.quote}`)
    .digest("hex")
    .slice(0, 32);
  return item.hmac === expected;
}

interface Queue {
  items: QueueItem[];
}

// --- Config ---
const QUEUE_PATH = path.join(__dirname, "..", "data", "mint-queue.json");
const LOCK_PATH = QUEUE_PATH + ".lock";
const LOG_PATH = path.join(__dirname, "..", "logs", "auto-mint.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB log rotation
const ARTWORKS_DIR = path.resolve(__dirname, "..", "data", "artworks");
const MAX_RETRIES = 3;
const MIN_BALANCE_ETH = 0.0005; // Minimum ETH to proceed (gas buffer)
const WATCH_INTERVAL_S = parseInt(process.env.MINT_INTERVAL || "300"); // 5 min default
const IS_WATCH = process.env.MINT_WATCH === "true";

// --- File locking (prevents concurrent writes) ---
function acquireLock(): boolean {
  try {
    // O_EXCL fails if file exists — atomic check-and-create
    const fd = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    // Check if stale lock (PID no longer running)
    try {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf-8").trim());
      try { process.kill(pid, 0); return false; } catch { /* PID dead, remove stale lock */ }
      fs.unlinkSync(LOCK_PATH);
      return acquireLock();
    } catch { return false; }
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

// --- Queue I/O (atomic writes + safe parse) ---
function loadQueue(): Queue {
  if (!fs.existsSync(QUEUE_PATH)) {
    return { items: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
  } catch (err: any) {
    log(`WARNING: Queue file corrupted, starting fresh: ${err.message}`);
    return { items: [] };
  }
}

function saveQueue(queue: Queue): void {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: write to temp file, then rename (prevents corruption on crash)
  const tmpPath = QUEUE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
  fs.renameSync(tmpPath, QUEUE_PATH);
}

// --- Path validation (prevents path traversal) ---
function validateArtworkPath(p: string): string {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(ARTWORKS_DIR)) {
    throw new Error(`SECURITY: artworkPath "${p}" is outside allowed directory ${ARTWORKS_DIR}`);
  }
  return resolved;
}

// --- Logging (with rotation) ---
function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Rotate if log exceeds max size
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size > MAX_LOG_BYTES) {
        const rotated = LOG_PATH + ".1";
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(LOG_PATH, rotated);
      }
    } catch {}
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}

// --- Retry wrapper ---
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelay = 2000
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1); // 2s, 4s, 8s
        log(`  Retry ${attempt}/${maxAttempts} for ${label} in ${delay}ms: ${err.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Gas check ---
async function checkBalance(
  provider: any,
  address: string
): Promise<{ ok: boolean; balance: bigint; formatted: string }> {
  const balance = await provider.getBalance(address);
  const formatted = ethers.formatEther(balance);
  const ok = balance >= ethers.parseEther(MIN_BALANCE_ETH.toString());
  return { ok, balance, formatted };
}

// --- Process a single queue item ---
async function processItem(
  item: QueueItem,
  queue: Queue,
  nft: any,
  marketplace: any,
  deployer: any
): Promise<boolean> {
  log(`--- Item #${item.id}: "${item.quote.slice(0, 50)}..." ---`);

  // SECURITY: Verify queue item integrity (HMAC)
  if (!verifyQueueHmac(item)) {
    log(`  SECURITY: HMAC mismatch on item #${item.id} — possible queue tampering. SKIPPING.`);
    item.status = "failed";
    item.error = "HMAC verification failed — queue may have been tampered with";
    saveQueue(queue);
    return false;
  }

  // Gas check before processing
  const { ok, formatted } = await checkBalance(
    ethers.provider,
    deployer.address
  );
  if (!ok) {
    log(`  SKIPPED — Balance too low: ${formatted} ETH (need ${MIN_BALANCE_ETH})`);
    return false;
  }

  // Auto-generate placeholder artwork if missing
  if (!fs.existsSync(item.artworkPath)) {
    log(`  Artwork not found at ${item.artworkPath}, generating placeholder...`);
    const generated = generatePlaceholder({
      id: item.id,
      quote: item.quote,
      attribution: item.attribution,
    });
    item.artworkPath = generated;
    saveQueue(queue);
    log(`  Generated: ${generated}`);
  }

  // Convert SVG to PNG if needed (eliminates SVG script injection vector)
  if (item.artworkPath.endsWith(".svg")) {
    const pngPath = item.artworkPath.replace(/\.svg$/, ".png");
    if (!fs.existsSync(pngPath)) {
      log(`  Converting SVG → PNG...`);
      await convertToPng(item.artworkPath, pngPath);
    }
    item.artworkPath = pngPath;
    saveQueue(queue);
    log(`  Using PNG: ${pngPath}`);
  }

  // Validate artwork path (prevent path traversal — blocks reading .env, etc.)
  const safePath = validateArtworkPath(item.artworkPath);

  // Step 1: Upload artwork to IPFS
  if (!item.imageCid) {
    item.status = "uploading";
    saveQueue(queue);

    log("  Uploading artwork to IPFS...");
    item.imageCid = await withRetry(
      () => uploadFile(safePath, `misogyny-exe-${item.id}`),
      "IPFS artwork upload"
    );
    log(`  Image CID: ${item.imageCid}`);
    saveQueue(queue);
  }

  // Step 2: Generate + upload animation HTML
  let animationCid: string | undefined;
  let animationStyle: string | undefined;
  try {
    log("  Generating animation...");
    const anim = generateAnimation({ id: item.id, quote: item.quote });
    animationStyle = anim.style;
    log(`  Animation style: ${anim.style}`);

    log("  Uploading animation to IPFS...");
    animationCid = await withRetry(
      () => uploadFile(anim.htmlPath, `misogyny-exe-${item.id}-anim.html`),
      "IPFS animation upload"
    );
    log(`  Animation CID: ${animationCid}`);
  } catch (err: any) {
    log(`  Animation generation/upload failed (non-blocking): ${err.message}`);
  }

  // Step 3: Build + upload metadata JSON
  if (!item.metadataCid) {
    log("  Uploading metadata to IPFS...");
    const metadata = buildMetadata({
      name: `MISOGYNY.EXE #${item.id}`,
      description: `"${item.quote}" — ${item.attribution}. Typographic artwork from the MISOGYNY.EXE autonomous art bot. All royalties split: 5% charity, 5% operations, 5% artist.`,
      imageCid: item.imageCid,
      quote: item.quote,
      attribution: item.attribution,
      source: item.source,
      animationCid,
      animationStyle,
      // counterQuote stored in queue only — revealed on redemption, not in pre-purchase metadata
    });

    item.metadataCid = await withRetry(
      () => uploadJSON(metadata, `misogyny-exe-metadata-${item.id}.json`),
      "IPFS metadata upload"
    );
    log(`  Metadata CID: ${item.metadataCid}`);
    saveQueue(queue);
  }

  // Step 4: Mint NFT
  if (!item.tokenId) {
    log("  Minting NFT...");
    item.status = "minting";
    saveQueue(queue);

    const metadataURI = `ipfs://${item.metadataCid}`;
    const mintTx = await withRetry(
      async () => {
        const tx = await nft.mint(deployer.address, metadataURI);
        return tx;
      },
      "NFT mint"
    );
    // Save TX hash IMMEDIATELY — prevents duplicate mint if crash before tokenId extraction
    item.mintTx = mintTx.hash;
    saveQueue(queue);

    const receipt = await mintTx.wait();

    // Extract tokenId from Transfer event
    const transferLog = receipt!.logs.find((log: any) => {
      try {
        return nft.interface.parseLog(log)?.name === "Transfer";
      } catch {
        return false;
      }
    });
    if (transferLog) {
      const parsed = nft.interface.parseLog(transferLog);
      item.tokenId = Number(parsed!.args.tokenId);
    } else {
      item.tokenId = Number(await nft.totalSupply());
    }

    log(`  Minted token #${item.tokenId} — TX: ${item.mintTx}`);
    saveQueue(queue);
  }

  // Step 5: List on marketplace
  if (item.status !== "done") {
    log(`  Listing for ${item.listPrice} ETH...`);
    item.status = "listing";
    saveQueue(queue);

    const listTx = await withRetry(
      async () => {
        const tx = await marketplace.list(
          item.tokenId!,
          ethers.parseEther(item.listPrice)
        );
        return tx;
      },
      "marketplace list"
    );
    await listTx.wait();
    item.listTx = listTx.hash;
    item.status = "done";
    log(`  Listed! TX: ${item.listTx}`);
    saveQueue(queue);
  }

  // Step 6: Post to social media (non-blocking — mint+list already succeeded)
  try {
    log("  Posting to social media...");
    const socialResults = await postToSocials({
      quote: item.quote,
      tokenId: item.tokenId!,
      imageCid: item.imageCid,
      artworkPath: safePath,
    });
    for (const r of socialResults) {
      if (r.success) {
        log(`  [${r.platform}] Posted: ${r.url}`);
      } else {
        log(`  [${r.platform}] Skipped: ${r.error}`);
      }
    }
  } catch (err: any) {
    log(`  Social post error (non-blocking): ${err.message}`);
  }

  log(`  DONE`);
  return true;
}

// --- Main ---
async function runOnce() {
  // Acquire file lock (prevents concurrent runs from corrupting queue)
  if (!acquireLock()) {
    log("Another auto-mint instance is running (lock file exists). Skipping.");
    return 0;
  }

  try {
    return await _runOnce();
  } finally {
    releaseLock();
  }
}

async function _runOnce() {
  const NFT_ADDRESS = process.env.V3_NFT_ADDRESS;
  const MARKETPLACE_ADDRESS = process.env.V3_MARKETPLACE_ADDRESS;

  if (!NFT_ADDRESS || !MARKETPLACE_ADDRESS) {
    log("ERROR: Set V3_NFT_ADDRESS and V3_MARKETPLACE_ADDRESS in .env");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const { formatted: bal } = await checkBalance(
    ethers.provider,
    deployer.address
  );

  log("=== MISOGYNY.EXE — Auto-Mint Pipeline ===");
  log(`Network:  ${network.name}`);
  log(`Deployer: ${deployer.address}`);
  log(`Balance:  ${bal} ETH`);
  log(`NFT:      ${NFT_ADDRESS}`);
  log(`Market:   ${MARKETPLACE_ADDRESS}`);

  const nft = await ethers.getContractAt("MisogynyNFT", NFT_ADDRESS);
  const marketplace = await ethers.getContractAt(
    "MisogynyMarketplace",
    MARKETPLACE_ADDRESS
  );

  const queue = loadQueue();

  // Retry previously failed items (if under max retries)
  for (const item of queue.items) {
    if (item.status === "failed") {
      const retries = item.retries || 0;
      if (retries < MAX_RETRIES) {
        log(`Retrying failed item #${item.id} (attempt ${retries + 1}/${MAX_RETRIES})`);
        // Reset to the last successful checkpoint
        if (item.tokenId) {
          item.status = "listing";
        } else if (item.metadataCid) {
          item.status = "minting";
        } else if (item.imageCid) {
          item.status = "uploading";
        } else {
          item.status = "pending";
        }
        item.retries = retries + 1;
        item.lastAttempt = new Date().toISOString();
        item.error = undefined;
        saveQueue(queue);
      }
    }
  }

  const pending = queue.items.filter(
    (i) =>
      i.status === "pending" ||
      i.status === "uploading" ||
      i.status === "minting" ||
      i.status === "listing"
  );

  if (pending.length === 0) {
    log("No pending items in queue.");
    return 0;
  }

  log(`Processing ${pending.length} item(s)...\n`);

  let done = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      const success = await processItem(item, queue, nft, marketplace, deployer);
      if (success) done++;
    } catch (error: any) {
      item.status = "failed";
      item.error = error.message;
      item.retries = (item.retries || 0) + 1;
      item.lastAttempt = new Date().toISOString();
      saveQueue(queue);
      log(`  FAILED (attempt ${item.retries}/${MAX_RETRIES}): ${error.message}`);
      failed++;
    }
  }

  log(`\n=== Complete: ${done} minted, ${failed} failed ===`);
  return done;
}

async function main() {
  if (IS_WATCH) {
    log(`=== Watch mode: polling every ${WATCH_INTERVAL_S}s ===`);
    while (true) {
      try {
        await runOnce();
      } catch (err: any) {
        log(`Watch error: ${err.message}`);
      }
      log(`Sleeping ${WATCH_INTERVAL_S}s...\n`);
      await sleep(WATCH_INTERVAL_S * 1000);
    }
  } else {
    await runOnce();
  }
}

main().catch((error) => {
  log(`FATAL: ${error.message}`);
  process.exitCode = 1;
});
