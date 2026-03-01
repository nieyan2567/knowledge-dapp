import { expect } from "chai";
import { ethers } from "hardhat";
import {
  KnowledgeContent,
  KnowledgeGovernor,
  NativeVotes,
  TimelockController,
} from "../typechain-types";
import {
  KnowledgeContent__factory,
  KnowledgeGovernor__factory,
  NativeVotes__factory,
  TimelockController__factory,
} from "../typechain-types";

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("Governance Flow (Native coin staking votes, secure, TypeChain factory)", function () {
  it("should update reward rules via propose -> vote -> queue -> execute (native votes)", async function () {
    const [deployer, voter1, voter2] = await ethers.getSigners();

    // NativeVotes：激活延迟=1块，冷却=1秒（测试加速）
    const nativeVotesFactory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nativeVotesFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    // KnowledgeContent：先由 deployer 初始化 antiSybil，再转 owner 给 timelock
    const contentFactory = (await ethers.getContractFactory("KnowledgeContent")) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await contentFactory.deploy();
    await content.waitForDeployment();

    // 给奖励池充值，便于后续演示
    await (await deployer.sendTransaction({ to: await content.getAddress(), value: ethers.parseEther("5") })).wait();

    // 绑定 antiSybil（之后投票才会通过）
    await (await content.setAntiSybil(await nativeVotes.getAddress(), ethers.parseEther("1"))).wait();

    // Timelock（minDelay=2秒）
    const timelockFactory = (await ethers.getContractFactory("TimelockController")) as unknown as TimelockController__factory;
    const minDelay = 2;
    const timelock: TimelockController = await timelockFactory.deploy(
      minDelay,
      [deployer.address],
      [ethers.ZeroAddress],
      deployer.address
    );
    await timelock.waitForDeployment();

    // Governor
    const governorFactory = (await ethers.getContractFactory("KnowledgeGovernor")) as unknown as KnowledgeGovernor__factory;
    const governor: KnowledgeGovernor = await governorFactory.deploy(
      await nativeVotes.getAddress(),
      await timelock.getAddress()
    );
    await governor.waitForDeployment();

    // Timelock proposer -> Governor
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    await (await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress())).wait();
    await (await timelock.revokeRole(PROPOSER_ROLE, deployer.address)).wait();

    // 把 content owner 交给 timelock（治理执行才有权限）
    await (await content.transferOwnership(await timelock.getAddress())).wait();

    // voter1/voter2 质押并激活投票权（满足 proposalThreshold/quorum）
    // proposalThreshold=10 ether（Governor里写的），所以 voter1 至少激活 10
    await (await nativeVotes.connect(voter1).deposit({ value: ethers.parseEther("20") })).wait();
    await (await nativeVotes.connect(voter2).deposit({ value: ethers.parseEther("10") })).wait();
    await mineBlocks(1);
    await (await nativeVotes.connect(voter1).activate()).wait();
    await (await nativeVotes.connect(voter2).activate()).wait();

    // 显式 delegate（习惯一致；默认也会委托给自己）
    await (await nativeVotes.connect(voter1).delegate(voter1.address)).wait();
    await (await nativeVotes.connect(voter2).delegate(voter2.address)).wait();

    await mineBlocks(1);

    // 提案：修改奖励规则（必须在 cap 内）
    const newMinVotes = 20n;
    const newRewardPerVote = 2n * 10n ** 15n; // 0.002/票（<= 1 ether cap）

    const calldata = content.interface.encodeFunctionData("setRewardRules", [
      newMinVotes,
      newRewardPerVote,
    ]);

    const description = "Proposal: update reward rules (secure native)";
    const descriptionHash = ethers.id(description);

    // propose（发起人必须达到 proposalThreshold）
    await (await governor.connect(voter1).propose(
      [await content.getAddress()],
      [0],
      [calldata],
      description
    )).wait();

    // 用 hashProposal 计算 proposalId（最稳，不依赖事件）
    const proposalId = await governor.hashProposal(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    // 等 votingDelay
    const votingDelay = await governor.votingDelay();
    await mineBlocks(Number(votingDelay));

    // 投票 For=1
    await (await governor.connect(voter1).castVote(proposalId, 1)).wait();
    await (await governor.connect(voter2).castVote(proposalId, 1)).wait();

    // 等 votingPeriod 结束
    const votingPeriod = await governor.votingPeriod();
    await mineBlocks(Number(votingPeriod));

    // queue
    await (await governor.queue(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    )).wait();

    // 等 timelock delay
    await ethers.provider.send("evm_increaseTime", [minDelay + 1]);
    await mineBlocks(1);

    // execute
    await (await governor.execute(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    )).wait();

    // 断言更新成功
    expect(await content.minVotesToReward()).to.equal(newMinVotes);
    expect(await content.rewardPerVote()).to.equal(newRewardPerVote);
  });
});