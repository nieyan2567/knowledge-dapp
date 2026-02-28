import { ethers } from "hardhat";

/**
 * 部署“原生币统一”版本：
 * - NativeVotes：质押原生币产生投票权
 * - KnowledgeContent：奖励发原生币（奖励池预存）
 * - TimelockController：延迟执行
 * - KnowledgeGovernor：治理执行入口（token=NativeVotes）
 *
 * 绑定关系：
 * - Timelock PROPOSER_ROLE -> Governor
 * - KnowledgeContent owner -> Timelock（只有 DAO 能改奖励规则）
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // 1) NativeVotes
  const NativeVotes = await ethers.getContractFactory("NativeVotes");
  const nativeVotes = await NativeVotes.deploy();
  await nativeVotes.waitForDeployment();
  console.log("NativeVotes:", await nativeVotes.getAddress());

  // 2) KnowledgeContent（无需传 token）
  const KnowledgeContent = await ethers.getContractFactory("KnowledgeContent");
  const content = await KnowledgeContent.deploy();
  await content.waitForDeployment();
  console.log("KnowledgeContent:", await content.getAddress());

  // 3) Timelock
  const Timelock = await ethers.getContractFactory("TimelockController");
  const minDelay = 60; // 联盟链演示建议 60 秒；本地可改 2 秒
  const timelock = await Timelock.deploy(
    minDelay,
    [deployer.address],
    [ethers.ZeroAddress],
    deployer.address
  );
  await timelock.waitForDeployment();
  console.log("Timelock:", await timelock.getAddress());

  // 4) Governor（token=NativeVotes）
  const Governor = await ethers.getContractFactory("KnowledgeGovernor");
  const governor = await Governor.deploy(
    await nativeVotes.getAddress(),
    await timelock.getAddress()
  );
  await governor.waitForDeployment();
  console.log("Governor:", await governor.getAddress());

  // 5) Timelock proposer -> Governor；移除 deployer proposer
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
  await timelock.revokeRole(PROPOSER_ROLE, deployer.address);
  console.log("Timelock PROPOSER_ROLE -> Governor");

  // 6) KnowledgeContent owner -> Timelock
  await content.transferOwnership(await timelock.getAddress());
  console.log("KnowledgeContent ownership -> Timelock");

  // 7) 给 KnowledgeContent 预存一点奖励池（可选）
  // 例如存 5 个原生币，用于后续 distributeReward 测试/演示
  const fundTx = await deployer.sendTransaction({
    to: await content.getAddress(),
    value: ethers.parseEther("5"),
  });
  await fundTx.wait();
  console.log("Funded KnowledgeContent with 5 native coins.");

  console.log("\nDONE.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});