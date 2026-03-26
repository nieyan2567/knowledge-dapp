# Knowledge DApp Contracts

This repository contains the blockchain layer for the Knowledge DApp. It includes the staking, content, treasury, governor, and timelock contracts, along with deployment and verification scripts.

## Repository Scope

This repository currently contains only the smart contract stack and related tests.

```text
knowledge-dapp/
├─ contracts/
├─ scripts/
├─ test/
├─ deployments/
├─ typechain-types/
└─ hardhat.config.ts
```

Frontend code is maintained separately in the sibling project `../knowledge-dapp-ui`. The ABI export script in this repository writes into that project.

## Contract Architecture

- `NativeVotes`: users stake KC, wait for activation, and obtain governance voting power.
- `KnowledgeContent`: authors register content, update content metadata with on-chain version history, delete content by soft delete, and accept votes.
- `TreasuryNative`: holds KC rewards, reserves pending rewards, and lets beneficiaries claim them.
- `KnowledgeGovernor`: DAO proposal and voting entrypoint.
- `TimelockController`: delayed execution and final owner of governance-controlled contracts.

## Content Version History

`KnowledgeContent` now stores version history natively on-chain.

- `registerContent(...)` creates version `1`
- `updateContent(...)` appends a new version instead of deleting or overwriting history
- `contentVersionCount(contentId)` returns the number of stored versions
- `getContentVersion(contentId, version)` returns the metadata of a historical version
- `deleteContent(contentId)` is a soft delete only; historical versions remain queryable

Current safety rules:

- only the author can update content
- deleted content cannot be updated, voted, or rewarded
- authors cannot update after votes exist
- authors cannot delete after reward accrual
- contract owner can force-delete for moderation

## Treasury Model

The treasury uses two separate constraints:

- actual treasury balance: how much KC the contract currently holds
- epoch budget: the maximum reward amount that may be accrued during one epoch

Current deployment defaults:

- initial treasury funding target: `5 KC`
- treasury epoch duration: `7 days`
- treasury epoch budget: `100 KC`

Effective reward capacity is the smaller of:

- remaining treasury balance
- remaining epoch budget

The treasury does not auto-refill. If funds run low, new reward accruals revert until someone funds the treasury again.

## Prerequisites

- Node.js
- npm

Install dependencies:

```bash
npm install
```

## Hardhat Scripts

`package.json` exposes the current supported workflows:

- `npm run compile`
- `npm test`
- `npm run clean`
- `npm run local_1`
- `npm run local_2`
- `npm run local_3`
- `npm run local_4`
- `npm run besu_1`
- `npm run besu_2`
- `npm run besu_3`
- `npm run besu_4`
- `npm run copy`

Legacy deployment scripts have been renamed to `*.legacy.txt` and are not part of the active workflow.

## Local Deployment Flow

Start a local Hardhat node in one terminal:

```bash
npx hardhat node
```

Run the deployment pipeline in another terminal:

```bash
npm run local_1
npm run local_2
npm run local_3
npm run local_4
```

Meaning of each step:

1. `local_1`: deploy `NativeVotes`, `KnowledgeContent`, `TreasuryNative`, `TimelockController`, `KnowledgeGovernor`
2. `local_2`: fund treasury to the target balance, bind content to treasury and anti-sybil voting source, authorize content as treasury spender
3. `local_3`: transfer contract ownership to `TimelockController` and finalize governance handover
4. `local_4`: verify deployment integrity, role configuration, treasury reserve coverage, and content version history surface

Deployment metadata is stored in:

- [deployments/localhost.json](/d:/knowledge-dapp/deployments/localhost.json)
- [deployments/consortium.json](/d:/knowledge-dapp/deployments/consortium.json)

## Consortium / Besu Deployment Flow

Configure environment variables in `.env` as needed:

- `BESU_RPC_URL`
- `BESU_CHAIN_ID`
- `DEPLOYER_PRIVATE_KEY`

Then run:

```bash
npm run besu_1
npm run besu_2
npm run besu_3
npm run besu_4
```

## Frontend ABI Export

After contract changes, export deployment info and ABI files to the sibling frontend project:

```bash
npm run copy
```

This script writes to:

- `../knowledge-dapp-ui/src/contracts/deployment.json`
- `../knowledge-dapp-ui/src/contracts/abi/*.json`

## Tests

Run the full contract test suite:

```bash
npm test
```

Current coverage includes:

- governance proposal, vote, queue, execute flow
- staking activation and withdrawal behavior
- treasury pending reward reservation accounting
- content register, update, version history lookup, delete, vote, and reward flow

## Main Files

- [contracts/KnowledgeContent.sol](/d:/knowledge-dapp/contracts/KnowledgeContent.sol)
- [contracts/TreasuryNative.sol](/d:/knowledge-dapp/contracts/TreasuryNative.sol)
- [contracts/NativeVotes.sol](/d:/knowledge-dapp/contracts/NativeVotes.sol)
- [contracts/KnowledgeGovernor.sol](/d:/knowledge-dapp/contracts/KnowledgeGovernor.sol)
- [scripts/1_deploy_contracts.ts](/d:/knowledge-dapp/scripts/1_deploy_contracts.ts)
- [scripts/2_initialize_system.ts](/d:/knowledge-dapp/scripts/2_initialize_system.ts)
- [scripts/3_handover_ownership.ts](/d:/knowledge-dapp/scripts/3_handover_ownership.ts)
- [scripts/4_verify_system.ts](/d:/knowledge-dapp/scripts/4_verify_system.ts)

## Notes

- `KnowledgeContent` keeps current metadata in `contents(contentId)` and historical metadata in `getContentVersion(...)`.
- `deleteContent(...)` is a business-level delete, not physical deletion of chain history.
- `TreasuryNative` tracks `totalPendingRewards` to prevent over-reserving rewards beyond available KC.
