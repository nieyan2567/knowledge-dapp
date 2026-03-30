import { expect } from "chai";
import { ethers } from "hardhat";
import {
  KnowledgeContent,
  KnowledgeGovernor,
  NativeVotes,
  RevenueVault,
  TimelockController,
  TreasuryNative,
} from "../typechain-types";
import {
  KnowledgeContent__factory,
  KnowledgeGovernor__factory,
  NativeVotes__factory,
  RevenueVault__factory,
  TimelockController__factory,
  TreasuryNative__factory,
} from "../typechain-types";

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
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
  revenueVault: RevenueVault;
  content: KnowledgeContent;
  timelock: TimelockController;
  governor: KnowledgeGovernor;
  minDelay: number;
}

async function setupGovernanceEnvironment(options?: {
  initialProposalFee?: bigint;
}): Promise<GovernanceEnv> {
  const [deployer, voter1, voter2, poorVoter] = await ethers.getSigners();

  const nativeVotesFactory = (await ethers.getContractFactory(
    "NativeVotes"
  )) as unknown as NativeVotes__factory;
  const nativeVotes = (await nativeVotesFactory.deploy(
    1,
    1
  )) as unknown as NativeVotes;
  await nativeVotes.waitForDeployment();

  const treasuryFactory = (await ethers.getContractFactory(
    "TreasuryNative"
  )) as unknown as TreasuryNative__factory;
  const treasury = (await treasuryFactory.deploy(
    3600,
    ethers.parseEther("100")
  )) as unknown as TreasuryNative;
  await treasury.waitForDeployment();

  const revenueVaultFactory = (await ethers.getContractFactory(
    "RevenueVault"
  )) as unknown as RevenueVault__factory;
  const revenueVault = (await revenueVaultFactory.deploy(
    await treasury.getAddress(),
    deployer.address,
    3000,
    ethers.parseEther("0.5"),
    ethers.parseEther("2"),
    ethers.parseEther("5"),
    ethers.parseEther("1"),
    3600
  )) as unknown as RevenueVault;
  await revenueVault.waitForDeployment();

  const contentFactory = (await ethers.getContractFactory(
    "KnowledgeContent"
  )) as unknown as KnowledgeContent__factory;
  const content = (await contentFactory.deploy()) as unknown as KnowledgeContent;
  await content.waitForDeployment();

  await content.setAntiSybil(
    await nativeVotes.getAddress(),
    ethers.parseEther("1")
  );
  await content.setTreasury(await treasury.getAddress());
  await content.setRevenueVault(await revenueVault.getAddress());
  await treasury.setSpender(await content.getAddress(), true);

  const timelockFactory = (await ethers.getContractFactory(
    "TimelockController"
  )) as unknown as TimelockController__factory;
  const minDelay = 2;
  const timelock = (await timelockFactory.deploy(
    minDelay,
    [deployer.address],
    [ethers.ZeroAddress],
    deployer.address
  )) as unknown as TimelockController;
  await timelock.waitForDeployment();

  const governorFactory = (await ethers.getContractFactory(
    "KnowledgeGovernor"
  )) as unknown as KnowledgeGovernor__factory;
  const governor = (await governorFactory.deploy(
    await nativeVotes.getAddress(),
    await timelock.getAddress(),
    await revenueVault.getAddress(),
    options?.initialProposalFee ?? 0n
  )) as unknown as KnowledgeGovernor;
  await governor.waitForDeployment();

  await nativeVotes.transferOwnership(await timelock.getAddress());
  await content.transferOwnership(await timelock.getAddress());
  await treasury.transferOwnership(await timelock.getAddress());
  await revenueVault.transferOwnership(await timelock.getAddress());

  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
  await timelock.revokeRole(PROPOSER_ROLE, deployer.address);

  await nativeVotes.connect(voter1).deposit({ value: ethers.parseEther("20") });
  await nativeVotes.connect(voter2).deposit({ value: ethers.parseEther("10") });
  await nativeVotes.connect(poorVoter).deposit({ value: ethers.parseEther("1") });

  await mineBlocks(1);

  await nativeVotes.connect(voter1).activate();
  await nativeVotes.connect(voter2).activate();
  await nativeVotes.connect(poorVoter).activate();

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
    revenueVault,
    content,
    timelock,
    governor,
    minDelay,
  };
}

describe("Governance Flow & Edge Cases", function () {
  it("Should extend the proposal deadline when quorum is reached late", async function () {
    const env = await setupGovernanceEnvironment();
    const { voter1, governor, content, treasury } = env;

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [
      5,
      ethers.parseEther("0.001"),
    ]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [
      3600,
      ethers.parseEther("10"),
    ]);

    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];
    const description = "Late quorum extension proposal";
    const descriptionHash = ethers.id(description);

    await governor.connect(voter1).propose(targets, values, calldatas, description);
    const proposalId = await governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash
    );

    const votingDelay = Number(await governor.votingDelay());
    await mineBlocks(votingDelay + 1);

    const initialDeadline = await governor.proposalDeadline(proposalId);
    const extension = await governor.lateQuorumVoteExtension();
    const currentBlock = await ethers.provider.getBlockNumber();

    await mineBlocks(Number(initialDeadline) - currentBlock - 1);
    await governor.connect(voter1).castVote(proposalId, 1);

    const extendedDeadline = await governor.proposalDeadline(proposalId);
    expect(extendedDeadline).to.be.greaterThan(initialDeadline);
    expect(extendedDeadline).to.equal(
      BigInt((await ethers.provider.getBlockNumber()) + Number(extension))
    );
  });

  it("should update rewards, budgets, vote timings, and fee sinks through governance", async function () {
    const env = await setupGovernanceEnvironment();
    const {
      voter1,
      voter2,
      governor,
      nativeVotes,
      content,
      treasury,
      minDelay,
    } = env;

    const newMinVotes = 5n;
    const newRewardPerVote = ethers.parseEther("0.002");
    const newEpochDuration = 3600n;
    const newEpochBudget = ethers.parseEther("200");
    const newCooldownSeconds = 7200n;
    const newActivationBlocks = 20n;
    const newRegisterFee = ethers.parseEther("0.01");
    const newUpdateFee = ethers.parseEther("0.005");
    const newProposalFee = ethers.parseEther("0.05");

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [
      newMinVotes,
      newRewardPerVote,
    ]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [
      newEpochDuration,
      newEpochBudget,
    ]);
    const calldata3 = nativeVotes.interface.encodeFunctionData(
      "setCooldownSeconds",
      [newCooldownSeconds]
    );
    const calldata4 = nativeVotes.interface.encodeFunctionData(
      "setActivationBlocks",
      [newActivationBlocks]
    );
    const calldata5 = content.interface.encodeFunctionData("setContentFees", [
      newRegisterFee,
      newUpdateFee,
    ]);
    const calldata6 = governor.interface.encodeFunctionData("setProposalFee", [
      newProposalFee,
    ]);

    const targets = [
      await content.getAddress(),
      await treasury.getAddress(),
      await nativeVotes.getAddress(),
      await nativeVotes.getAddress(),
      await content.getAddress(),
      await governor.getAddress(),
    ];
    const values = [0, 0, 0, 0, 0, 0];
    const calldatas = [
      calldata1,
      calldata2,
      calldata3,
      calldata4,
      calldata5,
      calldata6,
    ];
    const description =
      "Proposal: update reward rules, treasury budget, native vote timings, and fees";
    const descriptionHash = ethers.id(description);

    await governor.connect(voter1).propose(targets, values, calldatas, description);
    const proposalId = await governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash
    );

    const votingDelay = Number(await governor.votingDelay());
    await mineBlocks(votingDelay + 1);

    await governor.connect(voter1).castVote(proposalId, 1);
    await governor.connect(voter2).castVote(proposalId, 1);

    const votingPeriod = Number(await governor.votingPeriod());
    await mineBlocks(votingPeriod + 1);

    await governor.queue(targets, values, calldatas, descriptionHash);
    await increaseTime(minDelay + 1);
    await governor.execute(targets, values, calldatas, descriptionHash);

    expect(await content.minVotesToReward()).to.equal(newMinVotes);
    expect(await content.rewardPerVote()).to.equal(newRewardPerVote);
    expect(await treasury.epochDuration()).to.equal(newEpochDuration);
    expect(await treasury.epochBudget()).to.equal(newEpochBudget);
    expect(await nativeVotes.cooldownSeconds()).to.equal(newCooldownSeconds);
    expect(await nativeVotes.activationBlocks()).to.equal(newActivationBlocks);
    expect(await content.registerFee()).to.equal(newRegisterFee);
    expect(await content.updateFee()).to.equal(newUpdateFee);
    expect(await governor.proposalFee()).to.equal(newProposalFee);
  });

  it("Should revert propose if voting power is below threshold", async function () {
    const env = await setupGovernanceEnvironment();
    const { poorVoter, governor, content, treasury } = env;

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [
      5,
      ethers.parseEther("0.001"),
    ]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [
      3600,
      ethers.parseEther("10"),
    ]);

    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];
    const description = "Bad Proposal by poor voter";

    await expect(
      governor.connect(poorVoter).propose(targets, values, calldatas, description)
    ).to.be.reverted;
  });

  it("Should revert execute if not queued", async function () {
    const env = await setupGovernanceEnvironment();
    const { voter1, voter2, governor, content, treasury } = env;

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [
      5,
      ethers.parseEther("0.001"),
    ]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [
      3600,
      ethers.parseEther("10"),
    ]);

    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];
    const description = "Proposal to test state check";
    const descriptionHash = ethers.id(description);

    await governor.connect(voter1).propose(targets, values, calldatas, description);
    const proposalId = await governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash
    );

    const votingDelay = Number(await governor.votingDelay());
    await mineBlocks(votingDelay + 1);

    await governor.connect(voter1).castVote(proposalId, 1);
    await governor.connect(voter2).castVote(proposalId, 1);

    const votingPeriod = Number(await governor.votingPeriod());
    await mineBlocks(votingPeriod + 1);

    await expect(
      governor.execute(targets, values, calldatas, descriptionHash)
    ).to.be.reverted;
  });

  it("Should require proposal fees when configured and forward them to RevenueVault", async function () {
    const proposalFee = ethers.parseEther("0.05");
    const env = await setupGovernanceEnvironment({ initialProposalFee: proposalFee });
    const { voter1, governor, content, treasury, revenueVault } = env;

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [
      5,
      ethers.parseEther("0.001"),
    ]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [
      3600,
      ethers.parseEther("10"),
    ]);

    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];
    const description = "Paid proposal";

    await expect(
      governor.connect(voter1).propose(targets, values, calldatas, description)
    ).to.be.revertedWith("fee required");

    const before = await ethers.provider.getBalance(await revenueVault.getAddress());

    await governor
      .connect(voter1)
      .proposeWithFee(targets, values, calldatas, description, {
        value: proposalFee,
      });

    const after = await ethers.provider.getBalance(await revenueVault.getAddress());
    expect(after - before).to.equal(proposalFee);
  });
});
