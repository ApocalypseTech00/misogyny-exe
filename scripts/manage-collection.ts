import { ethers, network } from "hardhat";
import path from "path";
import fs from "fs";

/**
 * Manage the originally deployed Collection (ERC-721) and OpenEdition (ERC-1155).
 * These are the v1 contracts already live on Base mainnet.
 *
 * Commands:
 *   set-uris     — Set token URIs on Collection (batch)
 *   create-auctions — Create reserve auctions for all tokens
 *   set-oe-uri   — Set the OpenEdition metadata URI
 *   status       — Show current state of both contracts
 *
 * Usage:
 *   npx hardhat run scripts/manage-collection.ts --network base-mainnet
 *
 * Set MANAGE_CMD env var to choose command:
 *   MANAGE_CMD=status npx hardhat run scripts/manage-collection.ts --network base-mainnet
 *   MANAGE_CMD=set-uris npx hardhat run scripts/manage-collection.ts --network base-mainnet
 *   MANAGE_CMD=create-auctions npx hardhat run scripts/manage-collection.ts --network base-mainnet
 *   MANAGE_CMD=set-oe-uri npx hardhat run scripts/manage-collection.ts --network base-mainnet
 */

const COLLECTION_ABI = [
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function mint(string) returns (uint256)",
  "function createAuction(uint256 tokenId, uint256 reservePrice)",
  "function auctions(uint256) view returns (uint256 reservePrice, uint256 highestBid, address highestBidder, uint256 endTime, bool active, bool settled)",
  "function owner() view returns (address)",
  "function contractURI() view returns (string)",
];

const OPEN_EDITION_ABI = [
  "function totalMinted() view returns (uint256)",
  "function mintStart() view returns (uint256)",
  "function mintEnd() view returns (uint256)",
  "function PRICE() view returns (uint256)",
  "function uri(uint256) view returns (string)",
  "function setURI(string)",
  "function owner() view returns (address)",
  "function contractURI() view returns (string)",
];

async function main() {
  const COLLECTION_ADDRESS = process.env.COLLECTION_ADDRESS;
  const OE_ADDRESS = process.env.OPEN_EDITION_ADDRESS;

  if (!COLLECTION_ADDRESS || !OE_ADDRESS) {
    console.error(
      "Set COLLECTION_ADDRESS and OPEN_EDITION_ADDRESS in .env"
    );
    process.exit(1);
  }

  const cmd = process.env.MANAGE_CMD || "status";
  const [deployer] = await ethers.getSigners();

  console.log(`=== MISOGYNY.EXE — Collection Manager ===`);
  console.log(`Network:    ${network.name}`);
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Command:    ${cmd}`);
  console.log(`Collection: ${COLLECTION_ADDRESS}`);
  console.log(`OpenEdition: ${OE_ADDRESS}\n`);

  const collection = new ethers.Contract(
    COLLECTION_ADDRESS,
    COLLECTION_ABI,
    deployer
  );
  const openEdition = new ethers.Contract(
    OE_ADDRESS,
    OPEN_EDITION_ABI,
    deployer
  );

  switch (cmd) {
    case "status":
      await showStatus(collection, openEdition);
      break;
    case "set-uris":
      await setTokenURIs(collection);
      break;
    case "create-auctions":
      await createAuctions(collection);
      break;
    case "set-oe-uri":
      await setOpenEditionURI(openEdition);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Valid: status, set-uris, create-auctions, set-oe-uri");
  }
}

async function showStatus(collection: ethers.Contract, oe: ethers.Contract) {
  console.log("--- Collection (ERC-721) ---");
  const totalSupply = await collection.totalSupply();
  console.log(`Total supply: ${totalSupply}`);

  for (let i = 1; i <= Number(totalSupply); i++) {
    const owner = await collection.ownerOf(i);
    let uri = "";
    try {
      uri = await collection.tokenURI(i);
    } catch {}
    const auction = await collection.auctions(i);

    console.log(`  Token #${i}:`);
    console.log(`    Owner: ${owner}`);
    console.log(`    URI: ${uri || "(empty)"}`);
    console.log(
      `    Auction: ${auction.active ? "ACTIVE" : auction.settled ? "SETTLED" : "NONE"}`
    );
    if (auction.active) {
      console.log(
        `    Reserve: ${ethers.formatEther(auction.reservePrice)} ETH`
      );
      console.log(
        `    Highest bid: ${ethers.formatEther(auction.highestBid)} ETH`
      );
    }
  }

  console.log("\n--- Open Edition (ERC-1155) ---");
  const minted = await oe.totalMinted();
  const price = await oe.PRICE();
  const start = await oe.mintStart();
  const end = await oe.mintEnd();
  let uri = "";
  try {
    uri = await oe.uri(1);
  } catch {}

  console.log(`Total minted: ${minted}`);
  console.log(`Price: ${ethers.formatEther(price)} ETH`);
  console.log(`Mint start: ${new Date(Number(start) * 1000).toISOString()}`);
  console.log(`Mint end: ${new Date(Number(end) * 1000).toISOString()}`);
  console.log(`URI: ${uri || "(empty)"}`);
}

async function setTokenURIs(collection: ethers.Contract) {
  // Load URIs from data/token-uris.json
  // Format: { "1": "ipfs://...", "2": "ipfs://...", ... }
  const uriPath = path.join(__dirname, "..", "data", "token-uris.json");
  if (!fs.existsSync(uriPath)) {
    console.log("Create data/token-uris.json with token ID → IPFS URI mapping:");
    console.log('  { "1": "ipfs://Qm...", "2": "ipfs://Qm...", ... }');
    return;
  }

  const uris: Record<string, string> = JSON.parse(
    fs.readFileSync(uriPath, "utf-8")
  );

  for (const [tokenId, uri] of Object.entries(uris)) {
    console.log(`Setting URI for token #${tokenId}: ${uri}`);
    // Collection uses ERC721URIStorage which doesn't expose a public setTokenURI
    // The token URIs were set at mint time (empty strings)
    // We'd need a setTokenURI function — check if it exists
    console.log(
      `  Note: MisogynyCollection sets URIs at mint time only.`
    );
    console.log(
      `  If URIs need updating, you'll need to add a setTokenURI function.`
    );
    break;
  }
}

async function createAuctions(collection: ethers.Contract) {
  const RESERVE_PRICE = process.env.RESERVE_PRICE || "0.3";
  const totalSupply = await collection.totalSupply();

  console.log(
    `Creating auctions for ${totalSupply} tokens at ${RESERVE_PRICE} ETH reserve...\n`
  );

  for (let i = 1; i <= Number(totalSupply); i++) {
    const auction = await collection.auctions(i);
    if (auction.active || auction.settled) {
      console.log(`  Token #${i}: skipped (auction already exists)`);
      continue;
    }

    try {
      console.log(`  Token #${i}: creating auction...`);
      const tx = await collection.createAuction(
        i,
        ethers.parseEther(RESERVE_PRICE)
      );
      await tx.wait();
      console.log(`  Token #${i}: auction created — TX: ${tx.hash}`);
    } catch (error: any) {
      console.error(`  Token #${i}: FAILED — ${error.message}`);
    }
  }
}

async function setOpenEditionURI(oe: ethers.Contract) {
  const newURI = process.env.OE_METADATA_URI;
  if (!newURI) {
    console.error("Set OE_METADATA_URI env var to the IPFS URI");
    return;
  }

  console.log(`Setting OpenEdition URI to: ${newURI}`);
  const tx = await oe.setURI(newURI);
  await tx.wait();
  console.log(`Done! TX: ${tx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
