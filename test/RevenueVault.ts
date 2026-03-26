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

  async function deployVault(treasury: TreasuryNative, faucetWallet: string) {
    const vaultFactory = (await ethers.getContractFactory(
      "RevenueVault"
    )) as unknown as RevenueVault__factory;
    const vault: RevenueVault = await vaultFactory.deploy(
      await treasury.getAddress(),
      faucetWallet,
      3000,
      ethers.parseEther("0.5"),
      ethers.parseEther("2"),
      ethers.parseEther("5"),
      ethers.parseEther("1"),
      3600
    );
    await vault.waitForDeployment();
    return vault;
  }

  it("Should split new revenue between faucet reserve and treasury reserve", async function () {
    const [deployer, faucet] = await ethers.getSigners();
    const treasury = await deployTreasury("1");
    const vault = await deployVault(treasury, faucet.address);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("10"),
    });

    await expect(vault.syncRevenue())
      .to.emit(vault, "RevenueSynced")
      .withArgs(
        ethers.parseEther("10"),
        ethers.parseEther("3"),
        ethers.parseEther("3")
      );

    expect(await vault.faucetPending()).to.equal(ethers.parseEther("3"));
    expect(await vault.availableForTreasury()).to.equal(ethers.parseEther("7"));
  });

  it("Should auto-pay faucet and refill Treasury during rebalance", async function () {
    const [deployer, faucet, caller] = await ethers.getSigners();
    const treasury = await deployTreasury("1");
    const vault = await deployVault(treasury, faucet.address);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("10"),
    });

    const faucetBefore = await ethers.provider.getBalance(faucet.address);
    const tx = await vault.connect(caller).rebalance();
    const receipt = await tx.wait();

    expect(receipt?.status).to.equal(1);
    expect(await vault.faucetPending()).to.equal(0n);
    expect(
      await ethers.provider.getBalance(await treasury.getAddress())
    ).to.equal(ethers.parseEther("5"));

    const faucetAfter = await ethers.provider.getBalance(faucet.address);
    expect(faucetAfter - faucetBefore).to.equal(ethers.parseEther("3"));
    expect(
      await ethers.provider.getBalance(await vault.getAddress())
    ).to.equal(ethers.parseEther("3"));
  });

  it("Should allow faucet payout without treasury refill when threshold not met", async function () {
    const [deployer, faucet, caller] = await ethers.getSigners();
    const treasury = await deployTreasury("3");
    const vault = await deployVault(treasury, faucet.address);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("2"),
    });

    expect(await vault.needsRefill()).to.equal(false);
    expect(await vault.needsFaucetPayout()).to.equal(true);

    const faucetBefore = await ethers.provider.getBalance(faucet.address);
    await vault.connect(caller).releaseFaucetIfNeeded();
    const faucetAfter = await ethers.provider.getBalance(faucet.address);

    expect(faucetAfter - faucetBefore).to.equal(ethers.parseEther("0.6"));
    expect(await vault.faucetPending()).to.equal(0n);
  });

  it("Should let rebalance succeed when only faucet payout is needed", async function () {
    const [deployer, faucet, caller] = await ethers.getSigners();
    const treasury = await deployTreasury("5");
    const vault = await deployVault(treasury, faucet.address);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("2"),
    });

    expect(await vault.needsFaucetPayout()).to.equal(true);
    expect(await vault.needsRefill()).to.equal(false);

    const faucetBefore = await ethers.provider.getBalance(faucet.address);
    const tx = await vault.connect(caller).rebalance();
    await tx.wait();
    const faucetAfter = await ethers.provider.getBalance(faucet.address);

    expect(faucetAfter - faucetBefore).to.equal(ethers.parseEther("0.6"));
    expect(await vault.faucetPending()).to.equal(0n);
    expect(
      await ethers.provider.getBalance(await treasury.getAddress())
    ).to.equal(ethers.parseEther("5"));
  });

  it("Should respect cooldowns for treasury refill decisions", async function () {
    const [deployer, faucet, caller] = await ethers.getSigners();
    const treasury = await deployTreasury("1");
    const vault = await deployVault(treasury, faucet.address);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("10"),
    });

    await vault.connect(caller).rebalance();
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

  it("Should allow owner manual actions and protect faucet reserves on withdrawal", async function () {
    const [deployer, faucet, outsider] = await ethers.getSigners();
    const treasury = await deployTreasury("5");
    const vault = await deployVault(treasury, faucet.address);

    await deployer.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("3"),
    });

    await vault.syncRevenue();
    expect(await vault.faucetPending()).to.equal(ethers.parseEther("0.9"));

    await expect(vault.connect(outsider).manualRefill(ethers.parseEther("1")))
      .to.be.revertedWith("Ownable: caller is not the owner");

    await vault.manualRefill(ethers.parseEther("1"));
    expect(
      await ethers.provider.getBalance(await treasury.getAddress())
    ).to.equal(ethers.parseEther("6"));

    await expect(
      vault.withdrawRevenue(deployer.address, ethers.parseEther("1.2"))
    ).to.be.revertedWith("reserved revenue");

    await vault.withdrawRevenue(deployer.address, ethers.parseEther("1"));
  });

  it("Should validate faucet and refill policy parameters", async function () {
    const [faucet] = await ethers.getSigners();
    const treasury = await deployTreasury("1");
    const vaultFactory = (await ethers.getContractFactory(
      "RevenueVault"
    )) as unknown as RevenueVault__factory;

    await expect(
      vaultFactory.deploy(
        await treasury.getAddress(),
        faucet.address,
        3000,
        ethers.parseEther("0.5"),
        ethers.parseEther("6"),
        ethers.parseEther("5"),
        ethers.parseEther("1"),
        3600
      )
    ).to.be.revertedWith("bad threshold");

    const vault = await deployVault(treasury, faucet.address);
    await expect(
      vault.setFaucetConfig(
        ethers.ZeroAddress,
        3000,
        ethers.parseEther("0.5"),
        true
      )
    ).to.be.revertedWith("faucet=0");

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
