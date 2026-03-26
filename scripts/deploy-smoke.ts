import { ethers } from "hardhat";

/**
 * DEPRECATED
 * 该脚本依赖旧版 RewardToken 合约，已不适用于当前项目。
 * 请勿继续使用。
 *
 * 如需验证当前系统，请使用：
 * - scripts/1_deploy_contracts.ts
 * - scripts/4_verify_system.ts
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deployer:", deployer.address);
  console.log("Balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  const RewardToken = await ethers.getContractFactory("RewardToken");
  const rewardToken = await RewardToken.deploy();
  await rewardToken.waitForDeployment();

  console.log("RewardToken deployed to:", await rewardToken.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
