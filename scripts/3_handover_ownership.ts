import { ethers } from "hardhat";
import * as readline from "readline";
import { loadDeployment } from "./utils/deployments";
import { KnowledgeContent, TimelockController } from "../typechain-types";

async function confirmOrExit() {
  console.log("⚠️  警告：即将执行权限移交操作，此操作不可逆！");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise<void>((resolve) => {
    rl.question("确认要继续吗？(输入 yes 继续): ", (answer) => {
      if (answer.toLowerCase() !== "yes") {
        console.log("❌ 操作已取消");
        process.exit(0);
      }
      resolve();
    });
  });

  rl.close();
}

async function main() {
  await confirmOrExit();
  console.log("🔄 开始权限移交流程...");

  const info = await loadDeployment();

  const contentAddress = info.contracts.KnowledgeContent;
  const timelockAddress = info.contracts.TimelockController;
  const governorAddress = info.contracts.KnowledgeGovernor;

  const [deployer] = await ethers.getSigners();

  const ContentFactory = await ethers.getContractFactory("KnowledgeContent");
  const content = ContentFactory.attach(contentAddress) as KnowledgeContent;

  const TimelockFactory = await ethers.getContractFactory("TimelockController");
  const timelock = TimelockFactory.attach(timelockAddress) as TimelockController;

  // 1) 验证 content owner 仍是 deployer
  const contentOwner = await content.owner();
  console.log("Content 当前 Owner:", contentOwner);
  console.log("当前脚本运行者:", deployer.address);

  if (contentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`❌ Deployer 不再是 Content 的 Owner (当前: ${contentOwner})`);
  }

  // 2) 验证 timelock admin（OZ 4.9.x：TIMELOCK_ADMIN_ROLE）
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  const isTimelockAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  console.log("Timelock 地址:", timelockAddress);
  console.log("Deployer is TimelockAdmin?", isTimelockAdmin);

  if (!isTimelockAdmin) {
    throw new Error(
      [
        "❌ 当前 signer 不是 Timelock TIMELOCK_ADMIN_ROLE，无法 grant/revoke role。",
        "如果你已经 renounce 掉 admin，就无法修复权限，只能重部署。",
      ].join("\n")
    );
  }

  // (可选安全检查) Governor 不应该是 TimelockAdmin
  const govAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, governorAddress);
  if (govAdmin) {
    throw new Error("❌ 验证失败：Governor 不应该是 Timelock Admin");
  }

  console.log("✅ 权限验证通过");

  // 3) 将 Content Owner 移交给 Timelock
  console.log("🔑 正在转移 KnowledgeContent 所有权给 Timelock...");
  const transferTx = await content.transferOwnership(timelockAddress);
  await transferTx.wait();
  console.log("✅ 所有权转移成功，交易哈希:", transferTx.hash);

  // 4) 将 Timelock PROPOSER_ROLE 授予 Governor
  console.log("🏛️  正在授权 Governor 为 Timelock Proposer...");
  const grantTx = await timelock.grantRole(PROPOSER_ROLE, governorAddress);
  await grantTx.wait();
  console.log("✅ 授权成功，交易哈希:", grantTx.hash);

  // 5) 撤销 Deployer 的 PROPOSER_ROLE
  console.log("🚫 正在撤销 Deployer 的 Proposer 权限...");
  const revokeTx = await timelock.revokeRole(PROPOSER_ROLE, deployer.address);
  await revokeTx.wait();
  console.log("✅ 撤销成功，交易哈希:", revokeTx.hash);

  // 6) 撤销 Deployer 的 CANCELLER_ROLE（按你要求：不授予 Governor）
  console.log("🚫 正在撤销 Deployer 的 Canceller 权限（不授予 Governor）...");
  const revokeCancelTx = await timelock.revokeRole(CANCELLER_ROLE, deployer.address);
  await revokeCancelTx.wait();
  console.log("✅ 撤销成功，交易哈希:", revokeCancelTx.hash);

  // 7) 最终去中心化：deployer 放弃 Timelock Admin
  console.log("🧨 Deployer 放弃 Timelock Admin（TIMELOCK_ADMIN_ROLE，最终去中心化）...");
  const renounceTx = await timelock.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  await renounceTx.wait();
  console.log("✅ renounce 成功:", renounceTx.hash);

  // 8) 最终验证
  const newOwner = await content.owner();
  if (newOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("❌ 最终验证失败：Content Owner 未正确更新");
  }

  const governorProposer = await timelock.hasRole(PROPOSER_ROLE, governorAddress);
  const deployerProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address);

  const deployerStillAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  const governorStillAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, governorAddress);

  const deployerCanceller = await timelock.hasRole(CANCELLER_ROLE, deployer.address);
  const governorCanceller = await timelock.hasRole(CANCELLER_ROLE, governorAddress);

  if (!governorProposer) throw new Error("❌ 验证失败：Governor 未获得 Proposer");
  if (deployerProposer) throw new Error("❌ 验证失败：Deployer 仍是 Proposer");

  if (deployerStillAdmin) throw new Error("❌ 验证失败：Deployer 仍是 TimelockAdmin（renounce 未生效）");
  if (governorStillAdmin) throw new Error("❌ 验证失败：Governor 不应是 TimelockAdmin");

  if (deployerCanceller) throw new Error("❌ 验证失败：Deployer 仍是 Canceller");
  if (governorCanceller) throw new Error("❌ 验证失败：Governor 不应是 Canceller（按当前策略）");

  console.log("✅ 所有最终验证通过");
  console.log("\n🎉 第三阶段完成：系统已完成权限移交（EOA 无后门权限）。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});