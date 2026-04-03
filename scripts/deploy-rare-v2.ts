import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * MISOGYNY.EXE — Rare Protocol V2 Collection Deployment
 *
 * Deploys a NEW Rare Protocol ERC-721 collection for the redemption mechanic.
 * The original RARE_CONTRACT_ADDRESS stays live for existing SuperRare listings.
 *
 * The new collection supports the same mint pipeline but tokens can be
 * redeemed (URI updated) when purchased.
 *
 * NOTE: Rare Protocol contracts are deployed via the `rare` CLI, not Hardhat.
 *       The rare CLI handles IPFS pinning and contract deployment.
 *       updateTokenURI support depends on the Rare Protocol contract standard.
 *
 * Usage:
 *   npx ts-node scripts/deploy-rare-v2.ts                  # Deploy on Sepolia
 *   npx ts-node scripts/deploy-rare-v2.ts --mainnet        # Deploy on Mainnet
 *   npx ts-node scripts/deploy-rare-v2.ts --dry-run        # Preview only
 */

const RARE_CHAIN = process.argv.includes("--mainnet") ? "mainnet" : "sepolia";
const DRY_RUN = process.argv.includes("--dry-run");

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
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

async function main() {
  log("=== MISOGYNY.EXE — Rare Protocol V2 Collection ===");
  log(`Chain:    ${RARE_CHAIN}`);
  log(`Dry run:  ${DRY_RUN}`);
  log(`\nOriginal collection: ${process.env.RARE_CONTRACT_ADDRESS || "(not set)"}`);
  log("NOTE: Original collection is NOT affected.\n");

  if (DRY_RUN) {
    log("[DRY RUN] Would deploy:");
    log('  rare deploy erc721 "MISOGYNY.EXE V2" "MSGNY2" --chain ' + RARE_CHAIN);
    log("\nAfter deployment:");
    log("  1. Set RARE_V2_CONTRACT_ADDRESS in .env");
    log("  2. Run migrate-tokens-rare.ts to re-mint existing tokens");
    log("  3. Update rare-mint.ts to use V2 contract for new mints");
    return;
  }

  // Deploy new collection
  log('Deploying "MISOGYNY.EXE V2" collection...');
  const output = rareExec(
    `deploy erc721 "MISOGYNY.EXE V2" "MSGNY2" --chain ${RARE_CHAIN}`
  );
  log(`Deploy output: ${output}`);

  // Parse contract address
  const match = output.match(/0x[a-fA-F0-9]{40}/);
  if (!match) {
    log("ERROR: Could not parse contract address from output");
    process.exit(1);
  }

  const contractAddress = match[0];
  log(`\n=== DEPLOYMENT COMPLETE ===`);
  log(`V2 Contract: ${contractAddress}`);
  log(`Chain:       ${RARE_CHAIN}`);
  log(`\nAdd to .env:`);
  log(`RARE_V2_CONTRACT_ADDRESS=${contractAddress}`);
  log(`\nOriginal contract UNTOUCHED:`);
  log(`  RARE_CONTRACT_ADDRESS=${process.env.RARE_CONTRACT_ADDRESS || "(check .env)"}`);
  log(`\nNext steps:`);
  log(`  1. Add RARE_V2_CONTRACT_ADDRESS to .env`);
  log(`  2. Migrate existing tokens if needed`);
  log(`  3. Point rare-agent.ts to use V2 for new mints`);

  // Save deployment info
  const infoPath = path.join(__dirname, "..", "data", `rare-v2-deployment-${RARE_CHAIN}.json`);
  fs.mkdirSync(path.dirname(infoPath), { recursive: true });
  fs.writeFileSync(infoPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    chain: RARE_CHAIN,
    contractAddress,
    originalContract: process.env.RARE_CONTRACT_ADDRESS,
  }, null, 2));
  log(`\nDeployment info saved: ${infoPath}`);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exitCode = 1;
});
