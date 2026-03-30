// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorPreventLateQuorum.sol";

/**
 * @title KnowledgeGovernor
 * @notice 知识治理系统的核心 Governor 合约。
 * @dev
 * 基于 OpenZeppelin Governor 组合实现，负责：
 * 1. 创建提案并进入投票流程。
 * 2. 通过 Timelock 排队与执行治理动作。
 * 3. 维护法定人数、投票延迟、投票周期等治理参数。
 * 4. 为提案提交引入可治理调节的协议费用，并将费用转入 Revenue Vault。
 */
contract KnowledgeGovernor is
    Governor,
    GovernorSettings,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorCountingSimple,
    GovernorTimelockControl,
    GovernorPreventLateQuorum
{
    /// @notice 提案费用接收地址，通常为协议的 Revenue Vault。
    address payable public revenueVault;

    /// @notice 当前发起提案所需附带的原生币费用。
    uint256 public proposalFee;

    /**
     * @notice Revenue Vault 地址更新时触发。
     * @param revenueVault 新的费用接收地址。
     */
    event RevenueVaultUpdated(address indexed revenueVault);

    /**
     * @notice 提案费用更新时触发。
     * @param proposalFee 新的提案费用。
     */
    event ProposalFeeUpdated(uint256 proposalFee);

    /**
     * @notice 部署治理合约并初始化治理参数与费用配置。
     * @param _token 提供投票权快照的 IVotes 代币合约。
     * @param _timelock 提案排队与执行所使用的 TimelockController。
     * @param _revenueVault 提案费用接收地址。
     * @param _proposalFee 初始提案费用。
     */
    constructor(
        IVotes _token,
        TimelockController _timelock,
        address payable _revenueVault,
        uint256 _proposalFee
    )
        Governor("KnowledgeGovernor")
        GovernorSettings(5, 100, 10 ether)
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(4)
        GovernorTimelockControl(_timelock)
        GovernorPreventLateQuorum(20)
    {
        if (_proposalFee > 0) {
            require(_revenueVault != address(0), "vault=0");
        }

        revenueVault = _revenueVault;
        proposalFee = _proposalFee;

        emit RevenueVaultUpdated(_revenueVault);
        emit ProposalFeeUpdated(_proposalFee);
    }

    /**
     * @notice 更新提案费用接收地址。
     * @dev 只能通过治理提案调用。
     * @param _revenueVault 新的 Revenue Vault 地址。
     */
    function setRevenueVault(address payable _revenueVault) external onlyGovernance {
        revenueVault = _revenueVault;
        emit RevenueVaultUpdated(_revenueVault);
    }

    /**
     * @notice 更新发起提案所需的协议费用。
     * @dev 当费用大于 0 时，要求 Revenue Vault 已正确配置。
     * @param _proposalFee 新的提案费用。
     */
    function setProposalFee(uint256 _proposalFee) external onlyGovernance {
        if (_proposalFee > 0) {
            require(revenueVault != address(0), "vault not set");
        }

        proposalFee = _proposalFee;
        emit ProposalFeeUpdated(_proposalFee);
    }

    /**
     * @notice 在提案费用为 0 时创建提案。
     * @dev 保留标准 Governor.propose 入口，用于免费提案场景。
     * @param targets 提案动作目标合约列表。
     * @param values 每个动作附带的原生币数额。
     * @param calldatas 每个动作的 calldata。
     * @param description 提案描述文本。
     * @return 提案 ID。
     */
    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override(Governor, IGovernor) returns (uint256) {
        require(proposalFee == 0, "fee required");
        return super.propose(targets, values, calldatas, description);
    }

    /**
     * @notice 附带提案费用创建治理提案。
     * @dev 收到的费用会立即转入 Revenue Vault，再调用底层 Governor 提案流程。
     * @param targets 提案动作目标合约列表。
     * @param values 每个动作附带的原生币数额。
     * @param calldatas 每个动作的 calldata。
     * @param description 提案描述文本。
     * @return 提案 ID。
     */
    function proposeWithFee(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) external payable returns (uint256) {
        require(msg.value == proposalFee, "bad fee");

        if (proposalFee > 0) {
            require(revenueVault != address(0), "vault not set");
            (bool ok, ) = revenueVault.call{value: msg.value}("");
            require(ok, "fee transfer failed");
        }

        return super.propose(targets, values, calldatas, description);
    }

    /// @inheritdoc GovernorSettings
    function votingDelay()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    /// @inheritdoc GovernorSettings
    function votingPeriod()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    /// @inheritdoc GovernorSettings
    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    /// @inheritdoc GovernorVotesQuorumFraction
    function quorum(uint256 blockNumber)
        public
        view
        override(IGovernor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    /// @inheritdoc GovernorTimelockControl
    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    /// @inheritdoc GovernorPreventLateQuorum
    function proposalDeadline(uint256 proposalId)
        public
        view
        override(IGovernor, Governor, GovernorPreventLateQuorum)
        returns (uint256)
    {
        return super.proposalDeadline(proposalId);
    }

    /// @inheritdoc GovernorTimelockControl
    function _execute(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
    {
        super._execute(proposalId, targets, values, calldatas, descriptionHash);
    }

    /// @inheritdoc GovernorTimelockControl
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint256)
    {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    /// @inheritdoc GovernorTimelockControl
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    /// @inheritdoc GovernorPreventLateQuorum
    function lateQuorumVoteExtension()
        public
        view
        override(GovernorPreventLateQuorum)
        returns (uint64)
    {
        return super.lateQuorumVoteExtension();
    }

    /**
     * @notice 更新迟到法定人数的额外投票延长期。
     * @dev 只能通过治理提案调用。
     * @param newVoteExtension 新的延长期区块数。
     */
    function setLateQuorumVoteExtension(uint64 newVoteExtension)
        public
        override(GovernorPreventLateQuorum)
        onlyGovernance
    {
        super.setLateQuorumVoteExtension(newVoteExtension);
    }

    /// @inheritdoc GovernorPreventLateQuorum
    function _castVote(
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory params
    )
        internal
        override(Governor, GovernorPreventLateQuorum)
        returns (uint256)
    {
        return super._castVote(proposalId, account, support, reason, params);
    }

    /// @inheritdoc GovernorTimelockControl
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
