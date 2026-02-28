import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * 本文件覆盖 3 类测试（DeFi 简化治理增强版）：
 * 1) 成功闭环：提案->投票->timelock排队->执行，修改业务合约参数
 * 2) 提案门槛：proposalThreshold > 0，低于门槛的账户不能 propose
 * 3) Quorum：quorumFraction 生效，未达法定人数提案应失败（queue 会 revert）
 *
 * 依赖：
 * - OpenZeppelin 4.9.6
 * - Solidity 0.8.20
 * - ethers v6
 */

describe("Governance Flow (DeFi-like simplified, with threshold & quorum)", function () {
  /**
   * 帮助函数：挖 N 个区块
   */
  async function mineBlocks(n: number) {
    for (let i = 0; i < n; i++) {
      await ethers.provider.send("evm_mine", []);
    }
  }

  it("SUCCESS: should update reward rules via propose -> vote -> queue -> execute", async function () {
    const [deployer, voter1, voter2] = await ethers.getSigners();

    // 1) 部署 RewardToken / KnowledgeContent
    const RewardToken = await ethers.getContractFactory("RewardToken");
    const rewardToken = await RewardToken.deploy();
    await rewardToken.waitForDeployment();

    const KnowledgeContent = await ethers.getContractFactory("KnowledgeContent");
    const content = await KnowledgeContent.deploy(await rewardToken.getAddress());
    await content.waitForDeployment();

    // RewardToken 的 owner 交给 KnowledgeContent（业务合约负责 mint 奖励）
    await rewardToken.transferOwnership(await content.getAddress());

    // 2) 部署 GovernanceToken（ERC20Votes）
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const govToken = await GovernanceToken.deploy();
    await govToken.waitForDeployment();

    /**
     * 为了满足 quorumFraction=10%：
     * 这里把总供应设置为 150 KGT（100 + 50），quorum=15 KGT
     * voter1 + voter2 都投票 => 参与投票权=150，肯定 >= 15
     *
     * 同时满足 proposalThreshold=10 KGT：voter1 有 100，满足
     */
    await govToken.mint(voter1.address, ethers.parseEther("100"));
    await govToken.mint(voter2.address, ethers.parseEther("50"));

    // ✅ 真实 DeFi：必须 delegate 才产生投票权（ERC20Votes）
    await govToken.connect(voter1).delegate(voter1.address);
    await govToken.connect(voter2).delegate(voter2.address);

    // 挖一个块，让委托快照生效
    await ethers.provider.send("evm_mine", []);

    // 3) 部署 Timelock（测试用 minDelay=2 秒）
    const Timelock = await ethers.getContractFactory("TimelockController");
    const minDelay = 2;

    // 初始化 proposers 先给 deployer，executors 给 address(0) => 任何人可执行
    const timelock = await Timelock.deploy(
      minDelay,
      [deployer.address],
      [ethers.ZeroAddress],
      deployer.address
    );
    await timelock.waitForDeployment();

    // 4) 部署 Governor
    const Governor = await ethers.getContractFactory("KnowledgeGovernor");
    const governor = await Governor.deploy(await govToken.getAddress(), await timelock.getAddress());
    await governor.waitForDeployment();

    // 5) 配置 Timelock 权限：PROPOSER_ROLE -> Governor；移除 deployer 的 proposer 权限
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.revokeRole(PROPOSER_ROLE, deployer.address);

    // 6) 把业务合约 owner 转给 Timelock（保证只能通过 DAO 改规则）
    await content.transferOwnership(await timelock.getAddress());

    // --- 开始治理流程 ---

    // 7) 构造提案：修改奖励规则 setRewardRules(20, 2e18)
    const newMinVotes = 20n;
    const newRewardPerVote = ethers.parseEther("2"); // 2 KRT / vote

    const calldata = content.interface.encodeFunctionData("setRewardRules", [
      newMinVotes,
      newRewardPerVote,
    ]);

    const description = "Proposal #1: update reward rules";
    const descriptionHash = ethers.id(description);

    // 8) propose（必须执行）
    await governor.connect(voter1).propose(
      [await content.getAddress()],
      [0],
      [calldata],
      description
    );

    // 9) 用 hashProposal 计算 proposalId（稳定、专业）
    const proposalId = await governor.hashProposal(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    expect(proposalId).to.not.equal(0n);

    // 10) 等待 votingDelay = 1 block
    await ethers.provider.send("evm_mine", []);

    // 11) castVote（1=For）
    await governor.connect(voter1).castVote(proposalId, 1);
    await governor.connect(voter2).castVote(proposalId, 1);

    // 12) 等待 votingPeriod = 20 blocks
    await mineBlocks(20);

    // 13) queue：进入 timelock
    await governor.queue(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    // 14) 等待 timelock minDelay
    await ethers.provider.send("evm_increaseTime", [minDelay + 1]);
    await ethers.provider.send("evm_mine", []);

    // 15) execute：执行提案
    await governor.execute(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    // 16) 断言：规则被成功修改
    expect(await content.minVotesToReward()).to.equal(newMinVotes);
    expect(await content.rewardPerVote()).to.equal(newRewardPerVote);
  });

  it("THRESHOLD: should reject proposal if proposer below proposalThreshold", async function () {
    const [deployer, smallHolder] = await ethers.getSigners();

    // 1) 部署 RewardToken / KnowledgeContent（只是提供 target）
    const RewardToken = await ethers.getContractFactory("RewardToken");
    const rewardToken = await RewardToken.deploy();
    await rewardToken.waitForDeployment();

    const KnowledgeContent = await ethers.getContractFactory("KnowledgeContent");
    const content = await KnowledgeContent.deploy(await rewardToken.getAddress());
    await content.waitForDeployment();
    await rewardToken.transferOwnership(await content.getAddress());

    // 2) GovernanceToken
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const govToken = await GovernanceToken.deploy();
    await govToken.waitForDeployment();

    /**
     * smallHolder 只有 1 KGT < proposalThreshold(10 KGT)
     * 并且要 delegate 后才会有投票权（虽然少）
     */
    await govToken.mint(smallHolder.address, ethers.parseEther("1"));
    await govToken.connect(smallHolder).delegate(smallHolder.address);
    await ethers.provider.send("evm_mine", []);

    // 3) Timelock
    const Timelock = await ethers.getContractFactory("TimelockController");
    const minDelay = 2;
    const timelock = await Timelock.deploy(
      minDelay,
      [deployer.address],
      [ethers.ZeroAddress],
      deployer.address
    );
    await timelock.waitForDeployment();

    // 4) Governor
    const Governor = await ethers.getContractFactory("KnowledgeGovernor");
    const governor = await Governor.deploy(await govToken.getAddress(), await timelock.getAddress());
    await governor.waitForDeployment();

    // 5) Timelock proposer -> Governor
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.revokeRole(PROPOSER_ROLE, deployer.address);

    // 6) content owner -> timelock
    await content.transferOwnership(await timelock.getAddress());

    // 7) 构造提案 calldata
    const calldata = content.interface.encodeFunctionData("setRewardRules", [
      20n,
      ethers.parseEther("2"),
    ]);
    const description = "Proposal: update reward rules";

    // 8) smallHolder propose 应失败（低于 proposalThreshold）
    await expect(
      governor.connect(smallHolder).propose(
        [await content.getAddress()],
        [0],
        [calldata],
        description
      )
    ).to.be.reverted;
  });

  it("QUORUM: should fail (queue reverted) if quorum is not reached even with For votes", async function () {
    const [deployer, voter1] = await ethers.getSigners();

    // 1) RewardToken / KnowledgeContent
    const RewardToken = await ethers.getContractFactory("RewardToken");
    const rewardToken = await RewardToken.deploy();
    await rewardToken.waitForDeployment();

    const KnowledgeContent = await ethers.getContractFactory("KnowledgeContent");
    const content = await KnowledgeContent.deploy(await rewardToken.getAddress());
    await content.waitForDeployment();
    await rewardToken.transferOwnership(await content.getAddress());

    // 2) GovernanceToken
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const govToken = await GovernanceToken.deploy();
    await govToken.waitForDeployment();

    /**
     * 制造“不达 quorum”：
     * quorumFraction=10%。
     * 我们让总供应 = 1000 KGT（deployer 900 + voter1 50 + 其他 50可不分配）
     * quorum = 100 KGT。
     * 但只有 voter1 参与投票，投票权=50 < 100 => 不达 quorum。
     *
     * 同时 voter1 仍需满足 proposalThreshold=10 KGT（有 50，满足）。
     */
    await govToken.mint(deployer.address, ethers.parseEther("900")); // 抬高总供应，但不投票
    await govToken.mint(voter1.address, ethers.parseEther("50"));

    // 只有 voter1 delegate 并投票
    await govToken.connect(voter1).delegate(voter1.address);
    await ethers.provider.send("evm_mine", []);

    // 3) Timelock
    const Timelock = await ethers.getContractFactory("TimelockController");
    const minDelay = 2;
    const timelock = await Timelock.deploy(
      minDelay,
      [deployer.address],
      [ethers.ZeroAddress],
      deployer.address
    );
    await timelock.waitForDeployment();

    // 4) Governor
    const Governor = await ethers.getContractFactory("KnowledgeGovernor");
    const governor = await Governor.deploy(await govToken.getAddress(), await timelock.getAddress());
    await governor.waitForDeployment();

    // 5) Timelock proposer -> Governor
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.revokeRole(PROPOSER_ROLE, deployer.address);

    // 6) content owner -> timelock
    await content.transferOwnership(await timelock.getAddress());

    // 7) 构造提案
    const calldata = content.interface.encodeFunctionData("setRewardRules", [
      20n,
      ethers.parseEther("2"),
    ]);

    const description = "Proposal: quorum test";
    const descriptionHash = ethers.id(description);

    // 8) propose（voter1 满足 threshold）
    await governor.connect(voter1).propose(
      [await content.getAddress()],
      [0],
      [calldata],
      description
    );

    const proposalId = await governor.hashProposal(
      [await content.getAddress()],
      [0],
      [calldata],
      descriptionHash
    );

    // 9) 等待 votingDelay
    await ethers.provider.send("evm_mine", []);

    // 10) 投票（全票赞成，但只有 50 参与，不够 quorum=100）
    await governor.connect(voter1).castVote(proposalId, 1);

    // 11) 等待 votingPeriod
    await mineBlocks(20);

    /**
     * 12) 不达 quorum 时，提案应 Defeated，queue 会 revert
     * 不同版本 revert 文案可能不同，所以用 to.be.reverted 更稳
     */
    await expect(
      governor.queue(
        [await content.getAddress()],
        [0],
        [calldata],
        descriptionHash
      )
    ).to.be.reverted;
  });
});