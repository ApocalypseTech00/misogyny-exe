import { expect } from "chai";
import { ethers } from "hardhat";

describe("MisogynyPaymentSplitter", function () {
  let splitter: any;
  let charity: string;
  let artist: string;
  let project: string;

  beforeEach(async function () {
    const [, charityWallet, artistWallet, projectWallet] =
      await ethers.getSigners();

    charity = charityWallet.address;
    artist = artistWallet.address;
    project = projectWallet.address;

    const Factory = await ethers.getContractFactory(
      "MisogynyPaymentSplitter"
    );
    splitter = await Factory.deploy(
      [charity, artist, project],
      [50, 30, 20]
    );
    await splitter.waitForDeployment();
  });

  it("should have correct shares", async function () {
    expect(await splitter.shares(charity)).to.equal(50);
    expect(await splitter.shares(artist)).to.equal(30);
    expect(await splitter.shares(project)).to.equal(20);
  });

  it("should have 100 total shares", async function () {
    expect(await splitter.totalShares()).to.equal(100);
  });

  it("should report correct pending amounts", async function () {
    const [sender] = await ethers.getSigners();
    await sender.sendTransaction({
      to: await splitter.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    expect(await splitter.pending(charity)).to.equal(
      ethers.parseEther("0.5")
    );
    expect(await splitter.pending(artist)).to.equal(
      ethers.parseEther("0.3")
    );
    expect(await splitter.pending(project)).to.equal(
      ethers.parseEther("0.2")
    );
  });

  it("should split ETH correctly", async function () {
    const [sender] = await ethers.getSigners();

    await sender.sendTransaction({
      to: await splitter.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    // Release to charity (50%)
    const charityBefore = await ethers.provider.getBalance(charity);
    await splitter.release(charity);
    const charityAfter = await ethers.provider.getBalance(charity);
    expect(charityAfter - charityBefore).to.equal(
      ethers.parseEther("0.5")
    );

    // Release to artist (30%)
    const artistBefore = await ethers.provider.getBalance(artist);
    await splitter.release(artist);
    const artistAfter = await ethers.provider.getBalance(artist);
    expect(artistAfter - artistBefore).to.equal(
      ethers.parseEther("0.3")
    );

    // Release to project (20%)
    const projectBefore = await ethers.provider.getBalance(project);
    await splitter.release(project);
    const projectAfter = await ethers.provider.getBalance(project);
    expect(projectAfter - projectBefore).to.equal(
      ethers.parseEther("0.2")
    );
  });

  it("should releaseAll in one call", async function () {
    const [sender] = await ethers.getSigners();

    await sender.sendTransaction({
      to: await splitter.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    const charityBefore = await ethers.provider.getBalance(charity);
    const artistBefore = await ethers.provider.getBalance(artist);
    const projectBefore = await ethers.provider.getBalance(project);

    await splitter.releaseAll();

    const charityAfter = await ethers.provider.getBalance(charity);
    const artistAfter = await ethers.provider.getBalance(artist);
    const projectAfter = await ethers.provider.getBalance(project);

    expect(charityAfter - charityBefore).to.equal(
      ethers.parseEther("0.5")
    );
    expect(artistAfter - artistBefore).to.equal(
      ethers.parseEther("0.3")
    );
    expect(projectAfter - projectBefore).to.equal(
      ethers.parseEther("0.2")
    );

    // Contract should be empty
    expect(
      await ethers.provider.getBalance(await splitter.getAddress())
    ).to.equal(0);
  });

  it("should reject release for non-payee", async function () {
    const [sender] = await ethers.getSigners();

    await sender.sendTransaction({
      to: await splitter.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    await expect(
      splitter.release(sender.address)
    ).to.be.revertedWithCustomError(splitter, "AccountHasNoShares");
  });

  it("should reject release when no payment due", async function () {
    await expect(
      splitter.release(charity)
    ).to.be.revertedWithCustomError(splitter, "NotDuePayment");
  });

  it("should handle multiple deposits", async function () {
    const [sender] = await ethers.getSigners();

    await sender.sendTransaction({
      to: await splitter.getAddress(),
      value: ethers.parseEther("0.5"),
    });
    await sender.sendTransaction({
      to: await splitter.getAddress(),
      value: ethers.parseEther("0.5"),
    });

    const charityBefore = await ethers.provider.getBalance(charity);
    await splitter.release(charity);
    const charityAfter = await ethers.provider.getBalance(charity);
    expect(charityAfter - charityBefore).to.equal(
      ethers.parseEther("0.5")
    );
  });

  it("should reject empty payees array", async function () {
    const Factory = await ethers.getContractFactory(
      "MisogynyPaymentSplitter"
    );
    await expect(Factory.deploy([], [])).to.be.revertedWithCustomError(
      Factory,
      "NoPayees"
    );
  });

  it("should track payee count", async function () {
    expect(await splitter.payeeCount()).to.equal(3);
    expect(await splitter.payee(0)).to.equal(charity);
    expect(await splitter.payee(1)).to.equal(artist);
    expect(await splitter.payee(2)).to.equal(project);
  });
});
