// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeGovernor
 * @dev DeFi风格治理：Governor + TimelockController（OZ4.9.6兼容）
 * 流程：propose -> vote -> queue(timelock) -> execute
 */

import "@openzeppelin/contracts/governance/IGovernor.sol";
import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";

contract KnowledgeGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    constructor(
        IVotes _token,
        TimelockController _timelock
    )
        Governor("KnowledgeGovernor")
        /**
         * votingDelay = 1 block
         * votingPeriod = 20 blocks
         * proposalThreshold = 10e18 (10 KGT)
         *
         * 注意：proposalThreshold 用的是“投票权”，所以必须 delegate 才有效
         */
        GovernorSettings(1, 20, 10e18)
        GovernorVotes(_token)
        /**
         * quorum = 总供应的 10%
         * 真实 DeFi 常用 quorum 机制，防止少数人低参与度通过提案
         */
        GovernorVotesQuorumFraction(10)
        GovernorTimelockControl(_timelock)
    {}

    // ✅ OZ4：这些函数需要 override(IGovernor, GovernorSettings)
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

    // ✅ OZ4：quorum 来自 IGovernor 与 GovernorVotesQuorumFraction
    function quorum(
        uint256 blockNumber
    )
        public
        view
        override(IGovernor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    // ===== TimelockControl 必需 overrides =====

    function state(
        uint256 proposalId
    )
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function _execute(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._execute(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
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

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
