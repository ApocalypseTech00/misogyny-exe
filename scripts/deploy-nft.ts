import { ethers, network } from "hardhat";

const PAYMENT_SPLITTER = "0xDb065C3b0932FceCcEDF9fBDfa95354dd58a9048";
const MINT_DURATION = 14 * 24 * 60 * 60; // 14 days in seconds
const RESERVE_PRICE = ethers.parseEther("0.3");

// Sunday March 8, 2026 00:00:00 UTC — International Women's Day
const MINT_START = 1772928000;

// Placeholder URIs — update once artwork is on IPFS
const OPEN_EDITION_URI = ""; // will be set after IPFS upload
const CONTRACT_URI_OE = ""; // collection metadata for OpenSea
const CONTRACT_URI_1OF1 = ""; // collection metadata for OpenSea

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=== MISOGYNY.EXE — NFT Deployment ===");
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log(`Splitter: ${PAYMENT_SPLITTER}\n`);

  // --- 1. Deploy Open Edition (ERC-1155) ---
  console.log("1/3 Deploying MisogynyOpenEdition (ERC-1155)...");
  const OE = await ethers.getContractFactory("MisogynyOpenEdition");
  const openEdition = await OE.deploy(
    OPEN_EDITION_URI,
    CONTRACT_URI_OE,
    PAYMENT_SPLITTER,
    MINT_START,
    MINT_DURATION
  );
  await openEdition.waitForDeployment();
  const oeAddress = await openEdition.getAddress();
  console.log(`   Open Edition deployed: ${oeAddress}`);

  // --- 2. Deploy 1/1 Collection (ERC-721) ---
  console.log("\n2/3 Deploying MisogynyCollection (ERC-721)...");
  const Col = await ethers.getContractFactory("MisogynyCollection");
  const collection = await Col.deploy(CONTRACT_URI_1OF1, PAYMENT_SPLITTER);
  await collection.waitForDeployment();
  const colAddress = await collection.getAddress();
  console.log(`   Collection deployed: ${colAddress}`);

  // --- 3. Mint 9x 1/1 tokens (placeholder URIs for now) ---
  console.log("\n3/3 Minting 9 x 1/1 tokens...");
  for (let i = 1; i <= 9; i++) {
    const tx = await collection.mint(""); // URI set later via IPFS
    await tx.wait();
    console.log(`   Minted token #${i}`);
  }

  // --- Summary ---
  const endBalance = await ethers.provider.getBalance(deployer.address);
  const gasUsed = balance - endBalance;

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(`Open Edition (ERC-1155): ${oeAddress}`);
  console.log(`  - Price: 0.002 ETH per mint`);
  console.log(`  - Duration: 14 days from now`);
  console.log(`  - Proceeds → PaymentSplitter`);
  console.log(`\n1/1 Collection (ERC-721): ${colAddress}`);
  console.log(`  - 9 tokens minted to deployer`);
  console.log(`  - Reserve auctions: 0.3 ETH each`);
  console.log(`  - Proceeds → PaymentSplitter`);
  console.log(`\nGas used: ${ethers.formatEther(gasUsed)} ETH`);
  console.log(`Remaining: ${ethers.formatEther(endBalance)} ETH`);

  console.log("\n=== NEXT STEPS ===");
  console.log("1. Upload artwork to IPFS");
  console.log("2. Call setURI() on Open Edition with IPFS URI");
  console.log("3. Set token URIs on 1/1 collection");
  console.log("4. Call createAuction(tokenId, reservePrice) for each 1/1");
  console.log("5. Register contracts in Crossmint console");
  console.log(`\nAdd to .env:`);
  console.log(`OPEN_EDITION_ADDRESS=${oeAddress}`);
  console.log(`COLLECTION_ADDRESS=${colAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
