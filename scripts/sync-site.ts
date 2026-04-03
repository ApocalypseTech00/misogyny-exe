import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { execSync } from "child_process";
import { generateAnimation, pickAnimationStyle } from "./generate-animation";

dotenv.config({ path: [".env.local", ".env"] });

/**
 * MISOGYNY.EXE — Site Sync
 *
 * Polls the NFT contract for new mints, fetches metadata from IPFS,
 * downloads artwork + animation, updates tokens.json, and redeploys to Surge.
 *
 * Designed to run as a cron job on the Hetzner server or locally.
 * No Pi access needed — everything comes from on-chain + IPFS.
 *
 * Usage:
 *   npx ts-node scripts/sync-site.ts                    # Sync + deploy
 *   npx ts-node scripts/sync-site.ts --dry-run           # Check only, no deploy
 *   npx ts-node scripts/sync-site.ts --no-deploy          # Sync files, skip Surge deploy
 *   npx ts-node scripts/sync-site.ts --domain custom.surge.sh  # Deploy to custom domain
 */

const ROOT = path.join(__dirname, "..");
const SITE_DIR = path.join(ROOT, "site");
const TOKENS_PATH = path.join(SITE_DIR, "tokens.json");
const NFT_IMAGES_DIR = path.join(SITE_DIR, "nft-images");
const ANIMATIONS_DIR = path.join(SITE_DIR, "animations");
const LOG_PATH = path.join(ROOT, "logs", "sync-site.log");

const DRY_RUN = process.argv.includes("--dry-run");
const NO_DEPLOY = process.argv.includes("--no-deploy");
const DOMAIN_FLAG = process.argv.indexOf("--domain");
const SURGE_DOMAINS = DOMAIN_FLAG > -1
  ? [process.argv[DOMAIN_FLAG + 1]]
  : ["apocalypsetech.surge.sh", "apocalypsetech.xyz"];

const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
];

const RPC_URL = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const NFT_ADDRESS = process.env.V3_NFT_ADDRESS!;
const MARKETPLACE_ADDRESS = process.env.V3_MARKETPLACE_ADDRESS!;

const NFT_ABI = [
  "function totalSupply() view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const MKT_ABI = [
  "function listings(uint256 tokenId) view returns (address seller, uint256 price)",
];

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

interface TokenEntry {
  tokenId: number;
  name: string;
  quote: string;
  attribution: string;
  price: string;
  animStyle: string;
}

function loadTokens(): TokenEntry[] {
  if (!fs.existsSync(TOKENS_PATH)) return [];
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
}

function saveTokens(tokens: TokenEntry[]) {
  tokens.sort((a, b) => a.tokenId - b.tokenId);
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

/**
 * Fetch JSON from IPFS with gateway fallback.
 */
async function fetchIPFS(cid: string): Promise<any> {
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const url = gateway + cid;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
    } catch {}
  }
  throw new Error(`Failed to fetch IPFS CID: ${cid}`);
}

/**
 * Download a file from IPFS to disk.
 */
async function downloadIPFS(cid: string, destPath: string): Promise<boolean> {
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const url = gateway + cid;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(destPath, buffer);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Extract CID from ipfs:// URI or gateway URL.
 */
function extractCID(uri: string): string {
  if (uri.startsWith("ipfs://")) return uri.slice(7);
  // Try to extract from gateway URL
  const match = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : uri;
}

async function main() {
  log("=== MISOGYNY.EXE — Site Sync ===");
  log(`NFT contract: ${NFT_ADDRESS}`);
  log(`Dry run: ${DRY_RUN}`);
  log(`Deploy: ${!NO_DEPLOY && !DRY_RUN}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const nft = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
  const mkt = new ethers.Contract(MARKETPLACE_ADDRESS, MKT_ABI, provider);

  // 1. Get total supply
  const totalSupply = Number(await nft.totalSupply());
  log(`On-chain totalSupply: ${totalSupply}`);

  // 2. Load current tokens
  const tokens = loadTokens();
  const existingIds = new Set(tokens.map((t) => t.tokenId));
  log(`Site has ${tokens.length} tokens (IDs: ${[...existingIds].join(", ")})`);

  // 3. Find missing tokens
  const missing: number[] = [];
  for (let i = 1; i <= totalSupply; i++) {
    if (!existingIds.has(i)) missing.push(i);
  }

  if (missing.length === 0) {
    log("Site is up to date — no new tokens.");
    return;
  }

  log(`\nFound ${missing.length} new token(s): ${missing.join(", ")}\n`);

  if (DRY_RUN) {
    for (const tokenId of missing) {
      try {
        const uri = await nft.tokenURI(tokenId);
        log(`  #${tokenId}: ${uri}`);
      } catch (e: any) {
        log(`  #${tokenId}: ERROR — ${e.message.slice(0, 80)}`);
      }
    }
    log("\n[DRY RUN] No changes made.");
    return;
  }

  // 4. Fetch metadata and assets for each missing token
  let added = 0;
  for (const tokenId of missing) {
    try {
      log(`Processing token #${tokenId}...`);

      // Fetch tokenURI
      let uri: string;
      try {
        uri = await nft.tokenURI(tokenId);
      } catch {
        log(`  Skipping #${tokenId} — tokenURI call failed (may not exist)`);
        continue;
      }

      const metadataCid = extractCID(uri);
      log(`  Metadata CID: ${metadataCid}`);

      // Fetch metadata from IPFS
      const metadata = await fetchIPFS(metadataCid);
      log(`  Name: ${metadata.name}`);

      // Extract quote and attribution from attributes
      const attrs = metadata.attributes || [];
      const quote = attrs.find((a: any) => a.trait_type === "Quote")?.value || metadata.name;
      const attribution = attrs.find((a: any) => a.trait_type === "Attribution")?.value || "Anonymous";
      const animStyle = attrs.find((a: any) => a.trait_type === "Animation")?.value;

      // Get listing price from marketplace
      let price = "0.001";
      try {
        const listing = await mkt.listings(tokenId);
        if (listing.price > 0n) {
          price = ethers.formatEther(listing.price);
        }
      } catch {}

      // Download image
      if (metadata.image) {
        const imageCid = extractCID(metadata.image);
        const imagePath = path.join(NFT_IMAGES_DIR, `${tokenId}.png`);
        if (!fs.existsSync(imagePath)) {
          log(`  Downloading image...`);
          const ok = await downloadIPFS(imageCid, imagePath);
          if (ok) log(`  Image saved: ${imagePath}`);
          else log(`  Image download failed — will use IPFS fallback`);
        }
      }

      // Download or generate animation
      if (metadata.animation_url) {
        const animCid = extractCID(metadata.animation_url);
        const animPath = path.join(ANIMATIONS_DIR, `${tokenId}-${animStyle || "scramble"}.html`);
        if (!fs.existsSync(animPath)) {
          log(`  Downloading animation...`);
          const ok = await downloadIPFS(animCid, animPath);
          if (ok) log(`  Animation saved: ${animPath}`);
          else log(`  Animation download failed — generating locally`);
        }
      }
      // If no animation exists, generate one
      const animDir = ANIMATIONS_DIR;
      const existingAnims = fs.existsSync(animDir)
        ? fs.readdirSync(animDir).filter((f) => f.startsWith(`${tokenId}-`))
        : [];
      if (existingAnims.length === 0) {
        log(`  Generating animation locally...`);
        const style = animStyle || pickAnimationStyle(tokenId);
        const result = generateAnimation({
          id: tokenId,
          quote,
          style: style as any,
          outputDir: animDir,
        });
        log(`  Generated: ${result.style}`);
      }

      // Determine final animation style
      const finalAnimStyle = animStyle
        || pickAnimationStyle(tokenId);

      // Add to tokens list
      tokens.push({
        tokenId,
        name: metadata.name || `MISOGYNY.EXE #${tokenId}`,
        quote,
        attribution,
        price,
        animStyle: finalAnimStyle,
      });

      added++;
      log(`  Added token #${tokenId} ✓`);
    } catch (err: any) {
      log(`  ERROR on #${tokenId}: ${err.message}`);
    }
  }

  if (added === 0) {
    log("\nNo tokens were added.");
    return;
  }

  // 5. Save updated tokens.json
  saveTokens(tokens);
  log(`\nUpdated tokens.json — ${tokens.length} tokens total (+${added} new)`);

  // 6. Deploy to Surge
  if (NO_DEPLOY) {
    log("Skipping Surge deploy (--no-deploy)");
    return;
  }

  for (const domain of SURGE_DOMAINS) {
    try {
      log(`\nDeploying to ${domain}...`);
      const output = execSync(`npx surge ${SITE_DIR} ${domain}`, {
        encoding: "utf-8",
        timeout: 120000,
        cwd: ROOT,
      });
      if (output.includes("Success")) {
        log(`  Deployed to ${domain} ✓`);
      } else {
        log(`  Deploy output: ${output.slice(-200)}`);
      }
    } catch (err: any) {
      log(`  Deploy to ${domain} failed: ${err.message.slice(0, 200)}`);
    }
  }

  log(`\n=== Sync complete — ${added} new token(s) added ===`);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exitCode = 1;
});
