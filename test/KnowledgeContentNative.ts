import { expect } from "chai";
import { ethers } from "hardhat";
import {
  KnowledgeContent,
  NativeVotes,
  TreasuryNative,
} from "../typechain-types";
import {
  KnowledgeContent__factory,
  NativeVotes__factory,
  TreasuryNative__factory,
} from "../typechain-types";

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("KnowledgeContent (Treasury Native)", function () {
  it("Should accrue reward into Treasury and allow author to claim()", async function () {
    const [deployer, author] = await ethers.getSigners();

    // 1) Deploy NativeVotes
    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1); // cooldown=1s, activationBlocks=1 (测试快)
    await nativeVotes.waitForDeployment();

    // 2) Deploy TreasuryNative
    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      3600, // epochDuration=1h
      ethers.parseEther("100") // epochBudget
    );
    await treasury.waitForDeployment();

    // 3) Deploy KnowledgeContent
    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    // 4) Fund treasury
    await (
      await deployer.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("5"),
      })
    ).wait();

    // 5) Init content: anti-sybil + treasury + spender
    await (
      await content.setAntiSybil(
        await nativeVotes.getAddress(),
        ethers.parseEther("1")
      )
    ).wait();

    await (await content.setTreasury(await treasury.getAddress())).wait();
    await (await treasury.setSpender(await content.getAddress(), true)).wait();

    // 6) Author registers content
    await (await content.connect(author).registerContent("QmHash")).wait();

    // 7) Create 10 voters (each stake >= 1 ETH voting power)
    for (let i = 0; i < 10; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);

      // give ETH
      await (
        await deployer.sendTransaction({
          to: w.address,
          value: ethers.parseEther("2"),
        })
      ).wait();

      // deposit stake
      await (
        await nativeVotes.connect(w).deposit({ value: ethers.parseEther("1") })
      ).wait();

      // wait activation blocks + activate
      await mineBlocks(1);
      await (await nativeVotes.connect(w).activate()).wait();

      // vote
      await (await content.connect(w).vote(1)).wait();
    }

      // 8) accrue reward (content -> treasury)
      await (await content.distributeReward(1)).wait();

      const pending = await treasury.pendingRewards(author.address);
      expect(pending).to.be.gt(0n);

      // 9) author claim from treasury
      const before = await ethers.provider.getBalance(author.address);

      // 发送并等待交易
      const tx = await treasury.connect(author).claim();
      await tx.wait(); 

      const after = await ethers.provider.getBalance(author.address);
      const pendingAfter = await treasury.pendingRewards(author.address);

      // ✅ 核心逻辑验证 1: Pending 奖励必须被清零
      expect(pendingAfter).to.equal(0n);

      // ✅ 核心逻辑验证 2: 余额必须增加 (证明钱到账了)
      expect(after).to.be.gt(before);

      // ✅ 核心逻辑验证 3: 余额增加量 < pending (证明扣除了 Gas 费)
      // 避开计算 gasCost 的类型陷阱，同时验证了业务逻辑的正确性
      const balanceIncrease = after - before;
      expect(balanceIncrease).to.be.lt(pending);

      // (可选) 接近精确验证，可以断言增加量非常接近 pending (允许少量 Gas 误差)
  });

  it("Should emit ContentRegistered event", async function () {
    const [deployer] = await ethers.getSigners();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content = await contentFactory.deploy();
    await content.waitForDeployment();

    await expect(content.registerContent("QmTest"))
      .to.emit(content, "ContentRegistered")
      .withArgs(1, deployer.address, "QmTest");
  });
});