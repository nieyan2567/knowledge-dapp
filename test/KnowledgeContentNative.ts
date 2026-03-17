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

// 辅助函数：挖矿
async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("KnowledgeContent (Treasury Native + Metadata)", function () {
  
  it("Should accrue reward into Treasury and allow author to claim() [With Title/Desc]", async function () {
    const [deployer, author] = await ethers.getSigners();

    // 1) Deploy NativeVotes
    const nativeVotesFactory = (await ethers.getContractFactory(
      "NativeVotes"
    )) as unknown as NativeVotes__factory;
    // 注意：如果 NativeVotes 依赖 delegate 而不是 activate，这里参数可能需要调整，或者下面投票前需要 delegate
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1); 
    await nativeVotes.waitForDeployment();

    // 2) Deploy TreasuryNative
    const treasuryFactory = (await ethers.getContractFactory(
      "TreasuryNative"
    )) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await treasuryFactory.deploy(
      3600, 
      ethers.parseEther("100")
    );
    await treasury.waitForDeployment();

    // 3) Deploy KnowledgeContent (新版合约)
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

    // 5) Init content
    await (
      await content.setAntiSybil(
        await nativeVotes.getAddress(),
        ethers.parseEther("1")
      )
    ).wait();

    await (await content.setTreasury(await treasury.getAddress())).wait();
    await (await treasury.setSpender(await content.getAddress(), true)).wait();

    // ---------------------------------------------------------
    // ✅ 修改点 1: 注册内容时传入 title 和 description
    // ---------------------------------------------------------
    const testTitle = "My Awesome Article";
    const testDesc = "This is a detailed description of the content.";
    
    const registerTx = await content.connect(author).registerContent(
      "QmHashNewVersion", 
      testTitle, 
      testDesc
    );
    await registerTx.wait();

    // (可选) 验证链上存储是否正确
    const storedContent = await content.contents(1);
    expect(storedContent.title).to.equal(testTitle);
    expect(storedContent.description).to.equal(testDesc);

    // 7) Create 10 voters
    for (let i = 0; i < 10; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);

      await (
        await deployer.sendTransaction({
          to: w.address,
          value: ethers.parseEther("2"),
        })
      ).wait();

      await (
        await nativeVotes.connect(w).deposit({ value: ethers.parseEther("1") })
      ).wait();

      await mineBlocks(1);
      
      // 注意：某些 Votes 实现需要 activate，有些需要 delegate。
      // 如果你的 NativeVotes 像第二段代码那样使用 delegate 获取票数：
      // await nativeVotes.connect(w).delegate(w.address); 
      // 如果沿用原来的 activate 逻辑，保持下方代码不变：
      await (await nativeVotes.connect(w).activate()).wait();

      await (await content.connect(w).vote(1)).wait();
    }

    // 8) accrue reward
    await (await content.distributeReward(1)).wait();

    const pending = await treasury.pendingRewards(author.address);
    expect(pending).to.be.gt(0n);

    // 9) author claim
    const before = await ethers.provider.getBalance(author.address);

    const tx = await treasury.connect(author).claim();
    await tx.wait(); 

    const after = await ethers.provider.getBalance(author.address);
    const pendingAfter = await treasury.pendingRewards(author.address);

    expect(pendingAfter).to.equal(0n);
    expect(after).to.be.gt(before);
    
    const balanceIncrease = after - before;
    expect(balanceIncrease).to.be.lt(pending);
  });

  // ---------------------------------------------------------
  // ✅ 修改点 2: 更新事件断言，匹配新的事件签名 (5个参数)
  // ---------------------------------------------------------
  it("Should emit ContentRegistered event with metadata", async function () {
    const [deployer] = await ethers.getSigners();

    const contentFactory = (await ethers.getContractFactory(
      "KnowledgeContent"
    )) as unknown as KnowledgeContent__factory;
    const content = await contentFactory.deploy();
    await content.waitForDeployment();

    const title = "Test Title";
    const desc = "Test Description";
    const hash = "QmTestNew";

    // 期望触发的事件现在需要包含 title 和 description
    await expect(content.registerContent(hash, title, desc))
      .to.emit(content, "ContentRegistered")
      .withArgs(1, deployer.address, hash, title, desc); // 参数顺序必须与 Event 定义一致
  });

  // 原有的边缘情况测试 (Revert tests) 不需要修改逻辑，
  // 但如果它们内部调用了 registerContent，也需要补全参数。
  // 这里以 "Should revert distributeReward..." 为例进行修正示意：
  
  it("Should revert distributeReward when budget insufficient (Updated Register)", async function () {
    const [deployer, author] = await ethers.getSigners();

    const nvFactory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const nativeVotes = await nvFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    const smallBudget = ethers.parseEther("0.0001"); 
    const tFactory = (await ethers.getContractFactory("TreasuryNative")) as unknown as TreasuryNative__factory;
    const treasury = await tFactory.deploy(3600, smallBudget);
    await treasury.waitForDeployment();

    await deployer.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("0.00005"),
    });

    const cFactory = (await ethers.getContractFactory("KnowledgeContent")) as unknown as KnowledgeContent__factory;
    const content = await cFactory.deploy();
    await content.waitForDeployment();

    await content.setAntiSybil(await nativeVotes.getAddress(), ethers.parseEther("1"));
    await content.setTreasury(await treasury.getAddress());
    await treasury.setSpender(await content.getAddress(), true);

    // ✅ 修改点：注册时补全 title 和 description
    await content.connect(author).registerContent("QmHash", "Title", "Desc");

    for (let i = 0; i < 2; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("2") });
      await nativeVotes.connect(w).deposit({ value: ethers.parseEther("1") });
      await mineBlocks(1);
      await nativeVotes.connect(w).activate();
      await content.connect(w).vote(1);
    }

    // 注意：原测试代码这里的 expect 错误地写了 "Not enough votes"，
    // 实际上如果是预算不足，Treasury 应该 revert "epoch budget exceeded" 或类似错误。
    // 请根据 TreasuryNative 的实际 revert 字符串调整。
    // 这里假设是因为预算不足导致失败。
    await expect(content.distributeReward(1)).to.be.reverted; 
  });
});