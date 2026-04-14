import { expect } from "chai";
import { ethers } from "hardhat";
import {
  SplitGuard,
  MockRareCollection,
  MockRareBazaar,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SplitGuard", function () {
  let collection: MockRareCollection;
  let bazaar: MockRareBazaar;
  let splitter: HardhatEthersSigner;
  let guard: SplitGuard;
  let deployerA: HardhatEthersSigner;
  let bot: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const COLDIE_AUCTION =
    "0x434f4c4449455f41554354494f4e000000000000000000000000000000000000";

  beforeEach(async function () {
    [deployerA, bot, treasury, splitter, other] = await ethers.getSigners();

    // Deploy mocks
    const CollectionFactory = await ethers.getContractFactory(
      "MockRareCollection",
      deployerA
    );
    collection = await CollectionFactory.deploy();
    await collection.waitForDeployment();

    const BazaarFactory = await ethers.getContractFactory(
      "MockRareBazaar",
      deployerA
    );
    bazaar = await BazaarFactory.deploy();
    await bazaar.waitForDeployment();

    // Deploy SplitGuard (no BOT constructor arg — writers are granted via setWriter)
    const GuardFactory = await ethers.getContractFactory("SplitGuard", deployerA);
    guard = await GuardFactory.deploy(
      await bazaar.getAddress(),
      await collection.getAddress(),
      splitter.address,
      COLDIE_AUCTION,
      deployerA.address,
      treasury.address
    );
    await guard.waitForDeployment();

    // DEPLOYER_A grants bot the writer role (normal post-deploy step)
    await guard.connect(deployerA).setWriter(bot.address, true);

    // Mint a token directly to SplitGuard (bypassing CollectionAdmin for this focused test)
    await collection.mint(await guard.getAddress(), "ipfs://token-1");
  });

  describe("Deployment", function () {
    it("sets all immutables", async function () {
      expect(await guard.BAZAAR()).to.equal(await bazaar.getAddress());
      expect(await guard.COLLECTION()).to.equal(await collection.getAddress());
      expect(await guard.SPLITTER()).to.equal(splitter.address);
      expect(await guard.AUCTION_TYPE()).to.equal(COLDIE_AUCTION);
      expect(await guard.DEPLOYER_A()).to.equal(deployerA.address);
      expect(await guard.TREASURY()).to.equal(treasury.address);
    });

    it("starts with no writers", async function () {
      // Fresh deploy (without the beforeEach grant)
      const fresh = await (await ethers.getContractFactory("SplitGuard")).deploy(
        await bazaar.getAddress(),
        await collection.getAddress(),
        splitter.address,
        COLDIE_AUCTION,
        deployerA.address,
        treasury.address
      );
      await fresh.waitForDeployment();
      expect(await fresh.writer(bot.address)).to.equal(false);
      expect(await fresh.writer(deployerA.address)).to.equal(false);
    });

    it("grants setApprovalForAll to bazaar in constructor", async function () {
      expect(
        await collection.isApprovedForAll(
          await guard.getAddress(),
          await bazaar.getAddress()
        )
      ).to.equal(true);
    });

    it("reverts on any zero address in constructor", async function () {
      const Factory = await ethers.getContractFactory("SplitGuard");

      const base: [string, string, string, string, string, string] = [
        await bazaar.getAddress(),
        await collection.getAddress(),
        splitter.address,
        COLDIE_AUCTION,
        deployerA.address,
        treasury.address,
      ];

      for (let i = 0; i < base.length; i++) {
        if (i === 3) continue; // AUCTION_TYPE is bytes32, not address
        const args = [...base] as typeof base;
        args[i] = ethers.ZeroAddress;
        await expect(
          Factory.deploy(args[0], args[1], args[2], args[3], args[4], args[5])
        ).to.be.revertedWithCustomError(guard, "ZeroAddress");
      }
    });
  });

  describe("Writer management", function () {
    it("DEPLOYER_A can grant writer role", async function () {
      await expect(guard.connect(deployerA).setWriter(other.address, true))
        .to.emit(guard, "WriterUpdated")
        .withArgs(other.address, true);
      expect(await guard.writer(other.address)).to.equal(true);
    });

    it("DEPLOYER_A can revoke writer role (the kill switch)", async function () {
      expect(await guard.writer(bot.address)).to.equal(true);
      await guard.connect(deployerA).setWriter(bot.address, false);
      expect(await guard.writer(bot.address)).to.equal(false);
    });

    it("non-DEPLOYER_A cannot grant writer role", async function () {
      await expect(
        guard.connect(bot).setWriter(other.address, true)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");

      await expect(
        guard.connect(other).setWriter(other.address, true)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");
    });

    it("revoked writer cannot listAuction", async function () {
      await guard.connect(deployerA).setWriter(bot.address, false);
      await expect(
        guard.connect(bot).listAuction(1, ethers.parseEther("0.01"), 86400)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");
    });
  });

  describe("listAuction", function () {
    it("writer can list, forwards to bazaar with [SPLITTER] and [100]", async function () {
      await guard
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
      expect(call.splitAddresses[0]).to.equal(splitter.address);
      expect(call.splitRatios.length).to.equal(1);
      expect(call.splitRatios[0]).to.equal(100);
    });

    it("reverts when caller is not a writer", async function () {
      await expect(
        guard.connect(other).listAuction(1, ethers.parseEther("0.01"), 86400)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");
    });

    it("reverts when DEPLOYER_A calls listAuction (not a writer by default)", async function () {
      await expect(
        guard.connect(deployerA).listAuction(1, ethers.parseEther("0.01"), 86400)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");
    });

    it("reverts when SplitGuard doesn't own the token", async function () {
      // Mint token #2 to someone else
      await collection.mint(other.address, "ipfs://not-ours");
      await expect(
        guard.connect(bot).listAuction(2, ethers.parseEther("0.01"), 86400)
      ).to.be.revertedWithCustomError(guard, "NotTokenOwner");
    });
  });

  describe("cancelAuction", function () {
    it("writer can cancel", async function () {
      await guard.connect(bot).cancelAuction(1);
      expect(
        await bazaar.isCancelled(await collection.getAddress(), 1)
      ).to.equal(true);
    });

    it("DEPLOYER_A can cancel (backup path, even without writer role)", async function () {
      await guard.connect(deployerA).cancelAuction(1);
      expect(
        await bazaar.isCancelled(await collection.getAddress(), 1)
      ).to.equal(true);
    });

    it("DEPLOYER_A can cancel after revoking all writers (recovery path)", async function () {
      await guard.connect(deployerA).setWriter(bot.address, false);
      await guard.connect(deployerA).cancelAuction(1);
      expect(
        await bazaar.isCancelled(await collection.getAddress(), 1)
      ).to.equal(true);
    });

    it("reverts for unauthorized callers", async function () {
      await expect(
        guard.connect(other).cancelAuction(1)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");

      await expect(
        guard.connect(treasury).cancelAuction(1)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");
    });
  });

  describe("emergencyWithdraw", function () {
    it("writer can withdraw — destination HARDCODED to TREASURY", async function () {
      await guard.connect(bot).emergencyWithdraw(1);
      expect(await collection.ownerOf(1)).to.equal(treasury.address);
    });

    it("DEPLOYER_A can withdraw — also to TREASURY", async function () {
      await guard.connect(deployerA).emergencyWithdraw(1);
      expect(await collection.ownerOf(1)).to.equal(treasury.address);
    });

    it("reverts for unauthorized callers", async function () {
      await expect(
        guard.connect(other).emergencyWithdraw(1)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");

      await expect(
        guard.connect(treasury).emergencyWithdraw(1)
      ).to.be.revertedWithCustomError(guard, "NotAuthorized");
    });

    it("no caller can redirect destination (no `to` parameter exists)", async function () {
      // The function signature takes only tokenId. There is no way for a
      // compromised writer to pass a destination. Enforced at the Solidity
      // compiler level — this test is a design assertion.
      const frag = guard.interface.getFunction("emergencyWithdraw");
      expect(frag.inputs.length).to.equal(1);
      expect(frag.inputs[0].type).to.equal("uint256");
    });
  });

  describe("onERC721Received", function () {
    it("returns the standard selector so safeTransferFrom works", async function () {
      const selector = await guard.onERC721Received(
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        0,
        "0x"
      );
      // 0x150b7a02 is the ERC-721 onERC721Received selector
      expect(selector).to.equal("0x150b7a02");
    });
  });

  describe("Immutability", function () {
    it("SPLITTER / TREASURY / BAZAAR / COLLECTION / AUCTION_TYPE / DEPLOYER_A have no setters", async function () {
      const frags = guard.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);
      expect(frags).to.not.include("setSplitter");
      expect(frags).to.not.include("setTreasury");
      expect(frags).to.not.include("setBazaar");
      expect(frags).to.not.include("setCollection");
      expect(frags).to.not.include("setAuctionType");
      expect(frags).to.not.include("setDeployerA");
    });
  });
});
