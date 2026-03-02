import { ethers } from "hardhat";
import { loadDeployment } from "./utils/deployments";
import { KnowledgeContent } from "../typechain-types"; // 确保运行过 npx hardhat compile 生成类型

async function main() {
  console.log("🔧 开始初始化 KnowledgeContent...");

  const info = await loadDeployment();

  const contentAddress = info.contracts.KnowledgeContent;
  const nativeVotesAddress = info.contracts.NativeVotes;
  const timelockAddress = info.contracts.TimelockController;

  const [deployer] = await ethers.getSigners();
  
  // 获取合约实例 (带类型)
  const ContentFactory = await ethers.getContractFactory("KnowledgeContent");
  const content = ContentFactory.attach(contentAddress) as KnowledgeContent;

  // 1. 验证owner权限
  const currentOwner = await content.owner();
  console.log("Current 当前 Owner:", currentOwner);
  console.log("当前脚本运行者:", deployer.address);

  if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    // 如果 owner 已经是 timelock，说明你跑晚了
    if (currentOwner.toLowerCase() === timelockAddress.toLowerCase()) {
      throw new Error(
        [
          "❌ 当前 KnowledgeContent 的 Owner 已经是 Timelock，说明你已执行过脚本3的 transferOwnership。",
          "脚本2（充值 + setAntiSybil）必须在脚本3之前运行。",
          "如果你现在仍想修改参数，需要走 Governor 提案 -> Timelock queue/execute 的治理流程。",
        ].join("\n")
      );
    }
    throw new Error(`❌ 错误：当前 signer ${deployer.address} 不是 Content 的 Owner (当前 Owner: ${currentOwner})`);
  }
  console.log("✅ 权限验证通过：当前 signer 是 Content 的 Owner");

  const code = await ethers.provider.getCode(contentAddress);
  console.log("Content code length:", code.length);

  // 2. 充值奖励池 (5 ETH)
  console.log("💰 正在向 KnowledgeContent 充值 5 ETH...");

  const targetBalance = ethers.parseEther("5");
  const currentBalance = await ethers.provider.getBalance(contentAddress);

  console.log("KnowledgeContent 当前余额:", ethers.formatEther(currentBalance), "ETH");

  if (currentBalance < targetBalance) {
    const need = targetBalance - currentBalance;
    console.log(`💰 正在向 KnowledgeContent 补齐余额：${ethers.formatEther(need)} ETH...`);

    const fundTx = await deployer.sendTransaction({
      to: contentAddress,
      value: need,
    });
    await fundTx.wait();
    console.log("✅ 充值成功，交易哈希:", fundTx.hash);
  } else {
    console.log("✅ 跳过充值：合约余额已达到/超过 5 ETH");
  }

  // 3. 设置 AntiSybil
  const minStakeToVote = ethers.parseEther("1");
  const storedVotesContract = await content.votesContract();
  const storedMinStake = await content.minStakeToVote();

  const needSet =
    storedVotesContract.toLowerCase() !== nativeVotesAddress.toLowerCase() ||
    storedMinStake !== minStakeToVote;

  if (needSet) {
    console.log(
      `🛡️  正在设置 AntiSybil: votesContract=${nativeVotesAddress}, minStake=${ethers.formatEther(minStakeToVote)} ETH...`
    );
    const tx = await content.setAntiSybil(nativeVotesAddress, minStakeToVote);
    await tx.wait();
    console.log("✅ AntiSybil 设置成功，交易哈希:", tx.hash);
  } else {
    console.log("✅ 跳过 setAntiSybil：链上已是目标配置");
  }

  // 4. 链上验证（再读一次确认）
  const storedVotesContractSecond = await content.votesContract();
  const storedMinStakeSecond = await content.minStakeToVote();
  
  if (storedVotesContractSecond.toLowerCase() !== nativeVotesAddress.toLowerCase()) {
    throw new Error("❌ 验证失败：votesContract 地址不匹配");
  }
  if (storedMinStakeSecond !== minStakeToVote) {
    throw new Error("❌ 验证失败：minStakeToVote 数值不匹配");
  }
  
  console.log("✅ 链上验证通过：AntiSybil 配置正确");
  console.log("\n🎉 第二阶段完成：Content 已初始化并充值。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});