import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * MISOGYNY.EXE — Token Migration (V3 → V4)
 *
 * Re-mints existing tokens on the new V4 contract using the same
 * IPFS metadata URIs. Tokens keep their original artwork and metadata.
 *
 * Does NOT touch V3 contracts — tokens continue to exist there.
 * The V4 versions are the "redemption-enabled" copies.
 *
 * Prerequisites:
 *   - V4 contracts deployed (run deploy-v4-redemption.ts first)
 *   - V4_NFT_ADDRESS set in .env
 *   - mint-queue.json has the token metadata CIDs
 *
 * Usage:
 *   npx hardhat run scripts/migrate-tokens.ts --network base-sepolia
 *   npx hardhat run scripts/migrate-tokens.ts --network base-mainnet
 *   MIGRATE_DRY_RUN=true npx hardhat run scripts/migrate-tokens.ts --network base-mainnet
 */

const QUEUE_PATH = path.join(__dirname, "..", "data", "mint-queue.json");
const DRY_RUN = process.env.MIGRATE_DRY_RUN === "true";

interface QueueItem {
  id: number;
  quote: string;
  attribution: string;
  tokenId?: number;
  metadataCid?: string;
  status: string;
  counterQuote?: string;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const V4_NFT_ADDRESS = process.env.V4_NFT_ADDRESS;
  if (!V4_NFT_ADDRESS) {
    console.error("V4_NFT_ADDRESS not set in .env. Deploy V4 contracts first.");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  log("=== MISOGYNY.EXE — Token Migration (V3 → V4) ===");
  log(`Network:   ${network.name}`);
  log(`Deployer:  ${deployer.address}`);
  log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  log(`V4 NFT:    ${V4_NFT_ADDRESS}`);
  log(`Dry run:   ${DRY_RUN}`);
  log("");

  // Load queue to get metadata CIDs
  if (!fs.existsSync(QUEUE_PATH)) {
    log("ERROR: mint-queue.json not found");
    process.exit(1);
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
  const mintedItems: QueueItem[] = queue.items.filter(
    (i: QueueItem) => i.status === "done" && i.metadataCid
  );

  if (mintedItems.length === 0) {
    log("No minted tokens to migrate.");
    return;
  }

  log(`Found ${mintedItems.length} tokens to migrate:\n`);
  for (const item of mintedItems) {
    log(`  #${item.id} (token ${item.tokenId}): "${item.quote.slice(0, 50)}..."`);
    log(`    Metadata: ipfs://${item.metadataCid}`);
    if (item.counterQuote) {
      log(`    Counter:  "${item.counterQuote.slice(0, 50)}..."`);
    }
  }

  if (DRY_RUN) {
    log("\n[DRY RUN] Would mint the above tokens on V4 contract. Exiting.");
    return;
  }

  const nft = await ethers.getContractAt("MisogynyNFT", V4_NFT_ADDRESS);

  log(`\nMigrating ${mintedItems.length} tokens...\n`);

  const migrated: { oldTokenId: number; newTokenId: number; txHash: string }[] = [];

  for (const item of mintedItems) {
    const metadataUri = `ipfs://${item.metadataCid}`;

    try {
      log(`Minting V4 copy of #${item.id}...`);
      const tx = await nft.mint(deployer.address, metadataUri);
      log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait();

      // Extract new tokenId
      const transferLog = receipt!.logs.find((l: any) => {
        try { return nft.interface.parseLog(l)?.name === "Transfer"; }
        catch { return false; }
      });
      let newTokenId: number;
      if (transferLog) {
        const parsed = nft.interface.parseLog(transferLog);
        newTokenId = Number(parsed!.args.tokenId);
      } else {
        newTokenId = Number(await nft.totalSupply());
      }

      log(`  Migrated: V3 token #${item.tokenId} → V4 token #${newTokenId}`);
      migrated.push({
        oldTokenId: item.tokenId || item.id,
        newTokenId,
        txHash: tx.hash,
      });
    } catch (err: any) {
      log(`  FAILED: ${err.message}`);
    }
  }

  // Save migration map
  const mapPath = path.join(__dirname, "..", "data", `migration-map-${network.name}.json`);
  fs.writeFileSync(mapPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    network: network.name,
    v4Contract: V4_NFT_ADDRESS,
    tokens: migrated,
  }, null, 2));

  log(`\n=== Migration Complete ===`);
  log(`Migrated: ${migrated.length}/${mintedItems.length}`);
  log(`Migration map saved: ${mapPath}`);
  log(`\nNext: list migrated tokens on V4 marketplace`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
