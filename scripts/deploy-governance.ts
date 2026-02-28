import { ethers } from "hardhat";

/**
 * 部署并完成 DeFi 风格治理绑定：
 * 1) RewardToken + KnowledgeContent（奖励发放业务）
 * 2) GovernanceToken（治理投票权）
 * 3) TimelockController（延迟执行）
 * 4) KnowledgeGovernor（提案/投票/计票）
 * 5) 把 KnowledgeContent.owner 转交给 Timelock（只允许 DAO 改规则）
 * 6) 配置 Timelock roles：PROPOSER_ROLE 交给 Governor；EXECUTOR_ROLE 允许所有人执行（真实常用）
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // 1) 部署 RewardToken
  const RewardToken = await ethers.getContractFactory("RewardToken");
  const rewardToken = await RewardToken.deploy();
  await rewardToken.waitForDeployment();
  console.log("RewardToken:", await rewardToken.getAddress());

  // 2) 部署 KnowledgeContent（传入奖励 Token 地址）
  const KnowledgeContent = await ethers.getContractFactory("KnowledgeContent");
  const content = await KnowledgeContent.deploy(await rewardToken.getAddress());
  await content.waitForDeployment();
  console.log("KnowledgeContent:", await content.getAddress());

  // 3) 把 RewardToken 的 owner 转移给 KnowledgeContent（业务合约负责 mint 奖励）
  await rewardToken.transferOwnership(await content.getAddress());
  console.log("RewardToken ownership -> KnowledgeContent");

  // 4) 部署 GovernanceToken（ERC20Votes）
  const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
  const govToken = await GovernanceToken.deploy();
  await govToken.waitForDeployment();
  console.log("GovernanceToken:", await govToken.getAddress());

  // 5) 部署 TimelockController
  const Timelock = await ethers.getContractFactory("TimelockController");
  
  // minDelay：建议测试网用 60s 或更短；本地测试可用 2s
  const minDelay = 60; // 秒

  // proposers 初始可先给 deployer（后面会 revoke），executors 设为 address(0) 表示任何人都能执行
  const timelock = await Timelock.deploy(
    minDelay,
    [deployer.address],                 // proposers
    [ethers.ZeroAddress],               // executors: anyone
    deployer.address                    // admin: deployer（初始化用，后续也可以交给 timelock 自己）
  );
  await timelock.waitForDeployment();
  console.log("Timelock:", await timelock.getAddress());

  // 6) 部署 Governor
  const Governor = await ethers.getContractFactory("KnowledgeGovernor");
  const governor = await Governor.deploy(await govToken.getAddress(), await timelock.getAddress());
  await governor.waitForDeployment();
  console.log("Governor:", await governor.getAddress());

  // 7) 配置 Timelock 权限：PROPOSER_ROLE 交给 Governor，并移除 deployer 的 proposer 权限
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();

  await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
  await timelock.revokeRole(PROPOSER_ROLE, deployer.address);

  console.log("Timelock PROPOSER_ROLE -> Governor");

  // 8) 把 KnowledgeContent.owner 转交给 Timelock（DAO 才能改奖励规则）
  await content.transferOwnership(await timelock.getAddress());
  console.log("KnowledgeContent ownership -> Timelock");

  console.log("\n=== Done ===");
  console.log("RewardToken:", await rewardToken.getAddress());
  console.log("KnowledgeContent:", await content.getAddress());
  console.log("GovernanceToken:", await govToken.getAddress());
  console.log("Timelock:", await timelock.getAddress());
  console.log("Governor:", await governor.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});