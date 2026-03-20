import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, mainnet } from "viem/chains";

dotenv.config();

/**
 * MISOGYNY.EXE — Rare Protocol Mint Pipeline
 *
 * Drop-in replacement for auto-mint.ts that uses Rare Protocol CLI
 * instead of Hardhat for ERC-721 deploy, mint (with IPFS), and auctions.
 *
 * Designed for SuperRare Partner Track (EF Synthesis Hackathon).
 *
 * Usage:
 *   npm run rare:mint              # Process queue on Sepolia
 *   npm run rare:mint:mainnet      # Process queue on Mainnet
 *   npm run rare:deploy            # Deploy new collection on Sepolia
 *   npm run rare:deploy:mainnet    # Deploy new collection on Mainnet
 *
 * Env vars:
 *   RARE_CONTRACT_ADDRESS   — Deployed Rare Protocol ERC-721 contract
 *   RARE_CHAIN              — Chain to use (sepolia or mainnet, default: sepolia)
 *   RARE_AUCTION_DURATION   — Auction duration in seconds (default: 86400 = 24h)
 *   RARE_STARTING_PRICE     — Auction starting price in ETH (default: 0.01)
 *   RARE_ROYALTY_RECEIVER   — Royalty receiver address (default: deployer wallet)
 */

import {
  computeQueueHmac,
} from "./scraper";
import type { Queue } from "./scraper";

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

const LOG_PATH = path.join(__dirname, "..", "logs", "rare-mint.log");
const DATA_DIR = path.join(__dirname, "..", "data");
const ARTWORKS_DIR = path.join(DATA_DIR, "artworks");

const RARE_CHAIN = process.env.RARE_CHAIN || "sepolia";
const RARE_CONTRACT = process.env.RARE_CONTRACT_ADDRESS || "";
const AUCTION_DURATION = process.env.RARE_AUCTION_DURATION || "86400";
const STARTING_PRICE = process.env.RARE_STARTING_PRICE || "0.01";
const ROYALTY_RECEIVER = process.env.RARE_ROYALTY_RECEIVER || "";

// Revenue split addresses
const CHARITY_ADDRESS = process.env.CHARITY_ADDRESS as Address || "0x0000000000000000000000000000000000000001" as Address;
const ARTIST_ADDRESS = process.env.ARTIST_ADDRESS as Address || "0x0000000000000000000000000000000000000002" as Address;
const PROJECT_ADDRESS = process.env.PROJECT_ADDRESS as Address || "0x0000000000000000000000000000000000000003" as Address;

// Split ratios (must sum to 100)
const CHARITY_SPLIT = 50;
const ARTIST_SPLIT = 30;
const PROJECT_SPLIT = 20;

// SuperRare auction contract addresses
const AUCTION_CONTRACTS: Record<string, Address> = {
  sepolia: "0xC8Edc7049b233641ad3723D6C60019D1c8771612",
  mainnet: "0x6D7c44773C52D396F43c2D511B81aa168E9a7a42",
};

// Minimal ABI for configureAuction + setApprovalForAll
const BAZAAR_ABI = [
  {
    name: "configureAuction",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_auctionType", type: "bytes32" },
      { name: "_originContract", type: "address" },
      { name: "_tokenId", type: "uint256" },
      { name: "_startingAmount", type: "uint256" },
      { name: "_currencyAddress", type: "address" },
      { name: "_lengthOfAuction", type: "uint256" },
      { name: "_startTime", type: "uint256" },
      { name: "_splitAddresses", type: "address[]" },
      { name: "_splitRatios", type: "uint8[]" },
    ],
    outputs: [],
  },
] as const;

const NFT_ABI = [
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

// COLDIE_AUCTION type hash
const COLDIE_AUCTION = "0x434f4c4449455f41554354494f4e000000000000000000000000000000000000" as `0x${string}`;
const ETH_ZERO = "0x0000000000000000000000000000000000000000" as Address;

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

function rareExec(cmd: string): string {
  log(`  $ rare ${cmd}`);
  try {
    const output = execSync(`rare ${cmd}`, {
      encoding: "utf-8",
      timeout: 5 * 60 * 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim();
  } catch (err: any) {
    const errOutput = (err.stdout || "") + (err.stderr || "");
    throw new Error(`Rare CLI failed: ${errOutput.slice(0, 500)}`);
  }
}

// --- Deploy a new collection ---

function deployCollection(name: string, symbol: string): string {
  log(`Deploying collection: ${name} (${symbol}) on ${RARE_CHAIN}...`);
  const output = rareExec(
    `deploy erc721 "${name}" "${symbol}" --chain ${RARE_CHAIN}`
  );
  log(`  Deploy output: ${output}`);

  // Parse contract address from output
  const match = output.match(/0x[a-fA-F0-9]{40}/);
  if (!match) throw new Error("Could not parse contract address from deploy output");

  const address = match[0];
  log(`  Contract deployed: ${address}`);
  return address;
}

// --- Mint a single NFT via Rare Protocol CLI ---

interface MintResult {
  tokenId: number;
  txHash?: string;
}

async function mintNFT(
  contractAddress: string,
  name: string,
  description: string,
  imagePath: string,
): Promise<MintResult> {
  log(`  Minting: "${name.slice(0, 60)}..."`);

  // Build mint command with image upload (Rare CLI handles IPFS pinning)
  let cmd = `mint --contract ${contractAddress} --chain ${RARE_CHAIN}`;
  cmd += ` --name "${name.replace(/"/g, '\\"')}"`;
  cmd += ` --description "${description.replace(/"/g, '\\"')}"`;
  cmd += ` --image "${imagePath}"`;
  cmd += ` --tag misogyny --tag art --tag autonomous-agent`;

  if (ROYALTY_RECEIVER) {
    cmd += ` --royalty-receiver ${ROYALTY_RECEIVER}`;
  }

  const output = rareExec(cmd);
  log(`  Mint output: ${output}`);

  // Parse token ID from output
  const tokenMatch = output.match(/token\s*(?:id|#)?:?\s*(\d+)/i);
  const tokenId = tokenMatch ? parseInt(tokenMatch[1]) : 0;

  // Parse tx hash
  const txMatch = output.match(/0x[a-fA-F0-9]{64}/);
  const txHash = txMatch ? txMatch[0] : undefined;

  return { tokenId, txHash };
}

// --- Create auction with revenue splits via direct contract call ---

async function createAuctionWithSplits(
  contractAddress: string,
  tokenId: number,
  startingPrice: string,
  duration: string,
): Promise<void> {
  const auctionAddress = AUCTION_CONTRACTS[RARE_CHAIN];
  if (!auctionAddress) throw new Error(`No auction contract for chain: ${RARE_CHAIN}`);

  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
  if (!privateKey) throw new Error("PRIVATE_KEY not set");

  const chain = RARE_CHAIN === "mainnet" ? mainnet : sepolia;
  const rpcUrl = RARE_CHAIN === "mainnet"
    ? (process.env.BASE_MAINNET_RPC_URL || "https://eth.llamarpc.com")
    : "https://ethereum-sepolia-rpc.publicnode.com";

  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  log(`  Creating auction for token #${tokenId} with revenue splits...`);
  log(`    Charity (${CHARITY_SPLIT}%): ${CHARITY_ADDRESS}`);
  log(`    Artist  (${ARTIST_SPLIT}%): ${ARTIST_ADDRESS}`);
  log(`    Project (${PROJECT_SPLIT}%): ${PROJECT_ADDRESS}`);

  // Check approval
  const approved = await publicClient.readContract({
    address: contractAddress as Address,
    abi: NFT_ABI,
    functionName: "isApprovedForAll",
    args: [account.address, auctionAddress],
  });

  if (!approved) {
    log("  Approving auction contract...");
    const approveTx = await walletClient.writeContract({
      address: contractAddress as Address,
      abi: NFT_ABI,
      functionName: "setApprovalForAll",
      args: [auctionAddress, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    log(`  Approved: ${approveTx}`);
  }

  // Create auction with splits
  const tx = await walletClient.writeContract({
    address: auctionAddress,
    abi: BAZAAR_ABI,
    functionName: "configureAuction",
    args: [
      COLDIE_AUCTION,
      contractAddress as Address,
      BigInt(tokenId),
      parseEther(startingPrice),
      ETH_ZERO, // ETH currency
      BigInt(duration),
      BigInt(0), // startTime 0 = starts on first bid
      [CHARITY_ADDRESS, ARTIST_ADDRESS, PROJECT_ADDRESS],
      [CHARITY_SPLIT, ARTIST_SPLIT, PROJECT_SPLIT],
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  log(`  Auction created with splits! Block: ${receipt.blockNumber}, tx: ${tx}`);
}

// --- Generate placeholder artwork ---

function ensureArtwork(artworkPath: string, quote: string): string {
  if (fs.existsSync(artworkPath)) return artworkPath;

  // Generate a simple SVG artwork
  const dir = path.dirname(artworkPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const escapedQuote = quote
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // Split quote into lines for SVG text wrapping
  const words = escapedQuote.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).length > 35) {
      lines.push(current.trim());
      current = w;
    } else {
      current += " " + w;
    }
  }
  if (current.trim()) lines.push(current.trim());

  const lineHeight = 48;
  const startY = 400 - (lines.length * lineHeight) / 2;
  const textLines = lines
    .map((l, i) => `<text x="400" y="${startY + i * lineHeight}" text-anchor="middle" font-family="serif" font-size="32" font-weight="bold" fill="white">${l}</text>`)
    .join("\n    ");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
  <rect width="800" height="800" fill="black"/>
  <text x="400" y="60" text-anchor="middle" font-family="monospace" font-size="18" fill="#e20000" letter-spacing="8">MISOGYNY.EXE</text>
  <line x1="100" y1="80" x2="700" y2="80" stroke="#333" stroke-width="1"/>
  ${textLines}
  <line x1="100" y1="720" x2="700" y2="720" stroke="#333" stroke-width="1"/>
  <text x="400" y="760" text-anchor="middle" font-family="monospace" font-size="12" fill="#555">Autonomous Agent • On-Chain Art • ${new Date().toISOString().slice(0, 10)}</text>
</svg>`;

  // Save as SVG (Rare CLI supports SVG uploads)
  const svgPath = artworkPath.replace(/\.png$/, ".svg");
  fs.writeFileSync(svgPath, svg);
  log(`  Generated artwork: ${svgPath}`);
  return svgPath;
}

// --- Process the mint queue ---

async function processQueue() {
  if (!RARE_CONTRACT) {
    log("ERROR: Set RARE_CONTRACT_ADDRESS in .env");
    log("Deploy first: npm run rare:deploy");
    process.exit(1);
  }

  const queue = loadQueue();
  const pending = queue.items.filter(
    (i) => i.status === "pending" || (i.status === "failed" && (i.retries || 0) < 3)
  );

  if (pending.length === 0) {
    log("No pending items in queue");
    return;
  }

  log(`Processing ${pending.length} pending items on ${RARE_CHAIN}...`);

  for (const item of pending) {
    // Verify HMAC integrity
    if (item.hmac) {
      const expected = computeQueueHmac(item);
      if (item.hmac !== expected) {
        log(`  SECURITY: HMAC mismatch for #${item.id} — skipping (possible tampering)`);
        item.status = "failed";
        item.error = "HMAC integrity check failed";
        continue;
      }
    }

    try {
      // Step 1: Generate artwork if missing
      item.status = "uploading";
      saveQueue(queue);

      const artworkPath = ensureArtwork(item.artworkPath, item.quote);

      // Step 2: Mint via Rare Protocol CLI (handles IPFS upload)
      item.status = "minting";
      saveQueue(queue);

      const description = `"${item.quote}"\n\n— ${item.attribution}\n\nAutonomously scraped, classified, and minted by MISOGYNY.EXE. An anti-misogyny art project that turns real misogynistic quotes into confrontational typographic NFTs.`;
      const name = `MISOGYNY.EXE — "${item.quote.slice(0, 50)}${item.quote.length > 50 ? "..." : ""}"`;

      const mintResult = await mintNFT(RARE_CONTRACT, name, description, artworkPath);
      item.tokenId = mintResult.tokenId;
      item.mintTx = mintResult.txHash;

      // Step 3: Create auction with charity/artist/project splits
      if (mintResult.tokenId > 0) {
        item.status = "listing";
        saveQueue(queue);

        await createAuctionWithSplits(
          RARE_CONTRACT,
          mintResult.tokenId,
          STARTING_PRICE,
          AUCTION_DURATION,
        );
      }

      item.status = "done";
      log(`  Done: #${item.id} → token #${item.tokenId}`);
    } catch (err: any) {
      item.status = "failed";
      item.error = err.message?.slice(0, 200);
      item.retries = (item.retries || 0) + 1;
      item.lastAttempt = new Date().toISOString();
      log(`  Failed #${item.id}: ${err.message?.slice(0, 200)}`);
    }

    saveQueue(queue);
  }

  const done = queue.items.filter((i) => i.status === "done").length;
  const failed = queue.items.filter((i) => i.status === "failed").length;
  log(`\nQueue: ${done} done, ${failed} failed, ${queue.items.length} total`);
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--deploy")) {
    const address = deployCollection("MISOGYNY.EXE", "MSGNX");
    log(`\nAdd to .env:\nRARE_CONTRACT_ADDRESS=${address}`);
    return;
  }

  if (args.includes("--status")) {
    if (!RARE_CONTRACT) {
      log("No RARE_CONTRACT_ADDRESS set");
      return;
    }
    const output = rareExec(`status --contract ${RARE_CONTRACT} --chain ${RARE_CHAIN}`);
    console.log(output);
    return;
  }

  await processQueue();
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
});
