import { expect } from "chai";
import { ethers } from "hardhat";

// ✅ 关键：用 TypeChain 工厂部署，返回值是强类型合约实例
import {
  NativeVotes__factory,
  KnowledgeContent__factory,
  KnowledgeGovernor__factory,
  TimelockController__factory,
} from "../typechain-types";

describe("Governance Flow (Native coin staking votes, TypeChain factory)", function () {
  async function mineBlocks(n: number) {
    for (let i = 0; i < n; i++) {
      await ethers.provider.send("evm_mine", []);
    }
  }

  it("should update reward rules via propose -> vote -> queue -> execute (native votes)", async function () {
    const [deployer, voter1, voter2] = await ethers.getSigners();

    // 1) 部署 NativeVotes（强类型）
    const nativeVotes = await new NativeVotes__factory(deployer).deploy();
    await nativeVotes.waitForDeployment();

    // 2) 部署 KnowledgeContent（原生币奖励版）
    const content = await new KnowledgeContent__factory(deployer).deploy();
    await content.waitForDeployment();

    // 给 content 充值奖励池（否则 distributeReward 可能没钱）
    await deployer.sendTransaction({
      to: await content.getAddress(),
      value: ethers.parseEther("5"),
    });

    // 3) 部署 Timelock（minDelay=2 秒，测试用）
    const minDelay = 2;
    const timelock = await new TimelockController__factory(deployer).deploy(
      minDelay,
      [deployer.address],       // proposers（先给 deployer，后面会改成 governor）
      [ethers.ZeroAddress],     // executors（0地址=任何人可执行）
      deployer.address          // admin
    );
    await timelock.waitForDeployment();

    // 4) 部署 Governor（token=NativeVotes）
    const governor = await new KnowledgeGovernor__factory(deployer).deploy(
      await nativeVotes.getAddress(),
      await timelock.getAddress()
    );
    await governor.waitForDeployment();

    // 5) Timelock proposer -> Governor；移除 deployer proposer
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.revokeRole(PROPOSER_ROLE, deployer.address);

    // 6) content owner -> timelock（保证只能 DAO 改规则）
    await content.transferOwnership(await timelock.getAddress());

    /**
     * 7) 质押原生币获得投票权（满足 proposalThreshold + quorum）
     *
     * 你 KnowledgeGovernor 里：
     * proposalThreshold = 10 ether
     * 所以 voter1 至少 deposit 10 ETH（联盟链原生币也按 18 decimals）
     */
    await nativeVotes.connect(voter1).deposit({ value: ethers.parseEther("20") });
    await nativeVotes.connect(voter2).deposit({ value: ethers.parseEther("10") });

    // 显式 delegate（更贴近真实 DeFi）
    await nativeVotes.connect(voter1).delegate(voter1.address);
    await nativeVotes.connect(voter2).delegate(voter2.address);

    // 让委托快照生效
    await mineBlocks(1);

    // 8) 构造提案：setRewardRules(20, 2e15)
    const newMinVotes = 20n;
    const newRewardPerVote = 2n * 10n ** 15n; // 0.002 原生币/票（wei）

    const calldata = content.interface.encodeFunctionData("setRewardRules", [
      newMinVotes,
      newRewardPerVote,
    ]);

    const description = "Proposal: update native reward rules";
    const descriptionHash = ethers.id(description);

    // 9) propose（必须）
    await governor.connect(voter1).propose(
      [await content.getAddress()],
      [0],
      [calldata],
      description
    );

    // 10) 计算 proposalId（稳定写法，不解析事件）
    const proposalId = await governor.hashProposal(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    expect(proposalId).to.not.equal(0n);

    // votingDelay = 1 block
    await mineBlocks(1);

    // 11) 投票（1 = For）
    await governor.connect(voter1).castVote(proposalId, 1);
    await governor.connect(voter2).castVote(proposalId, 1);

    // votingPeriod = 20 blocks
    await mineBlocks(20);

    // 12) queue（进入 timelock）
    await governor.queue(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    // 13) 等待 timelock minDelay
    await ethers.provider.send("evm_increaseTime", [minDelay + 1]);
    await mineBlocks(1);

    // 14) execute（执行提案）
    await governor.execute(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    // 15) 断言：规则被修改
    expect(await content.minVotesToReward()).to.equal(newMinVotes);
    expect(await content.rewardPerVote()).to.equal(newRewardPerVote);
  });
});