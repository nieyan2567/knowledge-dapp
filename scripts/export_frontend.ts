import fs from "fs";
import path from "path";

const FRONTEND_CONTRACTS_DIR = "../knowledge-dapp-ui/src/contracts";
const FRONTEND_ABI_DIR = "../knowledge-dapp-ui/src/contracts/abi";

const DEPLOYMENTS_DIR = "./deployments";

const LOCAL_CONTRACTS = [
  "NativeVotes",
  "KnowledgeContent",
  "TreasuryNative",
  "KnowledgeGovernor",
];

const OZ_CONTRACTS = [
  {
    name: "TimelockController",
    path: "./artifacts/@openzeppelin/contracts/governance/TimelockController.sol/TimelockController.json",
  },
];

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyDeployment() {
  const src = path.join(DEPLOYMENTS_DIR, "consortium.json");
  const dst = path.join(FRONTEND_CONTRACTS_DIR, "deployment.json");

  if (!fs.existsSync(src)) {
    throw new Error(`❌ deployment.json 不存在：${src}`);
  }
  fs.copyFileSync(src, dst);
  console.log("✅ deployment.json 已复制到前端");
}

function copyLocalAbi(contractName: string) {
  const artifactPath = path.join(
    "./artifacts/contracts",
    contractName + ".sol",
    contractName + ".json"
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error(`❌ 找不到 artifact: ${artifactPath}`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const dst = path.join(FRONTEND_ABI_DIR, `${contractName}.json`);

  fs.writeFileSync(dst, JSON.stringify({ abi: artifact.abi }, null, 2));

  console.log(`✅ ABI 导出: ${contractName}`);
}

function copyOZAbi(contract: { name: string; path: string }) {
  if (!fs.existsSync(contract.path)) {
    throw new Error(`❌ 找不到 OZ artifact: ${contract.path}`);
  }

  const artifact = JSON.parse(fs.readFileSync(contract.path, "utf8"));

  const dst = path.join(FRONTEND_ABI_DIR, `${contract.name}.json`);

  fs.writeFileSync(dst, JSON.stringify({ abi: artifact.abi }, null, 2));

  console.log(`✅ ABI 导出: ${contract.name}`);
}

async function main() {
  console.log("🚀 导出前端合约信息...\n");

  ensureDir(FRONTEND_CONTRACTS_DIR);
  ensureDir(FRONTEND_ABI_DIR);

  copyDeployment();

  console.log("\n📦 导出本地合约 ABI:");
  for (const contract of LOCAL_CONTRACTS) {
    copyLocalAbi(contract);
  }

  console.log("\n📦 导出 OpenZeppelin ABI:");
  for (const contract of OZ_CONTRACTS) {
    copyOZAbi(contract);
  }

  console.log("\n🎉 前端 ABI 和地址同步完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});