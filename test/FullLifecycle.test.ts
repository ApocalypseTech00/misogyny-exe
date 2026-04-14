import { expect } from "chai";
import { ethers } from "hardhat";
import {
  CollectionAdmin,
  MisogynyPaymentSplitter,
  MockRareBazaar,
  MockRareCollection,
  QuoteRegistry,
  SplitGuard,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * MISOGYNY.EXE V6 — Full lifecycle integration test
 *
 * Exercises the entire V6 pipeline on a local hardhat network against mock Rare
 * contracts. This is the "does it actually work end-to-end" check that catches
 * wiring bugs before they burn real Sepolia gas.
 *
 * Scenario:
 *   1. Deploy everything in the order deploy-v6.ts does
 *   2. Transfer Rare collection ownership → CollectionAdmin
 *   3. Grant bot writer role on CollectionAdmin, SplitGuard, QuoteRegistry
 *   4. setRoyaltyReceiver(secondary) via CollectionAdmin
 *   5. Bot mints through CollectionAdmin → token lands in SplitGuard
 *   6. Bot registers quote on QuoteRegistry
 *   7. Bot lists via SplitGuard → MockBazaar records the call with [primary, 100]
 *   8. Simulate sale: mock the ETH flow to primary splitter + token transfer to buyer
 *   9. Verify splitter pending() math
 *  10. Release payees
 *  11. Redemption: bot updates tokenURI + inscribes comeback via writer role
 *  12. Verify final state
 *
 * Plus a few adversarial cases: revoked bot can't mint, emergencyWithdraw lands
 * in TREASURY not caller, DEPLOYER_A can cancel auctions as backup.
 */

describe("V6 — Full lifecycle integration", function () {
  const COLDIE_AUCTION =
    "0x434f4c4449455f41554354494f4e000000000000000000000000000000000000";

  let collection: MockRareCollection;
  let bazaar: MockRareBazaar;
  let primary: MisogynyPaymentSplitter;
  let secondary: MisogynyPaymentSplitter;
  let splitGuard: SplitGuard;
  let admin: CollectionAdmin;
  let registry: QuoteRegistry;

  let deployerA: HardhatEthersSigner;
  let deployerB: HardhatEthersSigner;
  let bot: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let charity: HardhatEthersSigner;
  let artist: HardhatEthersSigner;
  let project: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  beforeEach(async function () {
    [deployerA, deployerB, bot, treasury, buyer, charity, artist, project, outsider] =
      await ethers.getSigners();

    // 1. Mock Rare collection — deployed under deployerA for convenience
    const CollectionFactory = await ethers.getContractFactory(
      "MockRareCollection",
      deployerA
    );
    collection = await CollectionFactory.deploy();
    await collection.waitForDeployment();

    // 2. Mock Rare Bazaar
    const BazaarFactory = await ethers.getContractFactory("MockRareBazaar", deployerA);
    bazaar = await BazaarFactory.deploy();
    await bazaar.waitForDeployment();

    // 3. Primary splitter (50/30/20)
    const SplitterFactory = await ethers.getContractFactory(
      "MisogynyPaymentSplitter",
      deployerA
    );
    primary = await SplitterFactory.deploy(
      [charity.address, artist.address, project.address],
      [50, 30, 20]
    );
    await primary.waitForDeployment();

    // 4. Secondary splitter (1/1/1)
    secondary = await SplitterFactory.deploy(
      [charity.address, artist.address, project.address],
      [1, 1, 1]
    );
    await secondary.waitForDeployment();

    // 5. SplitGuard
    const SplitGuardFactory = await ethers.getContractFactory("SplitGuard", deployerA);
    splitGuard = await SplitGuardFactory.deploy(
      await bazaar.getAddress(),
      await collection.getAddress(),
      await primary.getAddress(),
      COLDIE_AUCTION,
      deployerA.address,
      treasury.address
    );
    await splitGuard.waitForDeployment();

    // 6. CollectionAdmin (deployed by deployerA, therefore owner = deployerA)
    const CollectionAdminFactory = await ethers.getContractFactory(
      "CollectionAdmin",
      deployerA
    );
    admin = await CollectionAdminFactory.deploy(
      await collection.getAddress(),
      await splitGuard.getAddress()
    );
    await admin.waitForDeployment();

    // 7. QuoteRegistry (deployed by deployerA, then ownership transferred to deployerB)
    const QuoteRegistryFactory = await ethers.getContractFactory(
      "QuoteRegistry",
      deployerA
    );
    registry = await QuoteRegistryFactory.deploy();
    await registry.waitForDeployment();

    // 8. Wire: transfer collection ownership to CollectionAdmin
    await collection.transferOwnership(await admin.getAddress());

    // 9. Wire: grant bot writer role on all three V6 contracts
    await admin.connect(deployerA).setWriter(bot.address, true);
    await splitGuard.connect(deployerA).setWriter(bot.address, true);
    await registry.connect(deployerA).setWriter(bot.address, true);

    // 10. Wire: set EIP-2981 royalty receiver to secondary splitter
    await admin.connect(deployerA).setRoyaltyReceiver(await secondary.getAddress());

    // 11. Wire: transfer QuoteRegistry ownership to DEPLOYER_B (matches deploy-v6.ts)
    await registry.connect(deployerA).transferOwnership(deployerB.address);
  });

  it("deploy-wiring is correct", async function () {
    expect(await collection.owner()).to.equal(await admin.getAddress());
    expect(await collection.royaltyReceiver()).to.equal(await secondary.getAddress());
    expect(await admin.owner()).to.equal(deployerA.address);
    expect(await admin.writer(bot.address)).to.equal(true);
    expect(await admin.SPLIT_GUARD()).to.equal(await splitGuard.getAddress());
    expect(await splitGuard.DEPLOYER_A()).to.equal(deployerA.address);
    expect(await splitGuard.TREASURY()).to.equal(treasury.address);
    expect(await splitGuard.SPLITTER()).to.equal(await primary.getAddress());
    expect(await splitGuard.writer(bot.address)).to.equal(true);
    expect(await registry.owner()).to.equal(deployerB.address);
    expect(await registry.writer(bot.address)).to.equal(true);
    expect(await primary.totalShares()).to.equal(100n);
    expect(await secondary.totalShares()).to.equal(3n);
  });

  it("bot mints through CollectionAdmin — token lands in SplitGuard, never in bot", async function () {
    const quote = "Women belong in the kitchen, not in the boardroom";
    const uri = "ipfs://hate1";
    await expect(admin.connect(bot).mint(uri, quote))
      .to.emit(admin, "MintRouted");

    // Token 1 owned by SplitGuard, NOT bot
    expect(await collection.ownerOf(1)).to.equal(await splitGuard.getAddress());
    expect(await collection.tokenURI(1)).to.equal(uri);
  });

  it("bot registers quote on QuoteRegistry — post-ownership-transfer", async function () {
    await admin.connect(bot).mint("ipfs://hate1", "women bad");

    // Even though DEPLOYER_B now owns QuoteRegistry, the bot still has writer role
    await registry.connect(bot).registerQuote(1, "women bad");
    expect(await registry.quoteOf(1)).to.equal("women bad");
    expect(await registry.totalQuotes()).to.equal(1n);
  });

  it("bot lists via SplitGuard — MockBazaar records exactly [primary, 100]", async function () {
    await admin.connect(bot).mint("ipfs://hate1", "quote");
    await registry.connect(bot).registerQuote(1, "quote");

    await splitGuard
      .connect(bot)
      .listAuction(1, ethers.parseEther("0.01"), 86400);

    expect(await bazaar.callCount()).to.equal(1);
    const call = await bazaar.getCall(0);
    expect(call.auctionType).to.equal(COLDIE_AUCTION);
    expect(call.originContract).to.equal(await collection.getAddress());
    expect(call.tokenId).to.equal(1n);
    expect(call.startingAmount).to.equal(ethers.parseEther("0.01"));
    expect(call.currencyAddress).to.equal(ethers.ZeroAddress);
    expect(call.lengthOfAuction).to.equal(86400n);
    expect(call.startTime).to.equal(0n);
    expect(call.splitAddresses.length).to.equal(1);
    expect(call.splitAddresses[0]).to.equal(await primary.getAddress());
    expect(call.splitRatios.length).to.equal(1);
    expect(call.splitRatios[0]).to.equal(100);
  });

  it("simulated sale → splitter math checks out → payees pull via release", async function () {
    // Simulate the Rare Bazaar auction settling: ETH to the splitter, token to buyer
    const salePrice = ethers.parseEther("1.0");
    await buyer.sendTransaction({ to: await primary.getAddress(), value: salePrice });

    const charityBalBefore = await ethers.provider.getBalance(charity.address);
    const artistBalBefore = await ethers.provider.getBalance(artist.address);
    const projectBalBefore = await ethers.provider.getBalance(project.address);

    // Expected splits on 1 ETH: charity 0.5, artist 0.3, project 0.2
    expect(await primary.pending(charity.address)).to.equal(ethers.parseEther("0.5"));
    expect(await primary.pending(artist.address)).to.equal(ethers.parseEther("0.3"));
    expect(await primary.pending(project.address)).to.equal(ethers.parseEther("0.2"));

    // Pull-payment: any caller can release, funds go to the payee address
    await primary.connect(outsider).release(charity.address);
    await primary.connect(outsider).release(artist.address);
    await primary.connect(outsider).release(project.address);

    expect(await ethers.provider.getBalance(charity.address)).to.equal(
      charityBalBefore + ethers.parseEther("0.5")
    );
    expect(await ethers.provider.getBalance(artist.address)).to.equal(
      artistBalBefore + ethers.parseEther("0.3")
    );
    expect(await ethers.provider.getBalance(project.address)).to.equal(
      projectBalBefore + ethers.parseEther("0.2")
    );
  });

  it("redemption flow: bot updates tokenURI + inscribes comeback post-sale", async function () {
    // Full flow: mint → register → list → simulated sale → redemption
    await admin.connect(bot).mint("ipfs://hate1", "original hate quote");
    await registry.connect(bot).registerQuote(1, "original hate quote");
    await splitGuard
      .connect(bot)
      .listAuction(1, ethers.parseEther("0.01"), 86400);

    // Simulate sale: Rare Bazaar would transfer the token from SplitGuard to buyer.
    // Since we use a mock, we impersonate SplitGuard directly.
    // SplitGuard has no receive()/fallback(), so fund the impersonated account
    // via hardhat_setBalance (not a direct ETH transfer).
    const splitGuardAddr = await splitGuard.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [splitGuardAddr]);
    await ethers.provider.send("hardhat_setBalance", [
      splitGuardAddr,
      "0x56BC75E2D63100000", // 100 ETH for gas
    ]);
    const splitGuardAsSigner = await ethers.getSigner(splitGuardAddr);
    await collection
      .connect(splitGuardAsSigner)
      .transferFrom(splitGuardAddr, buyer.address, 1);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [splitGuardAddr]);

    expect(await collection.ownerOf(1)).to.equal(buyer.address);

    // Redemption: bot updates tokenURI + inscribes comeback via writer role.
    // CollectionAdmin forwards to the Rare collection (which it owns), so the
    // buyer's token's URI changes even though they now own the token.
    await admin.connect(bot).updateTokenURI(1, "ipfs://redeemed1");
    await registry
      .connect(bot)
      .inscribeComeback(1, "Ada Lovelace invented software in 1843");

    expect(await collection.tokenURI(1)).to.equal("ipfs://redeemed1");
    expect(await registry.comebackOf(1)).to.equal(
      "Ada Lovelace invented software in 1843"
    );
    expect(await registry.redeemed(1)).to.equal(true);
    expect(await collection.ownerOf(1)).to.equal(buyer.address); // still owned by buyer
  });

  it("revoked bot cannot mint, register, or list — kill switch works", async function () {
    // Grant, verify works, revoke, verify blocks everything
    await admin.connect(bot).mint("ipfs://hate1", "quote");

    // DEPLOYER_A revokes bot on CollectionAdmin
    await admin.connect(deployerA).setWriter(bot.address, false);
    await expect(
      admin.connect(bot).mint("ipfs://hate2", "quote2")
    ).to.be.revertedWithCustomError(admin, "NotWriter");

    // DEPLOYER_A revokes bot on SplitGuard
    await splitGuard.connect(deployerA).setWriter(bot.address, false);
    await expect(
      splitGuard
        .connect(bot)
        .listAuction(1, ethers.parseEther("0.01"), 86400)
    ).to.be.revertedWithCustomError(splitGuard, "NotAuthorized");

    // DEPLOYER_B revokes bot on QuoteRegistry
    await registry.connect(deployerB).setWriter(bot.address, false);
    await expect(
      registry.connect(bot).registerQuote(1, "quote")
    ).to.be.revertedWithCustomError(registry, "NotWriter");
  });

  it("emergencyWithdraw lands in TREASURY — compromised bot cannot redirect", async function () {
    await admin.connect(bot).mint("ipfs://hate1", "quote");
    expect(await collection.ownerOf(1)).to.equal(await splitGuard.getAddress());

    // Even as BOT, emergencyWithdraw has no `to` param — destination is immutable
    await splitGuard.connect(bot).emergencyWithdraw(1);
    expect(await collection.ownerOf(1)).to.equal(treasury.address);
  });

  it("DEPLOYER_A can cancelAuction when bot is revoked — lost bot key doesn't lock listings", async function () {
    await admin.connect(bot).mint("ipfs://hate1", "quote");
    await splitGuard
      .connect(bot)
      .listAuction(1, ethers.parseEther("0.01"), 86400);

    // Bot key leaks — DEPLOYER_A revokes
    await splitGuard.connect(deployerA).setWriter(bot.address, false);

    // DEPLOYER_A backup cancel
    await splitGuard.connect(deployerA).cancelAuction(1);
    expect(
      await bazaar.isCancelled(await collection.getAddress(), 1)
    ).to.equal(true);
  });

  it("mint-to-SplitGuard is hardcoded — bot cannot redirect destination", async function () {
    // CollectionAdmin.mint takes (uri, quote) — no `to` param. Token ALWAYS goes to SplitGuard.
    // This test proves the mint destination is NOT configurable at the ABI level.
    const frag = admin.interface.getFunction("mint");
    expect(frag.inputs.length).to.equal(2);
    expect(frag.inputs[0].name).to.equal("uri");
    expect(frag.inputs[1].name).to.equal("quote");

    // Prove the hardcoded destination works for multiple mints
    await admin.connect(bot).mint("ipfs://hate1", "q1");
    await admin.connect(bot).mint("ipfs://hate2", "q2");
    await admin.connect(bot).mint("ipfs://hate3", "q3");
    expect(await collection.ownerOf(1)).to.equal(await splitGuard.getAddress());
    expect(await collection.ownerOf(2)).to.equal(await splitGuard.getAddress());
    expect(await collection.ownerOf(3)).to.equal(await splitGuard.getAddress());
  });
});
