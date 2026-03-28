import { ethers } from "hardhat";
import { loadDeployment } from "./utils/deployments";
import {
  KnowledgeContent,
  TimelockController,
  KnowledgeGovernor,
  NativeVotes,
  RevenueVault,
  TreasuryNative,
} from "../typechain-types";

async function assertHasCode(label: string, addr: string) {
  const code = await ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    throw new Error(
      `${label} 在 ${addr} 处没有合约代码（可能未部署、链已重置，或地址错误）`
    );
  }
  console.log(`   正常 ${label} 已部署合约代码（长度=${code.length}）`);
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
  console.log("开始检查 KC 治理系统当前状态...\n");

  const info = await loadDeployment();
  const [deployer] = await ethers.getSigners();

  console.log("部署完整性");
  await assertHasCode("NativeVotes", info.contracts.NativeVotes);
  await assertHasCode("KnowledgeContent", info.contracts.KnowledgeContent);
  await assertHasCode("TreasuryNative", info.contracts.TreasuryNative);
  await assertHasCode("RevenueVault", info.contracts.RevenueVault);
  await assertHasCode("TimelockController", info.contracts.TimelockController);
  await assertHasCode("KnowledgeGovernor", info.contracts.KnowledgeGovernor);

  const nativeVotes = (await (await ethers.getContractFactory("NativeVotes"))
    .attach(info.contracts.NativeVotes)) as NativeVotes;
  const content = (await (await ethers.getContractFactory("KnowledgeContent"))
    .attach(info.contracts.KnowledgeContent)) as KnowledgeContent;
  const treasury = (await (await ethers.getContractFactory("TreasuryNative"))
    .attach(info.contracts.TreasuryNative)) as TreasuryNative;
  const revenueVault = (await (await ethers.getContractFactory("RevenueVault"))
    .attach(info.contracts.RevenueVault)) as RevenueVault;
  const timelock = (await (await ethers.getContractFactory("TimelockController"))
    .attach(info.contracts.TimelockController)) as TimelockController;
  const governor = (await (await ethers.getContractFactory("KnowledgeGovernor"))
    .attach(info.contracts.KnowledgeGovernor)) as KnowledgeGovernor;

  console.log("\nABI 接口检查");
  console.log("   NativeVotes.cooldownSeconds():", (await nativeVotes.cooldownSeconds()).toString());
  console.log("   NativeVotes.activationBlocks():", (await nativeVotes.activationBlocks()).toString());
  console.log("   NativeVotes.setCooldownSeconds():", hasFunction(nativeVotes, "setCooldownSeconds"));
  console.log("   NativeVotes.setActivationBlocks():", hasFunction(nativeVotes, "setActivationBlocks"));
  console.log("   KnowledgeContent.updateContent():", hasFunction(content, "updateContent"));
  console.log("   KnowledgeContent.deleteContent():", hasFunction(content, "deleteContent"));
  console.log("   KnowledgeContent.setContentPolicy():", hasFunction(content, "setContentPolicy"));
  console.log("   KnowledgeContent.contentVersionCount():", hasFunction(content, "contentVersionCount"));
  console.log("   KnowledgeContent.getContentVersion():", hasFunction(content, "getContentVersion"));
  console.log("   TreasuryNative.totalPendingRewards():", hasFunction(treasury, "totalPendingRewards"));
  console.log("   RevenueVault.needsRefill():", hasFunction(revenueVault, "needsRefill"));
  console.log("   RevenueVault.refillTreasuryIfNeeded():", hasFunction(revenueVault, "refillTreasuryIfNeeded"));
  console.log("   RevenueVault.rebalance():", hasFunction(revenueVault, "rebalance"));
  console.log("   RevenueVault.releaseFaucetIfNeeded():", hasFunction(revenueVault, "releaseFaucetIfNeeded"));
  console.log("   Governor.timelock():", await governor.timelock());
  console.log("   Governor.token():", await governor.token());

  console.log("\nKnowledgeContent 状态");
  const contentOwner = await content.owner();
  const votesContract = await content.votesContract();
  const minStakeToVote = await content.minStakeToVote();
  const minVotesToReward = await content.minVotesToReward();
  const rewardPerVote = await content.rewardPerVote();
  const editLockVotes = await content.editLockVotes();
  const allowDeleteAfterVote = await content.allowDeleteAfterVote();
  const maxVersionsPerContent = await content.maxVersionsPerContent();
  const contentTreasury = await content.treasury();
  const contentPaused = await content.paused();
  const contentCount = await content.contentCount();
  const contentBal = await ethers.provider.getBalance(info.contracts.KnowledgeContent);

  console.log("   合约地址:", info.contracts.KnowledgeContent);
  console.log("   Owner:", contentOwner);
  console.log("   是否暂停:", contentPaused);
  console.log("   VotesContract:", votesContract);
  console.log("   最低投票质押:", ethers.formatEther(minStakeToVote), "KC");
  console.log("   获得奖励的最少票数:", minVotesToReward.toString());
  console.log("   每票奖励:", ethers.formatEther(rewardPerVote), "KC");
  console.log("   编辑锁定票数:", editLockVotes.toString());
  console.log("   投票后是否允许删除:", allowDeleteAfterVote);
  console.log("   单条内容最大版本数:", maxVersionsPerContent.toString());
  console.log("   绑定的 Treasury:", contentTreasury);
  console.log("   内容总数:", contentCount.toString());
  console.log("   合约余额:", ethers.formatEther(contentBal), "KC");

  if (contentCount > 0n) {
    const latest = await content.contents(contentCount);
    const versionCount = await content.contentVersionCount(contentCount);
    console.log("   最新内容.id:", latest.id.toString());
    console.log("   最新内容.author:", latest.author);
    console.log("   最新内容.voteCount:", latest.voteCount.toString());
    console.log("   最新内容.rewardAccrued:", latest.rewardAccrued);
    console.log("   最新内容.deleted:", latest.deleted);
    console.log("   最新内容.latestVersion:", latest.latestVersion.toString());
    console.log("   最新内容.lastUpdatedAt:", latest.lastUpdatedAt.toString());
    console.log("   最新内容.versionCount:", versionCount.toString());

    if (versionCount > 0n) {
      const version = await content.getContentVersion(contentCount, versionCount);
      console.log("   最新版本.ipfsHash:", version[0]);
      console.log("   最新版本.title:", version[1]);
      console.log("   最新版本.timestamp:", version[3].toString());
    }
  }

  console.log("\nTreasuryNative 状态");
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

  console.log("   合约地址:", info.contracts.TreasuryNative);
  console.log("   Owner:", treasuryOwner);
  console.log("   是否暂停:", treasuryPaused);
  console.log("   余额:", ethers.formatEther(treasuryBal), "KC");
  console.log("   周期时长:", epochDuration.toString(), "秒");
  console.log("   周期预算:", ethers.formatEther(epochBudget), "KC");
  console.log("   当前周期已支出:", ethers.formatEther(epochSpent), "KC");
  console.log("   当前周期开始时间:", epochStart.toString());
  console.log("   Content 是否为授权支出方:", spenderOk);
  console.log("   待领取奖励总额:", ethers.formatEther(totalPendingRewards), "KC");
  console.log("   待领取奖励（deployer）:", ethers.formatEther(pendingDeployer), "KC");
  console.log("   当前余额是否覆盖待领取奖励:", treasuryCoversPending);

  console.log("\nRevenueVault 状态");
  const revenueVaultOwner = await revenueVault.owner();
  const revenueVaultBal = await ethers.provider.getBalance(info.contracts.RevenueVault);
  const revenueVaultPaused = await revenueVault.paused();
  const revenueVaultTreasury = await revenueVault.treasury();
  const faucetWallet = await revenueVault.faucetWallet();
  const faucetBalance = await ethers.provider.getBalance(faucetWallet);
  const faucetShareBps = await revenueVault.faucetShareBps();
  const faucetPending = await revenueVault.faucetPending();
  const minFaucetPayout = await revenueVault.minFaucetPayout();
  const refillThreshold = await revenueVault.refillThreshold();
  const targetTreasuryBalance = await revenueVault.targetTreasuryBalance();
  const minRefillAmount = await revenueVault.minRefillAmount();
  const refillCooldown = await revenueVault.refillCooldown();
  const lastRefillAt = await revenueVault.lastRefillAt();
  const autoRefillEnabled = await revenueVault.autoRefillEnabled();
  const autoFaucetEnabled = await revenueVault.autoFaucetEnabled();
  const needsFaucetPayout = await revenueVault.needsFaucetPayout();
  const needsRefill = await revenueVault.needsRefill();
  const availableForTreasury = await revenueVault.availableForTreasury();
  const maxRefillAmount = await revenueVault.maxRefillAmount();

  console.log("   合约地址:", info.contracts.RevenueVault);
  console.log("   Owner:", revenueVaultOwner);
  console.log("   是否暂停:", revenueVaultPaused);
  console.log("   绑定的 Treasury:", revenueVaultTreasury);
  console.log("   Faucet 钱包:", faucetWallet);
  console.log("   Faucet 余额:", ethers.formatEther(faucetBalance), "KC");
  console.log("   Faucet 分成基点:", faucetShareBps.toString());
  console.log("   Faucet 待发放金额:", ethers.formatEther(faucetPending), "KC");
  console.log("   Faucet 最小发放金额:", ethers.formatEther(minFaucetPayout), "KC");
  console.log("   余额:", ethers.formatEther(revenueVaultBal), "KC");
  console.log("   触发回填阈值:", ethers.formatEther(refillThreshold), "KC");
  console.log("   Treasury 目标余额:", ethers.formatEther(targetTreasuryBalance), "KC");
  console.log("   最小回填金额:", ethers.formatEther(minRefillAmount), "KC");
  console.log("   回填冷却期:", refillCooldown.toString(), "秒");
  console.log("   上次回填时间:", lastRefillAt.toString());
  console.log("   是否启用自动回填:", autoRefillEnabled);
  console.log("   是否启用自动 Faucet:", autoFaucetEnabled);
  console.log("   是否需要发放 Faucet:", needsFaucetPayout);
  console.log("   是否需要回填:", needsRefill);
  console.log("   可用于 Treasury 的金额:", ethers.formatEther(availableForTreasury), "KC");
  console.log("   最大回填金额:", ethers.formatEther(maxRefillAmount), "KC");

  console.log("\nTimelock 状态");
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

  console.log("   合约地址:", info.contracts.TimelockController);
  console.log("   最小延迟:", Number(await timelock.getMinDelay()), "秒");
  console.log("   Governor 是否为 Proposer:", isGovProposer);
  console.log("   Deployer 是否为 Proposer:", isDeployerProposer);
  console.log("   Deployer 是否为 TimelockAdmin:", isDeployerAdmin);
  console.log("   Governor 是否为 TimelockAdmin:", isGovAdmin);
  console.log("   Deployer 是否为 Canceller:", isDeployerCanceller);
  console.log("   Governor 是否为 Canceller:", isGovCanceller);
  console.log("   是否开放 Executor（address(0)）:", openExecutor);

  console.log("\nGovernor 状态");
  const govToken = await governor.token();
  const govTimelock = await governor.timelock();

  console.log("   合约地址:", info.contracts.KnowledgeGovernor);
  console.log("   Token:", govToken);
  console.log("   Timelock:", govTimelock);
  console.log("   投票延迟:", (await governor.votingDelay()).toString(), "个区块");
  console.log("   投票周期:", (await governor.votingPeriod()).toString(), "个区块");
  console.log("   延迟法定人数扩展:", (await governor.lateQuorumVoteExtension()).toString(), "个区块");
  console.log("   提案门槛:", ethers.formatEther(await governor.proposalThreshold()), "KC");
  console.log("   最新区块的法定人数:", (await governor.quorum((await ethers.provider.getBlockNumber()) - 1)).toString());

  console.log("\n安全检查汇总");
  const nativeVotesOwner = await nativeVotes.owner();
  const nativeVotesOwnerIsTimelock = eqAddr(nativeVotesOwner, info.contracts.TimelockController);
  const contentOwnerIsTimelock = eqAddr(contentOwner, info.contracts.TimelockController);
  const treasuryOwnerIsTimelock = eqAddr(treasuryOwner, info.contracts.TimelockController);
  const revenueVaultOwnerIsTimelock = eqAddr(revenueVaultOwner, info.contracts.TimelockController);
  const contentTreasuryIsTreasury = eqAddr(contentTreasury, info.contracts.TreasuryNative);
  const revenueVaultTreasuryIsTreasury = eqAddr(
    revenueVaultTreasury,
    info.contracts.TreasuryNative
  );
  const govTimelockOk = eqAddr(govTimelock, info.contracts.TimelockController);

  console.log("   NativeVotes owner 是否为 Timelock:", nativeVotesOwnerIsTimelock);
  console.log("   Content owner 是否为 Timelock:", contentOwnerIsTimelock);
  console.log("   Treasury owner 是否为 Timelock:", treasuryOwnerIsTimelock);
  console.log("   RevenueVault owner 是否为 Timelock:", revenueVaultOwnerIsTimelock);
  console.log("   Content.treasury 是否为 TreasuryNative:", contentTreasuryIsTreasury);
  console.log("   RevenueVault.treasury 是否为 TreasuryNative:", revenueVaultTreasuryIsTreasury);
  console.log("   Treasury 是否已授权 Content 为 spender:", spenderOk);
  console.log("   Governor.timelock 是否为 TimelockController:", govTimelockOk);
  console.log("   Treasury 余额是否大于等于预留奖励:", treasuryCoversPending);

  if (!nativeVotesOwnerIsTimelock) {
    console.log("   警告 NativeVotes owner 不是 Timelock。");
  }
  if (!contentOwnerIsTimelock) {
    console.log("   警告 Content owner 不是 Timelock。");
  }
  if (!treasuryOwnerIsTimelock) {
    console.log("   警告 Treasury owner 不是 Timelock。");
  }
  if (!revenueVaultOwnerIsTimelock) {
    console.log("   警告 RevenueVault owner 不是 Timelock。");
  }
  if (!contentTreasuryIsTreasury) {
    console.log("   警告 KnowledgeContent 绑定到了错误的 Treasury。");
  }
  if (!revenueVaultTreasuryIsTreasury) {
    console.log("   警告 RevenueVault 绑定到了错误的 Treasury。");
  }
  if (!spenderOk) {
    console.log("   警告 Treasury 尚未授权 KnowledgeContent 作为 spender。");
  }
  if (isDeployerAdmin) {
    console.log("   警告 Deployer 仍然持有 Timelock admin 权限。");
  }
  if (isDeployerCanceller) {
    console.log("   警告 Deployer 仍然持有 Canceller 权限。");
  }
  if (!openExecutor) {
    console.log("   警告 Timelock executor 角色当前不是开放状态。");
  }
  if (!govTimelockOk) {
    console.log("   警告 Governor 的 timelock 与部署信息不一致。");
  }
  if (!treasuryCoversPending) {
    console.log("   警告 Treasury 余额不足以覆盖预留奖励。");
  }

  console.log("\n系统检查完成。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
