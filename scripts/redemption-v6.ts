import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, mainnet } from "viem/chains";
import { generateArtwork } from "./generate-artwork";
import { generateRedeemedAnimation } from "./generate-redeemed-animation";
import { uploadFile, uploadJSON, buildMetadata } from "./upload-to-ipfs";
import { captureHtmlToMp4 } from "./capture-mp4";
import { postToSocials } from "./post-to-socials";
import type { Queue, QueueItem } from "./scraper";

dotenv.config({ path: [".env.local", ".env"] });

/**
 * MISOGYNY.EXE V6 — Redemption pipeline
 *
 * Fired when the indexer reports a sale. The roast was approved by the operator at
 * scrape time and has been sitting in the queue — redemption just loads it and
 * runs the transformation. NO AI CALLS at redemption time (V6 spec §9.3).
 *
 * Per spec §9.2:
 *   1. Read QuoteRegistry.quoteOf(tokenId) for the original quote
 *   2. Look up pre-approved roast from the mint queue by tokenId
 *   3. Generate redeemed PNG (inverted palette + "REDEEMED" glyph)
 *   4. Generate glitch animation HTML (hate → roast transition) — the new animation_url
 *   5. Capture MP4 of the glitch for Bluesky only (not IPFS)
 *   6. Pin PNG + HTML + metadata to IPFS
 *   7. CollectionAdmin.updateTokenURI(tokenId, newURI)
 *   8. QuoteRegistry.inscribeComeback(tokenId, roast)
 *   9. Post MP4 + PNG to Bluesky
 *  10. Mark redeemed
 */

// -------------------------------------------------------
// ABIs
// -------------------------------------------------------

const RARE_NFT_ABI = parseAbi([
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

const QUOTE_REGISTRY_ABI = parseAbi([
  "function quoteOf(uint256) view returns (string)",
  "function comebackOf(uint256) view returns (string)",
  "function redeemed(uint256) view returns (bool)",
  "function inscribeComeback(uint256 tokenId, string comeback)",
]);

const COLLECTION_ADMIN_ABI = parseAbi([
  "function updateTokenURI(uint256 tokenId, string uri)",
]);

// -------------------------------------------------------
// Types / config
// -------------------------------------------------------

interface Sale {
  tokenId: number;
  seller: string;
  buyer: string;
  price: string;
  tx: string;
  block: number;
}

interface IndexState {
  chain: string;
  collectionAddress: string;
  bazaarAddress: string;
  lastBlock: number;
  updatedAt: string;
  sales: Sale[];
}

const RARE_CHAIN = process.env.RARE_CHAIN || "sepolia";
const COLLECTION_ADDRESS = (process.env.RARE_CONTRACT_ADDRESS || "") as Address;
const REGISTRY_ADDRESS = (process.env.QUOTE_REGISTRY_ADDRESS || "") as Address;
const COLLECTION_ADMIN_ADDRESS = (process.env.COLLECTION_ADMIN_ADDRESS || "") as Address;
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

const INDEX_PATH = path.join(__dirname, "..", "data", "index-v6-eth.json");
const REDEEMED_PATH = path.join(__dirname, "..", "data", "redeemed-v6.json");
const QUEUE_PATH = path.join(__dirname, "..", "data", "v6-mint-queue.json");
const LOG_PATH = path.join(__dirname, "..", "logs", "redemption-v6.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const CHECK_INTERVAL_S = 60;

// -------------------------------------------------------
// Logging (with rotation)
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------------------------------------------
// Redeemed tracking
// -------------------------------------------------------

function loadRedeemed(): Set<number> {
  if (!fs.existsSync(REDEEMED_PATH)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(REDEEMED_PATH, "utf-8"));
    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveRedeemed(redeemed: Set<number>): void {
  const dir = path.dirname(REDEEMED_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = REDEEMED_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify([...redeemed]));
  fs.renameSync(tmp, REDEEMED_PATH);
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
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set");
  const key = (PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const chain = getChain();
  const rpcUrl = getRpcUrl();
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }), account });
  return { publicClient, walletClient };
}

// -------------------------------------------------------
// Lookups
// -------------------------------------------------------

async function fetchOriginalQuoteFromRegistry(tokenId: number): Promise<string> {
  if (!REGISTRY_ADDRESS) return "";
  const { publicClient } = getClients();
  const q = (await publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: QUOTE_REGISTRY_ABI,
    functionName: "quoteOf",
    args: [BigInt(tokenId)],
  })) as string;
  return q || "";
}

function loadQueue(): Queue {
  if (!fs.existsSync(QUEUE_PATH)) return { items: [] };
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
}

function findApprovedRoast(tokenId: number, fallbackQuote: string): string | null {
  const queue = loadQueue();
  const item = queue.items.find((i) => i.tokenId === tokenId);
  if (item?.roast) return item.roast;
  // Secondary match: some queues may not have the tokenId wired yet (edge case) —
  // fall back to matching by quote text.
  const byQuote = queue.items.find((i) => i.quote === fallbackQuote && i.roast);
  return byQuote?.roast ?? null;
}

// -------------------------------------------------------
// Bluesky post text (redemption-specific)
// -------------------------------------------------------

function sanitizeForBluesky(s: string): string {
  return s.replace(/@/g, "").replace(/#/g, "").replace(/\s+/g, " ").trim();
}

function buildRedemptionText(tokenId: number, originalQuote: string, roast: string): string {
  const origTrimmed = sanitizeForBluesky(originalQuote).slice(0, 120);
  const roastTrimmed = sanitizeForBluesky(roast).slice(0, 120);
  return [
    `REDEEMED`,
    ``,
    `\u201C${origTrimmed}${originalQuote.length > 120 ? "\u2026" : ""}\u201D`,
    ``,
    `ROAST: \u201C${roastTrimmed}\u201D`,
    ``,
    `MISOGYNY.EXE #${tokenId}`,
  ].join("\n").slice(0, 300);
}

// -------------------------------------------------------
// Redemption
// -------------------------------------------------------

async function redeemToken(sale: Sale, dryRun = false): Promise<boolean> {
  log(`\n--- Redeeming token #${sale.tokenId} ---`);
  log(`  sold for ${sale.price} ETH in tx ${sale.tx.slice(0, 18)}...`);

  // 1. Original quote
  log("  [1/9] fetching original quote from QuoteRegistry");
  const originalQuote = await fetchOriginalQuoteFromRegistry(sale.tokenId);
  if (!originalQuote) {
    log(`  ERROR: QuoteRegistry has no entry for #${sale.tokenId}. Skipping.`);
    return false;
  }

  // 2. Pre-approved roast
  log("  [2/9] looking up pre-approved roast in queue");
  const roast = findApprovedRoast(sale.tokenId, originalQuote);
  if (!roast) {
    log(`  ERROR: no pre-approved roast for #${sale.tokenId}. Needs manual attention.`);
    return false;
  }
  log(`  hate:  "${originalQuote.slice(0, 80)}${originalQuote.length > 80 ? "..." : ""}"`);
  log(`  roast: "${roast}"`);

  // 3. Redeemed PNG (inverted palette + REDEEMED glyph)
  log("  [3/9] generating redeemed PNG");
  const pngSvgPath = generateArtwork({
    id: sale.tokenId,
    quote: roast,
    attribution: "Redeemed",
    palette: "redeemed",
  });
  const pngPath = pngSvgPath.replace(/\.svg$/, ".png");
  for (let i = 0; i < 40 && !fs.existsSync(pngPath); i++) {
    await sleep(250);
  }
  const imageFile = fs.existsSync(pngPath) ? pngPath : pngSvgPath;

  // 4. Glitch animation HTML (hate → roast transition)
  log("  [4/9] generating glitch animation HTML (hate \u2192 roast)");
  const anim = generateRedeemedAnimation({
    id: sale.tokenId,
    hateQuote: originalQuote,
    counterQuote: roast,
  });
  log(`  animation style: ${anim.style}`);

  if (dryRun) {
    log("  [DRY RUN] skipping IPFS + on-chain + social");
    return true;
  }

  // 5. MP4 capture for Bluesky (not IPFS)
  log("  [5/9] capturing MP4 for Bluesky");
  let mp4Path: string | undefined;
  try {
    mp4Path = await captureHtmlToMp4({
      htmlPath: anim.htmlPath,
      tokenId: sale.tokenId,
      kind: "redemption",
    });
  } catch (err: any) {
    log(`  MP4 capture failed (non-blocking): ${err.message?.slice(0, 200)}`);
  }

  // 6. Pin PNG + HTML + metadata to IPFS
  log("  [6/9] pinning PNG + HTML + metadata to IPFS");
  const imageCid = await uploadFile(imageFile, `misogyny-exe-${sale.tokenId}-redeemed.${imageFile.endsWith(".png") ? "png" : "svg"}`);
  const animCid = await uploadFile(anim.htmlPath, `misogyny-exe-${sale.tokenId}-redeemed-anim.html`);

  const metadata = buildMetadata({
    name: `MISOGYNY.EXE #${sale.tokenId} — REDEEMED`,
    description:
      "This piece has been redeemed. What was once hate is now a roast.\n\n" +
      "Original quote transformed on purchase. Roast pre-approved at mint.",
    imageCid,
    quote: roast,
    attribution: "Redeemed",
    animationCid: animCid,
    animationStyle: anim.style,
    counterQuote: roast,
  });
  const metadataCid = await uploadJSON(
    metadata,
    `misogyny-exe-${sale.tokenId}-redeemed-metadata.json`
  );
  const metadataUri = `ipfs://${metadataCid}`;
  log(`  metadata URI ${metadataUri}`);

  // 7. updateTokenURI on-chain (via CollectionAdmin)
  log("  [7/9] CollectionAdmin.updateTokenURI");
  if (!COLLECTION_ADMIN_ADDRESS) {
    log("  ERROR: COLLECTION_ADMIN_ADDRESS not set — skipping on-chain updates");
    return false;
  }
  const { publicClient, walletClient } = getClients();
  try {
    const tx = await walletClient.writeContract({
      address: COLLECTION_ADMIN_ADDRESS,
      abi: COLLECTION_ADMIN_ABI,
      functionName: "updateTokenURI",
      args: [BigInt(sale.tokenId), metadataUri],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    log(`  updateTokenURI confirmed block=${receipt.blockNumber}`);
  } catch (err: any) {
    log(`  updateTokenURI failed: ${err.message?.slice(0, 200)}`);
    return false;
  }

  // 8. inscribeComeback on QuoteRegistry (idempotent)
  log("  [8/9] QuoteRegistry.inscribeComeback");
  try {
    const alreadyRedeemed = (await publicClient.readContract({
      address: REGISTRY_ADDRESS,
      abi: QUOTE_REGISTRY_ABI,
      functionName: "redeemed",
      args: [BigInt(sale.tokenId)],
    })) as boolean;
    if (alreadyRedeemed) {
      log(`  already inscribed on-chain, skipping`);
    } else {
      const tx = await walletClient.writeContract({
        address: REGISTRY_ADDRESS,
        abi: QUOTE_REGISTRY_ABI,
        functionName: "inscribeComeback",
        args: [BigInt(sale.tokenId), roast],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      log(`  inscribeComeback confirmed tx=${tx}`);
    }
  } catch (err: any) {
    log(`  inscribeComeback failed (non-fatal): ${err.message?.slice(0, 200)}`);
  }

  // 9. Bluesky post
  log("  [9/9] posting to Bluesky");
  try {
    const results = await postToSocials({
      quote: roast,
      tokenId: sale.tokenId,
      artworkPath: fs.existsSync(pngPath) ? pngPath : undefined,
      mp4Path,
      customText: buildRedemptionText(sale.tokenId, originalQuote, roast),
    });
    for (const r of results) {
      log(r.success ? `  [${r.platform}] ${r.url}` : `  [${r.platform}] skip: ${r.error}`);
    }
  } catch (err: any) {
    log(`  social post failed (non-blocking): ${err.message?.slice(0, 200)}`);
  }

  log(`  \u2713 token #${sale.tokenId} REDEEMED`);
  return true;
}

// -------------------------------------------------------
// Watch mode
// -------------------------------------------------------

async function checkForSales(): Promise<void> {
  if (!fs.existsSync(INDEX_PATH)) {
    log("No index file found. Run indexer-v6-eth.ts first.");
    return;
  }

  const index: IndexState = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  const redeemed = loadRedeemed();

  log(`Checking unredeemed sales... (${redeemed.size} already redeemed)`);
  const unredeemed = index.sales.filter((s) => !redeemed.has(s.tokenId));
  if (unredeemed.length === 0) {
    log("No new sales to redeem.");
    return;
  }
  log(`Found ${unredeemed.length} unredeemed sale(s).`);

  for (const sale of unredeemed) {
    try {
      const ok = await redeemToken(sale);
      if (ok) {
        redeemed.add(sale.tokenId);
        saveRedeemed(redeemed);
      } else {
        // Failed; leave unredeemed so next cycle can retry.
        log(`  will retry #${sale.tokenId} next cycle`);
      }
    } catch (err: any) {
      log(`  FAILED to redeem #${sale.tokenId}: ${err.message?.slice(0, 200)}`);
    }
  }
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (!COLLECTION_ADDRESS) {
    log("ERROR: RARE_CONTRACT_ADDRESS not set in .env");
    process.exit(1);
  }

  log("=== MISOGYNY.EXE V6 — Redemption ===");
  log(`Chain:           ${RARE_CHAIN}`);
  log(`Collection:      ${COLLECTION_ADDRESS}`);
  log(`CollectionAdmin: ${COLLECTION_ADMIN_ADDRESS || "NOT SET"}`);
  log(`Registry:        ${REGISTRY_ADDRESS || "NOT SET"}`);

  // Single-token CLI: npx ts-node redemption-v6.ts <tokenId> [--dry-run]
  const numeric = parseInt(args[0]);
  if (!isNaN(numeric) && args[0] !== "--watch" && args[0] !== "--check") {
    const dryRun = args.includes("--dry-run");
    const synthetic: Sale = {
      tokenId: numeric,
      seller: "0x0000000000000000000000000000000000000000",
      buyer: "0x0000000000000000000000000000000000000000",
      price: "0",
      tx: "0x" + "0".repeat(64),
      block: 0,
    };
    await redeemToken(synthetic, dryRun);
    return;
  }

  if (args.includes("--watch")) {
    log(`\n=== Watch mode: checking every ${CHECK_INTERVAL_S}s ===`);
    let running = true;
    process.on("SIGINT", () => { running = false; });
    process.on("SIGTERM", () => { running = false; });
    while (running) {
      try {
        await checkForSales();
      } catch (err: any) {
        log(`Watch error: ${err.message}`);
      }
      const sleepMs = CHECK_INTERVAL_S * 1000;
      const chunk = 5000;
      let slept = 0;
      while (slept < sleepMs && running) {
        await sleep(Math.min(chunk, sleepMs - slept));
        slept += chunk;
      }
    }
    log("Redemption watcher stopped.");
    return;
  }

  // Default (also --check): one-shot pass
  await checkForSales();
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
});
