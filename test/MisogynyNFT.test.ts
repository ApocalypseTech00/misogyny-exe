import { expect } from "chai";
import { ethers } from "hardhat";
import { MisogynyNFT, MisogynyMarketplace } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MisogynyNFT", function () {
  let nft: MisogynyNFT;
  let marketplace: MisogynyMarketplace;
  let owner: HardhatEthersSigner;
  let charity: HardhatEthersSigner;
  let bot: HardhatEthersSigner;
  let artist: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, charity, bot, artist, user] = await ethers.getSigners();

    const NFT = await ethers.getContractFactory("MisogynyNFT");
    nft = await NFT.deploy();
    await nft.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("MisogynyMarketplace");
    marketplace = await Marketplace.deploy(
      await nft.getAddress(),
      charity.address,
      bot.address,
      artist.address
    );
    await marketplace.waitForDeployment();

    await nft.setMarketplace(await marketplace.getAddress());
  });

  describe("Deployment", function () {
    it("should have correct name and symbol", async function () {
      expect(await nft.name()).to.equal("MISOGYNY.EXE");
      expect(await nft.symbol()).to.equal("MSGNY");
    });

    it("should set owner correctly", async function () {
      expect(await nft.owner()).to.equal(owner.address);
    });

    it("should set marketplace correctly", async function () {
      expect(await nft.marketplace()).to.equal(
        await marketplace.getAddress()
      );
    });
  });

  describe("Marketplace setting", function () {
    it("should allow owner to update marketplace", async function () {
      await nft.setMarketplace(user.address);
      expect(await nft.marketplace()).to.equal(user.address);
    });

    it("should reject zero address marketplace", async function () {
      await expect(
        nft.setMarketplace(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(nft, "TransferRestricted");
    });

    it("should reject non-owner setting marketplace", async function () {
      await expect(
        nft.connect(user).setMarketplace(user.address)
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    });

    it("should emit MarketplaceUpdated event", async function () {
      await expect(nft.setMarketplace(user.address))
        .to.emit(nft, "MarketplaceUpdated")
        .withArgs(user.address);
    });
  });

  describe("Minting", function () {
    it("should mint to specified address", async function () {
      await nft.mint(user.address, "ipfs://test");
      expect(await nft.ownerOf(1)).to.equal(user.address);
    });

    it("should set tokenURI correctly", async function () {
      await nft.mint(owner.address, "ipfs://metadata/1");
      expect(await nft.tokenURI(1)).to.equal("ipfs://metadata/1");
    });

    it("should increment totalSupply", async function () {
      expect(await nft.totalSupply()).to.equal(0);
      await nft.mint(owner.address, "ipfs://1");
      expect(await nft.totalSupply()).to.equal(1);
      await nft.mint(owner.address, "ipfs://2");
      expect(await nft.totalSupply()).to.equal(2);
    });

    it("should assign sequential token IDs starting at 1", async function () {
      await nft.mint(owner.address, "ipfs://1");
      await nft.mint(owner.address, "ipfs://2");
      expect(await nft.ownerOf(1)).to.equal(owner.address);
      expect(await nft.ownerOf(2)).to.equal(owner.address);
    });

    it("should reject non-owner minting", async function () {
      await expect(
        nft.connect(user).mint(user.address, "ipfs://test")
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    });
  });

  describe("Transfer restrictions", function () {
    beforeEach(async function () {
      await nft.mint(owner.address, "ipfs://1");
    });

    it("should block direct transferFrom", async function () {
      await expect(
        nft.transferFrom(owner.address, user.address, 1)
      ).to.be.revertedWithCustomError(nft, "TransferRestricted");
    });

    it("should block direct safeTransferFrom", async function () {
      await expect(
        nft["safeTransferFrom(address,address,uint256)"](
          owner.address,
          user.address,
          1
        )
      ).to.be.revertedWithCustomError(nft, "TransferRestricted");
    });

    it("should allow transfer via marketplace (buy flow)", async function () {
      // Owner lists token on marketplace
      await marketplace.list(1, ethers.parseEther("1"));
      // User buys it
      await marketplace
        .connect(user)
        .buy(1, { value: ethers.parseEther("1") });
      expect(await nft.ownerOf(1)).to.equal(user.address);
    });

    it("should block transfer even with approval", async function () {
      await nft.approve(user.address, 1);
      await expect(
        nft.connect(user).transferFrom(owner.address, user.address, 1)
      ).to.be.revertedWithCustomError(nft, "TransferRestricted");
    });
  });
});
