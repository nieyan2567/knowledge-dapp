// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title NativeVotes
 * @notice 基于原生币质押实现的治理投票权合约，兼容 OpenZeppelin `IVotes`。
 * @dev
 * 设计要点：
 * 1. 用户充值后先进入 `pendingStake`，必须等待若干区块并调用 `activate` 后才获得投票权。
 * 2. 用户申请退出时会先立即扣减投票权，再经过冷却期后才能真正提走资金。
 * 3. 已激活质押额会参与委托、投票权快照和总供应量快照。
 * 4. 禁止直接向合约转账，避免“钱进来了但没有投票权”的误操作。
 */

import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Checkpoints.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract NativeVotes is IVotes, Ownable, EIP712, ReentrancyGuard {
    using Checkpoints for Checkpoints.Trace224;

    /// @notice 申请退出后需要等待的冷却时间，单位为秒。
    uint256 public cooldownSeconds;
    /// @notice 充值后需要等待多少个区块才能激活投票权。
    uint256 public activationBlocks;

    /// @notice 每个地址已激活的质押金额，这部分会计入投票权。
    mapping(address => uint256) public staked;
    /// @notice 每个地址已充值但尚未激活的质押金额，这部分暂不计入投票权。
    mapping(address => uint256) public pendingStake;
    /// @notice 每个地址最早可执行 `activate` 的区块号。
    mapping(address => uint256) public activateAfterBlock;

    /// @notice 每个地址已申请退出但尚未提走的金额，资金仍锁定在合约中。
    mapping(address => uint256) public pendingWithdraw;
    /// @notice 每个地址最早可执行 `withdraw` 的时间戳。
    mapping(address => uint256) public withdrawAfterTime;

    /// @dev 委托人到被委托人的映射；若未显式设置，则默认委托给自己。
    mapping(address => address) private _delegates;
    /// @dev 每个被委托人对应的投票权历史快照。
    mapping(address => Checkpoints.Trace224) private _delegateCheckpoints;
    /// @dev 全网总投票权历史快照，仅统计已激活质押。
    Checkpoints.Trace224 private _totalCheckpoints;

    /// @notice 每个地址当前的签名 nonce，用于 `delegateBySig` 防重放。
    mapping(address => uint256) public nonces;
    /// @dev EIP-712 委托签名结构体的类型哈希。
    bytes32 private constant _DELEGATION_TYPEHASH =
        keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)");

    /**
     * @notice 用户充值成功时触发。
     * @param user 充值用户地址。
     * @param amount 本次充值金额。
     * @param activateAfterBlock 本次充值后最早可激活投票权的区块号。
     */
    event Deposited(address indexed user, uint256 amount, uint256 activateAfterBlock);

    /**
     * @notice 用户成功激活待质押金额时触发。
     * @param user 激活用户地址。
     * @param amount 本次从 `pendingStake` 转入 `staked` 的金额。
     */
    event Activated(address indexed user, uint256 amount);

    /**
     * @notice 用户撤回待激活质押时触发。
     * @param user 撤回待激活质押的用户地址。
     * @param amount 本次撤回的金额。
     * @param remainingPendingStake 撤回后剩余的待激活质押金额。
     */
    event PendingStakeCanceled(address indexed user, uint256 amount, uint256 remainingPendingStake);

    /**
     * @notice 用户发起退出申请时触发。
     * @param user 发起退出的用户地址。
     * @param amount 本次申请退出的金额。
     * @param withdrawAfterTime 该用户最早可提取该批资金的时间戳。
     */
    event WithdrawRequested(address indexed user, uint256 amount, uint256 withdrawAfterTime);

    /**
     * @notice 用户完成提现时触发。
     * @param user 提现用户地址。
     * @param amount 本次提取的金额。
     */
    event Withdrawn(address indexed user, uint256 amount);

    /**
     * @notice 冷却时间参数更新时触发。
     * @param oldCooldownSeconds 旧的冷却时间。
     * @param newCooldownSeconds 新的冷却时间。
     */
    event CooldownSecondsUpdated(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);

    /**
     * @notice 激活等待区块参数更新时触发。
     * @param oldActivationBlocks 旧的激活等待区块数。
     * @param newActivationBlocks 新的激活等待区块数。
     */
    event ActivationBlocksUpdated(uint256 oldActivationBlocks, uint256 newActivationBlocks);

    /**
     * @notice 部署质押投票权合约并初始化关键安全参数。
     * @param _cooldownSeconds 退出冷却期，单位为秒。
     * @param _activationBlocks 充值后需要等待的激活区块数。
     */
    constructor(
        uint256 _cooldownSeconds,
        uint256 _activationBlocks
    ) EIP712("NativeVotes", "2") {
        require(_cooldownSeconds > 0, "cooldown=0");
        require(_activationBlocks > 0, "activation=0");

        cooldownSeconds = _cooldownSeconds;
        activationBlocks = _activationBlocks;
    }

    /**
     * @notice 更新退出冷却期。
     * @dev 只有 owner 或其背后的治理 Timelock 可以修改。
     * @param newCooldownSeconds 新的退出冷却期，单位为秒。
     */
    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        require(newCooldownSeconds > 0, "cooldown=0");

        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;

        emit CooldownSecondsUpdated(oldCooldownSeconds, newCooldownSeconds);
    }

    /**
     * @notice 更新充值后激活投票权所需等待的区块数。
     * @dev 只有 owner 或其背后的治理 Timelock 可以修改。
     * @param newActivationBlocks 新的激活等待区块数。
     */
    function setActivationBlocks(uint256 newActivationBlocks) external onlyOwner {
        require(newActivationBlocks > 0, "activation=0");

        uint256 oldActivationBlocks = activationBlocks;
        activationBlocks = newActivationBlocks;

        emit ActivationBlocksUpdated(oldActivationBlocks, newActivationBlocks);
    }

    /**
     * @notice 向合约充值原生币作为待激活质押。
     * @dev
     * 充值成功后资金进入 `pendingStake`，不会立刻获得投票权。
     * 若用户多次充值，会把可激活区块向后推至 `max(旧值, 当前区块 + activationBlocks)`。
     */
    function deposit() external payable nonReentrant {
        require(msg.value > 0, "deposit=0");

        pendingStake[msg.sender] += msg.value;

        // 延迟激活：每次充值都会把激活时点推迟到不早于当前要求。
        uint256 target = block.number + activationBlocks;
        if (activateAfterBlock[msg.sender] < target) {
            activateAfterBlock[msg.sender] = target;
        }

        emit Deposited(msg.sender, msg.value, activateAfterBlock[msg.sender]);
    }

    /**
     * @notice 激活待质押金额，使其转化为可投票的已质押金额。
     * @dev
     * 只有达到 `activateAfterBlock` 后才能调用。
     * 激活后会把投票权计入委托对象，并写入总投票权快照。
     */
    function activate() external nonReentrant {
        require(pendingStake[msg.sender] > 0, "no pending");
        require(block.number >= activateAfterBlock[msg.sender], "not ready");

        uint256 amount = pendingStake[msg.sender];
        pendingStake[msg.sender] = 0;

        staked[msg.sender] += amount;

        // 投票权增加：从零地址增加到当前委托对象。
        address delegatee = delegates(msg.sender);
        _moveVotingPower(address(0), delegatee, amount);

        // 总票权增加，仅统计已激活部分。
        _writeTotalCheckpoint(_add, amount);

        emit Activated(msg.sender, amount);
    }

    /**
     * @notice 发起退出申请，立即扣减投票权，但资金需等待冷却期后才能提取。
     * @dev
     * 这样可以降低“先投票后立刻撤资”的治理攻击风险。
     * @param amount 本次申请退出的金额。
     */
    /**
     * @notice 撤回尚未激活的质押，立即退款且不经过冷却期。
     * @param amount 本次撤回的待激活质押金额。
     */
    function cancelPendingStake(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        require(pendingStake[msg.sender] >= amount, "insufficient pending");

        pendingStake[msg.sender] -= amount;

        if (pendingStake[msg.sender] == 0) {
            activateAfterBlock[msg.sender] = 0;
        }

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");

        emit PendingStakeCanceled(msg.sender, amount, pendingStake[msg.sender]);
    }

    /**
     * @notice 用户发起退出申请时会立刻减少投票权，但资金仍需等待冷却期后才能提取。
     * @dev 这样可以降低“先投票后立刻撤资”的治理攻击风险。
     * @param amount 本次申请退出的金额。
     */
    function requestWithdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        require(staked[msg.sender] >= amount, "insufficient staked");

        staked[msg.sender] -= amount;
        pendingWithdraw[msg.sender] += amount;

        // 立即减少投票权：从当前委托对象迁移回零地址。
        address delegatee = delegates(msg.sender);
        _moveVotingPower(delegatee, address(0), amount);

        // 总投票权同步减少。
        _writeTotalCheckpoint(_subtract, amount);

        uint256 unlockTime = block.timestamp + cooldownSeconds;
        if (withdrawAfterTime[msg.sender] < unlockTime) {
            withdrawAfterTime[msg.sender] = unlockTime;
        }

        emit WithdrawRequested(msg.sender, amount, withdrawAfterTime[msg.sender]);
    }

    /**
     * @notice 在冷却期结束后提取此前申请退出的资金。
     * @param amount 本次实际提取的金额。
     */
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        require(pendingWithdraw[msg.sender] >= amount, "insufficient pending");
        require(block.timestamp >= withdrawAfterTime[msg.sender], "cooldown");

        pendingWithdraw[msg.sender] -= amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice 查询某个地址当前的委托目标。
     * @dev 若未显式委托，则默认返回该地址自己。
     * @param account 要查询的地址。
     * @return 当前实际接收该地址投票权的委托目标地址。
     */
    function delegates(address account) public view override returns (address) {
        address d = _delegates[account];
        return d == address(0) ? account : d;
    }

    /**
     * @notice 将自己的已激活投票权委托给指定地址。
     * @param delegatee 接收投票权的委托目标地址。
     */
    function delegate(address delegatee) external override {
        _delegate(msg.sender, delegatee);
    }

    /**
     * @notice 通过 EIP-712 签名方式完成委托。
     * @param delegatee 接收投票权的委托目标地址。
     * @param nonce 签名使用的 nonce，必须与链上当前值一致。
     * @param expiry 签名过期时间戳，超过后不可再使用。
     * @param v 签名参数 v。
     * @param r 签名参数 r。
     * @param s 签名参数 s。
     */
    function delegateBySig(
        address delegatee,
        uint256 nonce,
        uint256 expiry,
        uint8 v, bytes32 r, bytes32 s
    ) external override {
        require(block.timestamp <= expiry, "signature expired");

        bytes32 structHash = keccak256(abi.encode(_DELEGATION_TYPEHASH, delegatee, nonce, expiry));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, v, r, s);

        require(nonce == nonces[signer]++, "bad nonce");

        _delegate(signer, delegatee);
    }

    /**
     * @notice 查询指定地址当前最新的投票权数量。
     * @param account 要查询的地址。
     * @return 该地址当前最新快照对应的投票权数量。
     */
    function getVotes(address account) external view override returns (uint256) {
        return _delegateCheckpoints[account].latest();
    }

    /**
     * @notice 查询指定地址在某个历史区块时点的投票权数量。
     * @param account 要查询的地址。
     * @param blockNumber 要查询的历史区块号，必须小于当前区块。
     * @return 该地址在指定历史区块时的投票权数量。
     */
    function getPastVotes(address account, uint256 blockNumber) external view override returns (uint256) {
        
        // 只允许查询已出块的历史区块，并限制到 Checkpoints 支持的区块范围。
        require(blockNumber < block.number, "block not yet mined");
        require(blockNumber <= type(uint32).max, "blockNumber too large");

        return _delegateCheckpoints[account].upperLookupRecent(uint32(blockNumber));
    }

    /**
     * @notice 查询指定历史区块时点的总投票权供应量。
     * @param blockNumber 要查询的历史区块号，必须小于当前区块。
     * @return 该历史区块时已激活总质押对应的总投票权。
     */
    function getPastTotalSupply(uint256 blockNumber) external view override returns (uint256) {
        require(blockNumber < block.number, "block not yet mined");
        require(blockNumber <= type(uint32).max, "blockNumber too large");
        return _totalCheckpoints.upperLookupRecent(uint32(blockNumber));
    }

    /**
     * @notice 执行内部委托逻辑并迁移投票权。
     * @dev 只迁移已激活的 `staked` 部分，`pendingStake` 不参与投票权计算。
     * @param delegator 发起委托的地址。
     * @param delegatee 新的委托目标地址。
     */
    function _delegate(address delegator, address delegatee) internal {
        address oldDelegate = delegates(delegator);
        _delegates[delegator] = delegatee;

        // 只迁移已激活质押对应的投票权，待激活质押不计票。
        uint256 balance = staked[delegator];
        _moveVotingPower(oldDelegate, delegatee, balance);

        emit DelegateChanged(delegator, oldDelegate, delegatee);
    }

    /**
     * @notice 在两个地址之间迁移投票权快照。
     * @param from 失去投票权的一方地址。
     * @param to 获得投票权的一方地址。
     * @param amount 本次迁移的投票权数量。
     */
    function _moveVotingPower(address from, address to, uint256 amount) internal {
        if (from == to || amount == 0) return;

        if (from != address(0)) {
            (uint256 oldVal, uint256 newVal) = _writeCheckpoint(_delegateCheckpoints[from], _subtract, amount);
            emit DelegateVotesChanged(from, oldVal, newVal);
        }

        if (to != address(0)) {
            (uint256 oldVal, uint256 newVal) = _writeCheckpoint(_delegateCheckpoints[to], _add, amount);
            emit DelegateVotesChanged(to, oldVal, newVal);
        }
    }

    /**
     * @notice 写入总投票权快照。
     * @param op 对旧值执行的运算函数，通常为加法或减法。
     * @param delta 本次变化量。
     */
    function _writeTotalCheckpoint(function(uint256,uint256) pure returns (uint256) op, uint256 delta) internal {
        _totalCheckpoints.push(uint32(block.number), uint224(op(_totalCheckpoints.latest(), delta)));
    }

    /**
     * @notice 向指定快照序列写入新的投票权值。
     * @param ckpts 目标快照序列。
     * @param op 对旧值执行的运算函数。
     * @param delta 本次变化量。
     * @return oldVal 变更前的投票权值。
     * @return newVal 变更后的投票权值。
     */
    function _writeCheckpoint(
        Checkpoints.Trace224 storage ckpts,
        function(uint256,uint256) pure returns (uint256) op,
        uint256 delta
    ) internal returns (uint256 oldVal, uint256 newVal) {
        oldVal = ckpts.latest();
        newVal = op(oldVal, delta);
        ckpts.push(uint32(block.number), uint224(newVal));
    }

    /**
     * @notice 对两个数做加法，供快照写入逻辑复用。
     * @param a 被加数。
     * @param b 加数。
     * @return 两数之和。
     */
    function _add(uint256 a, uint256 b) private pure returns (uint256) { return a + b; }

    /**
     * @notice 对两个数做减法，供快照写入逻辑复用。
     * @param a 被减数。
     * @param b 减数。
     * @return 两数之差。
     */
    function _subtract(uint256 a, uint256 b) private pure returns (uint256) { return a - b; }

    /**
     * @notice 禁止直接向合约转账。
     * @dev 用户必须使用 `deposit`，否则资金不会进入待激活流程。
     */
    receive() external payable {
        revert("use deposit()");
    }
}
