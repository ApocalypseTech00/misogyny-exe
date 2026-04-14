import { ethers, run, network } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

/**
 * MISOGYNY.EXE V6 — Full deploy
 *
 * Run as DEPLOYER_A's wallet. The script:
 *   1. Reads RARE_CONTRACT_ADDRESS, BOT_ADDRESS, CHARITY_ADDRESS, ARTIST_ADDRESS,
 *      PROJECT_ADDRESS, DEPLOYER_A_ADDRESS, DEPLOYER_B_ADDRESS, TREASURY_ADDRESS from .env.
 *   2. Deploys primary + secondary MisogynyPaymentSplitter instances.
 *   3. Deploys SplitGuard (immutable constructor with deployerA + treasury + bazaar + collection + splitter).
 *   4. Deploys CollectionAdmin(collection, splitGuard).
 *   5. Deploys QuoteRegistry, grants bot writer, transfers ownership to DEPLOYER_B_ADDRESS.
 *   6. On CollectionAdmin + SplitGuard: grants bot writer role, calls setRoyaltyReceiver.
 *   7. Verifies on Etherscan (non-local networks).
 *   8. Prints a paste-ready .env block for the rest of the pipeline.
 *
 * After this finishes, the OPERATOR manually transfers Rare collection ownership to
 * CollectionAdmin from whatever wallet deployed the collection (usually via `rare transfer`
 * or directly on the Rare collection via Etherscan). That step is OUT of this script because
 * the collection's owner is the Rare CLI deployer, not us.
 *
 * Usage:
 *   # Populate .env first with:
 *   #   PRIVATE_KEY=<DEPLOYER_A private key — NOT the bot key>
 *   #   RARE_CONTRACT_ADDRESS, BOT_ADDRESS, CHARITY/ARTIST/PROJECT_ADDRESS,
 *   #   DEPLOYER_A_ADDRESS, DEPLOYER_B_ADDRESS, TREASURY_ADDRESS
 *   npx hardhat run scripts/deploy-v6.ts --network sepolia
 *   npx hardhat run scripts/deploy-v6.ts --network mainnet
 */

// Rare Protocol Bazaar addresses (per V6 spec §5.1)
const BAZAAR_ADDRESSES: Record<string, string> = {
  mainnet: "0x6D7c44773C52D396F43c2D511B81aa168E9a7a42",
  sepolia: "0xC8Edc7049b233641ad3723D6C60019D1c8771612",
};

// COLDIE_AUCTION (reserve auction that starts on first bid)
const COLDIE_AUCTION =
  "0x434f4c4449455f41554354494f4e000000000000000000000000000000000000";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: ${name} must be set in .env`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=== MISOGYNY.EXE V6 — Deploy ===");
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address} (this MUST be DEPLOYER_A)`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  // --- Required env ---
  const rareAddress = requireEnv("RARE_CONTRACT_ADDRESS");
  const botAddress = requireEnv("BOT_ADDRESS");
  const charity = requireEnv("CHARITY_ADDRESS");
  const artist = requireEnv("ARTIST_ADDRESS");
  const project = requireEnv("PROJECT_ADDRESS");
  const deployerA = requireEnv("DEPLOYER_A_ADDRESS");
  const deployerB = requireEnv("DEPLOYER_B_ADDRESS");
  const treasury = requireEnv("TREASURY_ADDRESS");

  // Sanity: deploy signer must equal DEPLOYER_A_ADDRESS
  if (deployer.address.toLowerCase() !== deployerA.toLowerCase()) {
    console.error(
      `ERROR: signer ${deployer.address} does not match DEPLOYER_A_ADDRESS ${deployerA}.\n` +
        `The PRIVATE_KEY in .env MUST be DEPLOYER_A's key for this deploy. ` +
        `After deploy, swap PRIVATE_KEY back to the BOT key for production operation.`
    );
    process.exit(1);
  }

  // Sanity: no placeholder addresses (0x0000...0001 etc.)
  const PLACEHOLDER_PATTERN = /^0x0000000000000000000000000000000000000000$|^0x0000000000000000000000000000000000000001$|^0x0000000000000000000000000000000000000002$|^0x0000000000000000000000000000000000000003$/i;
  for (const [name, val] of [
    ["CHARITY_ADDRESS", charity],
    ["ARTIST_ADDRESS", artist],
    ["PROJECT_ADDRESS", project],
    ["DEPLOYER_A_ADDRESS", deployerA],
    ["DEPLOYER_B_ADDRESS", deployerB],
    ["TREASURY_ADDRESS", treasury],
    ["BOT_ADDRESS", botAddress],
  ]) {
    if (PLACEHOLDER_PATTERN.test(val)) {
      console.error(`ERROR: ${name} is a placeholder (${val}). Set a real address in .env.`);
      process.exit(1);
    }
  }

  // Bazaar for this chain
  const bazaarAddress = BAZAAR_ADDRESSES[network.name === "mainnet" ? "mainnet" : "sepolia"];
  if (!bazaarAddress) {
    console.error(`ERROR: No Rare Bazaar address known for network "${network.name}"`);
    process.exit(1);
  }

  console.log(`\nRare collection: ${rareAddress}`);
  console.log(`Rare Bazaar:     ${bazaarAddress}`);
  console.log(`Bot (writer):    ${botAddress}`);
  console.log(`DEPLOYER_A:      ${deployerA}`);
  console.log(`DEPLOYER_B:      ${deployerB}`);
  console.log(`TREASURY:        ${treasury}`);
  console.log(`\nSplit payees:`);
  console.log(`  Charity: ${charity}`);
  console.log(`  Artist:  ${artist}`);
  console.log(`  Project: ${project}`);

  // --- 1. Primary splitter (50/30/20) ---
  console.log("\n[1/6] Deploying primary MisogynyPaymentSplitter (50/30/20)...");
  const Splitter = await ethers.getContractFactory("MisogynyPaymentSplitter");
  const primarySplitter = await Splitter.deploy(
    [charity, artist, project],
    [50, 30, 20]
  );
  await primarySplitter.waitForDeployment();
  const primarySplitterAddr = await primarySplitter.getAddress();
  console.log(`      ${primarySplitterAddr}`);

  // --- 2. Secondary splitter (1/1/1) ---
  console.log("\n[2/6] Deploying secondary MisogynyPaymentSplitter (1/1/1)...");
  const secondarySplitter = await Splitter.deploy(
    [charity, artist, project],
    [1, 1, 1]
  );
  await secondarySplitter.waitForDeployment();
  const secondarySplitterAddr = await secondarySplitter.getAddress();
  console.log(`      ${secondarySplitterAddr}`);

  // --- 3. SplitGuard ---
  console.log("\n[3/6] Deploying SplitGuard...");
  const SplitGuard = await ethers.getContractFactory("SplitGuard");
  const splitGuard = await SplitGuard.deploy(
    bazaarAddress,
    rareAddress,
    primarySplitterAddr,
    COLDIE_AUCTION,
    deployerA,
    treasury
  );
  await splitGuard.waitForDeployment();
  const splitGuardAddr = await splitGuard.getAddress();
  console.log(`      ${splitGuardAddr}`);

  // --- 4. CollectionAdmin ---
  console.log("\n[4/6] Deploying CollectionAdmin...");
  const CollectionAdmin = await ethers.getContractFactory("CollectionAdmin");
  const collectionAdmin = await CollectionAdmin.deploy(
    rareAddress,
    splitGuardAddr
  );
  await collectionAdmin.waitForDeployment();
  const collectionAdminAddr = await collectionAdmin.getAddress();
  console.log(`      ${collectionAdminAddr}`);

  // --- 5. QuoteRegistry ---
  console.log("\n[5/6] Deploying QuoteRegistry...");
  const QuoteRegistry = await ethers.getContractFactory("QuoteRegistry");
  const registry = await QuoteRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`      ${registryAddr}`);

  // --- 6. Wire roles + royalty receiver ---
  console.log("\n[6/6] Wiring roles + royalty receiver...");

  console.log(`  CollectionAdmin.setWriter(${botAddress}, true)`);
  let tx = await collectionAdmin.setWriter(botAddress, true);
  await tx.wait();

  console.log(`  SplitGuard.setWriter(${botAddress}, true)`);
  tx = await splitGuard.setWriter(botAddress, true);
  await tx.wait();

  console.log(`  CollectionAdmin.setRoyaltyReceiver(${secondarySplitterAddr})`);
  console.log(`    NOTE: this will fail until the Rare collection's ownership is transferred to CollectionAdmin.`);
  console.log(`    If it fails below, that's OK — run it manually after the ownership transfer.`);
  try {
    tx = await collectionAdmin.setRoyaltyReceiver(secondarySplitterAddr);
    await tx.wait();
    console.log(`    ✓ royalty receiver set`);
  } catch (err: any) {
    console.log(`    ⚠ skipped (expected if collection ownership not yet transferred): ${err.message?.slice(0, 120)}`);
  }

  console.log(`  QuoteRegistry.setWriter(${botAddress}, true)`);
  tx = await registry.setWriter(botAddress, true);
  await tx.wait();

  console.log(`  QuoteRegistry.transferOwnership(${deployerB})`);
  tx = await registry.transferOwnership(deployerB);
  await tx.wait();

  // --- Verify on Etherscan ---
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\nWaiting for block confirmations before verification...");
    await new Promise((r) => setTimeout(r, 20000));

    const verifications = [
      {
        name: "Primary Splitter",
        address: primarySplitterAddr,
        args: [[charity, artist, project], [50, 30, 20]],
      },
      {
        name: "Secondary Splitter",
        address: secondarySplitterAddr,
        args: [[charity, artist, project], [1, 1, 1]],
      },
      {
        name: "SplitGuard",
        address: splitGuardAddr,
        args: [bazaarAddress, rareAddress, primarySplitterAddr, COLDIE_AUCTION, deployerA, treasury],
      },
      {
        name: "CollectionAdmin",
        address: collectionAdminAddr,
        args: [rareAddress, splitGuardAddr],
      },
      {
        name: "QuoteRegistry",
        address: registryAddr,
        args: [],
      },
    ];

    for (const v of verifications) {
      try {
        console.log(`Verifying ${v.name}...`);
        await run("verify:verify", {
          address: v.address,
          constructorArguments: v.args,
        });
        console.log(`  ✓ ${v.name} verified`);
      } catch (err: any) {
        if (err.message.includes("Already Verified")) {
          console.log(`  ${v.name} already verified`);
        } else {
          console.error(`  ⚠ ${v.name} verification failed: ${err.message?.slice(0, 200)}`);
        }
      }
    }
  }

  // --- Summary ---
  const endBalance = await ethers.provider.getBalance(deployer.address);
  const gasUsed = balance - endBalance;

  console.log("\n=== DEPLOYMENT COMPLETE ===\n");
  console.log("Next manual step (OPERATOR, not this script):");
  console.log(`  From whatever wallet deployed the Rare collection, call:`);
  console.log(`    RareCollection(${rareAddress}).transferOwnership(${collectionAdminAddr})`);
  console.log(`  (Directly via Etherscan or a viem one-liner.)`);
  console.log(``);
  console.log(`Once that's done, if royalty receiver step failed above, run:`);
  console.log(`  CollectionAdmin(${collectionAdminAddr}).setRoyaltyReceiver(${secondarySplitterAddr})`);
  console.log(``);
  console.log(`Then run the verification script:`);
  console.log(`  npx hardhat run scripts/verify-deploy.ts --network ${network.name}`);
  console.log(``);
  console.log(`Gas used: ${ethers.formatEther(gasUsed)} ETH`);
  console.log(``);
  console.log(`Add to .env (replacing any existing values):`);
  console.log(`--8<--`);
  console.log(`PRIMARY_SPLITTER_ADDRESS=${primarySplitterAddr}`);
  console.log(`SECONDARY_SPLITTER_ADDRESS=${secondarySplitterAddr}`);
  console.log(`SPLIT_GUARD_ADDRESS=${splitGuardAddr}`);
  console.log(`COLLECTION_ADMIN_ADDRESS=${collectionAdminAddr}`);
  console.log(`QUOTE_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`--8<--`);
  console.log(``);
  console.log(`IMPORTANT: now swap PRIVATE_KEY in .env from DEPLOYER_A to the BOT key`);
  console.log(`for production operation. Do NOT leave DEPLOYER_A's key on the Pi.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
