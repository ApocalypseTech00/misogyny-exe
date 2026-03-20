import { ethers, run, network } from "hardhat";

/**
 * Deploy the V3 autonomous bot contracts:
 *   1. PaymentSplitter (equal 3-way split: charity / bot-LLC / artist)
 *   2. MisogynyNFT (restricted ERC-721)
 *   3. MisogynyMarketplace (list/buy/cancel + 15% royalty)
 *   4. Set marketplace address on NFT contract
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v3.ts --network base-sepolia
 *   npx hardhat run scripts/deploy-v3.ts --network base-mainnet
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  // Wallet addresses — defaults to existing env vars
  const CHARITY = process.env.CHARITY_ADDRESS;
  const BOT = process.env.PROJECT_ADDRESS; // project wallet becomes bot-LLC wallet in V3
  const ARTIST = process.env.ARTIST_ADDRESS;

  if (!CHARITY || !BOT || !ARTIST) {
    console.error(
      "Set CHARITY_ADDRESS, PROJECT_ADDRESS, ARTIST_ADDRESS in .env"
    );
    process.exit(1);
  }

  console.log("=== MISOGYNY.EXE V3 — Contract Deployment ===");
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log(`\nRoyalty wallets (5% / 5% / 5%):`);
  console.log(`  Charity:  ${CHARITY}`);
  console.log(`  Bot/LLC:  ${BOT}`);
  console.log(`  Artist:   ${ARTIST}\n`);

  // --- 1. Deploy PaymentSplitter (equal 3-way split) ---
  console.log("1/4 Deploying PaymentSplitter (1:1:1 split)...");
  const Splitter = await ethers.getContractFactory("MisogynyPaymentSplitter");
  const splitter = await Splitter.deploy(
    [CHARITY, BOT, ARTIST],
    [1, 1, 1]
  );
  await splitter.waitForDeployment();
  const splitterAddr = await splitter.getAddress();
  console.log(`     Deployed: ${splitterAddr}`);

  // --- 2. Deploy MisogynyNFT ---
  console.log("\n2/4 Deploying MisogynyNFT (restricted ERC-721)...");
  const NFT = await ethers.getContractFactory("MisogynyNFT");
  const nft = await NFT.deploy();
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log(`     Deployed: ${nftAddr}`);

  // --- 3. Deploy Marketplace ---
  console.log("\n3/4 Deploying MisogynyMarketplace...");
  const Marketplace = await ethers.getContractFactory("MisogynyMarketplace");
  const marketplace = await Marketplace.deploy(
    nftAddr,
    CHARITY,
    BOT,
    ARTIST
  );
  await marketplace.waitForDeployment();
  const marketplaceAddr = await marketplace.getAddress();
  console.log(`     Deployed: ${marketplaceAddr}`);

  // --- 4. Wire up: set marketplace on NFT ---
  console.log("\n4/4 Setting marketplace address on NFT contract...");
  const tx = await nft.setMarketplace(marketplaceAddr);
  await tx.wait();
  console.log(`     Marketplace set. TX: ${tx.hash}`);

  // --- Verify on Basescan ---
  if (network.name === "base-sepolia" || network.name === "base-mainnet") {
    console.log("\nWaiting for block confirmations before verification...");

    const contracts = [
      {
        name: "PaymentSplitter",
        address: splitterAddr,
        args: [[CHARITY, BOT, ARTIST], [1, 1, 1]],
      },
      { name: "MisogynyNFT", address: nftAddr, args: [] },
      {
        name: "MisogynyMarketplace",
        address: marketplaceAddr,
        args: [nftAddr, CHARITY, BOT, ARTIST],
      },
    ];

    // Wait for indexing
    await new Promise((r) => setTimeout(r, 15000));

    for (const c of contracts) {
      try {
        console.log(`Verifying ${c.name}...`);
        await run("verify:verify", {
          address: c.address,
          constructorArguments: c.args,
        });
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

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(`PaymentSplitter: ${splitterAddr}`);
  console.log(`MisogynyNFT:     ${nftAddr}`);
  console.log(`Marketplace:     ${marketplaceAddr}`);
  console.log(`\nGas used: ${ethers.formatEther(gasUsed)} ETH`);
  console.log(`Remaining: ${ethers.formatEther(endBalance)} ETH`);
  console.log(`\nAdd to .env:`);
  console.log(`V3_SPLITTER_ADDRESS=${splitterAddr}`);
  console.log(`V3_NFT_ADDRESS=${nftAddr}`);
  console.log(`V3_MARKETPLACE_ADDRESS=${marketplaceAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
