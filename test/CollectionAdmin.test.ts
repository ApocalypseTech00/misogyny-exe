import { expect } from "chai";
import { ethers } from "hardhat";
import { CollectionAdmin, MockRareCollection } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("CollectionAdmin", function () {
  let collection: MockRareCollection;
  let admin: CollectionAdmin;
  let deployerA: HardhatEthersSigner; // owner
  let bot: HardhatEthersSigner; // writer
  let other: HardhatEthersSigner;
  let splitGuardAddr: string;

  beforeEach(async function () {
    [deployerA, bot, other] = await ethers.getSigners();

    // Use `other` as a stand-in for the SplitGuard address in these tests
    splitGuardAddr = other.address;

    const CollectionFactory = await ethers.getContractFactory("MockRareCollection", deployerA);
    collection = await CollectionFactory.deploy();
    await collection.waitForDeployment();

    const AdminFactory = await ethers.getContractFactory("CollectionAdmin", deployerA);
    admin = await AdminFactory.deploy(
      await collection.getAddress(),
      splitGuardAddr
    );
    await admin.waitForDeployment();

    // Transfer collection ownership to the admin wrapper
    await collection.transferOwnership(await admin.getAddress());

    // Grant bot the writer role
    await admin.setWriter(bot.address, true);
  });

  describe("Deployment", function () {
    it("sets owner to deployer", async function () {
      expect(await admin.owner()).to.equal(deployerA.address);
    });

    it("stores COLLECTION and SPLIT_GUARD as immutable", async function () {
      expect(await admin.COLLECTION()).to.equal(await collection.getAddress());
      expect(await admin.SPLIT_GUARD()).to.equal(splitGuardAddr);
    });

    it("reverts on zero collection", async function () {
      const Factory = await ethers.getContractFactory("CollectionAdmin");
      await expect(
        Factory.deploy(ethers.ZeroAddress, splitGuardAddr)
      ).to.be.revertedWithCustomError(admin, "ZeroAddress");
    });

    it("reverts on zero split guard", async function () {
      const Factory = await ethers.getContractFactory("CollectionAdmin");
      await expect(
        Factory.deploy(await collection.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(admin, "ZeroAddress");
    });
  });

  describe("Writer management", function () {
    it("owner can grant + revoke writer", async function () {
      await expect(admin.setWriter(other.address, true))
        .to.emit(admin, "WriterUpdated")
        .withArgs(other.address, true);
      expect(await admin.writer(other.address)).to.equal(true);

      await admin.setWriter(other.address, false);
      expect(await admin.writer(other.address)).to.equal(false);
    });

    it("non-owner cannot set writer", async function () {
      await expect(
        admin.connect(bot).setWriter(other.address, true)
      ).to.be.revertedWithCustomError(admin, "OwnableUnauthorizedAccount");
    });
  });

  describe("mint", function () {
    it("mints via collection with recipient hardcoded to SPLIT_GUARD", async function () {
      const tx = await admin.connect(bot).mint("ipfs://meta1", "quote one");
      await tx.wait();

      // tokenId 1 goes to SPLIT_GUARD, not bot
      expect(await collection.ownerOf(1)).to.equal(splitGuardAddr);
      expect(await collection.tokenURI(1)).to.equal("ipfs://meta1");
    });

    it("emits MintRouted with tokenId + uri + quote", async function () {
      await expect(admin.connect(bot).mint("ipfs://meta1", "quote one"))
        .to.emit(admin, "MintRouted")
        .withArgs(1, "ipfs://meta1", "quote one");
    });

    it("assigns sequential token ids", async function () {
      await admin.connect(bot).mint("ipfs://a", "q1");
      await admin.connect(bot).mint("ipfs://b", "q2");
      await admin.connect(bot).mint("ipfs://c", "q3");
      expect(await collection.ownerOf(1)).to.equal(splitGuardAddr);
      expect(await collection.ownerOf(2)).to.equal(splitGuardAddr);
      expect(await collection.ownerOf(3)).to.equal(splitGuardAddr);
    });

    it("reverts for non-writer", async function () {
      await expect(
        admin.connect(other).mint("ipfs://meta", "quote")
      ).to.be.revertedWithCustomError(admin, "NotWriter");
    });

    it("reverts for revoked writer", async function () {
      await admin.setWriter(bot.address, false);
      await expect(
        admin.connect(bot).mint("ipfs://meta", "quote")
      ).to.be.revertedWithCustomError(admin, "NotWriter");
    });

    it("owner is not a writer by default", async function () {
      await expect(
        admin.mint("ipfs://meta", "quote")
      ).to.be.revertedWithCustomError(admin, "NotWriter");
    });
  });

  describe("updateTokenURI", function () {
    beforeEach(async function () {
      await admin.connect(bot).mint("ipfs://original", "quote");
    });

    it("writer can update tokenURI (redemption flow)", async function () {
      await admin.connect(bot).updateTokenURI(1, "ipfs://redeemed");
      expect(await collection.tokenURI(1)).to.equal("ipfs://redeemed");
    });

    it("reverts for non-writer", async function () {
      await expect(
        admin.connect(other).updateTokenURI(1, "ipfs://malicious")
      ).to.be.revertedWithCustomError(admin, "NotWriter");
    });

    it("owner cannot directly updateTokenURI without writer role", async function () {
      await expect(
        admin.updateTokenURI(1, "ipfs://from-owner")
      ).to.be.revertedWithCustomError(admin, "NotWriter");
    });
  });

  describe("setRoyaltyReceiver (owner only)", function () {
    it("owner can forward setRoyaltyReceiver", async function () {
      await expect(admin.setRoyaltyReceiver(other.address))
        .to.emit(collection, "RoyaltyReceiverUpdated")
        .withArgs(other.address);
      expect(await collection.royaltyReceiver()).to.equal(other.address);
    });

    it("writer cannot call setRoyaltyReceiver", async function () {
      await expect(
        admin.connect(bot).setRoyaltyReceiver(other.address)
      ).to.be.revertedWithCustomError(admin, "OwnableUnauthorizedAccount");
    });
  });

  describe("transferCollectionOwnership (owner only)", function () {
    it("owner can transfer underlying collection ownership", async function () {
      await admin.transferCollectionOwnership(deployerA.address);
      expect(await collection.owner()).to.equal(deployerA.address);
    });

    it("non-owner cannot transfer collection ownership", async function () {
      await expect(
        admin.connect(bot).transferCollectionOwnership(bot.address)
      ).to.be.revertedWithCustomError(admin, "OwnableUnauthorizedAccount");
    });
  });
});
