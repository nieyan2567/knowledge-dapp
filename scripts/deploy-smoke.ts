import { ethers } from "hardhat";

/**
 * 最小部署验证：
 * - 读取部署者余额
 * - 部署 RewardToken
 * - 输出合约地址与交易 hash
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