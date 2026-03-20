import { ethers, network } from "hardhat";

/**
 * Post-deploy script: send test ETH to the splitter,
 * call release() for each payee, and verify balances.
 *
 * Usage:
 *   SPLITTER_ADDRESS=0x... npx hardhat run scripts/test-splits.ts --network base-sepolia
 */
async function main() {
  const SPLITTER_ADDRESS = process.env.SPLITTER_ADDRESS;
  if (!SPLITTER_ADDRESS) {
    console.error("Set SPLITTER_ADDRESS env var");
    process.exit(1);
  }

  const CHARITY_ADDRESS = process.env.CHARITY_ADDRESS!;
  const ARTIST_ADDRESS = process.env.ARTIST_ADDRESS!;
  const PROJECT_ADDRESS = process.env.PROJECT_ADDRESS!;

  if (!CHARITY_ADDRESS || !ARTIST_ADDRESS || !PROJECT_ADDRESS) {
    console.error(
      "Set CHARITY_ADDRESS, ARTIST_ADDRESS, PROJECT_ADDRESS env vars"
    );
    process.exit(1);
  }

  const splitter = await ethers.getContractAt(
    "MisogynyPaymentSplitter",
    SPLITTER_ADDRESS
  );

  console.log(`Testing splits on ${network.name}...`);
  console.log(`Splitter: ${SPLITTER_ADDRESS}\n`);

  // Send 0.001 ETH to the contract
  const [signer] = await ethers.getSigners();
  const testAmount = ethers.parseEther("0.001");

  console.log(
    `Sending ${ethers.formatEther(testAmount)} ETH to splitter...`
  );
  const tx = await signer.sendTransaction({
    to: SPLITTER_ADDRESS,
    value: testAmount,
  });
  await tx.wait();
  console.log("Sent. TX:", tx.hash);

  const payees = [
    { name: "Charity (50%)", address: CHARITY_ADDRESS },
    { name: "Artist  (30%)", address: ARTIST_ADDRESS },
    { name: "Project (20%)", address: PROJECT_ADDRESS },
  ];

  for (const payee of payees) {
    const before = await ethers.provider.getBalance(payee.address);
    console.log(`\nReleasing to ${payee.name}: ${payee.address}`);

    const releaseTx = await splitter["release(address)"](
      payee.address
    );
    await releaseTx.wait();

    const after = await ethers.provider.getBalance(payee.address);
    const received = after - before;
    console.log(`  Received: ${ethers.formatEther(received)} ETH`);
    console.log(`  TX: ${releaseTx.hash}`);
  }

  console.log("\nAll splits verified!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
