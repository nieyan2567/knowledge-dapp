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
    throw new Error(`❌ ${label} 地址没有合约代码：${addr}（可能未部署/链已重置/地址错）`);
  }
  console.log(`   ✅ ${label} code ok (len=${code.length})`);
}

function eqAddr(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

async function main() {
  console.log("🔍 正在验证系统状态（Treasury 模块化版）...\n");

  const info = await loadDeployment();
  const [deployer] = await ethers.getSigners();

  // =========================================
  // 0️⃣ 部署完整性检查
  // =========================================
  console.log("🧩 部署完整性检查:");

  await assertHasCode("NativeVotes", info.contracts.NativeVotes);
  await assertHasCode("KnowledgeContent", info.contracts.KnowledgeContent);
  await assertHasCode("TreasuryNative", info.contracts.TreasuryNative); // ✅ 新增
  await assertHasCode("TimelockController", info.contracts.TimelockController);
  await assertHasCode("KnowledgeGovernor", info.contracts.KnowledgeGovernor);

  // attach（TypeChain）
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

  // 关键只读函数验证（防止地址错配/ABI错配）
  console.log("   🔎 合约类型验证:");

  console.log("      NativeVotes.cooldownSeconds():", (await nativeVotes.cooldownSeconds()).toString());
  console.log("      NativeVotes.activationBlocks():", (await nativeVotes.activationBlocks()).toString());

  // 下面这些调用如果 ABI/地址不对会直接 throw
  await content.owner();
  await content.votesContract();
  await content.minStakeToVote();
  await content.treasury(); // ✅ 新增：content 已有 treasury()

  await treasury.epochBudget();
  await treasury.epochDuration();
  await treasury.epochSpent();

  await timelock.getMinDelay();
  await governor.timelock();
  await governor.token();

  console.log("   ✅ ABI 调用验证通过\n");

  // =========================================
  // 1️⃣ KnowledgeContent 状态
  // =========================================
  console.log("📦 KnowledgeContent 状态:");
  const contentOwner = await content.owner();
  const votesContract = await content.votesContract();
  const minStakeToVote = await content.minStakeToVote();
  const contentTreasury = await content.treasury();

  console.log("   Address:", info.contracts.KnowledgeContent);
  console.log("   Owner:", contentOwner);
  console.log("   VotesContract:", votesContract);
  console.log("   MinStakeToVote:", ethers.formatEther(minStakeToVote), "ETH");
  console.log("   Treasury(bound):", contentTreasury);

  // Content 自己可能仍有余额（比如误转账），但奖励池以 Treasury 为准
  const contentBal = await ethers.provider.getBalance(info.contracts.KnowledgeContent);
  console.log("   Balance (Content):", ethers.formatEther(contentBal), "ETH");

  // =========================================
  // 2️⃣ TreasuryNative 状态（奖励池核心）
  // =========================================
  console.log("\n🏦 TreasuryNative 状态:");
  const treasuryOwner = await treasury.owner();
  const treasuryBal = await ethers.provider.getBalance(info.contracts.TreasuryNative);

  console.log("   Address:", info.contracts.TreasuryNative);
  console.log("   Owner:", treasuryOwner);
  console.log("   Balance (Treasury):", ethers.formatEther(treasuryBal), "ETH");

  console.log("   EpochDuration:", (await treasury.epochDuration()).toString(), "秒");
  console.log("   EpochBudget:", ethers.formatEther(await treasury.epochBudget()), "ETH");
  console.log("   EpochSpent:", ethers.formatEther(await treasury.epochSpent()), "ETH");
  console.log("   EpochStart:", (await treasury.epochStart()).toString());

  const spenderOk = await treasury.isSpender(info.contracts.KnowledgeContent);
  console.log("   Content is Spender?", spenderOk);

  // 任意展示一个 pendingRewards（deployer）用于检查读接口
  const pendingDeployer = await treasury.pendingRewards(deployer.address);
  console.log("   PendingRewards(deployer):", ethers.formatEther(pendingDeployer), "ETH");

  // =========================================
  // 3️⃣ Timelock 状态
  // =========================================
  console.log("\n⏳ TimelockController 状态:");

  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  console.log("   Address:", info.contracts.TimelockController);
  console.log("   MinDelay:", Number(await timelock.getMinDelay()), "秒");

  const isGovProposer = await timelock.hasRole(PROPOSER_ROLE, info.contracts.KnowledgeGovernor);
  const isDeployerProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address);

  const isDeployerAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  const isGovAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, info.contracts.KnowledgeGovernor);

  const isDeployerCanceller = await timelock.hasRole(CANCELLER_ROLE, deployer.address);
  const isGovCanceller = await timelock.hasRole(CANCELLER_ROLE, info.contracts.KnowledgeGovernor);

  const openExecutor = await timelock.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress);

  console.log("   Governor is Proposer?", isGovProposer);
  console.log("   Deployer is Proposer?", isDeployerProposer);

  console.log("   Deployer is TimelockAdmin?", isDeployerAdmin);
  console.log("   Governor is TimelockAdmin?", isGovAdmin);

  console.log("   Deployer is Canceller?", isDeployerCanceller);
  console.log("   Governor is Canceller?", isGovCanceller);

  console.log("   Open Executor (address(0))?", openExecutor);

  // =========================================
  // 4️⃣ Governor 状态
  // =========================================
  console.log("\n🏛️ KnowledgeGovernor 状态:");
  const govToken = await governor.token();
  const govTimelock = await governor.timelock();

  console.log("   Address:", info.contracts.KnowledgeGovernor);
  console.log("   Token:", govToken);
  console.log("   Timelock:", govTimelock);

  // =========================================
  // 5️⃣ 最终安全结论（关键断言/提示）
  // =========================================
  console.log("\n🧾 关键安全结论:");

  const contentOwnerIsTimelock = eqAddr(contentOwner, info.contracts.TimelockController);
  const treasuryOwnerIsTimelock = eqAddr(treasuryOwner, info.contracts.TimelockController);
  const contentTreasuryIsTreasury = eqAddr(contentTreasury, info.contracts.TreasuryNative);

  console.log("   Content Owner == Timelock ?", contentOwnerIsTimelock);
  console.log("   Treasury Owner == Timelock ?", treasuryOwnerIsTimelock);
  console.log("   Content.treasury == TreasuryNative ?", contentTreasuryIsTreasury);
  console.log("   Treasury.spender(Content) == true ?", spenderOk);

  if (!contentOwnerIsTimelock) console.log("   ⚠️ Content Owner 仍不是 Timelock（未完全去中心化）");
  if (!treasuryOwnerIsTimelock) console.log("   ⚠️ Treasury Owner 仍不是 Timelock（国库未交给 DAO）");
  if (!contentTreasuryIsTreasury) console.log("   ⚠️ Content 未绑定正确的 Treasury（发奖会失败/走错池子）");
  if (!spenderOk) console.log("   ⚠️ Treasury 未授权 Content 为 Spender（distributeReward 会 revert）");

  if (isDeployerAdmin) console.log("   ⚠️ Deployer 仍是 TimelockAdmin（存在后门权限）");
  if (isDeployerCanceller) console.log("   ⚠️ Deployer 仍是 Canceller（仍可取消已排队操作）");
  if (!openExecutor) console.log("   ⚠️ 未开放执行者，可能导致无人可 execute（建议 EXECUTOR_ROLE 给 address(0)）");

  // 额外一致性检查：Governor.timelock 应等于 TimelockController 地址
  const govTimelockOk = eqAddr(govTimelock, info.contracts.TimelockController);
  if (!govTimelockOk) console.log("   ⚠️ Governor.timelock 与 deployments 不一致（可能部署信息错/读错网）");

  console.log("\n✅ 系统状态检查完成。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});