import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { generateArtwork, convertToPng } from "./generate-artwork";
import { uploadFile, uploadJSON, buildMetadata } from "./upload-to-ipfs";

dotenv.config({ path: [".env.local", ".env"] });

/**
 * Redemption mechanic — when an NFT is purchased, the misogynistic quote
 * transforms into a positive quote about women.
 *
 * Flow:
 *   1. Indexer detects Sold event
 *   2. This script generates new "redeemed" artwork with a positive counter-quote
 *   3. Uploads new artwork + metadata to IPFS
 *   4. Calls updateTokenURI(tokenId, newURI) on-chain
 *
 * The buyer gets an NFT that tells a story: "this started as hate,
 * and I turned it into something else."
 *
 * Usage:
 *   npx ts-node scripts/redemption.ts <tokenId>
 *   npx ts-node scripts/redemption.ts --watch   (continuous monitoring)
 */

// --- Positive counter-quotes ---
// Curated list of empowering quotes about women.
// Each purchase randomly selects one.
const POSITIVE_QUOTES: string[] = [
  "She was not fragile like a flower, she was fragile like a bomb",
  "A woman is like a tea bag, you never know how strong she is until she is in hot water",
  "Well-behaved women seldom make history",
  "The future belongs to those who believe in the beauty of their dreams",
  "She remembered who she was and the game changed",
  "A woman with a voice is by definition a strong woman",
  "There is no limit to what we as women can accomplish",
  "She was powerful not because she wasn't scared but because she went on so strongly despite the fear",
  "Women are the real architects of society",
  "A strong woman looks a challenge in the eye and gives it a wink",
  "The most courageous act is still to think for yourself, aloud",
  "She stood in the storm and when the wind did not blow her way, she adjusted her sails",
  "Freedom cannot be achieved unless women have been emancipated from all forms of oppression",
  "I am no bird and no net ensnares me, I am a free human being with an independent will",
  "She was warned, she was given an explanation, nevertheless she persisted",
  "Women belong in all places where decisions are being made",
  "I raise up my voice not so that I can shout but so that those without a voice can be heard",
  "The question is not who is going to let me, it is who is going to stop me",
  "Life shrinks or expands in proportion to one's courage",
  "A feminist is anyone who recognizes the equality and full humanity of women and men",
];

// Redeemed artwork: pink background, dark text — pink = power/positivity
const REDEEMED_BG = "#F918D0";
const REDEEMED_TEXT = "#0a0a0a";

interface RedemptionOpts {
  tokenId: number;
  originalQuote?: string;
  outputDir?: string;
}

/**
 * Select a random positive quote. Uses tokenId as seed for determinism
 * (same token always gets the same counter-quote).
 */
function selectCounterQuote(tokenId: number): string {
  const index = tokenId % POSITIVE_QUOTES.length;
  return POSITIVE_QUOTES[index];
}

/**
 * Generate redeemed artwork — inverted colors (dark bg, pink text).
 * Same typographic style but the visual inversion signals transformation.
 */
function generateRedeemedArtwork(opts: RedemptionOpts): string {
  const counterQuote = selectCounterQuote(opts.tokenId);
  const dir = opts.outputDir || path.join(__dirname, "..", "data", "artworks", "redeemed");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SIZE = 1000;
  const words = counterQuote.toUpperCase().split(/\s+/);
  const wordCount = words.length;

  // Same font sizing logic as main generator
  let fontSize: number;
  if (wordCount <= 5) fontSize = 95;
  else if (wordCount <= 8) fontSize = 80;
  else if (wordCount <= 12) fontSize = 68;
  else if (wordCount <= 18) fontSize = 56;
  else fontSize = 42;

  const lineHeight = fontSize * 1.15;

  // Smart line breaking (same logic)
  let targetWpl: number;
  if (wordCount <= 10) targetWpl = 2;
  else if (wordCount <= 18) targetWpl = 3;
  else targetWpl = 3;

  const totalLines = Math.ceil(wordCount / targetWpl);
  const baseWpl = Math.floor(wordCount / totalLines);
  const extra = wordCount % totalLines;
  const lines: string[] = [];
  let idx = 0;
  for (let l = 0; l < totalLines; l++) {
    const take = baseWpl + (l < extra ? 1 : 0);
    lines.push(words.slice(idx, idx + take).join(" "));
    idx += take;
  }

  const totalTextHeight = lines.length * lineHeight;
  const startY = (SIZE - totalTextHeight) / 2 + fontSize * 0.75;

  // Read font
  const fontPath = path.join(__dirname, "..", "site", "fonts", "cmunbl.ttf");
  let fontFace = "";
  if (fs.existsSync(fontPath)) {
    const fontBase64 = fs.readFileSync(fontPath).toString("base64");
    fontFace = `
    <style type="text/css">
      @font-face {
        font-family: 'CMU Serif';
        src: url('data:font/truetype;base64,${fontBase64}') format('truetype');
        font-weight: 900;
        font-style: italic;
      }
    </style>`;
  }

  const textElements = lines.map((line, i) => {
    let text = escapeXml(line);
    if (i === 0) text = "\u201C" + text;
    if (i === lines.length - 1) {
      text = /[.!?]$/.test(line) ? text + "\u201D" : text + ".\u201D";
    }
    const y = startY + i * lineHeight;
    return `  <text x="500" y="${y}" text-anchor="middle" font-family="CMU Serif, Georgia, serif" font-size="${fontSize}" font-weight="900" font-style="italic" fill="${REDEEMED_TEXT}">${text}</text>`;
  });

  // "REDEEMED" watermark
  const watermark = `  <text x="500" y="${SIZE - 40}" text-anchor="middle" font-family="CMU Serif, Georgia, serif" font-size="14" font-style="italic" fill="${REDEEMED_TEXT}" opacity="0.25">REDEEMED — MISOGYNY.EXE #${opts.tokenId}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>${fontFace}
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="${REDEEMED_BG}"/>
${textElements.join("\n")}
${watermark}
</svg>`;

  const svgPath = path.join(dir, `${opts.tokenId}-redeemed.svg`);
  fs.writeFileSync(svgPath, svg);

  return svgPath;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// NFT contract ABI (only what we need)
const NFT_ABI = [
  "function updateTokenURI(uint256 tokenId, string calldata uri) external",
  "function tokenURI(uint256 tokenId) external view returns (string)",
];

/**
 * Full redemption pipeline for a single token:
 *   1. Generate redeemed artwork
 *   2. Convert to PNG
 *   3. Upload artwork to IPFS via Pinata
 *   4. Upload metadata to IPFS
 *   5. Call updateTokenURI on-chain
 */
export async function redeemToken(opts: RedemptionOpts & { dryRun?: boolean }): Promise<{
  counterQuote: string;
  svgPath: string;
  pngPath: string;
  metadataUri?: string;
  txHash?: string;
}> {
  const counterQuote = selectCounterQuote(opts.tokenId);
  console.log(`Redeeming token #${opts.tokenId}`);
  console.log(`  Original: "${opts.originalQuote || "(unknown)"}"`);
  console.log(`  Counter:  "${counterQuote}"`);

  // 1. Generate redeemed artwork
  const svgPath = generateRedeemedArtwork(opts);
  console.log(`  SVG: ${svgPath}`);

  // 2. Convert to PNG
  const sharp = (await import("sharp")).default;
  const pngPath = svgPath.replace(/\.svg$/, ".png");
  await sharp(svgPath).resize(1000, 1000).png({ quality: 90 }).toFile(pngPath);
  console.log(`  PNG: ${pngPath}`);

  if (opts.dryRun) {
    console.log("  [DRY RUN] Skipping IPFS upload and on-chain update");
    return { counterQuote, svgPath, pngPath };
  }

  // 3. Upload artwork to IPFS
  console.log("  Uploading artwork to IPFS...");
  const imageCid = await uploadFile(pngPath, `misogyny-exe-${opts.tokenId}-redeemed.png`);
  console.log(`  Image CID: ${imageCid}`);

  // 4. Upload metadata to IPFS
  const metadata = buildMetadata({
    name: `MISOGYNY.EXE #${opts.tokenId} — REDEEMED`,
    description: `This piece has been redeemed. What was once hate is now strength. Original misogynistic quote transformed on purchase.`,
    imageCid,
    quote: counterQuote,
    attribution: "Redeemed",
  });

  const metadataCid = await uploadJSON(metadata, `misogyny-exe-${opts.tokenId}-redeemed-metadata.json`);
  const metadataUri = `ipfs://${metadataCid}`;
  console.log(`  Metadata URI: ${metadataUri}`);

  // 5. Call updateTokenURI on-chain
  const NFT_ADDRESS = process.env.V3_NFT_ADDRESS;
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";

  if (!NFT_ADDRESS || !PRIVATE_KEY) {
    console.log("  V3_NFT_ADDRESS or PRIVATE_KEY not set — skipping on-chain update");
    console.log(`  Manual: call updateTokenURI(${opts.tokenId}, "${metadataUri}") on ${NFT_ADDRESS}`);
    return { counterQuote, svgPath, pngPath, metadataUri };
  }

  console.log("  Updating token URI on-chain...");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const nft = new ethers.Contract(NFT_ADDRESS, NFT_ABI, wallet);

  const tx = await nft.updateTokenURI(opts.tokenId, metadataUri);
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();
  console.log(`  Confirmed! Token #${opts.tokenId} is now redeemed on-chain.`);

  return { counterQuote, svgPath, pngPath, metadataUri, txHash: tx.hash };
}

/**
 * Watch mode — poll the index for new sales and redeem automatically.
 */
async function watchForSales() {
  const indexPath = path.join(__dirname, "..", "data", "index.json");
  const redeemedPath = path.join(__dirname, "..", "data", "redeemed.json");

  // Track which tokens have been redeemed
  let redeemed: Set<number>;
  if (fs.existsSync(redeemedPath)) {
    redeemed = new Set(JSON.parse(fs.readFileSync(redeemedPath, "utf-8")));
  } else {
    redeemed = new Set();
  }

  console.log("Watching for sales to redeem...");
  console.log(`  Already redeemed: ${redeemed.size} tokens`);

  const checkInterval = 60_000; // check every minute

  const check = async () => {
    if (!fs.existsSync(indexPath)) return;

    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const sales = index.sales || [];

    for (const sale of sales) {
      if (redeemed.has(sale.tokenId)) continue;

      console.log(`\nNew sale detected: token #${sale.tokenId}`);
      try {
        await redeemToken({ tokenId: sale.tokenId });
        redeemed.add(sale.tokenId);
        fs.writeFileSync(redeemedPath, JSON.stringify([...redeemed]));
      } catch (err) {
        console.error(`  Failed to redeem token #${sale.tokenId}:`, err);
      }
    }
  };

  await check();
  setInterval(check, checkInterval);
}

// --- CLI mode ---
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === "--watch") {
    watchForSales().catch(console.error);
  } else if (args[0] === "--preview") {
    // Preview all positive quotes
    console.log("Positive counter-quotes pool:\n");
    POSITIVE_QUOTES.forEach((q, i) => console.log(`  ${i + 1}. "${q}"`));
    console.log(`\nTotal: ${POSITIVE_QUOTES.length} quotes`);
  } else {
    const dryRun = args.includes("--dry-run");
    const filteredArgs = args.filter((a) => a !== "--dry-run");
    const tokenId = parseInt(filteredArgs[0]);
    if (isNaN(tokenId)) {
      console.log("Usage:");
      console.log("  npx ts-node scripts/redemption.ts <tokenId>              Redeem (IPFS + on-chain)");
      console.log("  npx ts-node scripts/redemption.ts <tokenId> --dry-run    Generate artwork only");
      console.log("  npx ts-node scripts/redemption.ts --watch                Watch for sales");
      console.log("  npx ts-node scripts/redemption.ts --preview              List counter-quotes");
      process.exit(0);
    }
    redeemToken({ tokenId, originalQuote: filteredArgs[1], dryRun }).catch(console.error);
  }
}
