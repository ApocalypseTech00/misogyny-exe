import { ethers } from "hardhat";

async function main() {
  const NFT_ADDRESS = "0x356Dd09E02960D59f1073F9d22A2634bbE3b1736";
  const nft = await ethers.getContractAt("MisogynyNFT", NFT_ADDRESS);

  const tokenId = 1;
  const newURI = "ipfs://QmNjZLxGfMvgLQRvynwqabEcuEmrnnwWxmPouMCjYinkMj";

  console.log(`Updating token #${tokenId} URI to: ${newURI}`);
  const tx = await nft.updateTokenURI(tokenId, newURI);
  console.log("TX:", tx.hash);
  await tx.wait();
  console.log("Done! Metadata updated on-chain.");
}

main().catch(console.error);
