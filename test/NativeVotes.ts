import { expect } from "chai";
import { ethers } from "hardhat";
import { NativeVotes } from "../typechain-types";
import { NativeVotes__factory } from "../typechain-types";

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("NativeVotes (secure)", function () {
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
});