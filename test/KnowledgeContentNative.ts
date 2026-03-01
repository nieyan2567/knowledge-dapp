import { expect } from "chai";
import { ethers } from "hardhat";
import { KnowledgeContent, NativeVotes } from "../typechain-types";
import { KnowledgeContent__factory, NativeVotes__factory } from "../typechain-types";

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("KnowledgeContent (Native reward, secure)", function () {
  it("Should accrue rewards to pendingRewards and allow claim()", async function () {
    const [deployer, author] = await ethers.getSigners();

    // 部署 NativeVotes（测试用：激活延迟=1块，冷却=1秒）
    const nativeVotesFactory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    // 部署 KnowledgeContent
    const contentFactory = (await ethers.getContractFactory("KnowledgeContent")) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    // 充值奖励池 5 ETH
    await (await deployer.sendTransaction({ to: await content.getAddress(), value: ethers.parseEther("5") })).wait();

    // 初始化 antiSybil：绑定 votes 合约 + 设置投票门槛为 1 ETH
    await (await content.setAntiSybil(await nativeVotes.getAddress(), ethers.parseEther("1"))).wait();

    // author 上传内容
    await (await content.connect(author).registerContent("QmHash")).wait();

    // 生成 10 个投票者：每个都要 deposit+activate 达到 minStakeToVote 才能 vote
    // 默认 minVotesToReward=10，所以需要 10 票
    const voters: Array<{ wallet: any }> = [];
    for (let i = 0; i < 10; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      voters.push({ wallet: w });

      // 给投票者转 2 ETH（1用于质押，剩下用于投票交易 gas）
      await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("2") })).wait();

      // deposit 1 ETH -> 等待 1 block -> activate
      await (await nativeVotes.connect(w).deposit({ value: ethers.parseEther("1") })).wait();
      await mineBlocks(1);
      await (await nativeVotes.connect(w).activate()).wait();

      // vote 内容ID=1
      await (await content.connect(w).vote(1)).wait();
    }

    // distributeReward：只记账，不转账
    await (await content.distributeReward(1)).wait();

    const pending = await content.pendingRewards(author.address);
    expect(pending).to.be.gt(0n);

    // claim：作者领取（要扣 gas，因此要精确计算）
    const authorBefore = await ethers.provider.getBalance(author.address);

    const claimTx = await content.connect(author).claim();
    const receipt = await claimTx.wait();

    const gasUsed: bigint = receipt!.gasUsed;
    const gasPrice: bigint = receipt!.gasPrice ?? claimTx.gasPrice ?? 0n;
    const gasCost: bigint = gasUsed * gasPrice;

    const authorAfter: bigint = await ethers.provider.getBalance(author.address);

    // after 应当 ≈ before + pending - gasCost
    expect(authorAfter).to.equal(authorBefore + pending - gasCost);

    // pending 清零
    expect(await content.pendingRewards(author.address)).to.equal(0n);
  });
});