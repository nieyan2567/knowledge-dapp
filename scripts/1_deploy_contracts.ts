import { ethers } from "hardhat";
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { DeploymentInfo } from "../types/deployment";

async function main() {
  console.log("Starting contract deployment...");

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log("Network:", hre.network.name);
  console.log("ChainId:", Number(net.chainId));
  console.log("Deployer:", deployer.address);

  const cooldownSeconds = 3600;
  const activationBlocks = 10;

  console.log("Deploying NativeVotes...");
  const NativeVotes = await ethers.getContractFactory("NativeVotes");
  const nativeVotes = await NativeVotes.deploy(cooldownSeconds, activationBlocks);
  await nativeVotes.waitForDeployment();
  const nativeVotesAddress = await nativeVotes.getAddress();
  console.log("NativeVotes:", nativeVotesAddress);

  console.log("Deploying KnowledgeContent...");
  const KnowledgeContentFactory = await ethers.getContractFactory("KnowledgeContent");
  const content = await KnowledgeContentFactory.deploy();
  await content.waitForDeployment();
  const contentAddress = await content.getAddress();
  console.log("KnowledgeContent:", contentAddress);

  console.log("Deploying TreasuryNative...");
  const epochDuration = 7 * 24 * 3600;
  const epochBudget = ethers.parseEther("100");
  const Treasury = await ethers.getContractFactory("TreasuryNative");
  const treasury = await Treasury.deploy(epochDuration, epochBudget);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log("TreasuryNative:", treasuryAddress);

  console.log("Deploying FaucetVault...");
  const faucetSigner = process.env.FAUCET_AUTH_SIGNER_ADDRESS;
  if (!faucetSigner) {
    throw new Error("FAUCET_AUTH_SIGNER_ADDRESS is not set in .env");
  }

  const faucetClaimAmount = ethers.parseEther("2");
  const faucetMinAllowedBalance = ethers.parseEther("1");
  const faucetClaimCooldown = 24 * 3600;
  const faucetEpochDuration = 24 * 3600;
  const faucetEpochBudget = ethers.parseEther("20");

  const FaucetVault = await ethers.getContractFactory("FaucetVault");
  const faucetVault = await FaucetVault.deploy(
    faucetSigner,
    faucetClaimAmount,
    faucetMinAllowedBalance,
    faucetClaimCooldown,
    faucetEpochDuration,
    faucetEpochBudget
  );
  await faucetVault.waitForDeployment();
  const faucetVaultAddress = await faucetVault.getAddress();
  console.log("FaucetVault:", faucetVaultAddress);

  console.log("Deploying RevenueVault...");
  const faucetShareBps = 3000;
  const minFaucetPayout = ethers.parseEther("0.5");
  const refillThreshold = ethers.parseEther("2");
  const targetTreasuryBalance = ethers.parseEther("5");
  const minRefillAmount = ethers.parseEther("1");
  const refillCooldown = 3600;

  const RevenueVault = await ethers.getContractFactory("RevenueVault");
  const revenueVault = await RevenueVault.deploy(
    treasuryAddress,
    faucetVaultAddress,
    faucetShareBps,
    minFaucetPayout,
    refillThreshold,
    targetTreasuryBalance,
    minRefillAmount,
    refillCooldown
  );
  await revenueVault.waitForDeployment();
  const revenueVaultAddress = await revenueVault.getAddress();
  console.log("RevenueVault:", revenueVaultAddress);

  const Timelock = await ethers.getContractFactory("TimelockController");
  const minDelay = 60;
  const timelock = await Timelock.deploy(
    minDelay,
    [deployer.address],
    [ethers.ZeroAddress],
    deployer.address
  );
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("TimelockController:", timelockAddress);

  const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();
  const isTimelockAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  if (!isTimelockAdmin) {
    throw new Error("Deployer is not the initial Timelock admin");
  }

  console.log("Deploying KnowledgeGovernor...");
  const proposalFee = ethers.parseEther("0.05");
  const Governor = await ethers.getContractFactory("KnowledgeGovernor");
  const governor = await Governor.deploy(
    nativeVotesAddress,
    timelockAddress,
    revenueVaultAddress,
    proposalFee
  );
  await governor.waitForDeployment();
  const governorAddress = await governor.getAddress();
  console.log("KnowledgeGovernor:", governorAddress);

  const deploymentInfo: DeploymentInfo = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      NativeVotes: nativeVotesAddress,
      KnowledgeContent: contentAddress,
      TreasuryNative: treasuryAddress,
      FaucetVault: faucetVaultAddress,
      RevenueVault: revenueVaultAddress,
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
  console.log(`Saved deployment to ${filePath}`);

  console.log("Deployment complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
