import { expect } from "chai";
import { ethers } from "hardhat";
import {
  KnowledgeContent,
  KnowledgeGovernor,
  NativeVotes,
  TimelockController,
  TreasuryNative,
} from "../typechain-types";
import {
  KnowledgeContent__factory,
  KnowledgeGovernor__factory,
  NativeVotes__factory,
  TimelockController__factory,
  TreasuryNative__factory,
} from "../typechain-types";

// --- 辅助函数 ---
async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) await ethers.provider.send("evm_mine", []);
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await mineBlocks(1);
}

interface GovernanceEnv {
  deployer: any;
  voter1: any;
  voter2: any;
  poorVoter: any;
  nativeVotes: NativeVotes;
  treasury: TreasuryNative;
  content: KnowledgeContent;
  timelock: TimelockController;
  governor: KnowledgeGovernor;
  minDelay: number;
}

// --- 环境设置辅助函数 (避免代码重复) ---
async function setupGovernanceEnvironment(): Promise<GovernanceEnv> {
  const [deployer, voter1, voter2, poorVoter] = await ethers.getSigners();

  // 1. Deploy NativeVotes
  const nvFactory = await ethers.getContractFactory("NativeVotes") as unknown as NativeVotes__factory;
  const nativeVotes = await nvFactory.deploy(1, 1) as unknown as NativeVotes;
  await nativeVotes.waitForDeployment();

  // 2. Deploy Treasury
  const tFactory = await ethers.getContractFactory("TreasuryNative") as unknown as TreasuryNative__factory;
  const treasury = await tFactory.deploy(3600, ethers.parseEther("100")) as unknown as TreasuryNative;
  await treasury.waitForDeployment();

  // 3. Deploy Content
  const cFactory = await ethers.getContractFactory("KnowledgeContent") as unknown as KnowledgeContent__factory;
  const content = await cFactory.deploy() as unknown as KnowledgeContent;
  await content.waitForDeployment();

  // Init bindings
  await content.setAntiSybil(await nativeVotes.getAddress(), ethers.parseEther("1"));
  await content.setTreasury(await treasury.getAddress());
  await treasury.setSpender(await content.getAddress(), true);

  // 4. Deploy Timelock
  const tlFactory = await ethers.getContractFactory("TimelockController") as unknown as TimelockController__factory;
  const minDelay = 2;
  const timelock = await tlFactory.deploy(
    minDelay,
    [deployer.address],
    [ethers.ZeroAddress],
    deployer.address
  ) as unknown as TimelockController;
  await timelock.waitForDeployment();

  // 5. Deploy Governor
  const gFactory = await ethers.getContractFactory("KnowledgeGovernor") as unknown as KnowledgeGovernor__factory;
  const governor = await gFactory.deploy(await nativeVotes.getAddress(), await timelock.getAddress()) as unknown as KnowledgeGovernor;
  await governor.waitForDeployment();

  // 6. Handover ownership to timelock
  await content.transferOwnership(await timelock.getAddress());
  await treasury.transferOwnership(await timelock.getAddress());

  // 7. Setup Roles
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
  await timelock.revokeRole(PROPOSER_ROLE, deployer.address);

  // 8. Setup Voting Power
  // voter1: High power (Can propose)
  await nativeVotes.connect(voter1).deposit({ value: ethers.parseEther("20") });
  // voter2: Medium power
  await nativeVotes.connect(voter2).deposit({ value: ethers.parseEther("10") });
  // poorVoter: Low power (Cannot propose - assuming threshold is > 1 ETH)
  await nativeVotes.connect(poorVoter).deposit({ value: ethers.parseEther("1") });

  await mineBlocks(1);

  await nativeVotes.connect(voter1).activate();
  await nativeVotes.connect(voter2).activate();
  await nativeVotes.connect(poorVoter).activate();

  // Delegate to self
  await nativeVotes.connect(voter1).delegate(voter1.address);
  await nativeVotes.connect(voter2).delegate(voter2.address);
  await nativeVotes.connect(poorVoter).delegate(poorVoter.address);
  
  await mineBlocks(1);

  return {
    deployer,
    voter1,
    voter2,
    poorVoter,
    nativeVotes,
    treasury,
    content,
    timelock,
    governor,
    minDelay
  };
}

describe("Governance Flow & Edge Cases", function () {
  
  // === 测试 1: 正常流程 (Happy Path) ===
  it("should update reward rules AND treasury budget via propose -> vote -> queue -> execute", async function () {
    const env = await setupGovernanceEnvironment();
    const { voter1, voter2, governor, content, treasury, minDelay } = env;

    const newMinVotes = 5n;
    const newRewardPerVote = ethers.parseEther("0.002");
    const newEpochDuration = 3600n;
    const newEpochBudget = ethers.parseEther("200");

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [newMinVotes, newRewardPerVote]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [newEpochDuration, newEpochBudget]);

    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];
    const description = "Proposal: update reward rules + treasury budget";
    const descriptionHash = ethers.id(description);

    // Propose
    await governor.connect(voter1).propose(targets, values, calldatas, description);
    const proposalId = await governor.hashProposal(targets, values, calldatas, descriptionHash);
    
    // Wait voting delay
    const vDelay = Number(await governor.votingDelay());
    await mineBlocks(vDelay + 1);

    // Vote
    await governor.connect(voter1).castVote(proposalId, 1);
    await governor.connect(voter2).castVote(proposalId, 1);

    // Wait voting period
    const vPeriod = Number(await governor.votingPeriod());
    await mineBlocks(vPeriod + 1);

    // Queue
    await governor.queue(targets, values, calldatas, descriptionHash);

    // Wait timelock
    await increaseTime(minDelay + 1);

    // Execute
    await governor.execute(targets, values, calldatas, descriptionHash);

    // Verify
    expect(await content.minVotesToReward()).to.equal(newMinVotes);
    expect(await content.rewardPerVote()).to.equal(newRewardPerVote);
    expect(await treasury.epochDuration()).to.equal(newEpochDuration);
    expect(await treasury.epochBudget()).to.equal(newEpochBudget);
  });

  // === 测试 2: 覆盖 Proposal Threshold (针对 poorVoter) ===
  it("Should revert propose if voting power is below threshold", async function () {
    const env = await setupGovernanceEnvironment();
    const { poorVoter, governor, content, treasury } = env;

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [5, ethers.parseEther("0.001")]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [3600, ethers.parseEther("10")]);
    
    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];
    const description = "Bad Proposal by poor voter";

    // 尝试由票数不足的 poorVoter 发起提案
    // 预期会 Revert，错误信息通常包含 "proposer votes below proposal threshold"
    // 注意：具体错误字符串取决于你的 Governor 实现，这里使用通用的 reverted 检查
    await expect(
      governor.connect(poorVoter).propose(targets, values, calldatas, description)
    ).to.be.reverted; 
  });

  // === 测试 3: 覆盖 State Check (针对行 112, 130) ===
  it("Should revert execute if not queued (State Check)", async function () {
    const env = await setupGovernanceEnvironment();
    const { voter1, voter2, governor, content, treasury } = env;

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [5, ethers.parseEther("0.001")]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [3600, ethers.parseEther("10")]);
    
    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];
    const description = "Proposal to test state check";
    const descriptionHash = ethers.id(description);

    // 1. Propose
    await governor.connect(voter1).propose(targets, values, calldatas, description);
    const proposalId = await governor.hashProposal(targets, values, calldatas, descriptionHash);

    // 2. Wait & Vote
    const vDelay = Number(await governor.votingDelay());
    await mineBlocks(vDelay + 1);
    
    await governor.connect(voter1).castVote(proposalId, 1);
    await governor.connect(voter2).castVote(proposalId, 1);

    // 3. Wait Voting Period Ends (State becomes Succeeded)
    const vPeriod = Number(await governor.votingPeriod());
    await mineBlocks(vPeriod + 1);

    // 此时提案状态是 Succeeded，但还没有 Queue
    
    // 4. 尝试直接 Execute (跳过 Queue)
    // 预期会 Revert，错误信息通常包含 "proposal not queued" 或 "queue not called"
    // 这将覆盖 Governor 中检查 state == Queued 的代码行
    await expect(
      governor.execute(targets, values, calldatas, descriptionHash)
    ).to.be.reverted;
  });

});