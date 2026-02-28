# 基于区块链的去中心化知识协作与激励系统

当前仓库已初始化为多模块结构：

- `contracts/`：Solidity + Hardhat
- `backend/`：Spring Boot + Web3j + MySQL
- `frontend/`：Vue3 + Web3.js
- `infra/`：MySQL + IPFS 本地开发依赖

## 1. 目录结构

```text
knowledge-dapp/
├─ contracts/
├─ backend/
├─ frontend/
└─ infra/
```

## 2. 快速开始（建议顺序）

1. 启动基础依赖（MySQL + IPFS）
2. 启动本地链与部署合约（Hardhat）
3. 启动后端（Spring Boot）
4. 启动前端（Vue3）

## 3. 启动基础依赖

```bash
cd infra
docker compose up -d
```

- MySQL: `localhost:3306`
- IPFS API: `localhost:5001`
- IPFS Gateway: `localhost:8080`

## 4. 启动合约模块

```bash
cd contracts
npm install
npx hardhat node
```

新开终端：

```bash
cd contracts
npx hardhat run scripts/deploy.js --network localhost
```

部署后把合约地址填入：

- `backend/src/main/resources/application.yml`
- `frontend/.env.example`（复制为 `.env` 后使用）

## 5. 启动后端

```bash
cd backend
mvn spring-boot:run
```

默认端口：`8081`

## 6. 启动前端

```bash
cd frontend
npm install
npm run dev
```

默认端口：`5173`

## 7. 下一步建议

- 增加“知识发布/协作编辑/审核通过/奖励结算”完整业务流
- 增加 IPFS 文件上传与 CID 上链
- 增加后端对合约事件订阅与数据库持久化
