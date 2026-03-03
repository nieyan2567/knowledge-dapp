import { expect } from "chai";
import { ethers } from "hardhat";
import { NativeVotes } from "../typechain-types";
import { NativeVotes__factory } from "../typechain-types";

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("NativeVotes", function () {
  it("Should increase voting power only after activate()", async function () {
    const [user] = await ethers.getSigners();

    const factory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const cooldownSeconds = 1;
    const activationBlocks = 1;

    const nativeVotes: NativeVotes = await factory.deploy(cooldownSeconds, activationBlocks);
    await nativeVotes.waitForDeployment();

    // deposit 不立刻有投票权
    await (await nativeVotes.connect(user).deposit({ value: ethers.parseEther("5") })).wait();
    expect(await nativeVotes.getVotes(user.address)).to.equal(0n);

    // 等待激活区块
    await mineBlocks(activationBlocks);

    // activate 后才有投票权
    await (await nativeVotes.connect(user).activate()).wait();
    expect(await nativeVotes.getVotes(user.address)).to.equal(ethers.parseEther("5"));
  });

  it("Should reduce votes immediately on requestWithdraw, then withdraw after cooldown", async function () {
    const [user] = await ethers.getSigners();

    const factory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const cooldownSeconds = 2;
    const activationBlocks = 1;

    const nativeVotes: NativeVotes = await factory.deploy(cooldownSeconds, activationBlocks);
    await nativeVotes.waitForDeployment();

    await (await nativeVotes.connect(user).deposit({ value: ethers.parseEther("5") })).wait();
    await mineBlocks(activationBlocks);
    await (await nativeVotes.connect(user).activate()).wait();

    expect(await nativeVotes.getVotes(user.address)).to.equal(ethers.parseEther("5"));

    // requestWithdraw 会立刻减少投票权
    await (await nativeVotes.connect(user).requestWithdraw(ethers.parseEther("2"))).wait();
    expect(await nativeVotes.getVotes(user.address)).to.equal(ethers.parseEther("3"));

    // cooldown 未到不能提现
    await expect(nativeVotes.connect(user).withdraw(ethers.parseEther("2"))).to.be.revertedWith("cooldown");

    // 时间推进到 cooldown 之后
    await ethers.provider.send("evm_increaseTime", [cooldownSeconds + 1]);
    await mineBlocks(1);

    // 现在能提现
    await (await nativeVotes.connect(user).withdraw(ethers.parseEther("2"))).wait();
    expect(await nativeVotes.pendingWithdraw(user.address)).to.equal(0n);
  });
  
  it("Should revert when activating twice", async function () {
    const [user] = await ethers.getSigners();
    const factory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const nv = await factory.deploy(1, 1);
    await nv.waitForDeployment();

    await (await nv.connect(user).deposit({ value: ethers.parseEther("1") })).wait();
    await mineBlocks(1);
    await (await nv.connect(user).activate()).wait();

    // 再次激活应该失败 (覆盖 activate 中的 require 检查)
    await expect(nv.connect(user).activate()).to.be.revertedWith("no pending");
  });

  it("Should revert when requesting withdraw with zero balance", async function () {
    const [user] = await ethers.getSigners();
    const factory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const nv = await factory.deploy(1, 1);
    await nv.waitForDeployment();

    // 没有存款直接请求取款
    await expect(nv.connect(user).requestWithdraw(ethers.parseEther("1"))).to.be.reverted;
  });

  it("Should revert when withdrawing more than pending", async function () {
    const [user] = await ethers.getSigners();
    const factory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const nv = await factory.deploy(1, 1);
    await nv.waitForDeployment();

    await (await nv.connect(user).deposit({ value: ethers.parseEther("2") })).wait();
    await mineBlocks(1);
    await (await nv.connect(user).activate()).wait();
    
    // 只请求提取 1
    await (await nv.connect(user).requestWithdraw(ethers.parseEther("1"))).wait();
    await ethers.provider.send("evm_increaseTime", [2]);
    await mineBlocks(1);

    // 尝试提取 2 (超过 pending)
    await expect(nv.connect(user).withdraw(ethers.parseEther("2"))).to.be.reverted;
  });
});