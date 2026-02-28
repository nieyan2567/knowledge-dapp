import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@typechain/hardhat";

import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      }
    ],
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },

  networks: {
    consortium: {
      url: process.env.BESU_RPC_URL || "http://127.0.0.1:8545",
      chainId: Number(process.env.BESU_CHAIN_ID || "20260"),
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },

};

export default config;
