import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbi,
  parseEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, mainnet } from "viem/chains";
import { generateArtwork } from "./generate-artwork";
import { generateAnimation } from "./generate-animation";
import { uploadFile, uploadJSON, buildMetadata } from "./upload-to-ipfs";
import { captureHtmlToMp4 } from "./capture-mp4";
import { postToSocials } from "./post-to-socials";
import { computeQueueHmac } from "./scraper";
import type { Queue, QueueItem } from "./scraper";

dotenv.config();

/**
 * MISOGYNY.EXE V6 — mint pipeline
 *
 * Processes queue items that the agent (rare-agent-v6.ts) has marked "approved".
 * Flow per V6 spec §8.2:
 *   1. Generate PNG thumbnail + HTML animation
 *   2. Pin PNG + HTML + metadata to IPFS (NOT MP4)
 *   3. CollectionAdmin.mint(uri, quote)  — token lands in SplitGuard
 *   4. Parse tokenId from Transfer event on the receipt (not regex-on-stdout)
 *   5. QuoteRegistry.registerQuote(tokenId, quote)
 *   6. SplitGuard.listAuction(tokenId, startingPrice, duration)
 *   7. Capture MP4 from the HTML (Bluesky only, not IPFS)
 *   8. Post to Bluesky
 *
 * No Rare CLI. No direct Rare Bazaar interaction. No splits array. All revenue-movement
 * is gated by the on-chain CollectionAdmin + SplitGuard contracts.
 */

// -------------------------------------------------------
// Paths + config
// -------------------------------------------------------

const QUEUE_PATH = path.join(__dirname, "..", "data", "v6-mint-queue.json");
const LOG_PATH = path.join(__dirname, "..", "logs", "rare-mint-v6.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const RARE_CHAIN = process.env.RARE_CHAIN || "sepolia";
const AUCTION_DURATION = BigInt(process.env.RARE_AUCTION_DURATION || "86400");
const STARTING_PRICE_ETH = process.env.RARE_STARTING_PRICE || "0.01";

const COLLECTION_ADMIN_ADDRESS = (process.env.COLLECTION_ADMIN_ADDRESS || "") as Address;
const QUOTE_REGISTRY_ADDRESS = (process.env.QUOTE_REGISTRY_ADDRESS || "") as Address;
const SPLIT_GUARD_ADDRESS = (process.env.SPLIT_GUARD_ADDRESS || "") as Address;
const RARE_CONTRACT_ADDRESS = (process.env.RARE_CONTRACT_ADDRESS || "") as Address;

// -------------------------------------------------------
// ABIs (minimal)
// -------------------------------------------------------

const COLLECTION_ADMIN_ABI = parseAbi([
  "function mint(string uri, string quote) returns (uint256)",
]);

const QUOTE_REGISTRY_ABI = parseAbi([
  "function registerQuote(uint256 tokenId, string quote)",
  "function quoteOf(uint256) view returns (string)",
]);

const SPLIT_GUARD_ABI = parseAbi([
  "function listAuction(uint256 tokenId, uint256 startingPrice, uint256 duration)",
]);

// Standard ERC-721 Transfer event — emitted by the Rare collection under CollectionAdmin
const ERC721_TRANSFER_EVENT = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
])[0];

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
// viem clients
// -------------------------------------------------------

function getChain() {
  return RARE_CHAIN === "mainnet" ? mainnet : sepolia;
}

function getRpcUrl(): string {
  return RARE_CHAIN === "mainnet"
    ? (process.env.ETHEREUM_MAINNET_RPC_URL || "https://eth.llamarpc.com")
    : (process.env.ETHEREUM_SEPOLIA_RPC_URL ||
       "https://ethereum-sepolia-rpc.publicnode.com");
}

function getClients() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set");
  const key = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const chain = getChain();
  const rpcUrl = getRpcUrl();
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }), account });
  return { publicClient, walletClient, account };
}

// -------------------------------------------------------
// Pipeline steps
// -------------------------------------------------------

/**
 * Render PNG + HTML and (optionally) pin to IPFS. Persists CIDs on the queue item.
 */
async function generateAndPin(item: QueueItem): Promise<void> {
  const needPng = !item.imageCid;
  const needAnim = !item.animationCid;
  const needMetadata = !item.metadataCid;

  if (!needPng && !needAnim && !needMetadata) return;

  // 1. PNG thumbnail (hate palette for mints)
  if (needPng) {
    const svgPath = generateArtwork({
      id: item.id,
      quote: item.quote,
      attribution: item.attribution,
      palette: "hate",
    });
    // generate-artwork schedules async PNG conversion; wait for it
    const pngPath = svgPath.replace(/\.svg$/, ".png");
    // Poll briefly for the PNG to exist
    for (let i = 0; i < 40 && !fs.existsSync(pngPath); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const imageFile = fs.existsSync(pngPath) ? pngPath : svgPath;
    item.imageCid = await uploadFile(imageFile, `misogyny-exe-${item.id}`);
    log(`  image CID ${item.imageCid}`);
  }

  // 2. HTML animation (on-chain animation_url)
  let animStyle: string | undefined;
  if (needAnim) {
    const anim = generateAnimation({ id: item.id, quote: item.quote });
    animStyle = anim.style;
    item.animationCid = await uploadFile(anim.htmlPath, `misogyny-exe-${item.id}-anim.html`);
    log(`  animation CID ${item.animationCid} (${anim.style})`);
  }

  // 3. Metadata JSON
  if (needMetadata) {
    const metadata = buildMetadata({
      name: `MISOGYNY.EXE #${item.id}`,
      description:
        `"${item.quote}" — ${item.attribution}. ` +
        `Autonomously scraped, classified, and minted by MISOGYNY.EXE. ` +
        `Primary sale: 50% charity, 30% artist, 20% project — enforced on-chain by SplitGuard.`,
      imageCid: item.imageCid!,
      quote: item.quote,
      attribution: item.attribution,
      source: item.source,
      animationCid: item.animationCid,
      animationStyle: animStyle,
    });
    item.metadataCid = await uploadJSON(metadata, `misogyny-exe-metadata-${item.id}.json`);
    log(`  metadata CID ${item.metadataCid}`);
  }
}

/**
 * Call CollectionAdmin.mint(uri, quote) and parse tokenId from the Transfer event on the receipt.
 * Idempotent: if item.tokenId is already set, skips.
 */
async function mintThroughAdmin(item: QueueItem): Promise<number> {
  if (item.tokenId) return item.tokenId;
  if (!COLLECTION_ADMIN_ADDRESS) throw new Error("COLLECTION_ADMIN_ADDRESS not set");
  if (!RARE_CONTRACT_ADDRESS) throw new Error("RARE_CONTRACT_ADDRESS not set");
  if (!item.metadataCid) throw new Error("metadataCid missing — pin IPFS first");

  const uri = `ipfs://${item.metadataCid}`;
  const { publicClient, walletClient } = getClients();

  log(`  CollectionAdmin.mint(uri="${uri}", quote="${item.quote.slice(0, 40)}...")`);
  const txHash = await walletClient.writeContract({
    address: COLLECTION_ADMIN_ADDRESS,
    abi: COLLECTION_ADMIN_ABI,
    functionName: "mint",
    args: [uri, item.quote],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  log(`  mint tx confirmed block=${receipt.blockNumber}`);

  // Parse tokenId from the ERC-721 Transfer event emitted by the Rare collection
  let tokenId: number | undefined;
  for (const entry of receipt.logs) {
    if (entry.address.toLowerCase() !== RARE_CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = decodeEventLog({
        abi: [ERC721_TRANSFER_EVENT],
        data: entry.data,
        topics: entry.topics,
      });
      if (parsed.eventName === "Transfer") {
        tokenId = Number((parsed.args as any).tokenId);
        break;
      }
    } catch {
      // not a Transfer event, ignore
    }
  }
  if (tokenId === undefined) {
    throw new Error("Could not parse tokenId from Transfer event on receipt");
  }

  item.tokenId = tokenId;
  item.mintTx = txHash;
  log(`  tokenId=${tokenId}`);
  return tokenId;
}

/**
 * Call QuoteRegistry.registerQuote. Idempotent: skip if already registered on-chain.
 */
async function registerQuote(item: QueueItem): Promise<void> {
  if (!QUOTE_REGISTRY_ADDRESS) throw new Error("QUOTE_REGISTRY_ADDRESS not set");
  if (!item.tokenId) throw new Error("tokenId missing — mint first");

  const { publicClient, walletClient } = getClients();

  // Idempotency: check if already registered
  const existing = await publicClient.readContract({
    address: QUOTE_REGISTRY_ADDRESS,
    abi: QUOTE_REGISTRY_ABI,
    functionName: "quoteOf",
    args: [BigInt(item.tokenId)],
  }) as string;
  if (existing && existing.length > 0) {
    log(`  QuoteRegistry: already registered for #${item.tokenId}, skipping`);
    return;
  }

  log(`  QuoteRegistry.registerQuote(${item.tokenId}, "${item.quote.slice(0, 40)}...")`);
  const txHash = await walletClient.writeContract({
    address: QUOTE_REGISTRY_ADDRESS,
    abi: QUOTE_REGISTRY_ABI,
    functionName: "registerQuote",
    args: [BigInt(item.tokenId), item.quote],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  item.registerTx = txHash;
  log(`  registerQuote confirmed tx=${txHash}`);
}

/**
 * Call SplitGuard.listAuction. Skips if item.listTx already set.
 */
async function listOnSplitGuard(item: QueueItem): Promise<void> {
  if (item.listTx) return;
  if (!SPLIT_GUARD_ADDRESS) throw new Error("SPLIT_GUARD_ADDRESS not set");
  if (!item.tokenId) throw new Error("tokenId missing — mint first");

  const { publicClient, walletClient } = getClients();

  log(`  SplitGuard.listAuction(${item.tokenId}, ${STARTING_PRICE_ETH} ETH, ${AUCTION_DURATION}s)`);
  const txHash = await walletClient.writeContract({
    address: SPLIT_GUARD_ADDRESS,
    abi: SPLIT_GUARD_ABI,
    functionName: "listAuction",
    args: [BigInt(item.tokenId), parseEther(STARTING_PRICE_ETH), AUCTION_DURATION],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  item.listTx = txHash;
  log(`  listAuction confirmed tx=${txHash}`);
}

/**
 * Capture MP4 from the pinned HTML animation (ipfs://... → local) for Bluesky.
 * MP4 is NOT pinned to IPFS — posted directly via AT Protocol (V6 spec §10.4).
 */
async function captureMp4ForBluesky(item: QueueItem): Promise<string | null> {
  // We have the HTML on IPFS at item.animationCid — simplest is to regenerate locally
  // (deterministic per tokenId / style), because the original file is already written
  // by generate-animation.ts and lives under data/artworks/animations/.
  const animPath = path.join(
    __dirname,
    "..",
    "data",
    "artworks",
    "animations",
    `${item.id}-scramble.html`
  );
  // Fallback: look for any file matching this id
  let htmlPath = animPath;
  if (!fs.existsSync(htmlPath)) {
    const dir = path.dirname(animPath);
    if (fs.existsSync(dir)) {
      const candidates = fs.readdirSync(dir).filter((f) => f.startsWith(`${item.id}-`) && f.endsWith(".html"));
      if (candidates.length > 0) htmlPath = path.join(dir, candidates[0]);
    }
  }
  if (!fs.existsSync(htmlPath)) {
    log(`  MP4 skipped — no local HTML animation found for #${item.id}`);
    return null;
  }
  try {
    const mp4Path = await captureHtmlToMp4({ htmlPath, tokenId: item.id, kind: "mint" });
    log(`  MP4 captured ${mp4Path}`);
    return mp4Path;
  } catch (err: any) {
    log(`  MP4 capture failed (non-blocking): ${err.message?.slice(0, 200)}`);
    return null;
  }
}

// -------------------------------------------------------
// Queue processor
// -------------------------------------------------------

async function processQueue(): Promise<void> {
  // Preflight env checks
  for (const [name, val] of [
    ["PRIVATE_KEY", process.env.PRIVATE_KEY],
    ["COLLECTION_ADMIN_ADDRESS", COLLECTION_ADMIN_ADDRESS],
    ["QUOTE_REGISTRY_ADDRESS", QUOTE_REGISTRY_ADDRESS],
    ["SPLIT_GUARD_ADDRESS", SPLIT_GUARD_ADDRESS],
    ["RARE_CONTRACT_ADDRESS", RARE_CONTRACT_ADDRESS],
  ]) {
    if (!val) {
      log(`ERROR: ${name} not set in .env`);
      process.exit(1);
    }
  }

  const queue = loadQueue();

  // Process items in approved / uploading / minting / registering / listing states
  const processable = queue.items.filter((i) =>
    ["approved", "uploading", "minting", "registering", "listing"].includes(i.status) ||
    (i.status === "failed" && (i.retries || 0) < 3)
  );

  if (processable.length === 0) {
    log("No approved items to mint");
    return;
  }

  log(`Processing ${processable.length} items on ${RARE_CHAIN}`);

  for (const item of processable) {
    // HMAC integrity check — reject if missing or tampered
    if (!item.hmac || item.hmac !== computeQueueHmac(item)) {
      log(`  SECURITY: HMAC ${!item.hmac ? "missing" : "mismatch"} for #${item.id} — failing (possible tampering)`);
      item.status = "failed";
      item.error = "HMAC integrity check failed";
      saveQueue(queue);
      continue;
    }

    try {
      log(`--- Processing #${item.id}: "${item.quote.slice(0, 60)}..."`);

      if (item.status === "approved" || item.status === "uploading") {
        item.status = "uploading";
        saveQueue(queue);
        await generateAndPin(item);
        saveQueue(queue);
      }

      if (!item.tokenId) {
        item.status = "minting";
        saveQueue(queue);
        await mintThroughAdmin(item);
        saveQueue(queue);
      }

      if (!item.registerTx) {
        item.status = "registering";
        saveQueue(queue);
        await registerQuote(item);
        saveQueue(queue);
      }

      if (!item.listTx) {
        item.status = "listing";
        saveQueue(queue);
        await listOnSplitGuard(item);
        saveQueue(queue);
      }

      item.status = "done";
      saveQueue(queue);
      log(`  ✓ done: tokenId #${item.tokenId}`);

      // Bluesky post (non-blocking): MP4 + PNG
      try {
        const mp4Path = await captureMp4ForBluesky(item);
        const pngPath = path.join(__dirname, "..", "data", "artworks", `${item.id}.png`);
        const socialResults = await postToSocials({
          quote: item.quote,
          tokenId: item.tokenId!,
          artworkPath: fs.existsSync(pngPath) ? pngPath : undefined,
          mp4Path: mp4Path ?? undefined,
        });
        for (const r of socialResults) {
          log(r.success ? `  [${r.platform}] ${r.url}` : `  [${r.platform}] skip: ${r.error}`);
        }
      } catch (err: any) {
        log(`  social post failed (non-blocking): ${err.message?.slice(0, 200)}`);
      }
    } catch (err: any) {
      item.status = "failed";
      item.error = err.message?.slice(0, 200);
      item.retries = (item.retries || 0) + 1;
      item.lastAttempt = new Date().toISOString();
      log(`  ✗ failed: ${err.message?.slice(0, 200)}`);
      saveQueue(queue);
    }
  }

  const done = queue.items.filter((i) => i.status === "done").length;
  const failed = queue.items.filter((i) => i.status === "failed").length;
  log(`\nQueue: ${done} done, ${failed} failed, ${queue.items.length} total`);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

async function main() {
  log("=== MISOGYNY.EXE V6 — Mint ===");
  log(`Chain: ${RARE_CHAIN}`);
  log(`CollectionAdmin: ${COLLECTION_ADMIN_ADDRESS}`);
  log(`QuoteRegistry:   ${QUOTE_REGISTRY_ADDRESS}`);
  log(`SplitGuard:      ${SPLIT_GUARD_ADDRESS}`);
  log(`Rare collection: ${RARE_CONTRACT_ADDRESS}`);

  await processQueue();
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
});
