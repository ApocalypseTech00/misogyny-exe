import { ethers, run, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * MISOGYNY.EXE — V4 Redemption Contracts Deployment
 *
 * Deploys NEW instances of all contracts with updateTokenURI support.
 * Does NOT touch the existing V3 contracts — they remain live for SuperRare.
 *
 * What this deploys:
 *   1. MisogynyNFT (same source — now with working updateTokenURI)
 *   2. MisogynyMarketplace (new instance pointing to new NFT)
 *   3. Sets marketplace on new NFT
 *
 * After deployment:
 *   - Run migrate-tokens.ts to re-mint existing tokens on the new contract
 *   - Update .env with V4_ addresses
 *   - The old V3 contracts stay live — SuperRare listings untouched
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v4-redemption.ts --network base-sepolia   # Test first
 *   npx hardhat run scripts/deploy-v4-redemption.ts --network base-mainnet   # Production
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  const CHARITY = process.env.CHARITY_ADDRESS;
  const BOT = process.env.PROJECT_ADDRESS;
  const ARTIST = process.env.ARTIST_ADDRESS;

  if (!CHARITY || !BOT || !ARTIST) {
    console.error("Set CHARITY_ADDRESS, PROJECT_ADDRESS, ARTIST_ADDRESS in .env");
    process.exit(1);
  }

  console.log("=== MISOGYNY.EXE V4 — Redemption Contracts ===");
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log(`\nRoyalty wallets:`);
  console.log(`  Charity:  ${CHARITY}`);
  console.log(`  Bot/LLC:  ${BOT}`);
  console.log(`  Artist:   ${ARTIST}`);
  console.log(`\nNOTE: This deploys NEW contracts. V3 contracts are NOT affected.\n`);

  // --- 1. Deploy MisogynyNFT ---
  console.log("1/3 Deploying MisogynyNFT (with updateTokenURI)...");
  const NFT = await ethers.getContractFactory("MisogynyNFT");
  const nft = await NFT.deploy();
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log(`     Deployed: ${nftAddr}`);

  // --- 2. Deploy Marketplace ---
  console.log("\n2/3 Deploying MisogynyMarketplace...");
  const Marketplace = await ethers.getContractFactory("MisogynyMarketplace");
  const marketplace = await Marketplace.deploy(nftAddr, CHARITY, BOT, ARTIST);
  await marketplace.waitForDeployment();
  const marketplaceAddr = await marketplace.getAddress();
  console.log(`     Deployed: ${marketplaceAddr}`);

  // --- 3. Wire up ---
  console.log("\n3/3 Setting marketplace address on NFT contract...");
  const tx = await nft.setMarketplace(marketplaceAddr);
  await tx.wait();
  console.log(`     Marketplace set. TX: ${tx.hash}`);

  // --- Verify on Basescan ---
  if (network.name === "base-sepolia" || network.name === "base-mainnet") {
    console.log("\nWaiting for block confirmations before verification...");
    await new Promise((r) => setTimeout(r, 15000));

    const contracts = [
      { name: "MisogynyNFT", address: nftAddr, args: [] },
      { name: "MisogynyMarketplace", address: marketplaceAddr, args: [nftAddr, CHARITY, BOT, ARTIST] },
    ];

    for (const c of contracts) {
      try {
        console.log(`Verifying ${c.name}...`);
        await run("verify:verify", { address: c.address, constructorArguments: c.args });
        console.log(`  ${c.name} verified!`);
      } catch (error: any) {
        if (error.message.includes("Already Verified")) {
          console.log(`  ${c.name} already verified.`);
        } else {
          console.error(`  ${c.name} verification failed: ${error.message}`);
        }
      }
    }
  }

  // --- Summary ---
  const endBalance = await ethers.provider.getBalance(deployer.address);
  const gasUsed = balance - endBalance;

  console.log("\n=== V4 DEPLOYMENT COMPLETE ===");
  console.log(`MisogynyNFT (V4):     ${nftAddr}`);
  console.log(`Marketplace (V4):     ${marketplaceAddr}`);
  console.log(`Gas used: ${ethers.formatEther(gasUsed)} ETH`);
  console.log(`\nAdd to .env:`);
  console.log(`V4_NFT_ADDRESS=${nftAddr}`);
  console.log(`V4_MARKETPLACE_ADDRESS=${marketplaceAddr}`);
  console.log(`\nV3 contracts are UNTOUCHED:`);
  console.log(`  V3_NFT_ADDRESS=${process.env.V3_NFT_ADDRESS || "(check .env)"}`);
  console.log(`  V3_MARKETPLACE_ADDRESS=${process.env.V3_MARKETPLACE_ADDRESS || "(check .env)"}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Add V4 addresses to .env`);
  console.log(`  2. Run: npx hardhat run scripts/migrate-tokens.ts --network ${network.name}`);
  console.log(`  3. Deploy new Rare Protocol collection for SuperRare redemption`);

  // Save deployment info
  const deployInfo = {
    network: network.name,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      nft: nftAddr,
      marketplace: marketplaceAddr,
    },
    gasUsed: ethers.formatEther(gasUsed),
    v3: {
      nft: process.env.V3_NFT_ADDRESS,
      marketplace: process.env.V3_MARKETPLACE_ADDRESS,
    },
  };
  const infoPath = path.join(__dirname, "..", "data", `v4-deployment-${network.name}.json`);
  fs.mkdirSync(path.dirname(infoPath), { recursive: true });
  fs.writeFileSync(infoPath, JSON.stringify(deployInfo, null, 2));
  console.log(`\nDeployment info saved: ${infoPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
