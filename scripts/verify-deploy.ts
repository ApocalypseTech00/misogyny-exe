import { ethers, network } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

/**
 * MISOGYNY.EXE V6 — Post-deploy verification
 *
 * Reads on-chain state and asserts against .env. Run before the first mint on any
 * new deployment (testnet or mainnet). Exits non-zero on any mismatch so it can
 * gate CI / cron.
 *
 * Usage:
 *   npx hardhat run scripts/verify-deploy.ts --network sepolia
 *   npx hardhat run scripts/verify-deploy.ts --network mainnet
 */

const BAZAAR_ADDRESSES: Record<string, string> = {
  mainnet: "0x6D7c44773C52D396F43c2D511B81aa168E9a7a42",
  sepolia: "0xC8Edc7049b233641ad3723D6C60019D1c8771612",
};

const COLDIE_AUCTION =
  "0x434f4c4449455f41554354494f4e000000000000000000000000000000000000";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ ${name} not set in .env`);
    process.exit(1);
  }
  return v;
}

function lc(s: string): string {
  return s.toLowerCase();
}

async function main() {
  const bazaarExpected = BAZAAR_ADDRESSES[network.name === "mainnet" ? "mainnet" : "sepolia"];
  if (!bazaarExpected) {
    console.error(`Unknown network: ${network.name}`);
    process.exit(1);
  }

  const rareAddress = requireEnv("RARE_CONTRACT_ADDRESS");
  const botAddress = requireEnv("BOT_ADDRESS");
  const charity = requireEnv("CHARITY_ADDRESS");
  const artist = requireEnv("ARTIST_ADDRESS");
  const project = requireEnv("PROJECT_ADDRESS");
  const deployerA = requireEnv("DEPLOYER_A_ADDRESS");
  const deployerB = requireEnv("DEPLOYER_B_ADDRESS");
  const treasury = requireEnv("TREASURY_ADDRESS");
  const primarySplitterAddr = requireEnv("PRIMARY_SPLITTER_ADDRESS");
  const secondarySplitterAddr = requireEnv("SECONDARY_SPLITTER_ADDRESS");
  const splitGuardAddr = requireEnv("SPLIT_GUARD_ADDRESS");
  const collectionAdminAddr = requireEnv("COLLECTION_ADMIN_ADDRESS");
  const registryAddr = requireEnv("QUOTE_REGISTRY_ADDRESS");

  console.log(`=== MISOGYNY.EXE V6 — Verify Deploy (${network.name}) ===\n`);

  const failures: string[] = [];

  function check(label: string, actual: string, expected: string) {
    const ok = lc(actual) === lc(expected);
    console.log(`${ok ? "✓" : "✗"} ${label}\n   expected: ${expected}\n   actual:   ${actual}`);
    if (!ok) failures.push(label);
  }

  function checkBool(label: string, actual: boolean, expected: boolean) {
    const ok = actual === expected;
    console.log(`${ok ? "✓" : "✗"} ${label}\n   expected: ${expected}\n   actual:   ${actual}`);
    if (!ok) failures.push(label);
  }

  function checkNum(label: string, actual: bigint | number, expected: bigint | number) {
    const ok = BigInt(actual) === BigInt(expected);
    console.log(`${ok ? "✓" : "✗"} ${label}\n   expected: ${expected}\n   actual:   ${actual}`);
    if (!ok) failures.push(label);
  }

  // --- CollectionAdmin ---
  const collectionAdmin = await ethers.getContractAt("CollectionAdmin", collectionAdminAddr);
  check("CollectionAdmin.owner == DEPLOYER_A", await collectionAdmin.owner(), deployerA);
  check("CollectionAdmin.COLLECTION == Rare collection", await collectionAdmin.COLLECTION(), rareAddress);
  check("CollectionAdmin.SPLIT_GUARD == SplitGuard", await collectionAdmin.SPLIT_GUARD(), splitGuardAddr);
  checkBool("CollectionAdmin.writer[BOT] == true", await collectionAdmin.writer(botAddress), true);

  // --- SplitGuard ---
  const splitGuard = await ethers.getContractAt("SplitGuard", splitGuardAddr);
  check("SplitGuard.BAZAAR == known Bazaar", await splitGuard.BAZAAR(), bazaarExpected);
  check("SplitGuard.COLLECTION == Rare collection", await splitGuard.COLLECTION(), rareAddress);
  check("SplitGuard.SPLITTER == primary splitter", await splitGuard.SPLITTER(), primarySplitterAddr);
  const auctionTypeOnChain = await splitGuard.AUCTION_TYPE();
  check("SplitGuard.AUCTION_TYPE == COLDIE_AUCTION", auctionTypeOnChain, COLDIE_AUCTION);
  check("SplitGuard.DEPLOYER_A == DEPLOYER_A", await splitGuard.DEPLOYER_A(), deployerA);
  check("SplitGuard.TREASURY == TREASURY", await splitGuard.TREASURY(), treasury);
  checkBool("SplitGuard.writer[BOT] == true", await splitGuard.writer(botAddress), true);

  // --- QuoteRegistry ---
  const registry = await ethers.getContractAt("QuoteRegistry", registryAddr);
  check("QuoteRegistry.owner == DEPLOYER_B", await registry.owner(), deployerB);
  checkBool("QuoteRegistry.writer[BOT] == true", await registry.writer(botAddress), true);

  // --- Primary splitter ---
  const primarySplitter = await ethers.getContractAt(
    "MisogynyPaymentSplitter",
    primarySplitterAddr
  );
  checkNum("Primary splitter.payeeCount == 3", await primarySplitter.payeeCount(), 3n);
  check("Primary splitter.payee(0) == CHARITY", await primarySplitter.payee(0), charity);
  check("Primary splitter.payee(1) == ARTIST", await primarySplitter.payee(1), artist);
  check("Primary splitter.payee(2) == PROJECT", await primarySplitter.payee(2), project);
  checkNum("Primary splitter.shares(CHARITY) == 50", await primarySplitter.shares(charity), 50n);
  checkNum("Primary splitter.shares(ARTIST) == 30", await primarySplitter.shares(artist), 30n);
  checkNum("Primary splitter.shares(PROJECT) == 20", await primarySplitter.shares(project), 20n);
  checkNum("Primary splitter.totalShares == 100", await primarySplitter.totalShares(), 100n);

  // --- Secondary splitter ---
  const secondarySplitter = await ethers.getContractAt(
    "MisogynyPaymentSplitter",
    secondarySplitterAddr
  );
  checkNum("Secondary splitter.payeeCount == 3", await secondarySplitter.payeeCount(), 3n);
  check("Secondary splitter.payee(0) == CHARITY", await secondarySplitter.payee(0), charity);
  check("Secondary splitter.payee(1) == ARTIST", await secondarySplitter.payee(1), artist);
  check("Secondary splitter.payee(2) == PROJECT", await secondarySplitter.payee(2), project);
  checkNum("Secondary splitter.shares(CHARITY) == 1", await secondarySplitter.shares(charity), 1n);
  checkNum("Secondary splitter.shares(ARTIST) == 1", await secondarySplitter.shares(artist), 1n);
  checkNum("Secondary splitter.shares(PROJECT) == 1", await secondarySplitter.shares(project), 1n);
  checkNum("Secondary splitter.totalShares == 3", await secondarySplitter.totalShares(), 3n);

  // --- Rare collection ownership + royalty receiver ---
  // These checks hit the live Rare collection — best-effort, the interface is owner-only
  // and setRoyaltyReceiver, both of which are Ownable.
  const rareLike = await ethers.getContractAt(
    ["function owner() view returns (address)"],
    rareAddress
  );
  try {
    const rareOwner = await rareLike.owner();
    check("Rare collection.owner == CollectionAdmin", rareOwner, collectionAdminAddr);
  } catch (err: any) {
    console.log(`? Rare collection.owner() read failed (may be a different ABI): ${err.message?.slice(0, 100)}`);
    failures.push("Rare collection owner check");
  }

  // --- Final verdict ---
  console.log("");
  if (failures.length === 0) {
    console.log("=== ALL CHECKS PASS ===");
    console.log("Safe to run the bot.");
  } else {
    console.log(`=== ${failures.length} CHECK(S) FAILED ===`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log("");
    console.log("DO NOT run the bot until these are fixed.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
