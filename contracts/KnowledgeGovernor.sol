// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeGovernor
 * @dev 基于 OpenZeppelin Governor 的 DAO 合约
 *
 * 特点：
 * - 投票权来自 NativeVotes（KC 质押）
 * - 提案需要达到 proposalThreshold（防止垃圾提案）
 * - 法定人数 quorumFraction（基于总质押）
 * - 使用 Timelock 延迟执行
 */

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorPreventLateQuorum.sol";

contract KnowledgeGovernor is
    Governor,
    GovernorSettings,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorCountingSimple,
    GovernorTimelockControl,
    GovernorPreventLateQuorum
{
    constructor(IVotes _token, TimelockController _timelock)
        Governor("KnowledgeGovernor")
        GovernorSettings(
            5,          // votingDelay: 5 block 投票开始前的等待时间（防止“投票前质押”）
            100,         // votingPeriod: 100 blocks 投票持续时间（约 20分钟，按链上出块速度调整）
            10 ether    // proposalThreshold: 10 KC 质押才能提交提案（防止垃圾提案）
        )
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(4) // 4% 法定人数
        GovernorTimelockControl(_timelock)
        GovernorPreventLateQuorum(20)
    {}

    // -------- 必须 override 的函数（OZ 要求）--------

    function votingDelay()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    function votingPeriod()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(IGovernor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalDeadline(uint256 proposalId)
        public
        view
        override(IGovernor, Governor, GovernorPreventLateQuorum)
        returns (uint256)
    {
        return super.proposalDeadline(proposalId);
    }

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

    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    function lateQuorumVoteExtension()
        public
        view
        override(GovernorPreventLateQuorum)
        returns (uint64)
    {
        return super.lateQuorumVoteExtension();
    }

    function setLateQuorumVoteExtension(uint64 newVoteExtension)
        public
        override(GovernorPreventLateQuorum)
        onlyGovernance
    {
        super.setLateQuorumVoteExtension(newVoteExtension);
    }

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

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
