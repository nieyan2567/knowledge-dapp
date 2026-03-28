// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeGovernor
 * @notice 基于 OpenZeppelin Governor 扩展组合实现的治理合约。
 * @dev
 * 主要特性：
 * 1. 投票权来源于 `NativeVotes` 这类兼容 `IVotes` 的质押投票权合约。
 * 2. 只有达到提案门槛的地址才能发起提案，减少垃圾提案。
 * 3. 法定人数按总投票权供应量的固定比例计算。
 * 4. 提案通过后不会立即执行，而是进入 `TimelockController` 延迟执行。
 * 5. 启用延迟法定人数扩展，降低提案临近结束时的突袭投票风险。
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
    /**
     * @notice 部署治理合约并绑定投票权来源与 Timelock。
     * @param _token 提供治理投票权快照的 `IVotes` 合约地址。
     * @param _timelock 提案执行所依赖的 TimelockController 合约地址。
     */
    constructor(IVotes _token, TimelockController _timelock)
        Governor("KnowledgeGovernor")
        GovernorSettings(
            5,          // 投票延迟：提案创建后需等待 5 个区块才开始投票。
            100,        // 投票周期：每个提案开放投票 100 个区块。
            10 ether    // 提案门槛：至少拥有 10 KC 投票权才能发起提案。
        )
        GovernorVotes(_token) // 使用外部 `IVotes` 合约作为投票权来源。
        GovernorVotesQuorumFraction(4) // 法定人数为总投票权的 4%。
        GovernorTimelockControl(_timelock)
        GovernorPreventLateQuorum(20) // 若法定人数在最后阶段才达到，则额外延长 20 个区块。
    {}

    /**
     * @notice 返回提案创建后到投票开始前需要等待的区块数。
     * @dev 该函数是 OZ 多继承要求的显式 override。
     * @return 当前治理配置下的投票延迟区块数。
     */
    function votingDelay()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    /**
     * @notice 返回提案开放投票的持续区块数。
     * @dev 该函数是 OZ 多继承要求的显式 override。
     * @return 当前治理配置下的投票周期区块数。
     */
    function votingPeriod()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    /**
     * @notice 返回发起提案所需达到的最小投票权门槛。
     * @dev 该函数是 OZ 多继承要求的显式 override。
     * @return 当前提案门槛。
     */
    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    /**
     * @notice 查询某个区块对应的法定人数要求。
     * @param blockNumber 要计算法定人数的历史区块号。
     * @return 指定区块下提案通过所需的最少赞成/参与基准票数。
     */
    function quorum(uint256 blockNumber)
        public
        view
        override(IGovernor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    /**
     * @notice 查询某个提案当前所处的状态。
     * @param proposalId 要查询的提案编号。
     * @return ProposalState 提案当前状态，如 Pending、Active、Queued、Executed 等。
     */
    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    /**
     * @notice 查询某个提案的投票截止区块。
     * @dev
     * 当启用了 `GovernorPreventLateQuorum` 后，若法定人数在提案末期才达到，
     * 截止区块可能会被动态延长，因此需要使用该 override 返回最终值。
     * @param proposalId 要查询的提案编号。
     * @return 该提案当前生效的最终截止区块。
     */
    function proposalDeadline(uint256 proposalId)
        public
        view
        override(IGovernor, Governor, GovernorPreventLateQuorum)
        returns (uint256)
    {
        return super.proposalDeadline(proposalId);
    }

    /**
     * @notice 执行已通过且已排队完成的提案。
     * @dev 实际执行逻辑由 `GovernorTimelockControl` 接管并通过 Timelock 完成。
     * @param proposalId 要执行的提案编号。
     * @param targets 提案调用的目标合约地址列表。
     * @param values 提案对每个目标发送的原生币金额列表。
     * @param calldatas 提案对每个目标执行的 calldata 列表。
     * @param descriptionHash 提案描述字符串的哈希值。
     */
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

    /**
     * @notice 取消一个尚未执行的提案。
     * @param targets 提案调用的目标合约地址列表。
     * @param values 提案对每个目标发送的原生币金额列表。
     * @param calldatas 提案对每个目标执行的 calldata 列表。
     * @param descriptionHash 提案描述字符串的哈希值。
     * @return 被取消的提案编号。
     */
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

    /**
     * @notice 返回治理执行者地址。
     * @dev 在集成 Timelock 时，执行者通常是 Timelock 合约而不是 Governor 自身。
     * @return 当前治理执行上下文对应的执行者地址。
     */
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    /**
     * @notice 返回延迟法定人数机制下的额外延长区块数。
     * @return 当前配置的延长区块数。
     */
    function lateQuorumVoteExtension()
        public
        view
        override(GovernorPreventLateQuorum)
        returns (uint64)
    {
        return super.lateQuorumVoteExtension();
    }

    /**
     * @notice 通过治理提案修改延迟法定人数的延长区块数。
     * @dev 只有治理流程本身可以调用，普通 owner 或外部账户不能直接修改。
     * @param newVoteExtension 新的延长区块数。
     */
    function setLateQuorumVoteExtension(uint64 newVoteExtension)
        public
        override(GovernorPreventLateQuorum)
        onlyGovernance
    {
        super.setLateQuorumVoteExtension(newVoteExtension);
    }

    /**
     * @notice 处理投票写入，并在需要时触发延迟法定人数机制。
     * @param proposalId 被投票的提案编号。
     * @param account 投票账户地址。
     * @param support 投票选项，通常为反对/赞成/弃权。
     * @param reason 投票理由文本。
     * @param params 扩展投票参数。
     * @return 该账户本次投票所消耗或计入的投票权数量。
     */
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

    /**
     * @notice 查询合约是否支持指定接口。
     * @param interfaceId 要检测的接口标识。
     * @return 若支持该接口则返回 true。
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
