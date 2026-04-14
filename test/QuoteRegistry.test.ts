import { expect } from "chai";
import { ethers } from "hardhat";
import { QuoteRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("QuoteRegistry", function () {
  let registry: QuoteRegistry;
  let owner: HardhatEthersSigner;
  let bot: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, bot, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("QuoteRegistry");
    registry = await Factory.deploy();
    await registry.waitForDeployment();
    // Owner grants bot writer role so existing behaviour tests work
    await registry.setWriter(bot.address, true);
  });

  describe("Deployment", function () {
    it("should set owner correctly", async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("should start with 0 quotes", async function () {
      expect(await registry.totalQuotes()).to.equal(0);
    });

    it("should start with no writers", async function () {
      const fresh = await (await ethers.getContractFactory("QuoteRegistry")).deploy();
      await fresh.waitForDeployment();
      expect(await fresh.writer(owner.address)).to.equal(false);
      expect(await fresh.writer(bot.address)).to.equal(false);
    });
  });

  describe("Writer management", function () {
    it("owner can grant writer role", async function () {
      await expect(registry.setWriter(other.address, true))
        .to.emit(registry, "WriterUpdated")
        .withArgs(other.address, true);
      expect(await registry.writer(other.address)).to.equal(true);
    });

    it("owner can revoke writer role", async function () {
      expect(await registry.writer(bot.address)).to.equal(true);
      await registry.setWriter(bot.address, false);
      expect(await registry.writer(bot.address)).to.equal(false);
    });

    it("non-owner cannot grant writer role", async function () {
      await expect(
        registry.connect(other).setWriter(other.address, true)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("writer cannot grant writer role to others", async function () {
      await expect(
        registry.connect(bot).setWriter(other.address, true)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("revoked writer cannot register quotes", async function () {
      await registry.setWriter(bot.address, false);
      await expect(
        registry.connect(bot).registerQuote(1, "quote")
      ).to.be.revertedWithCustomError(registry, "NotWriter");
    });
  });

  describe("registerQuote", function () {
    it("writer can store a quote", async function () {
      await registry.connect(bot).registerQuote(1, "Women belong in the kitchen");
      expect(await registry.quoteOf(1)).to.equal("Women belong in the kitchen");
    });

    it("increments totalQuotes", async function () {
      await registry.connect(bot).registerQuote(1, "quote 1");
      await registry.connect(bot).registerQuote(2, "quote 2");
      expect(await registry.totalQuotes()).to.equal(2);
    });

    it("emits QuoteRegistered event", async function () {
      await expect(registry.connect(bot).registerQuote(1, "test quote"))
        .to.emit(registry, "QuoteRegistered")
        .withArgs(1, "test quote");
    });

    it("rejects duplicate registration", async function () {
      await registry.connect(bot).registerQuote(1, "first");
      await expect(
        registry.connect(bot).registerQuote(1, "second")
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("rejects empty string", async function () {
      await expect(
        registry.connect(bot).registerQuote(1, "")
      ).to.be.revertedWithCustomError(registry, "EmptyString");
    });

    it("rejects non-writer (owner with no writer role)", async function () {
      // Owner is NOT a writer by default
      await expect(
        registry.registerQuote(1, "quote")
      ).to.be.revertedWithCustomError(registry, "NotWriter");
    });

    it("rejects random address", async function () {
      await expect(
        registry.connect(other).registerQuote(1, "quote")
      ).to.be.revertedWithCustomError(registry, "NotWriter");
    });
  });

  describe("inscribeComeback", function () {
    beforeEach(async function () {
      await registry.connect(bot).registerQuote(1, "misogynistic quote");
    });

    it("writer can store a comeback", async function () {
      await registry.connect(bot).inscribeComeback(
        1,
        "The biggest empire was run by a queen"
      );
      expect(await registry.comebackOf(1)).to.equal(
        "The biggest empire was run by a queen"
      );
    });

    it("marks token as redeemed", async function () {
      expect(await registry.redeemed(1)).to.equal(false);
      await registry.connect(bot).inscribeComeback(1, "comeback");
      expect(await registry.redeemed(1)).to.equal(true);
    });

    it("emits ComebackInscribed event", async function () {
      await expect(registry.connect(bot).inscribeComeback(1, "roast"))
        .to.emit(registry, "ComebackInscribed")
        .withArgs(1, "roast");
    });

    it("rejects double redemption", async function () {
      await registry.connect(bot).inscribeComeback(1, "first comeback");
      await expect(
        registry.connect(bot).inscribeComeback(1, "second comeback")
      ).to.be.revertedWithCustomError(registry, "AlreadyRedeemed");
    });

    it("rejects empty string", async function () {
      await expect(
        registry.connect(bot).inscribeComeback(1, "")
      ).to.be.revertedWithCustomError(registry, "EmptyString");
    });

    it("rejects non-writer", async function () {
      await expect(
        registry.connect(other).inscribeComeback(1, "comeback")
      ).to.be.revertedWithCustomError(registry, "NotWriter");
    });

    it("rejects comeback for unregistered token", async function () {
      await expect(
        registry.connect(bot).inscribeComeback(99, "orphaned comeback")
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });
  });

  describe("String length limits", function () {
    it("rejects quote longer than 1024 bytes", async function () {
      const longQuote = "x".repeat(1025);
      await expect(
        registry.connect(bot).registerQuote(1, longQuote)
      ).to.be.revertedWithCustomError(registry, "StringTooLong");
    });

    it("accepts quote at exactly 1024 bytes", async function () {
      const maxQuote = "x".repeat(1024);
      await registry.connect(bot).registerQuote(1, maxQuote);
      expect(await registry.quoteOf(1)).to.equal(maxQuote);
    });

    it("rejects comeback longer than 1024 bytes", async function () {
      await registry.connect(bot).registerQuote(1, "quote");
      const longComeback = "x".repeat(1025);
      await expect(
        registry.connect(bot).inscribeComeback(1, longComeback)
      ).to.be.revertedWithCustomError(registry, "StringTooLong");
    });
  });

  describe("registerBoth", function () {
    it("writer can store quote and comeback in one call", async function () {
      await registry.connect(bot).registerBoth(1, "hate", "counter");
      expect(await registry.quoteOf(1)).to.equal("hate");
      expect(await registry.comebackOf(1)).to.equal("counter");
      expect(await registry.redeemed(1)).to.equal(true);
      expect(await registry.totalQuotes()).to.equal(1);
    });

    it("emits both events", async function () {
      const tx = registry.connect(bot).registerBoth(1, "hate", "counter");
      await expect(tx)
        .to.emit(registry, "QuoteRegistered")
        .withArgs(1, "hate");
      await expect(tx)
        .to.emit(registry, "ComebackInscribed")
        .withArgs(1, "counter");
    });

    it("rejects duplicate", async function () {
      await registry.connect(bot).registerBoth(1, "hate", "counter");
      await expect(
        registry.connect(bot).registerBoth(1, "hate2", "counter2")
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("rejects empty quote", async function () {
      await expect(
        registry.connect(bot).registerBoth(1, "", "counter")
      ).to.be.revertedWithCustomError(registry, "EmptyString");
    });

    it("rejects empty comeback", async function () {
      await expect(
        registry.connect(bot).registerBoth(1, "hate", "")
      ).to.be.revertedWithCustomError(registry, "EmptyString");
    });

    it("rejects non-writer", async function () {
      await expect(
        registry.connect(other).registerBoth(1, "hate", "counter")
      ).to.be.revertedWithCustomError(registry, "NotWriter");
    });
  });

  describe("Independent token IDs", function () {
    it("handles non-sequential token IDs", async function () {
      await registry.connect(bot).registerQuote(5, "quote five");
      await registry.connect(bot).registerQuote(100, "quote hundred");
      expect(await registry.quoteOf(5)).to.equal("quote five");
      expect(await registry.quoteOf(100)).to.equal("quote hundred");
      expect(await registry.totalQuotes()).to.equal(2);
    });

    it("returns empty for unregistered tokens", async function () {
      expect(await registry.quoteOf(999)).to.equal("");
      expect(await registry.comebackOf(999)).to.equal("");
      expect(await registry.redeemed(999)).to.equal(false);
    });
  });
});
