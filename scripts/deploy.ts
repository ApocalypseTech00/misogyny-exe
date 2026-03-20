import { ethers, run, network } from "hardhat";

async function main() {
  // --- Addresses ---
  const CHARITY_ADDRESS =
    process.env.CHARITY_ADDRESS ||
    "0x0000000000000000000000000000000000000001"; // placeholder
  const ARTIST_ADDRESS =
    process.env.ARTIST_ADDRESS ||
    "0x0000000000000000000000000000000000000002"; // placeholder
  const PROJECT_ADDRESS =
    process.env.PROJECT_ADDRESS ||
    "0x0000000000000000000000000000000000000003"; // placeholder

  const payees = [CHARITY_ADDRESS, ARTIST_ADDRESS, PROJECT_ADDRESS];
  const shares = [50, 30, 20];

  console.log("Deploying MisogynyPaymentSplitter...");
  console.log(`  Network: ${network.name}`);
  console.log(`  Charity (50%): ${CHARITY_ADDRESS}`);
  console.log(`  Artist  (30%): ${ARTIST_ADDRESS}`);
  console.log(`  Project (20%): ${PROJECT_ADDRESS}`);

  const Factory = await ethers.getContractFactory(
    "MisogynyPaymentSplitter"
  );
  const splitter = await Factory.deploy(payees, shares);
  await splitter.waitForDeployment();

  const address = await splitter.getAddress();
  console.log(`\nPaymentSplitter deployed to: ${address}`);
  console.log(
    "\n>>> Use this address as the revenue/creator address <<<\n"
  );

  // Verify on Basescan (skip for local/hardhat network)
  if (
    network.name === "base-sepolia" ||
    network.name === "base-mainnet"
  ) {
    console.log("Waiting for block confirmations...");
    // Wait for a few blocks so Basescan can index
    const tx = splitter.deploymentTransaction();
    if (tx) await tx.wait(5);

    console.log("Verifying contract on Basescan...");
    try {
      await run("verify:verify", {
        address,
        constructorArguments: [payees, shares],
      });
      console.log("Contract verified on Basescan!");
    } catch (error: any) {
      if (error.message.includes("Already Verified")) {
        console.log("Contract already verified.");
      } else {
        console.error("Verification failed:", error.message);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
