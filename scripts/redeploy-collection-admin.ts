import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();

/**
 * One-off: redeploy CollectionAdmin with the royalty function-name fix,
 * hand off Rare collection ownership, set bot writer, set royalty receiver.
 * Run as DEPLOYER_A (the current CollectionAdmin owner).
 *
 * Steps:
 *   1. Deploy NEW CollectionAdmin(rareAddr, splitGuardAddr).
 *   2. Old CollectionAdmin.transferCollectionOwnership(newAdmin).
 *   3. New CollectionAdmin.setWriter(bot, true).
 *   4. New CollectionAdmin.setRoyaltyReceiver(secondarySplitter)  ← the test.
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const oldAdminAddr = process.env.COLLECTION_ADMIN_ADDRESS!;
  const rareAddr = process.env.RARE_CONTRACT_ADDRESS!;
  const splitGuardAddr = process.env.SPLIT_GUARD_ADDRESS!;
  const secondaryAddr = process.env.SECONDARY_SPLITTER_ADDRESS!;
  const botAddr = process.env.BOT_ADDRESS!;

  console.log(`Signer:           ${signer.address}`);
  console.log(`Old CollectionAdmin: ${oldAdminAddr}`);
  console.log(`Rare collection:  ${rareAddr}`);
  console.log(`SplitGuard:       ${splitGuardAddr}`);
  console.log(`Bot:              ${botAddr}`);
  console.log(`Secondary spltr:  ${secondaryAddr}`);

  // 1. Deploy new CollectionAdmin
  console.log("\n[1/4] Deploying new CollectionAdmin...");
  const Factory = await ethers.getContractFactory("CollectionAdmin");
  const newAdmin = await Factory.deploy(rareAddr, splitGuardAddr);
  await newAdmin.waitForDeployment();
  const newAdminAddr = await newAdmin.getAddress();
  console.log(`      ${newAdminAddr}`);

  // 2. Old CollectionAdmin hands off Rare collection ownership to new
  console.log("\n[2/4] Old CollectionAdmin.transferCollectionOwnership(new)...");
  const oldAdmin = new ethers.Contract(
    oldAdminAddr,
    ["function transferCollectionOwnership(address) external"],
    signer
  );
  let tx = await oldAdmin.transferCollectionOwnership(newAdminAddr);
  console.log(`      tx: ${tx.hash}`);
  await tx.wait();
  console.log(`      ✓ ownership handed off`);

  // 3. Bot writer on new CollectionAdmin
  console.log("\n[3/4] New CollectionAdmin.setWriter(bot, true)...");
  tx = await newAdmin.setWriter(botAddr, true);
  console.log(`      tx: ${tx.hash}`);
  await tx.wait();
  console.log(`      ✓ bot writer set`);

  // 4. The actual test — set royalty receiver via fixed forward
  console.log("\n[4/4] New CollectionAdmin.setRoyaltyReceiver(secondary) — THE FIX TEST");
  tx = await newAdmin.setRoyaltyReceiver(secondaryAddr);
  console.log(`      tx: ${tx.hash}`);
  await tx.wait();
  console.log(`      ✓ royalty receiver set successfully`);

  console.log("\n=== REDEPLOY COMPLETE ===");
  console.log(`\nUpdate .env:`);
  console.log(`  COLLECTION_ADMIN_ADDRESS=${newAdminAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
