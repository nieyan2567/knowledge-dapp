// types/deployment.ts
export interface DeploymentInfo {
  network: string;
  timestamp: string;
  deployer: string;
  contracts: {
    NativeVotes: string;
    KnowledgeContent: string;
    TimelockController: string;
    KnowledgeGovernor: string;
  };
}