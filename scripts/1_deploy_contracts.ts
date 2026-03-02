import { ethers } from "hardhat";
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { DeploymentInfo } from "../types/deployment";

async function main() {
  console.log("🚀 开始部署合约...");

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log("Network:", hre.network.name);
  console.log("ChainId:", Number(net.chainId));
  console.log("Deployer:", deployer.address);

  // --- 1) NativeVotes ---
  const cooldownSeconds = 3600; // 1h（演示可改短）
  const activationBlocks = 10;  // 激活延迟（演示可改短）

  const NativeVotes = await ethers.getContractFactory("NativeVotes");
  const nativeVotes = await NativeVotes.deploy(cooldownSeconds, activationBlocks);
  await nativeVotes.waitForDeployment();
  const nativeVotesAddress = await nativeVotes.getAddress();
  console.log("✅ NativeVotes:", nativeVotesAddress);

  // --- 2) KnowledgeContent ---
  const KnowledgeContent = await ethers.getContractFactory("KnowledgeContent");
  const content = await KnowledgeContent.deploy();
  await content.waitForDeployment();
  const contentAddress = await content.getAddress();
  console.log("✅ KnowledgeContent:", contentAddress);

  // --- 3) TimelockController ---
  // executors = address(0) => anyone can execute
  const Timelock = await ethers.getContractFactory("TimelockController");
  const minDelay = 60; // Besu 联盟链演示建议 60 秒

  const timelock = await Timelock.deploy(
    minDelay,
    [deployer.address],   // proposers：初始化阶段先给 deployer，后面移交给 governor
    [ethers.ZeroAddress], // executors：0地址 => anyone can execute
    deployer.address      // admin：初始化阶段给 deployer，最终会 renounce
  );

  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("✅ TimelockController:", timelockAddress);

  // ⭐ 关键：部署后立刻验证 Timelock Admin 是否正确（OZ 4.9.x 用 TIMELOCK_ADMIN_ROLE）
  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();
  const isTimelockAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);

  console.log("Timelock TIMELOCK_ADMIN_ROLE:", TIMELOCK_ADMIN_ROLE);
  console.log("Deployer is Timelock Admin?:", isTimelockAdmin);

  if (!isTimelockAdmin) {
    // 这里直接 fail，避免你后面脚本3再炸
    throw new Error(
      [
        "❌ Timelock 部署后 deployer 不是 TIMELOCK_ADMIN_ROLE！",
        "这通常意味着：TimelockController 版本/ABI 与预期不一致，或部署到的网络/地址有误。",
        "建议：确认你使用的 @openzeppelin/contracts 版本（建议 4.9.6）并重新部署。",
      ].join("\n")
    );
  }

  // --- 4) KnowledgeGovernor ---
  const Governor = await ethers.getContractFactory("KnowledgeGovernor");
  const governor = await Governor.deploy(nativeVotesAddress, timelockAddress);
  await governor.waitForDeployment();
  const governorAddress = await governor.getAddress();
  console.log("✅ KnowledgeGovernor:", governorAddress);

  // --- 5) 写 deployments/<network>.json ---
  const deploymentInfo: DeploymentInfo = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      NativeVotes: nativeVotesAddress,
      KnowledgeContent: contentAddress,
      TimelockController: timelockAddress,
      KnowledgeGovernor: governorAddress,
    },
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filePath = path.join(deploymentsDir, `${hre.network.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2), "utf8");
  console.log(`📄 deployments/${hre.network.name}.json 已写入: ${filePath}`);

  console.log("\n🎉 第一阶段完成：所有合约已部署且 Timelock Admin 校验通过。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});