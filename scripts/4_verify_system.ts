import { ethers } from "hardhat";
import { loadDeployment } from "./utils/deployments";
import {
  KnowledgeContent,
  TimelockController,
  KnowledgeGovernor,
  NativeVotes,
} from "../typechain-types";

async function assertHasCode(label: string, addr: string) {
  const code = await ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    throw new Error(`❌ ${label} 地址没有合约代码：${addr}（可能未部署/链已重置/地址错）`);
  }
  console.log(`   ✅ ${label} code ok (len=${code.length})`);
}

async function main() {
  console.log("🔍 正在验证系统状态...\n");

  const info = await loadDeployment();

  const [deployer] = await ethers.getSigners();

  // =========================================
  // 0️⃣ 部署完整性检查
  // =========================================
  console.log("🧩 部署完整性检查:");

  await assertHasCode("NativeVotes", info.contracts.NativeVotes);
  await assertHasCode("KnowledgeContent", info.contracts.KnowledgeContent);
  await assertHasCode("TimelockController", info.contracts.TimelockController);
  await assertHasCode("KnowledgeGovernor", info.contracts.KnowledgeGovernor);

  const NativeVotesFactory = await ethers.getContractFactory("NativeVotes");
  const nativeVotes = NativeVotesFactory.attach(
    info.contracts.NativeVotes
  ) as NativeVotes;

  const ContentFactory = await ethers.getContractFactory("KnowledgeContent");
  const content = ContentFactory.attach(
    info.contracts.KnowledgeContent
  ) as KnowledgeContent;

  const TimelockFactory = await ethers.getContractFactory("TimelockController");
  const timelock = TimelockFactory.attach(
    info.contracts.TimelockController
  ) as TimelockController;

  const GovernorFactory = await ethers.getContractFactory("KnowledgeGovernor");
  const governor = GovernorFactory.attach(
    info.contracts.KnowledgeGovernor
  ) as KnowledgeGovernor;

  // 关键只读函数验证（防止地址错配）
  console.log("   🔎 合约类型验证:");
  console.log(
    "      NativeVotes.cooldownSeconds():",
    (await nativeVotes.cooldownSeconds()).toString()
  );
  console.log(
    "      NativeVotes.activationBlocks():",
    (await nativeVotes.activationBlocks()).toString()
  );

  await content.owner();
  await timelock.getMinDelay();
  await governor.timelock();

  console.log("   ✅ ABI 调用验证通过\n");

  // =========================================
  // 1️⃣ KnowledgeContent 状态
  // =========================================
  console.log("📦 KnowledgeContent 状态:");
  const owner = await content.owner();
  console.log("   Owner:", owner);
  console.log("   VotesContract:", await content.votesContract());
  console.log(
    "   MinStakeToVote:",
    ethers.formatEther(await content.minStakeToVote()),
    "ETH"
  );

  const balance = await ethers.provider.getBalance(
    info.contracts.KnowledgeContent
  );
  console.log("   Balance:", ethers.formatEther(balance), "ETH");

  // =========================================
  // 2️⃣ Timelock 状态
  // =========================================
  console.log("\n⏳ TimelockController 状态:");

  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  console.log("   MinDelay:", Number(await timelock.getMinDelay()), "秒");

  const isGovProposer = await timelock.hasRole(
    PROPOSER_ROLE,
    info.contracts.KnowledgeGovernor
  );
  const isDeployerProposer = await timelock.hasRole(
    PROPOSER_ROLE,
    deployer.address
  );

  const isDeployerAdmin = await timelock.hasRole(
    TIMELOCK_ADMIN_ROLE,
    deployer.address
  );
  const isGovAdmin = await timelock.hasRole(
    TIMELOCK_ADMIN_ROLE,
    info.contracts.KnowledgeGovernor
  );

  const isDeployerCanceller = await timelock.hasRole(
    CANCELLER_ROLE,
    deployer.address
  );
  const isGovCanceller = await timelock.hasRole(
    CANCELLER_ROLE,
    info.contracts.KnowledgeGovernor
  );

  const openExecutor = await timelock.hasRole(
    EXECUTOR_ROLE,
    ethers.ZeroAddress
  );

  console.log("   Governor is Proposer?", isGovProposer);
  console.log("   Deployer is Proposer?", isDeployerProposer);

  console.log("   Deployer is TimelockAdmin?", isDeployerAdmin);
  console.log("   Governor is TimelockAdmin?", isGovAdmin);

  console.log("   Deployer is Canceller?", isDeployerCanceller);
  console.log("   Governor is Canceller?", isGovCanceller);

  console.log("   Open Executor (address(0))?", openExecutor);

  // =========================================
  // 3️⃣ Governor 状态
  // =========================================
  console.log("\n🏛️ KnowledgeGovernor 状态:");
  console.log("   Token:", await governor.token());
  console.log("   Timelock:", await governor.timelock());

  // =========================================
  // 4️⃣ 最终安全结论
  // =========================================
  console.log("\n🧾 关键安全结论:");

  const ownerIsTimelock =
    owner.toLowerCase() ===
    info.contracts.TimelockController.toLowerCase();

  console.log("   Content Owner == Timelock ?", ownerIsTimelock);

  if (!ownerIsTimelock)
    console.log("   ⚠️ Owner 仍不是 Timelock");

  if (isDeployerAdmin)
    console.log("   ⚠️ Deployer 仍是 TimelockAdmin");

  if (isDeployerCanceller)
    console.log("   ⚠️ Deployer 仍是 Canceller");

  if (!openExecutor)
    console.log("   ⚠️ 未开放执行者，可能无法 execute 提案");

  console.log("\n✅ 系统状态检查完成。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});