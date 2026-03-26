import { expect } from "chai";
import { ethers } from "hardhat";
import { RevenueVault, TreasuryNative } from "../typechain-types";
import {
  RevenueVault__factory,
  TreasuryNative__factory,
} from "../typechain-types";

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("RevenueVault", function () {
  async function deployTreasury(initialBalance: string = "0") {
    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      7 * 24 * 3600,
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    if (initialBalance !== "0") {
      const [deployer] = await ethers.getSigners();
      await deployer.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther(initialBalance),
      });
    }

    return treasury;
  }

  async function deployVault(treasury: TreasuryNative) {
    const vaultFactory = (await ethers.getContractFactory(
      "RevenueVault"
    )) as unknown as RevenueVault__factory;
    const vault: RevenueVault = await vaultFactory.deploy(
      await treasury.getAddress(),
      ethers.parseEther("2"),
      ethers.parseEther("5"),
      ethers.parseEther("1"),
      3600
    );
    await vault.waitForDeployment();
    return vault;
  }

  it("Should auto-refill Treasury up to the target balance", async function () {
    const [deployer, caller] = await ethers.getSigners();
    const treasury = await deployTreasury("1");
    const vault = await deployVault(treasury);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("10"),
    });

    await expect(vault.connect(caller).refillTreasuryIfNeeded())
      .to.emit(vault, "TreasuryRefilled")
      .withArgs(
        caller.address,
        await treasury.getAddress(),
        ethers.parseEther("4"),
        ethers.parseEther("5")
      );

    expect(
      await ethers.provider.getBalance(await treasury.getAddress())
    ).to.equal(ethers.parseEther("5"));
    expect(
      await ethers.provider.getBalance(await vault.getAddress())
    ).to.equal(ethers.parseEther("6"));
    expect(await vault.needsRefill()).to.equal(false);
  });

  it("Should cap refill to the balance currently held by RevenueVault", async function () {
    const [deployer, caller] = await ethers.getSigners();
    const treasury = await deployTreasury("0.5");
    const vault = await deployVault(treasury);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("1.5"),
    });

    await vault.connect(caller).refillTreasuryIfNeeded();

    expect(
      await ethers.provider.getBalance(await treasury.getAddress())
    ).to.equal(ethers.parseEther("2"));
    expect(
      await ethers.provider.getBalance(await vault.getAddress())
    ).to.equal(0n);
  });

  it("Should respect cooldowns for auto-refill decisions", async function () {
    const [deployer, caller] = await ethers.getSigners();
    const treasury = await deployTreasury("1");
    const vault = await deployVault(treasury);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("10"),
    });

    await vault.connect(caller).refillTreasuryIfNeeded();
    await treasury.withdrawTreasury(
      deployer.address,
      ethers.parseEther("4.5")
    );

    expect(
      await ethers.provider.getBalance(await treasury.getAddress())
    ).to.equal(ethers.parseEther("0.5"));
    expect(await vault.needsRefill()).to.equal(false);

    await increaseTime(3600);
    expect(await vault.needsRefill()).to.equal(true);
  });

  it("Should allow owner manual refill and revenue withdrawal", async function () {
    const [deployer, outsider] = await ethers.getSigners();
    const treasury = await deployTreasury("5");
    const vault = await deployVault(treasury);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("3"),
    });

    await vault.setAutoRefillEnabled(false);
    expect(await vault.needsRefill()).to.equal(false);

    await expect(vault.connect(outsider).manualRefill(ethers.parseEther("1")))
      .to.be.revertedWith("Ownable: caller is not the owner");

    await vault.manualRefill(ethers.parseEther("2"));
    expect(
      await ethers.provider.getBalance(await treasury.getAddress())
    ).to.equal(ethers.parseEther("7"));

    await vault.withdrawRevenue(deployer.address, ethers.parseEther("1"));
    expect(
      await ethers.provider.getBalance(await vault.getAddress())
    ).to.equal(0n);
  });

  it("Should validate refill policy parameters", async function () {
    const treasury = await deployTreasury("1");
    const vaultFactory = (await ethers.getContractFactory(
      "RevenueVault"
    )) as unknown as RevenueVault__factory;

    await expect(
      vaultFactory.deploy(
        await treasury.getAddress(),
        ethers.parseEther("6"),
        ethers.parseEther("5"),
        ethers.parseEther("1"),
        3600
      )
    ).to.be.revertedWith("bad threshold");

    const vault = await deployVault(treasury);
    await expect(
      vault.setRefillPolicy(
        ethers.parseEther("1"),
        0,
        ethers.parseEther("1"),
        3600
      )
    ).to.be.revertedWith("target=0");
  });
});
