import { expect } from "chai";
import { ethers } from "hardhat";
import { MisogynyNFT, MisogynyMarketplace } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MisogynyMarketplace", function () {
  let nft: MisogynyNFT;
  let marketplace: MisogynyMarketplace;
  let owner: HardhatEthersSigner;
  let charity: HardhatEthersSigner;
  let botWallet: HardhatEthersSigner;
  let artist: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, charity, botWallet, artist, seller, buyer] =
      await ethers.getSigners();

    const NFT = await ethers.getContractFactory("MisogynyNFT");
    nft = await NFT.deploy();
    await nft.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("MisogynyMarketplace");
    marketplace = await Marketplace.deploy(
      await nft.getAddress(),
      charity.address,
      botWallet.address,
      artist.address
    );
    await marketplace.waitForDeployment();

    await nft.setMarketplace(await marketplace.getAddress());
  });

  describe("Deployment", function () {
    it("should set NFT address correctly", async function () {
      expect(await marketplace.nft()).to.equal(await nft.getAddress());
    });

    it("should set wallet addresses correctly", async function () {
      expect(await marketplace.charityWallet()).to.equal(charity.address);
      expect(await marketplace.botWallet()).to.equal(botWallet.address);
      expect(await marketplace.artistWallet()).to.equal(artist.address);
    });

    it("should set royalty to 15%", async function () {
      expect(await marketplace.ROYALTY_BPS()).to.equal(1500);
    });

    it("should reject zero addresses in constructor", async function () {
      const Marketplace = await ethers.getContractFactory(
        "MisogynyMarketplace"
      );
      await expect(
        Marketplace.deploy(
          ethers.ZeroAddress,
          charity.address,
          botWallet.address,
          artist.address
        )
      ).to.be.revertedWithCustomError(Marketplace, "ZeroAddress");
    });
  });

  describe("Listing", function () {
    beforeEach(async function () {
      // Owner mints token to seller
      await nft.mint(seller.address, "ipfs://1");
    });

    it("should list a token", async function () {
      await marketplace
        .connect(seller)
        .list(1, ethers.parseEther("0.5"));
      const listing = await marketplace.listings(1);
      expect(listing.seller).to.equal(seller.address);
      expect(listing.price).to.equal(ethers.parseEther("0.5"));
    });

    it("should emit Listed event", async function () {
      await expect(
        marketplace.connect(seller).list(1, ethers.parseEther("0.5"))
      )
        .to.emit(marketplace, "Listed")
        .withArgs(1, seller.address, ethers.parseEther("0.5"));
    });

    it("should reject listing by non-owner of token", async function () {
      await expect(
        marketplace.connect(buyer).list(1, ethers.parseEther("0.5"))
      ).to.be.revertedWithCustomError(marketplace, "NotTokenOwner");
    });

    it("should reject zero price", async function () {
      await expect(
        marketplace.connect(seller).list(1, 0)
      ).to.be.revertedWithCustomError(marketplace, "ZeroPrice");
    });

    it("should reject double listing", async function () {
      await marketplace
        .connect(seller)
        .list(1, ethers.parseEther("0.5"));
      await expect(
        marketplace.connect(seller).list(1, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(marketplace, "AlreadyListed");
    });
  });

  describe("Buying", function () {
    const PRICE = ethers.parseEther("1");

    beforeEach(async function () {
      await nft.mint(seller.address, "ipfs://1");
      await marketplace.connect(seller).list(1, PRICE);
    });

    it("should transfer NFT to buyer", async function () {
      await marketplace.connect(buyer).buy(1, { value: PRICE });
      expect(await nft.ownerOf(1)).to.equal(buyer.address);
    });

    it("should pay seller 85%", async function () {
      const sellerBefore = await ethers.provider.getBalance(seller.address);
      await marketplace.connect(buyer).buy(1, { value: PRICE });
      const sellerAfter = await ethers.provider.getBalance(seller.address);

      // 85% of 1 ETH = 0.85 ETH
      expect(sellerAfter - sellerBefore).to.equal(
        ethers.parseEther("0.85")
      );
    });

    it("should split 15% royalty equally (5% each)", async function () {
      const charityBefore = await ethers.provider.getBalance(charity.address);
      const botBefore = await ethers.provider.getBalance(botWallet.address);
      const artistBefore = await ethers.provider.getBalance(artist.address);

      await marketplace.connect(buyer).buy(1, { value: PRICE });

      const charityAfter = await ethers.provider.getBalance(charity.address);
      const botAfter = await ethers.provider.getBalance(botWallet.address);
      const artistAfter = await ethers.provider.getBalance(artist.address);

      // 15% of 1 ETH = 0.15 ETH, split 3 ways = 0.05 ETH each
      expect(charityAfter - charityBefore).to.equal(
        ethers.parseEther("0.05")
      );
      expect(botAfter - botBefore).to.equal(ethers.parseEther("0.05"));
      expect(artistAfter - artistBefore).to.equal(
        ethers.parseEther("0.05")
      );
    });

    it("should clear listing after purchase", async function () {
      await marketplace.connect(buyer).buy(1, { value: PRICE });
      const listing = await marketplace.listings(1);
      expect(listing.price).to.equal(0);
      expect(listing.seller).to.equal(ethers.ZeroAddress);
    });

    it("should refund overpayment", async function () {
      const overpay = ethers.parseEther("2");
      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      const tx = await marketplace
        .connect(buyer)
        .buy(1, { value: overpay });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const buyerAfter = await ethers.provider.getBalance(buyer.address);

      // Buyer should have paid exactly 1 ETH + gas
      expect(buyerBefore - buyerAfter - gasUsed).to.equal(PRICE);
    });

    it("should emit Sold event", async function () {
      await expect(marketplace.connect(buyer).buy(1, { value: PRICE }))
        .to.emit(marketplace, "Sold")
        .withArgs(1, seller.address, buyer.address, PRICE);
    });

    it("should reject insufficient payment", async function () {
      await expect(
        marketplace
          .connect(buyer)
          .buy(1, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWithCustomError(marketplace, "InsufficientPayment");
    });

    it("should reject buying unlisted token", async function () {
      await expect(
        marketplace.connect(buyer).buy(99, { value: PRICE })
      ).to.be.revertedWithCustomError(marketplace, "NotListed");
    });
  });

  describe("Cancellation", function () {
    beforeEach(async function () {
      await nft.mint(seller.address, "ipfs://1");
      await marketplace
        .connect(seller)
        .list(1, ethers.parseEther("1"));
    });

    it("should cancel listing", async function () {
      await marketplace.connect(seller).cancel(1);
      const listing = await marketplace.listings(1);
      expect(listing.price).to.equal(0);
    });

    it("should emit Cancelled event", async function () {
      await expect(marketplace.connect(seller).cancel(1))
        .to.emit(marketplace, "Cancelled")
        .withArgs(1, seller.address);
    });

    it("should reject cancellation by non-seller", async function () {
      await expect(
        marketplace.connect(buyer).cancel(1)
      ).to.be.revertedWithCustomError(marketplace, "NotSeller");
    });

    it("should allow re-listing after cancellation", async function () {
      await marketplace.connect(seller).cancel(1);
      await marketplace
        .connect(seller)
        .list(1, ethers.parseEther("2"));
      const listing = await marketplace.listings(1);
      expect(listing.price).to.equal(ethers.parseEther("2"));
    });
  });

  describe("Wallet updates", function () {
    it("should allow owner to update wallets", async function () {
      await marketplace.updateWallets(
        buyer.address,
        seller.address,
        artist.address
      );
      expect(await marketplace.charityWallet()).to.equal(buyer.address);
      expect(await marketplace.botWallet()).to.equal(seller.address);
    });

    it("should emit WalletsUpdated event", async function () {
      await expect(
        marketplace.updateWallets(
          buyer.address,
          seller.address,
          artist.address
        )
      )
        .to.emit(marketplace, "WalletsUpdated")
        .withArgs(buyer.address, seller.address, artist.address);
    });

    it("should reject non-owner updating wallets", async function () {
      await expect(
        marketplace
          .connect(buyer)
          .updateWallets(buyer.address, seller.address, artist.address)
      ).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
    });

    it("should reject zero address wallets", async function () {
      await expect(
        marketplace.updateWallets(
          ethers.ZeroAddress,
          seller.address,
          artist.address
        )
      ).to.be.revertedWithCustomError(marketplace, "ZeroAddress");
    });
  });

  describe("Integration — full flow", function () {
    it("should handle primary sale (bot mints → lists → user buys)", async function () {
      // Bot (owner) mints to itself
      await nft.mint(owner.address, "ipfs://art/1");
      expect(await nft.ownerOf(1)).to.equal(owner.address);

      // Bot lists on marketplace
      await marketplace.list(1, ethers.parseEther("0.1"));

      // User buys
      const charityBefore = await ethers.provider.getBalance(charity.address);
      await marketplace
        .connect(buyer)
        .buy(1, { value: ethers.parseEther("0.1") });

      // NFT now belongs to buyer
      expect(await nft.ownerOf(1)).to.equal(buyer.address);

      // Charity got 5%
      const charityAfter = await ethers.provider.getBalance(charity.address);
      expect(charityAfter - charityBefore).to.equal(
        ethers.parseEther("0.005")
      );
    });

    it("should handle secondary sale (buyer re-lists → new buyer buys)", async function () {
      // Primary sale
      await nft.mint(seller.address, "ipfs://art/1");
      await marketplace
        .connect(seller)
        .list(1, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .buy(1, { value: ethers.parseEther("1") });

      // Secondary sale — buyer becomes seller
      await marketplace
        .connect(buyer)
        .list(1, ethers.parseEther("2"));
      const listing = await marketplace.listings(1);
      expect(listing.seller).to.equal(buyer.address);
      expect(listing.price).to.equal(ethers.parseEther("2"));

      // New buyer (use seller signer as the new buyer)
      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      await marketplace
        .connect(seller)
        .buy(1, { value: ethers.parseEther("2") });

      // NFT transferred to new buyer
      expect(await nft.ownerOf(1)).to.equal(seller.address);

      // Original buyer (now seller) got 85% of 2 ETH = 1.7 ETH
      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerAfter - buyerBefore).to.equal(ethers.parseEther("1.7"));
    });

    it("should handle multiple tokens independently", async function () {
      await nft.mint(seller.address, "ipfs://1");
      await nft.mint(seller.address, "ipfs://2");

      await marketplace
        .connect(seller)
        .list(1, ethers.parseEther("1"));
      await marketplace
        .connect(seller)
        .list(2, ethers.parseEther("2"));

      // Buy token 1 only
      await marketplace
        .connect(buyer)
        .buy(1, { value: ethers.parseEther("1") });

      expect(await nft.ownerOf(1)).to.equal(buyer.address);
      expect(await nft.ownerOf(2)).to.equal(seller.address);

      // Token 2 still listed
      const listing = await marketplace.listings(2);
      expect(listing.price).to.equal(ethers.parseEther("2"));
    });

    it("should handle rounding correctly on odd amounts", async function () {
      await nft.mint(seller.address, "ipfs://1");
      // Use a price that creates rounding: 1 wei
      // 15% of 1 = 0, perWallet = 0, seller gets 1
      // This tests the edge case gracefully
      await marketplace.connect(seller).list(1, 1);

      const sellerBefore = await ethers.provider.getBalance(seller.address);
      await marketplace.connect(buyer).buy(1, { value: 1 });
      const sellerAfter = await ethers.provider.getBalance(seller.address);

      // Royalty rounds to 0, seller gets everything
      expect(sellerAfter - sellerBefore).to.equal(1);
    });
  });
});

describe("PaymentSplitter — 5/5/5 split", function () {
  it("should split equally with shares [1, 1, 1]", async function () {
    const [sender, charity, bot, artist] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory(
      "MisogynyPaymentSplitter"
    );
    const splitter = await Factory.deploy(
      [charity.address, bot.address, artist.address],
      [1, 1, 1]
    );
    await splitter.waitForDeployment();

    // Send 3 ETH (cleanly divisible by 3)
    await sender.sendTransaction({
      to: await splitter.getAddress(),
      value: ethers.parseEther("3"),
    });

    // Each should get 1 ETH
    expect(await splitter.pending(charity.address)).to.equal(
      ethers.parseEther("1")
    );
    expect(await splitter.pending(bot.address)).to.equal(
      ethers.parseEther("1")
    );
    expect(await splitter.pending(artist.address)).to.equal(
      ethers.parseEther("1")
    );

    // Release all
    const charityBefore = await ethers.provider.getBalance(charity.address);
    const botBefore = await ethers.provider.getBalance(bot.address);
    const artistBefore = await ethers.provider.getBalance(artist.address);

    await splitter.releaseAll();

    expect(
      (await ethers.provider.getBalance(charity.address)) - charityBefore
    ).to.equal(ethers.parseEther("1"));
    expect(
      (await ethers.provider.getBalance(bot.address)) - botBefore
    ).to.equal(ethers.parseEther("1"));
    expect(
      (await ethers.provider.getBalance(artist.address)) - artistBefore
    ).to.equal(ethers.parseEther("1"));
  });
});
