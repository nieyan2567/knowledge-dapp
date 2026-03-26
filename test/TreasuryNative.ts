import { expect } from "chai";
import { ethers } from "hardhat";
import { TreasuryNative } from "../typechain-types";
import { TreasuryNative__factory } from "../typechain-types";

describe("TreasuryNative", function () {
  async function deployTreasury(): Promise<{
    deployer: any;
    spender: any;
    alice: any;
    bob: any;
    treasury: TreasuryNative;
  }> {
    const [deployer, spender, alice, bob] = await ethers.getSigners();

    const factory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury = await factory.deploy(3600, ethers.parseEther("100"));
    await treasury.waitForDeployment();

    await treasury.setSpender(spender.address, true);
    await (
      await deployer.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("5"),
      })
    ).wait();

    return { deployer, spender, alice, bob, treasury };
  }

  it("should enforce cumulative reward reservations", async function () {
    const { spender, alice, bob, treasury } = await deployTreasury();

    await (
      await treasury
        .connect(spender)
        .accrueReward(alice.address, ethers.parseEther("4"))
    ).wait();

    await (
      await treasury
        .connect(spender)
        .accrueReward(bob.address, ethers.parseEther("1"))
    ).wait();

    expect(await treasury.totalPendingRewards()).to.equal(
      ethers.parseEther("5")
    );

    await expect(
      treasury.connect(spender).accrueReward(bob.address, ethers.parseEther("1"))
    ).to.be.revertedWith("insufficient pool");
  });

  it("should prevent owner from withdrawing reserved rewards", async function () {
    const { deployer, spender, alice, treasury } = await deployTreasury();

    await (
      await treasury
        .connect(spender)
        .accrueReward(alice.address, ethers.parseEther("4"))
    ).wait();

    await expect(
      treasury
        .connect(deployer)
        .withdrawTreasury(deployer.address, ethers.parseEther("2"))
    ).to.be.revertedWith("reserved rewards");

    await (
      await treasury
        .connect(deployer)
        .withdrawTreasury(deployer.address, ethers.parseEther("1"))
    ).wait();
  });

  it("should release reserved capacity after claim", async function () {
    const { spender, alice, bob, treasury } = await deployTreasury();

    await (
      await treasury
        .connect(spender)
        .accrueReward(alice.address, ethers.parseEther("4"))
    ).wait();

    expect(await treasury.totalPendingRewards()).to.equal(
      ethers.parseEther("4")
    );

    await (await treasury.connect(alice).claim()).wait();

    expect(await treasury.totalPendingRewards()).to.equal(0n);

    await (
      await treasury
        .connect(spender)
        .accrueReward(bob.address, ethers.parseEther("1"))
    ).wait();

    expect(await treasury.pendingRewards(bob.address)).to.equal(
      ethers.parseEther("1")
    );
  });
});
