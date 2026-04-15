import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();

/**
 * Post-deploy wiring:
 *   1. Transfer Rare collection ownership → CollectionAdmin
 *   2. Re-call CollectionAdmin.setRoyaltyReceiver(secondarySplitter)
 *
 * Run with the SAME signer that deployed the Rare collection (0x36FC...).
 * Reads RARE_CONTRACT_ADDRESS, COLLECTION_ADMIN_ADDRESS, SECONDARY_SPLITTER_ADDRESS from .env.
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const rareAddr = process.env.RARE_CONTRACT_ADDRESS!;
  const adminAddr = process.env.COLLECTION_ADMIN_ADDRESS!;
  const secondaryAddr = process.env.SECONDARY_SPLITTER_ADDRESS!;

  console.log(`Signer:           ${signer.address}`);
  console.log(`Rare collection:  ${rareAddr}`);
  console.log(`CollectionAdmin:  ${adminAddr}`);
  console.log(`Secondary spltr:  ${secondaryAddr}`);

  // Minimal ABI for Ownable + setRoyaltyReceiver
  const rare = new ethers.Contract(
    rareAddr,
    ["function transferOwnership(address) external", "function owner() view returns (address)"],
    signer
  );
  const admin = new ethers.Contract(
    adminAddr,
    ["function setRoyaltyReceiver(address) external"],
    signer
  );

  const currentOwner: string = await rare.owner();
  console.log(`\nCurrent Rare collection owner: ${currentOwner}`);

  if (currentOwner.toLowerCase() === adminAddr.toLowerCase()) {
    console.log("Already owned by CollectionAdmin. Skipping transferOwnership.");
  } else if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error(
      `ERROR: signer ${signer.address} does not own the Rare collection. Current owner is ${currentOwner}. Cannot transfer.`
    );
    process.exit(1);
  } else {
    console.log("\n[1/2] Transferring Rare collection ownership → CollectionAdmin");
    const tx1 = await rare.transferOwnership(adminAddr);
    console.log(`      tx: ${tx1.hash}`);
    await tx1.wait();
    console.log("      ✓ ownership transferred");
  }

  console.log("\n[2/2] Setting royalty receiver to secondary splitter");
  const tx2 = await admin.setRoyaltyReceiver(secondaryAddr);
  console.log(`      tx: ${tx2.hash}`);
  await tx2.wait();
  console.log("      ✓ royalty receiver set");

  console.log("\n=== POST-DEPLOY WIRING COMPLETE ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
