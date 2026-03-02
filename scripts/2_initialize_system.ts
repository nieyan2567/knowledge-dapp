import { ethers } from "hardhat";
import { loadDeployment } from "./utils/deployments";
import { KnowledgeContent, TreasuryNative } from "../typechain-types"; // 确保运行过 npx hardhat compile 生成类型

async function main() {
  console.log("🔧 开始初始化系统...");

  const info = await loadDeployment();

  const contentAddress = info.contracts.KnowledgeContent;
  const nativeVotesAddress = info.contracts.NativeVotes;
  const timelockAddress = info.contracts.TimelockController;
  const treasuryAddress = info.contracts.TreasuryNative;

  const [deployer] = await ethers.getSigners();
  
  // 获取合约实例 (带类型)
  const ContentFactory = await ethers.getContractFactory("KnowledgeContent");
  const content = ContentFactory.attach(contentAddress) as KnowledgeContent;

  const TreasuryFactory = await ethers.getContractFactory("TreasuryNative");
  const treasury = TreasuryFactory.attach(treasuryAddress) as TreasuryNative;

  // 1. 验证owner权限
  const contentOwner = await content.owner();
  const treasuryOwner = await treasury.owner();

  console.log("Content Owner:", contentOwner);
  console.log("Treasury Owner:", treasuryOwner);
  console.log("当前脚本运行者:", deployer.address);

  // 如果 owner 已经是 timelock，说明跑过3了
  if (contentOwner.toLowerCase() === timelockAddress.toLowerCase()) {
    throw new Error(
      [
        "❌ 当前 KnowledgeContent 的 Owner 已经是 Timelock，说明你已执行过脚本3。",
        "脚本2（充值 + 绑定 Treasury + setAntiSybil）必须在脚本3之前运行。",
      ].join("\n")
    );
  }
  if (treasuryOwner.toLowerCase() === timelockAddress.toLowerCase()) {
    throw new Error(
      [
        "❌ 当前 Treasury 的 Owner 已经是 Timelock，说明你已执行过脚本3。",
        "脚本2 必须在脚本3之前运行。",
      ].join("\n")
    );
  }

  if (contentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`❌ 当前 signer 不是 Content Owner（当前 Owner: ${contentOwner}）`);
  }
  if (treasuryOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`❌ 当前 signer 不是 Treasury Owner（当前 Owner: ${treasuryOwner}）`);
  }

  console.log("✅ owner 权限验证通过（Content/Treasury）");

  // const code = await ethers.provider.getCode(contentAddress);
  // console.log("Content code length:", code.length);

  // 2. 充值Treasury (5 ETH)
  console.log("💰 正在向 Treasury 充值 5 ETH...");

  const targetBalance = ethers.parseEther("5");
  const currentBalance = await ethers.provider.getBalance(treasuryAddress);

  console.log("Treasury 当前余额:", ethers.formatEther(currentBalance), "ETH");

  if (currentBalance < targetBalance) {
    const need = targetBalance - currentBalance;
    console.log(`💰 正在向 Treasury 补齐余额：${ethers.formatEther(need)} ETH...`);

    const fundTx = await deployer.sendTransaction({
      to: treasuryAddress,
      value: need,
    });
    await fundTx.wait();
    console.log("✅ Treasury 充值成功，交易哈希:", fundTx.hash);
  } else {
    console.log("✅ 跳过充值：Treasury 余额已达到/超过 5 ETH");
  }

  // 3. setAntiSybil （Content）
  const minStakeToVote = ethers.parseEther("1");
  const storedVotesContract = await content.votesContract();
  const storedMinStake = await content.minStakeToVote();

  const needAntiSybil =
    storedVotesContract.toLowerCase() !== nativeVotesAddress.toLowerCase() ||
    storedMinStake !== minStakeToVote;

  if (needAntiSybil) {
    console.log(
      `🛡️ 设置 AntiSybil: votesContract=${nativeVotesAddress}, minStake=${ethers.formatEther(minStakeToVote)} ETH...`
    );
    const tx = await content.setAntiSybil(nativeVotesAddress, minStakeToVote);
    await tx.wait();
    console.log("✅ setAntiSybil 成功，交易哈希:", tx.hash);
  } else {
    console.log("✅ 跳过 setAntiSybil：链上已是目标配置");
  }

  // 4. setTreasury （Content）
  // KnowledgeContent 需要有 setTreasury(address)
  let needSetTreasury = true;
  try {
    const currentTreasury = await content.treasury(); // 需要 public treasury
    needSetTreasury = currentTreasury.toLowerCase() !== treasuryAddress.toLowerCase();
    console.log("Content 当前 Treasury:", currentTreasury);
  } catch {
    // 如果你没把 treasury 设成 public 变量，这里会失败
    // 你也可以删掉这个 try/catch，直接每次 setTreasury（幂等性由合约内部保证）
    console.log("⚠️ 无法读取 content.treasury()，将直接尝试 setTreasury...");
    needSetTreasury = true;
  }

  if (needSetTreasury) {
    console.log(`🏦 绑定 Treasury 到 Content: ${treasuryAddress}`);
    const tx = await content.setTreasury(treasuryAddress);
    await tx.wait();
    console.log("✅ setTreasury 成功，tx:", tx.hash);
  } else {
    console.log("✅ 跳过 setTreasury：已绑定目标 Treasury");
  }

  // 5. treasury.setSpender(content, true)
  const isSpender = await treasury.isSpender(contentAddress);
  if (!isSpender) {
    console.log(`🔐 授权 Content 作为 Treasury 的 spender...`);
    const tx = await treasury.setSpender(contentAddress, true);
    await tx.wait();
    console.log("✅ setSpender 成功，交易哈希:", tx.hash);
  } else {
    console.log("✅ 跳过 setSpender：Content 已是 Spender");
  }

  console.log("\n🎉 第二阶段完成：Treasury 已充值，Content 已绑定 Treasury + AntiSybil 配置完成。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});