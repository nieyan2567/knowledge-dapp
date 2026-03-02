import * as fs from "fs";
import * as path from "path";
import hre from "hardhat";
import { ethers } from "hardhat";
import { DeploymentInfo } from "../../types/deployment";

export async function loadDeployment(): Promise<DeploymentInfo> {
  const filePath = path.join(__dirname, `../../deployments/${hre.network.name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`❌ 未找到部署文件: ${filePath}（请先运行脚本1部署）`);
  }

  const info: DeploymentInfo = JSON.parse(fs.readFileSync(filePath, "utf8"));

  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== info.chainId) {
    throw new Error(
      `❌ 当前链ID(${Number(net.chainId)}) 与部署文件chainId(${info.chainId})不一致（可能你重置链后没重新部署）`
    );
  }

  return info;
}

export function deploymentsPathForNetwork(networkName: string): string {
    return path.join(__dirname, `../../deployments/${networkName}.json`);
}