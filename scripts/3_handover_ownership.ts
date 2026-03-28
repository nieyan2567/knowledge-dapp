import { ethers } from "hardhat";
import * as readline from "readline";

import { loadDeployment } from "./utils/deployments";
import {
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
  const revenueVault = (await (await ethers.getContractFactory("RevenueVault")).attach(
    revenueVaultAddress
  )) as RevenueVault;
  const timelock = (await (await ethers.getContractFactory("TimelockController")).attach(
    timelockAddress
  )) as TimelockController;

  const nativeVotesOwner = await nativeVotes.owner();
  const contentOwner = await content.owner();
  const treasuryOwner = await treasury.owner();
  const revenueVaultOwner = await revenueVault.owner();

  console.log("NativeVotes owner:", nativeVotesOwner);
  console.log("KnowledgeContent owner:", contentOwner);
  console.log("TreasuryNative owner:", treasuryOwner);
  console.log("RevenueVault owner:", revenueVaultOwner);
  console.log("Current deployer:", deployer.address);

  if (nativeVotesOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`NativeVotes owner mismatch before handover: ${nativeVotesOwner}`);
  }
  if (contentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Content owner mismatch before handover: ${contentOwner}`);
  }
  if (treasuryOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Treasury owner mismatch before handover: ${treasuryOwner}`);
  }
  if (revenueVaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`RevenueVault owner mismatch before handover: ${revenueVaultOwner}`);
  }

  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  const isTimelockAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  console.log("Timelock:", timelockAddress);
  console.log("Deployer is Timelock admin:", isTimelockAdmin);

  if (!isTimelockAdmin) {
    throw new Error(
      [
        "Current signer is not Timelock admin.",
        "If admin has already been renounced, you need to redeploy the system.",
      ].join(" ")
    );
  }

  const governorIsAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, governorAddress);
  if (governorIsAdmin) {
    throw new Error("Governor should not hold Timelock admin role");
  }

  console.log("Ownership pre-check passed.");

  const nativeVotesTx = await nativeVotes.transferOwnership(timelockAddress);
  await nativeVotesTx.wait();
  console.log("NativeVotes ownership transferred:", nativeVotesTx.hash);

  const contentTx = await content.transferOwnership(timelockAddress);
  await contentTx.wait();
  console.log("KnowledgeContent ownership transferred:", contentTx.hash);

  const treasuryTx = await treasury.transferOwnership(timelockAddress);
  await treasuryTx.wait();
  console.log("TreasuryNative ownership transferred:", treasuryTx.hash);

  const revenueVaultTx = await revenueVault.transferOwnership(timelockAddress);
  await revenueVaultTx.wait();
  console.log("RevenueVault ownership transferred:", revenueVaultTx.hash);

  const grantTx = await timelock.grantRole(PROPOSER_ROLE, governorAddress);
  await grantTx.wait();
  console.log("Granted Timelock proposer role to Governor:", grantTx.hash);

  const revokeProposerTx = await timelock.revokeRole(PROPOSER_ROLE, deployer.address);
  await revokeProposerTx.wait();
  console.log("Revoked proposer role from deployer:", revokeProposerTx.hash);

  const revokeCancellerTx = await timelock.revokeRole(CANCELLER_ROLE, deployer.address);
  await revokeCancellerTx.wait();
  console.log("Revoked canceller role from deployer:", revokeCancellerTx.hash);

  const renounceTx = await timelock.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  await renounceTx.wait();
  console.log("Deployer renounced Timelock admin:", renounceTx.hash);

  const newNativeVotesOwner = await nativeVotes.owner();
  const newContentOwner = await content.owner();
  const newTreasuryOwner = await treasury.owner();
  const newRevenueVaultOwner = await revenueVault.owner();

  if (newNativeVotesOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("NativeVotes owner was not transferred to Timelock");
  }
  if (newContentOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("KnowledgeContent owner was not transferred to Timelock");
  }
  if (newTreasuryOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("TreasuryNative owner was not transferred to Timelock");
  }
  if (newRevenueVaultOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error("RevenueVault owner was not transferred to Timelock");
  }

  const governorProposer = await timelock.hasRole(PROPOSER_ROLE, governorAddress);
  const deployerProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address);
  const deployerStillAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  const governorStillAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, governorAddress);
  const deployerCanceller = await timelock.hasRole(CANCELLER_ROLE, deployer.address);
  const governorCanceller = await timelock.hasRole(CANCELLER_ROLE, governorAddress);

  if (!governorProposer) throw new Error("Governor did not receive proposer role");
  if (deployerProposer) throw new Error("Deployer still has proposer role");
  if (deployerStillAdmin) throw new Error("Deployer still has Timelock admin role");
  if (governorStillAdmin) throw new Error("Governor should not have Timelock admin role");
  if (deployerCanceller) throw new Error("Deployer still has canceller role");
  if (governorCanceller) throw new Error("Governor should not have canceller role");

  console.log("All ownership and role checks passed.");
  console.log(
    "NativeVotes / KnowledgeContent / TreasuryNative / RevenueVault have been handed over to Timelock."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
