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

async function mineBlocks(n: number) {
  for (let i = 0; i < n; i++) await ethers.provider.send("evm_mine", []);
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await mineBlocks(1);
}

describe("Governance Flow (Treasury module, TypeChain factory)", function () {
  it("should update reward rules AND treasury budget via propose -> vote -> queue -> execute", async function () {
    const [deployer, voter1, voter2] = await ethers.getSigners();

    // ---------------- Deploy NativeVotes ----------------
    const nvFactory = (await ethers.getContractFactory("NativeVotes")) as unknown as NativeVotes__factory;
    const nativeVotes: NativeVotes = await nvFactory.deploy(1, 1);
    await nativeVotes.waitForDeployment();

    // ---------------- Deploy Treasury ----------------
    const tFactory = (await ethers.getContractFactory("TreasuryNative")) as unknown as TreasuryNative__factory;
    const treasury: TreasuryNative = await tFactory.deploy(3600, ethers.parseEther("100"));
    await treasury.waitForDeployment();

    // ---------------- Deploy Content ----------------
    const cFactory = (await ethers.getContractFactory("KnowledgeContent")) as unknown as KnowledgeContent__factory;
    const content: KnowledgeContent = await cFactory.deploy();
    await content.waitForDeployment();

    // init: bind votes + treasury + spender
    await (await content.setAntiSybil(await nativeVotes.getAddress(), ethers.parseEther("1"))).wait();
    await (await content.setTreasury(await treasury.getAddress())).wait();
    await (await treasury.setSpender(await content.getAddress(), true)).wait();

    // ---------------- Deploy Timelock ----------------
    const tlFactory = (await ethers.getContractFactory("TimelockController")) as unknown as TimelockController__factory;
    const minDelay = 2;
    const timelock: TimelockController = await tlFactory.deploy(
      minDelay,
      [deployer.address],     // proposers (init)
      [ethers.ZeroAddress],   // executors open
      deployer.address        // admin (init)
    );
    await timelock.waitForDeployment();

    // ---------------- Deploy Governor ----------------
    const gFactory = (await ethers.getContractFactory("KnowledgeGovernor")) as unknown as KnowledgeGovernor__factory;
    const governor: KnowledgeGovernor = await gFactory.deploy(await nativeVotes.getAddress(), await timelock.getAddress());
    await governor.waitForDeployment();

    // ---------------- Handover ownership to timelock ----------------
    await (await content.transferOwnership(await timelock.getAddress())).wait();
    await (await treasury.transferOwnership(await timelock.getAddress())).wait();

    // role: proposer -> governor, revoke deployer
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    await (await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress())).wait();
    await (await timelock.revokeRole(PROPOSER_ROLE, deployer.address)).wait();

    // ---------------- Setup voting power ----------------
    // voter1: 20, voter2: 10
    await (await nativeVotes.connect(voter1).deposit({ value: ethers.parseEther("20") })).wait();
    await (await nativeVotes.connect(voter2).deposit({ value: ethers.parseEther("10") })).wait();
    await mineBlocks(1);
    await (await nativeVotes.connect(voter1).activate()).wait();
    await (await nativeVotes.connect(voter2).activate()).wait();

    // delegate to self (确保 governor 读取投票权时生效)
    await (await nativeVotes.connect(voter1).delegate(voter1.address)).wait();
    await (await nativeVotes.connect(voter2).delegate(voter2.address)).wait();
    await mineBlocks(1);

    // =====================================================
    // Proposal: 1) Content.setRewardRules(5, 0.002 ether)
    //           2) Treasury.setBudget(3600, 200 ether)
    // =====================================================
    const newMinVotes = 5n;
    const newRewardPerVote = ethers.parseEther("0.002"); // 0.002 / vote

    const newEpochDuration = 3600n;
    const newEpochBudget = ethers.parseEther("200");

    const calldata1 = content.interface.encodeFunctionData("setRewardRules", [newMinVotes, newRewardPerVote]);
    const calldata2 = treasury.interface.encodeFunctionData("setBudget", [newEpochDuration, newEpochBudget]);

    const targets = [await content.getAddress(), await treasury.getAddress()];
    const values = [0, 0];
    const calldatas = [calldata1, calldata2];

    const description = "Proposal: update reward rules + treasury budget";
    const descriptionHash = ethers.id(description);

    // propose（从 voter1 发起）
    await (await governor.connect(voter1).propose(targets, values, calldatas, description)).wait();

    const proposalId = await governor.hashProposal(targets, values, calldatas, descriptionHash);
    expect(proposalId).to.not.equal(0n);

    // votingDelay
    const vDelay = Number(await governor.votingDelay());
    await mineBlocks(vDelay + 1);

    // vote For
    await (await governor.connect(voter1).castVote(proposalId, 1)).wait();
    await (await governor.connect(voter2).castVote(proposalId, 1)).wait();

    // votingPeriod
    const vPeriod = Number(await governor.votingPeriod());
    await mineBlocks(vPeriod + 1);

    // queue
    await (await governor.queue(targets, values, calldatas, descriptionHash)).wait();

    // wait timelock
    await increaseTime(minDelay + 1);

    // execute
    await (await governor.execute(targets, values, calldatas, descriptionHash)).wait();

    // verify updates
    expect(await content.minVotesToReward()).to.equal(newMinVotes);
    expect(await content.rewardPerVote()).to.equal(newRewardPerVote);

    expect(await treasury.epochDuration()).to.equal(newEpochDuration);
    expect(await treasury.epochBudget()).to.equal(newEpochBudget);
  });
});