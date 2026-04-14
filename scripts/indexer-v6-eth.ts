import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  createPublicClient,
  http,
  parseAbiItem,
  formatEther,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { mainnet, sepolia } from "viem/chains";

dotenv.config({ path: [".env.local", ".env"] });

/**
 * MISOGYNY.EXE V6 — Ethereum Event Indexer
 *
 * Watches the Rare Protocol Bazaar contract for Sold/AuctionSettled events
 * on our collection. Uses viem (NOT Hardhat/ethers).
 *
 * Features:
 *   - RPC fallback: tries multiple public endpoints
 *   - Retry logic: exponential backoff on RPC errors
 *   - Watch mode: continuous polling with configurable interval
 *   - Crash resilience: saves state after each chunk
 *   - Log rotation: 10MB max log file
 *
 * Usage:
 *   npx ts-node scripts/indexer-v6-eth.ts           # single scan, exit
 *   npx ts-node scripts/indexer-v6-eth.ts --watch    # continuous polling
 */

// --- Types ---

interface Sale {
  tokenId: number;
  seller: string;
  buyer: string;
  price: string; // ETH
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

// --- Config ---

const RARE_CHAIN = process.env.RARE_CHAIN || "sepolia";
const COLLECTION_ADDRESS = (process.env.RARE_CONTRACT_ADDRESS || "") as Address;

const BAZAAR_ADDRESSES: Record<string, Address> = {
  mainnet: "0x6D7c44773C52D396F43c2D511B81aa168E9a7a42",
  sepolia: "0xC8Edc7049b233641ad3723D6C60019D1c8771612",
};

const BAZAAR_ADDRESS = BAZAAR_ADDRESSES[RARE_CHAIN];

// Fallback RPC endpoints for Ethereum mainnet
const ETH_MAINNET_RPCS = [
  process.env.ETHEREUM_MAINNET_RPC_URL || "https://eth.llamarpc.com",
  "https://eth.llamarpc.com",
  "https://1rpc.io/eth",
  "https://rpc.ankr.com/eth",
];

const ETH_SEPOLIA_RPCS = [
  process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  "https://rpc.sepolia.org",
];

const INDEX_PATH = path.join(__dirname, "..", "data", "index-v6-eth.json");
const LOG_PATH = path.join(__dirname, "..", "logs", "indexer-v6-eth.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB log rotation
const CHUNK_SIZE = 2000; // blocks per query (avoid RPC limits)
const WATCH_INTERVAL_S = 60;

// --- ABI ---

// Rare Bazaar Sold event — emitted on direct sale + buy-now
const SOLD_EVENT = parseAbiItem(
  "event Sold(address indexed _originContract, address indexed _buyer, address _seller, uint256 _amount, uint256 _tokenId)"
);

// Rare Bazaar AuctionSettled event — emitted when an auction ends
const AUCTION_SETTLED_EVENT = parseAbiItem(
  "event AuctionSettled(address indexed _contractAddress, uint256 indexed _tokenId, address _winner, address _seller, uint256 _amount)"
);

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- State I/O (atomic writes) ---

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
  baseDelay = 3000,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        log(`  Retry ${attempt}/${maxAttempts} for ${label} in ${delay}ms: ${err.message?.slice(0, 100)}`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// --- RPC client with fallback ---

let _cachedClient: PublicClient<Transport, Chain> | null = null;
let _cachedRpcIndex = -1;

function getChain(): Chain {
  return RARE_CHAIN === "mainnet" ? mainnet : sepolia;
}

function getRpcList(): string[] {
  const rpcs = RARE_CHAIN === "mainnet" ? ETH_MAINNET_RPCS : ETH_SEPOLIA_RPCS;
  // Deduplicate while preserving order
  return [...new Set(rpcs)];
}

function createClient(rpcUrl: string): PublicClient<Transport, Chain> {
  return createPublicClient({
    chain: getChain(),
    transport: http(rpcUrl, { timeout: 30_000 }),
  }) as PublicClient<Transport, Chain>;
}

async function getClient(): Promise<PublicClient<Transport, Chain>> {
  // Try cached client first
  if (_cachedClient) {
    try {
      await _cachedClient.getBlockNumber();
      return _cachedClient;
    } catch {
      _cachedClient = null;
      _cachedRpcIndex = -1;
    }
  }

  const rpcs = getRpcList();
  for (let i = 0; i < rpcs.length; i++) {
    try {
      const client = createClient(rpcs[i]);
      await client.getBlockNumber();
      _cachedClient = client;
      _cachedRpcIndex = i;
      if (i > 0) log(`  Using fallback RPC #${i}: ${rpcs[i].slice(0, 35)}...`);
      return client;
    } catch (err: any) {
      log(`  RPC #${i} failed (${rpcs[i].slice(0, 35)}...): ${err.message?.slice(0, 80)}`);
    }
  }

  throw new Error("All RPC endpoints failed");
}

// --- Query with fallback ---

async function queryLogsWithFallback<T>(
  queryFn: (client: PublicClient<Transport, Chain>) => Promise<T>,
  label: string,
): Promise<T> {
  // Try cached client first
  if (_cachedClient) {
    try {
      return await withRetry(() => queryFn(_cachedClient!), `${label} (cached)`, 2, 2000);
    } catch {
      _cachedClient = null;
      _cachedRpcIndex = -1;
    }
  }

  // Try all RPCs
  const rpcs = getRpcList();
  const startIdx = Math.max(0, _cachedRpcIndex);

  for (let offset = 0; offset < rpcs.length; offset++) {
    const i = (startIdx + offset) % rpcs.length;
    try {
      const client = createClient(rpcs[i]);
      const result = await withRetry(() => queryFn(client), `${label} (rpc #${i})`, 2, 2000);
      _cachedClient = client;
      _cachedRpcIndex = i;
      return result;
    } catch (err: any) {
      log(`  RPC #${i} failed for ${label}: ${err.message?.slice(0, 80)}`);
    }
  }

  log(`  WARNING: All RPCs failed for ${label}. Returning empty.`);
  return [] as unknown as T;
}

// --- Main scan ---

async function runOnce(): Promise<void> {
  if (!COLLECTION_ADDRESS) {
    log("ERROR: Set RARE_CONTRACT_ADDRESS in .env");
    process.exit(1);
  }

  if (!BAZAAR_ADDRESS) {
    log(`ERROR: No Bazaar address for chain "${RARE_CHAIN}". Use "mainnet" or "sepolia".`);
    process.exit(1);
  }

  log("=== MISOGYNY.EXE V6 — Ethereum Event Indexer ===");
  log(`Chain:      ${RARE_CHAIN} (${getChain().id})`);
  log(`Collection: ${COLLECTION_ADDRESS}`);
  log(`Bazaar:     ${BAZAAR_ADDRESS}`);

  const client = await getClient();
  const currentBlock = Number(await withRetry(
    () => client.getBlockNumber(),
    "getBlockNumber",
  ));

  // Load or initialize state
  let state = loadState();

  if (
    state &&
    state.collectionAddress.toLowerCase() === COLLECTION_ADDRESS.toLowerCase() &&
    state.bazaarAddress.toLowerCase() === BAZAAR_ADDRESS.toLowerCase()
  ) {
    log(`Resuming from block ${state.lastBlock + 1} (current: ${currentBlock})`);
  } else {
    log("Starting fresh index...");
    // Look back ~7 days on Ethereum mainnet (~50k blocks) or use env override
    const deployBlock = process.env.V6_DEPLOY_BLOCK
      ? parseInt(process.env.V6_DEPLOY_BLOCK)
      : currentBlock - 50000;
    state = {
      chain: RARE_CHAIN,
      collectionAddress: COLLECTION_ADDRESS,
      bazaarAddress: BAZAAR_ADDRESS,
      lastBlock: deployBlock,
      updatedAt: "",
      sales: [],
    };
  }

  const fromBlock = state.lastBlock + 1;
  if (fromBlock > currentBlock) {
    log("Already up to date.");
    return;
  }

  const totalBlocks = currentBlock - fromBlock + 1;
  log(`Scanning ${totalBlocks} blocks (${fromBlock} -> ${currentBlock})...`);

  let scanned = fromBlock;
  let newSales = 0;

  // Track existing sales to avoid duplicates
  const existingTxSet = new Set(state.sales.map((s) => `${s.tx}-${s.tokenId}`));

  while (scanned <= currentBlock) {
    const toBlock = Math.min(scanned + CHUNK_SIZE - 1, currentBlock);
    const pct = Math.round(((scanned - fromBlock) / totalBlocks) * 100);
    log(`  [${pct}%] Blocks ${scanned} - ${toBlock}`);

    // --- Query Sold events ---
    const soldLogs = await queryLogsWithFallback(
      (c) =>
        c.getLogs({
          address: BAZAAR_ADDRESS,
          event: SOLD_EVENT,
          args: {
            _originContract: COLLECTION_ADDRESS,
          },
          fromBlock: BigInt(scanned),
          toBlock: BigInt(toBlock),
        }),
      "Sold",
    );

    for (const log_ of soldLogs) {
      const { _buyer, _seller, _amount, _tokenId } = log_.args as {
        _buyer?: Address;
        _seller?: Address;
        _amount?: bigint;
        _tokenId?: bigint;
      };

      if (!_buyer || !_seller || _amount === undefined || _tokenId === undefined) continue;

      const tokenId = Number(_tokenId);
      const txKey = `${log_.transactionHash}-${tokenId}`;
      if (existingTxSet.has(txKey)) continue;

      const sale: Sale = {
        tokenId,
        seller: _seller,
        buyer: _buyer,
        price: formatEther(_amount),
        tx: log_.transactionHash,
        block: Number(log_.blockNumber),
      };

      state.sales.push(sale);
      existingTxSet.add(txKey);
      newSales++;
      log(`    Sold: token #${tokenId} for ${sale.price} ETH (${_seller.slice(0, 10)}... -> ${_buyer.slice(0, 10)}...)`);
    }

    // --- Query AuctionSettled events ---
    const auctionLogs = await queryLogsWithFallback(
      (c) =>
        c.getLogs({
          address: BAZAAR_ADDRESS,
          event: AUCTION_SETTLED_EVENT,
          args: {
            _contractAddress: COLLECTION_ADDRESS,
          },
          fromBlock: BigInt(scanned),
          toBlock: BigInt(toBlock),
        }),
      "AuctionSettled",
    );

    for (const log_ of auctionLogs) {
      const { _tokenId, _winner, _seller, _amount } = log_.args as {
        _tokenId?: bigint;
        _winner?: Address;
        _seller?: Address;
        _amount?: bigint;
      };

      if (!_winner || !_seller || _amount === undefined || _tokenId === undefined) continue;

      const tokenId = Number(_tokenId);
      const txKey = `${log_.transactionHash}-${tokenId}`;
      if (existingTxSet.has(txKey)) continue;

      const sale: Sale = {
        tokenId,
        seller: _seller,
        buyer: _winner,
        price: formatEther(_amount),
        tx: log_.transactionHash,
        block: Number(log_.blockNumber),
      };

      state.sales.push(sale);
      existingTxSet.add(txKey);
      newSales++;
      log(`    AuctionSettled: token #${tokenId} for ${sale.price} ETH (winner: ${_winner.slice(0, 10)}...)`);
    }

    // Save after each chunk (crash resilience)
    state.lastBlock = toBlock;
    state.updatedAt = new Date().toISOString();
    saveState(state);

    scanned = toBlock + 1;
  }

  // Summary
  log(`\n=== Index Summary ===`);
  log(`Total sales:  ${state.sales.length} (+${newSales} new)`);
  log(`Last block:   ${state.lastBlock}`);
  log(`Saved to:     ${INDEX_PATH}`);
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const isWatch = args.includes("--watch");

  if (isWatch) {
    log(`=== Watch mode: polling every ${WATCH_INTERVAL_S}s ===`);
    let running = true;
    const shutdown = () => {
      log("\nShutting down...");
      running = false;
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    while (running) {
      try {
        await runOnce();
      } catch (err: any) {
        log(`Watch error: ${err.message}`);
      }
      log(`Sleeping ${WATCH_INTERVAL_S}s...\n`);
      const sleepMs = WATCH_INTERVAL_S * 1000;
      const chunk = 5000;
      let slept = 0;
      while (slept < sleepMs && running) {
        await sleep(Math.min(chunk, sleepMs - slept));
        slept += chunk;
      }
    }
    log("Indexer stopped.");
  } else {
    await runOnce();
  }
}

main().catch((error) => {
  log(`FATAL: ${error.message}`);
  process.exitCode = 1;
});
