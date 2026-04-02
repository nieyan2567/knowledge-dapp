import { ethers } from "hardhat";
import * as readline from "readline";

import { loadDeployment } from "./utils/deployments";
import {
  FaucetVault,
  KnowledgeContent,
  NativeVotes,
  RevenueVault,
  TimelockController,
  TreasuryNative,
} from "../typechain-types";

async function confirmOrExit() {
  console.log("⚠️  即将执行所有权移交流程，此操作不可逆。");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise<void>((resolve) => {
    rl.question("确认继续吗？输入 y 继续: ", (answer) => {
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "") {
        console.log("已取消操作。");
        process.exit(0);
      }
      resolve();
    });
  });

  rl.close();
}

async function main() {
  await confirmOrExit();
  console.log("开始执行所有权移交流程...");

  const info = await loadDeployment();
  const nativeVotesAddress = info.contracts.NativeVotes;
  const contentAddress = info.contracts.KnowledgeContent;
  const treasuryAddress = info.contracts.TreasuryNative;
  const faucetVaultAddress = info.contracts.FaucetVault;
  const revenueVaultAddress = info.contracts.RevenueVault;
  const timelockAddress = info.contracts.TimelockController;
  const governorAddress = info.contracts.KnowledgeGovernor;

  const [deployer] = await ethers.getSigners();

  const nativeVotes = (await (await ethers.getContractFactory("NativeVotes")).attach(
    nativeVotesAddress
  )) as NativeVotes;
  const content = (await (await ethers.getContractFactory("KnowledgeContent")).attach(
    contentAddress
  )) as KnowledgeContent;
  const treasury = (await (await ethers.getContractFactory("TreasuryNative")).attach(
    treasuryAddress
  )) as TreasuryNative;
  const faucetVault = (await (await ethers.getContractFactory("FaucetVault")).attach(
    faucetVaultAddress
  )) as FaucetVault;
  const revenueVault = (await (await ethers.getContractFactory("RevenueVault")).attach(
    revenueVaultAddress
  )) as RevenueVault;
  const timelock = (await (await ethers.getContractFactory("TimelockController")).attach(
    timelockAddress
  )) as TimelockController;

  const nativeVotesOwner = await nativeVotes.owner();
  const contentOwner = await content.owner();
  const treasuryOwner = await treasury.owner();
  const faucetVaultOwner = await faucetVault.owner();
  const revenueVaultOwner = await revenueVault.owner();

  console.log("NativeVotes 当前 owner:", nativeVotesOwner);
  console.log("KnowledgeContent 当前 owner:", contentOwner);
  console.log("TreasuryNative 当前 owner:", treasuryOwner);
  console.log("FaucetVault 当前 owner:", faucetVaultOwner);
  console.log("RevenueVault 当前 owner:", revenueVaultOwner);
  console.log("当前部署账户:", deployer.address);

  if (nativeVotesOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`移交前 NativeVotes owner 校验失败，当前 owner: ${nativeVotesOwner}`);
  }
  if (contentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`移交前 KnowledgeContent owner 校验失败，当前 owner: ${contentOwner}`);
  }
  if (treasuryOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`移交前 TreasuryNative owner 校验失败，当前 owner: ${treasuryOwner}`);
  }
  if (faucetVaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`移交前 FaucetVault owner 校验失败，当前 owner: ${faucetVaultOwner}`);
  }
  if (revenueVaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`移交前 RevenueVault owner 校验失败，当前 owner: ${revenueVaultOwner}`);
  }

  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  const isTimelockAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  console.log("Timelock 地址:", timelockAddress);
  console.log("当前部署账户是否为 Timelock admin:", isTimelockAdmin);

  if (!isTimelockAdmin) {
    throw new Error(
      [
        "当前签名账户不是 Timelock admin。",
        "如果 admin 已经执行过 renounce，则需要重新部署整套系统。",
      ].join(" ")
    );
  }

  const governorIsAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, governorAddress);
  if (governorIsAdmin) {
    throw new Error("权限校验失败：Governor 不应持有 Timelock admin 角色");
  }

  console.log("所有权移交前校验通过。");

  const nativeVotesTx = await nativeVotes.transferOwnership(timelockAddress);
  await nativeVotesTx.wait();
  console.log("NativeVotes 所有权已转移，交易哈希:", nativeVotesTx.hash);

  const contentTx = await content.transferOwnership(timelockAddress);
  await contentTx.wait();
  console.log("KnowledgeContent 所有权已转移，交易哈希:", contentTx.hash);

  const treasuryTx = await treasury.transferOwnership(timelockAddress);
  await treasuryTx.wait();
  console.log("TreasuryNative 所有权已转移，交易哈希:", treasuryTx.hash);

  const faucetVaultTx = await faucetVault.transferOwnership(timelockAddress);
  await faucetVaultTx.wait();
  console.log("FaucetVault 所有权已转移，交易哈希:", faucetVaultTx.hash);

  const revenueVaultTx = await revenueVault.transferOwnership(timelockAddress);
  await revenueVaultTx.wait();
  console.log("RevenueVault 所有权已转移，交易哈希:", revenueVaultTx.hash);

  const grantTx = await timelock.grantRole(PROPOSER_ROLE, governorAddress);
  await grantTx.wait();
  console.log("已向 Governor 授予 Timelock proposer 角色，交易哈希:", grantTx.hash);

  const revokeProposerTx = await timelock.revokeRole(PROPOSER_ROLE, deployer.address);
  await revokeProposerTx.wait();
  console.log("已撤销部署账户的 proposer 角色，交易哈希:", revokeProposerTx.hash);

  const revokeCancellerTx = await timelock.revokeRole(CANCELLER_ROLE, deployer.address);
  await revokeCancellerTx.wait();
  console.log("已撤销部署账户的 canceller 角色，交易哈希:", revokeCancellerTx.hash);

  const renounceTx = await timelock.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  await renounceTx.wait();
  console.log("部署账户已放弃 Timelock admin 角色，交易哈希:", renounceTx.hash);

  const newNativeVotesOwner = await nativeVotes.owner();
  const newContentOwner = await content.owner();
  const newTreasuryOwner = await treasury.owner();
  const newFaucetVaultOwner = await faucetVault.owner();
  const newRevenueVaultOwner = await revenueVault.owner();

  if (newNativeVotesOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("最终校验失败：NativeVotes owner 未转移到 Timelock");
  }
  if (newContentOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("最终校验失败：KnowledgeContent owner 未转移到 Timelock");
  }
  if (newTreasuryOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("最终校验失败：TreasuryNative owner 未转移到 Timelock");
  }
  if (newFaucetVaultOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("最终校验失败：FaucetVault owner 未转移到 Timelock");
  }
  if (newRevenueVaultOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("最终校验失败：RevenueVault owner 未转移到 Timelock");
  }

  const governorProposer = await timelock.hasRole(PROPOSER_ROLE, governorAddress);
  const deployerProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address);
  const deployerStillAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  const governorStillAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, governorAddress);
  const deployerCanceller = await timelock.hasRole(CANCELLER_ROLE, deployer.address);
  const governorCanceller = await timelock.hasRole(CANCELLER_ROLE, governorAddress);

  if (!governorProposer) throw new Error("最终校验失败：Governor 未获得 proposer 角色");
  if (deployerProposer) throw new Error("最终校验失败：部署账户仍然持有 proposer 角色");
  if (deployerStillAdmin) throw new Error("最终校验失败：部署账户仍然持有 Timelock admin 角色");
  if (governorStillAdmin) throw new Error("最终校验失败：Governor 不应持有 Timelock admin 角色");
  if (deployerCanceller) throw new Error("最终校验失败：部署账户仍然持有 canceller 角色");
  if (governorCanceller) throw new Error("最终校验失败：Governor 不应持有 canceller 角色");

  console.log("所有所有权与角色校验均已通过。");
  console.log(
    "NativeVotes / KnowledgeContent / TreasuryNative / FaucetVault / RevenueVault 已全部移交给 Timelock。"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
