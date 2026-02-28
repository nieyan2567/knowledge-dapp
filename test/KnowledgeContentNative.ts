import { expect } from "chai";
import { ethers } from "hardhat";
import { KnowledgeContent__factory } from "../typechain-types";

describe("KnowledgeContent (Native reward)", function () {
  it("Should distribute native coin reward", async function () {
    const [deployer, author] = await ethers.getSigners();

    // ✅ TypeChain Factory 部署（强类型）
    const content = await new KnowledgeContent__factory(deployer).deploy();
    await content.waitForDeployment();

    // 给奖励池充值 5 原生币
    await deployer.sendTransaction({
      to: await content.getAddress(),
      value: ethers.parseEther("5"),
    });

    // 注册内容
    await content.connect(author).registerContent("QmHash");

    // 投 10 票（默认 minVotesToReward = 10）
    for (let i = 0; i < 10; i++) {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);

      // 给随机钱包转 gas
      await deployer.sendTransaction({
        to: wallet.address,
        value: ethers.parseEther("1"),
      });

      // vote（强类型）
      await content.connect(wallet).vote(1);
    }

    const beforeBalance = await ethers.provider.getBalance(author.address);

    // 发放奖励
    await content.distributeReward(1);

    const afterBalance = await ethers.provider.getBalance(author.address);

    expect(afterBalance).to.be.gt(beforeBalance);
  });
});