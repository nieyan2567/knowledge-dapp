import { ethers } from "hardhat";
import { loadDeployment } from "./utils/deployments";
import {
  KnowledgeContent,
  RevenueVault,
  TreasuryNative,
} from "../typechain-types";

async function main() {
  console.log("Initializing deployed system...");

  const info = await loadDeployment();
  const contentAddress = info.contracts.KnowledgeContent;
  const nativeVotesAddress = info.contracts.NativeVotes;
  const timelockAddress = info.contracts.TimelockController;
  const treasuryAddress = info.contracts.TreasuryNative;
  const revenueVaultAddress = info.contracts.RevenueVault;
  const faucetWallet = process.env.FAUCET_WALLET;

  const [deployer] = await ethers.getSigners();

  if (!faucetWallet) {
    throw new Error("FAUCET_WALLET is not set in .env");
  }

  const ContentFactory = await ethers.getContractFactory("KnowledgeContent");
  const content = ContentFactory.attach(contentAddress) as KnowledgeContent;

  const TreasuryFactory = await ethers.getContractFactory("TreasuryNative");
  const treasury = TreasuryFactory.attach(treasuryAddress) as TreasuryNative;

  const RevenueVaultFactory = await ethers.getContractFactory("RevenueVault");
  const revenueVault = RevenueVaultFactory.attach(revenueVaultAddress) as RevenueVault;

  const contentOwner = await content.owner();
  const treasuryOwner = await treasury.owner();
  const revenueVaultOwner = await revenueVault.owner();

  if (contentOwner.toLowerCase() === timelockAddress.toLowerCase()) {
    throw new Error("KnowledgeContent owner is already the Timelock; run this script before handover");
  }
  if (treasuryOwner.toLowerCase() === timelockAddress.toLowerCase()) {
    throw new Error("Treasury owner is already the Timelock; run this script before handover");
  }
  if (revenueVaultOwner.toLowerCase() === timelockAddress.toLowerCase()) {
    throw new Error("RevenueVault owner is already the Timelock; run this script before handover");
  }

  if (contentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Current signer is not the KnowledgeContent owner (${contentOwner})`);
  }
  if (treasuryOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Current signer is not the Treasury owner (${treasuryOwner})`);
  }
  if (revenueVaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Current signer is not the RevenueVault owner (${revenueVaultOwner})`);
  }

  const treasuryTargetBalance = ethers.parseEther("5");
  const treasuryBalance = await ethers.provider.getBalance(treasuryAddress);
  if (treasuryBalance < treasuryTargetBalance) {
    const required = treasuryTargetBalance - treasuryBalance;
    const fundTreasuryTx = await deployer.sendTransaction({
      to: treasuryAddress,
      value: required,
    });
    await fundTreasuryTx.wait();
    console.log("Treasury topped up:", fundTreasuryTx.hash);
  }

  const faucetTargetBalance = ethers.parseEther("50");
  const faucetBalance = await ethers.provider.getBalance(faucetWallet);
  if (faucetBalance < faucetTargetBalance) {
    const required = faucetTargetBalance - faucetBalance;
    const fundFaucetTx = await deployer.sendTransaction({
      to: faucetWallet,
      value: required,
    });
    await fundFaucetTx.wait();
    console.log("Faucet topped up:", fundFaucetTx.hash);
  }

  const minStakeToVote = ethers.parseEther("1");
  const currentVotesContract = await content.votesContract();
  const currentMinStakeToVote = await content.minStakeToVote();
  if (
    currentVotesContract.toLowerCase() !== nativeVotesAddress.toLowerCase() ||
    currentMinStakeToVote !== minStakeToVote
  ) {
    const antiSybilTx = await content.setAntiSybil(nativeVotesAddress, minStakeToVote);
    await antiSybilTx.wait();
    console.log("Anti-sybil settings updated:", antiSybilTx.hash);
  }

  const currentTreasury = await content.treasury();
  if (currentTreasury.toLowerCase() !== treasuryAddress.toLowerCase()) {
    const setTreasuryTx = await content.setTreasury(treasuryAddress);
    await setTreasuryTx.wait();
    console.log("Content treasury updated:", setTreasuryTx.hash);
  }

  const currentRevenueVault = await content.revenueVault();
  if (currentRevenueVault.toLowerCase() !== revenueVaultAddress.toLowerCase()) {
    const setRevenueVaultTx = await content.setRevenueVault(revenueVaultAddress);
    await setRevenueVaultTx.wait();
    console.log("Content revenue vault updated:", setRevenueVaultTx.hash);
  }

  const registerFee = ethers.parseEther("0.01");
  const updateFee = ethers.parseEther("0.005");
  if ((await content.registerFee()) !== registerFee || (await content.updateFee()) !== updateFee) {
    const setFeesTx = await content.setContentFees(registerFee, updateFee);
    await setFeesTx.wait();
    console.log("Content fees updated:", setFeesTx.hash);
  }

  const isSpender = await treasury.isSpender(contentAddress);
  if (!isSpender) {
    const setSpenderTx = await treasury.setSpender(contentAddress, true);
    await setSpenderTx.wait();
    console.log("Treasury spender updated:", setSpenderTx.hash);
  }

  console.log("Initialization complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
