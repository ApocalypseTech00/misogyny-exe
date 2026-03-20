import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * On-chain event indexer for V3 contracts.
 *
 * Scans past blocks for Mint, Listed, Sold, Cancelled events.
 * Saves state to data/index.json for frontend consumption.
 *
 * Features:
 *   - RPC fallback: tries multiple endpoints if primary fails
 *   - Retry logic: exponential backoff on RPC errors
 *   - Watch mode: continuous polling with configurable interval
 *   - Smaller chunks: 2000 blocks per query to avoid RPC limits
 *
 * Usage:
 *   npx hardhat run scripts/indexer.ts --network base-mainnet
 *   INDEX_WATCH=true INDEX_INTERVAL=60 npx hardhat run scripts/indexer.ts --network base-mainnet
 */

interface Token {
  tokenId: number;
  owner: string;
  uri: string;
  mintTx: string;
  mintBlock: number;
}

interface Sale {
  tokenId: number;
  seller: string;
  buyer: string;
  price: string; // ETH
  tx: string;
  block: number;
}

interface Listing {
  tokenId: number;
  seller: string;
  price: string; // ETH
  tx: string;
  block: number;
  active: boolean;
}

interface IndexState {
  network: string;
  nftAddress: string;
  marketplaceAddress: string;
  lastBlock: number;
  updatedAt: string;
  tokens: Token[];
  listings: Listing[];
  sales: Sale[];
}

// --- Config ---
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");
const LOG_PATH = path.join(__dirname, "..", "logs", "indexer.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB log rotation
const CHUNK_SIZE = 2000; // Smaller chunks for Base public RPC
const WATCH_INTERVAL_S = parseInt(process.env.INDEX_INTERVAL || "60");
const IS_WATCH = process.env.INDEX_WATCH === "true";

// Fallback RPC endpoints for Base mainnet (ordered by reliability)
const BASE_MAINNET_RPCS = [
  process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://base.drpc.org",
  "https://base-mainnet.public.blastapi.io",
];

const BASE_SEPOLIA_RPCS = [
  process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
];

// Cache working fallback provider to avoid re-creating on every call
let _cachedFallbackProvider: ethers.JsonRpcProvider | null = null;
let _cachedFallbackIndex = -1;

// --- Logging (with rotation) ---
function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

// --- State I/O (atomic writes + safe parse) ---
function loadState(): IndexState | null {
  if (!fs.existsSync(INDEX_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch (err: any) {
    log(`WARNING: Index file corrupted, starting fresh: ${err.message}`);
    return null;
  }
}

function saveState(state: IndexState): void {
  const dir = path.dirname(INDEX_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = INDEX_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, INDEX_PATH);
}

// --- Retry wrapper ---
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelay = 3000
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
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

// --- Create a fallback provider with static network to avoid noisy retry logs ---
function createFallbackProvider(url: string): ethers.JsonRpcProvider {
  const chainId = network.name === "base-mainnet" ? 8453 : 84532;
  const net = ethers.Network.from(chainId);
  return new ethers.JsonRpcProvider(url, net, { staticNetwork: net });
}

// --- Try query with fallback RPC providers ---
async function queryWithFallback(
  contract: any,
  filter: any,
  fromBlock: number,
  toBlock: number,
  label: string
): Promise<any[]> {
  const contractAddr = await contract.getAddress();

  // If we have a cached working fallback, try it first
  if (_cachedFallbackProvider) {
    try {
      const fb = new ethers.Contract(
        contractAddr,
        contract.interface,
        _cachedFallbackProvider
      );
      return await fb.queryFilter(filter, fromBlock, toBlock);
    } catch {
      // Cached fallback died, clear it
      _cachedFallbackProvider = null;
      _cachedFallbackIndex = -1;
    }
  }

  // Try the hardhat-provided provider (primary)
  try {
    return await withRetry(
      () => contract.queryFilter(filter, fromBlock, toBlock),
      `${label} (primary)`,
      2,
      2000
    );
  } catch (primaryErr: any) {
    log(`  Primary RPC failed for ${label}: ${primaryErr.message.slice(0, 80)}`);
  }

  // Fallback: try alternative RPCs
  const rpcs =
    network.name === "base-mainnet" ? BASE_MAINNET_RPCS : BASE_SEPOLIA_RPCS;

  for (let i = 1; i < rpcs.length; i++) {
    try {
      log(`  Trying fallback RPC #${i}: ${rpcs[i].slice(0, 35)}...`);
      const fallbackProvider = createFallbackProvider(rpcs[i]);
      const fallbackContract = new ethers.Contract(
        contractAddr,
        contract.interface,
        fallbackProvider
      );
      const result = await withRetry(
        () => fallbackContract.queryFilter(filter, fromBlock, toBlock),
        `${label} (fallback #${i})`,
        2,
        2000
      );
      // Cache this working provider
      _cachedFallbackProvider = fallbackProvider;
      _cachedFallbackIndex = i;
      log(`  Fallback #${i} succeeded (cached)`);
      return result;
    } catch (err: any) {
      log(`  Fallback #${i} failed: ${err.message.slice(0, 80)}`);
    }
  }

  // All failed — return empty and log
  log(`  WARNING: All RPCs failed for ${label} blocks ${fromBlock}-${toBlock}. Skipping.`);
  return [];
}

// --- Main scan ---
async function runOnce() {
  const NFT_ADDRESS = process.env.V3_NFT_ADDRESS;
  const MARKETPLACE_ADDRESS = process.env.V3_MARKETPLACE_ADDRESS;

  if (!NFT_ADDRESS || !MARKETPLACE_ADDRESS) {
    log("ERROR: Set V3_NFT_ADDRESS and V3_MARKETPLACE_ADDRESS in .env");
    process.exit(1);
  }

  log("=== MISOGYNY.EXE — Event Indexer ===");
  log(`Network: ${network.name}`);
  log(`NFT:     ${NFT_ADDRESS}`);
  log(`Market:  ${MARKETPLACE_ADDRESS}`);

  const nft = await ethers.getContractAt("MisogynyNFT", NFT_ADDRESS);
  const marketplace = await ethers.getContractAt(
    "MisogynyMarketplace",
    MARKETPLACE_ADDRESS
  );

  // Load existing state or start fresh
  let state = loadState();
  const currentBlock = await withRetry(
    () => ethers.provider.getBlockNumber(),
    "getBlockNumber"
  );

  if (
    state &&
    state.nftAddress === NFT_ADDRESS &&
    state.marketplaceAddress === MARKETPLACE_ADDRESS
  ) {
    log(`Resuming from block ${state.lastBlock + 1} (current: ${currentBlock})`);
  } else {
    log("Starting fresh index...");
    // Look back from deployment block or env var, default 500k blocks (~11 days on Base)
    const deployBlock = process.env.V3_DEPLOY_BLOCK
      ? parseInt(process.env.V3_DEPLOY_BLOCK)
      : currentBlock - 500000;
    state = {
      network: network.name,
      nftAddress: NFT_ADDRESS,
      marketplaceAddress: MARKETPLACE_ADDRESS,
      lastBlock: deployBlock,
      updatedAt: "",
      tokens: [],
      listings: [],
      sales: [],
    };
  }

  const fromBlock = state.lastBlock + 1;
  if (fromBlock > currentBlock) {
    log("Already up to date.");
    return;
  }

  const totalBlocks = currentBlock - fromBlock + 1;
  log(`Scanning ${totalBlocks} blocks (${fromBlock} → ${currentBlock})...`);

  let scanned = fromBlock;
  let newMints = 0;
  let newListings = 0;
  let newSales = 0;
  let newCancels = 0;

  while (scanned <= currentBlock) {
    const toBlock = Math.min(scanned + CHUNK_SIZE - 1, currentBlock);
    const pct = Math.round(((scanned - fromBlock) / totalBlocks) * 100);
    log(`  [${pct}%] Blocks ${scanned} — ${toBlock}`);

    // --- NFT Transfer events (mint = from 0x0) ---
    const transferFilter = nft.filters.Transfer();
    const transferLogs = await queryWithFallback(
      nft,
      transferFilter,
      scanned,
      toBlock,
      "Transfer"
    );

    for (const txLog of transferLogs) {
      const args = (txLog as any).args;
      const from = args[0];
      const to = args[1];
      const tokenId = Number(args[2]);

      if (from === ethers.ZeroAddress) {
        // Mint event
        let uri = "";
        try {
          uri = await nft.tokenURI(tokenId);
        } catch {}

        const existing = state!.tokens.find((t) => t.tokenId === tokenId);
        if (!existing) {
          state!.tokens.push({
            tokenId,
            owner: to,
            uri,
            mintTx: txLog.transactionHash,
            mintBlock: txLog.blockNumber,
          });
          newMints++;
          log(`    Mint: token #${tokenId} → ${to.slice(0, 10)}...`);
        }
      } else {
        // Transfer (sale settled) — update owner
        const token = state!.tokens.find((t) => t.tokenId === tokenId);
        if (token) token.owner = to;
      }
    }

    // --- Marketplace Listed events ---
    const listedFilter = marketplace.filters.Listed();
    const listedLogs = await queryWithFallback(
      marketplace,
      listedFilter,
      scanned,
      toBlock,
      "Listed"
    );

    for (const txLog of listedLogs) {
      const args = (txLog as any).args;
      const tokenId = Number(args[0]);
      const seller = args[1];
      const price = ethers.formatEther(args[2]);

      // Deactivate any old listing for this token
      state!.listings
        .filter((l) => l.tokenId === tokenId && l.active)
        .forEach((l) => (l.active = false));

      state!.listings.push({
        tokenId,
        seller,
        price,
        tx: txLog.transactionHash,
        block: txLog.blockNumber,
        active: true,
      });
      newListings++;
      log(`    Listed: token #${tokenId} for ${price} ETH`);
    }

    // --- Marketplace Sold events ---
    const soldFilter = marketplace.filters.Sold();
    const soldLogs = await queryWithFallback(
      marketplace,
      soldFilter,
      scanned,
      toBlock,
      "Sold"
    );

    for (const txLog of soldLogs) {
      const args = (txLog as any).args;
      const tokenId = Number(args[0]);
      const seller = args[1];
      const buyer = args[2];
      const price = ethers.formatEther(args[3]);

      state!.sales.push({
        tokenId,
        seller,
        buyer,
        price,
        tx: txLog.transactionHash,
        block: txLog.blockNumber,
      });

      state!.listings
        .filter((l) => l.tokenId === tokenId && l.active)
        .forEach((l) => (l.active = false));

      const token = state!.tokens.find((t) => t.tokenId === tokenId);
      if (token) token.owner = buyer;

      newSales++;
      log(`    Sold: token #${tokenId} for ${price} ETH`);
    }

    // --- Marketplace Cancelled events ---
    const cancelFilter = marketplace.filters.Cancelled();
    const cancelLogs = await queryWithFallback(
      marketplace,
      cancelFilter,
      scanned,
      toBlock,
      "Cancelled"
    );

    for (const txLog of cancelLogs) {
      const args = (txLog as any).args;
      const tokenId = Number(args[0]);

      state!.listings
        .filter((l) => l.tokenId === tokenId && l.active)
        .forEach((l) => (l.active = false));

      newCancels++;
      log(`    Cancelled: token #${tokenId}`);
    }

    // Save after each chunk (crash resilience)
    state!.lastBlock = toBlock;
    state!.updatedAt = new Date().toISOString();
    saveState(state!);

    scanned = toBlock + 1;
  }

  // Summary
  const activeListings = state!.listings.filter((l) => l.active);
  log(`\n=== Index Summary ===`);
  log(`Tokens minted:   ${state!.tokens.length} (+${newMints} new)`);
  log(`Active listings: ${activeListings.length} (+${newListings} new)`);
  log(`Total sales:     ${state!.sales.length} (+${newSales} new)`);
  log(`Cancellations:   +${newCancels}`);
  log(`Last block:      ${state!.lastBlock}`);
  log(`Saved to:        ${INDEX_PATH}`);
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
