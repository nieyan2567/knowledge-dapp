import { ethers } from "hardhat";
import { loadDeployment } from "./utils/deployments";
import {
  KnowledgeContent,
  TimelockController,
  KnowledgeGovernor,
  NativeVotes,
  TreasuryNative,
} from "../typechain-types";

async function assertHasCode(label: string, addr: string) {
  const code = await ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    throw new Error(
      `${label} has no contract code at ${addr} (not deployed, chain reset, or wrong address)`
    );
  }
  console.log(`   OK ${label} code present (len=${code.length})`);
}

function eqAddr(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function hasFunction(contract: { interface: { getFunction(name: string): unknown } }, name: string) {
  try {
    contract.interface.getFunction(name);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("Checking system state for the KC governance stack...\n");

  const info = await loadDeployment();
  const [deployer] = await ethers.getSigners();

  console.log("Deployment integrity");
  await assertHasCode("NativeVotes", info.contracts.NativeVotes);
  await assertHasCode("KnowledgeContent", info.contracts.KnowledgeContent);
  await assertHasCode("TreasuryNative", info.contracts.TreasuryNative);
  await assertHasCode("TimelockController", info.contracts.TimelockController);
  await assertHasCode("KnowledgeGovernor", info.contracts.KnowledgeGovernor);

  const nativeVotes = (await (await ethers.getContractFactory("NativeVotes"))
    .attach(info.contracts.NativeVotes)) as NativeVotes;
  const content = (await (await ethers.getContractFactory("KnowledgeContent"))
    .attach(info.contracts.KnowledgeContent)) as KnowledgeContent;
  const treasury = (await (await ethers.getContractFactory("TreasuryNative"))
    .attach(info.contracts.TreasuryNative)) as TreasuryNative;
  const timelock = (await (await ethers.getContractFactory("TimelockController"))
    .attach(info.contracts.TimelockController)) as TimelockController;
  const governor = (await (await ethers.getContractFactory("KnowledgeGovernor"))
    .attach(info.contracts.KnowledgeGovernor)) as KnowledgeGovernor;

  console.log("\nABI surface");
  console.log("   NativeVotes.cooldownSeconds():", (await nativeVotes.cooldownSeconds()).toString());
  console.log("   NativeVotes.activationBlocks():", (await nativeVotes.activationBlocks()).toString());
  console.log("   KnowledgeContent.updateContent():", hasFunction(content, "updateContent"));
  console.log("   KnowledgeContent.deleteContent():", hasFunction(content, "deleteContent"));
  console.log("   TreasuryNative.totalPendingRewards():", hasFunction(treasury, "totalPendingRewards"));
  console.log("   Governor.timelock():", await governor.timelock());
  console.log("   Governor.token():", await governor.token());

  console.log("\nKnowledgeContent state");
  const contentOwner = await content.owner();
  const votesContract = await content.votesContract();
  const minStakeToVote = await content.minStakeToVote();
  const minVotesToReward = await content.minVotesToReward();
  const rewardPerVote = await content.rewardPerVote();
  const contentTreasury = await content.treasury();
  const contentPaused = await content.paused();
  const contentCount = await content.contentCount();
  const contentBal = await ethers.provider.getBalance(info.contracts.KnowledgeContent);

  console.log("   Address:", info.contracts.KnowledgeContent);
  console.log("   Owner:", contentOwner);
  console.log("   Paused:", contentPaused);
  console.log("   VotesContract:", votesContract);
  console.log("   MinStakeToVote:", ethers.formatEther(minStakeToVote), "KC");
  console.log("   MinVotesToReward:", minVotesToReward.toString());
  console.log("   RewardPerVote:", ethers.formatEther(rewardPerVote), "KC");
  console.log("   Treasury(bound):", contentTreasury);
  console.log("   ContentCount:", contentCount.toString());
  console.log("   Balance (Content):", ethers.formatEther(contentBal), "KC");

  if (contentCount > 0n) {
    const latest = await content.contents(contentCount);
    console.log("   LatestContent.id:", latest.id.toString());
    console.log("   LatestContent.author:", latest.author);
    console.log("   LatestContent.voteCount:", latest.voteCount.toString());
    console.log("   LatestContent.rewardAccrued:", latest.rewardAccrued);
    console.log("   LatestContent.deleted:", latest.deleted);
  }

  console.log("\nTreasuryNative state");
  const treasuryOwner = await treasury.owner();
  const treasuryBal = await ethers.provider.getBalance(info.contracts.TreasuryNative);
  const treasuryPaused = await treasury.paused();
  const epochDuration = await treasury.epochDuration();
  const epochBudget = await treasury.epochBudget();
  const epochSpent = await treasury.epochSpent();
  const epochStart = await treasury.epochStart();
  const totalPendingRewards = await treasury.totalPendingRewards();
  const spenderOk = await treasury.isSpender(info.contracts.KnowledgeContent);
  const pendingDeployer = await treasury.pendingRewards(deployer.address);
  const treasuryCoversPending = treasuryBal >= totalPendingRewards;

  console.log("   Address:", info.contracts.TreasuryNative);
  console.log("   Owner:", treasuryOwner);
  console.log("   Paused:", treasuryPaused);
  console.log("   Balance:", ethers.formatEther(treasuryBal), "KC");
  console.log("   EpochDuration:", epochDuration.toString(), "seconds");
  console.log("   EpochBudget:", ethers.formatEther(epochBudget), "KC");
  console.log("   EpochSpent:", ethers.formatEther(epochSpent), "KC");
  console.log("   EpochStart:", epochStart.toString());
  console.log("   Content is Spender?:", spenderOk);
  console.log("   TotalPendingRewards:", ethers.formatEther(totalPendingRewards), "KC");
  console.log("   PendingRewards(deployer):", ethers.formatEther(pendingDeployer), "KC");
  console.log("   Balance covers pending rewards?:", treasuryCoversPending);

  console.log("\nTimelock state");
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  const isGovProposer = await timelock.hasRole(PROPOSER_ROLE, info.contracts.KnowledgeGovernor);
  const isDeployerProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address);
  const isDeployerAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  const isGovAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, info.contracts.KnowledgeGovernor);
  const isDeployerCanceller = await timelock.hasRole(CANCELLER_ROLE, deployer.address);
  const isGovCanceller = await timelock.hasRole(CANCELLER_ROLE, info.contracts.KnowledgeGovernor);
  const openExecutor = await timelock.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress);

  console.log("   Address:", info.contracts.TimelockController);
  console.log("   MinDelay:", Number(await timelock.getMinDelay()), "seconds");
  console.log("   Governor is Proposer?:", isGovProposer);
  console.log("   Deployer is Proposer?:", isDeployerProposer);
  console.log("   Deployer is TimelockAdmin?:", isDeployerAdmin);
  console.log("   Governor is TimelockAdmin?:", isGovAdmin);
  console.log("   Deployer is Canceller?:", isDeployerCanceller);
  console.log("   Governor is Canceller?:", isGovCanceller);
  console.log("   Open Executor (address(0))?:", openExecutor);

  console.log("\nGovernor state");
  const govToken = await governor.token();
  const govTimelock = await governor.timelock();

  console.log("   Address:", info.contracts.KnowledgeGovernor);
  console.log("   Token:", govToken);
  console.log("   Timelock:", govTimelock);
  console.log("   VotingDelay:", (await governor.votingDelay()).toString(), "blocks");
  console.log("   VotingPeriod:", (await governor.votingPeriod()).toString(), "blocks");
  console.log("   ProposalThreshold:", ethers.formatEther(await governor.proposalThreshold()), "KC");
  console.log("   Quorum @ latest block:", (await governor.quorum((await ethers.provider.getBlockNumber()) - 1)).toString());

  console.log("\nSafety summary");
  const contentOwnerIsTimelock = eqAddr(contentOwner, info.contracts.TimelockController);
  const treasuryOwnerIsTimelock = eqAddr(treasuryOwner, info.contracts.TimelockController);
  const contentTreasuryIsTreasury = eqAddr(contentTreasury, info.contracts.TreasuryNative);
  const govTimelockOk = eqAddr(govTimelock, info.contracts.TimelockController);

  console.log("   Content owner == Timelock:", contentOwnerIsTimelock);
  console.log("   Treasury owner == Timelock:", treasuryOwnerIsTimelock);
  console.log("   Content.treasury == TreasuryNative:", contentTreasuryIsTreasury);
  console.log("   Treasury.spender(Content) == true:", spenderOk);
  console.log("   Governor.timelock == TimelockController:", govTimelockOk);
  console.log("   Treasury balance >= reserved rewards:", treasuryCoversPending);

  if (!contentOwnerIsTimelock) {
    console.log("   WARN Content owner is not Timelock.");
  }
  if (!treasuryOwnerIsTimelock) {
    console.log("   WARN Treasury owner is not Timelock.");
  }
  if (!contentTreasuryIsTreasury) {
    console.log("   WARN KnowledgeContent is bound to the wrong Treasury.");
  }
  if (!spenderOk) {
    console.log("   WARN Treasury has not authorized KnowledgeContent as spender.");
  }
  if (isDeployerAdmin) {
    console.log("   WARN Deployer still has Timelock admin privileges.");
  }
  if (isDeployerCanceller) {
    console.log("   WARN Deployer still has Canceller privileges.");
  }
  if (!openExecutor) {
    console.log("   WARN Timelock executor role is not open.");
  }
  if (!govTimelockOk) {
    console.log("   WARN Governor timelock does not match deployment info.");
  }
  if (!treasuryCoversPending) {
    console.log("   WARN Treasury balance does not cover reserved rewards.");
  }

  console.log("\nSystem verification completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
