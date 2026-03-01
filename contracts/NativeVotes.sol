// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title NativeVotes
 * @dev 原生币质押治理投票权（IVotes）——增强安全版
 *
 * 修复点：
 * 1) deposit 后不立刻生效：需要等待 activationBlocks 后调用 activate() 才获得投票权（防“短期资金治理劫持”）
 * 2) withdraw 需要 requestWithdraw + cooldownSeconds 冷却期（降低投票后立刻退出）
 * 3) receive() revert：避免用户误转账造成“资金进来但没投票权”
 */

import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "@openzeppelin/contracts/utils/Checkpoints.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract NativeVotes is IVotes, EIP712, ReentrancyGuard {
    using Checkpoints for Checkpoints.Trace224;

    // ======= 参数（可按联盟链需求调整，也可做成 DAO 可治理） =======
    uint256 public immutable cooldownSeconds;     // 退出冷却期（秒）
    uint256 public immutable activationBlocks;    // 投票权激活延迟（区块数）

    // ======= 余额与状态 =======
    mapping(address => uint256) public staked;            // 已激活质押（有投票权）
    mapping(address => uint256) public pendingStake;      // 未激活质押（无投票权）
    mapping(address => uint256) public activateAfterBlock;// 何时可 activate()

    // 退出请求（从 staked 发起）
    mapping(address => uint256) public pendingWithdraw;   // 已申请退出金额（仍锁在合约中）
    mapping(address => uint256) public withdrawAfterTime; // 何时可 withdraw()

    // 委托关系与快照
    mapping(address => address) private _delegates;
    mapping(address => Checkpoints.Trace224) private _delegateCheckpoints;
    Checkpoints.Trace224 private _totalCheckpoints;

    // EIP712
    mapping(address => uint256) public nonces;
    bytes32 private constant _DELEGATION_TYPEHASH =
        keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)");

    event Deposited(address indexed user, uint256 amount, uint256 activateAfterBlock);
    event Activated(address indexed user, uint256 amount);
    event WithdrawRequested(address indexed user, uint256 amount, uint256 withdrawAfterTime);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(
        uint256 _cooldownSeconds,
        uint256 _activationBlocks
    ) EIP712("NativeVotes", "2") {
        cooldownSeconds = _cooldownSeconds;     // 例如 3600（1小时）/ 86400（1天）
        activationBlocks = _activationBlocks;   // 例如 10/50
    }

    // -------------------- 质押 / 激活 --------------------

    /**
     * @notice 质押原生币（不会立刻获得投票权）
     */
    function deposit() external payable nonReentrant {
        require(msg.value > 0, "deposit=0");

        pendingStake[msg.sender] += msg.value;

        // 延迟激活：每次 deposit 都将激活时间推到 max(旧值, 当前+activationBlocks)
        uint256 target = block.number + activationBlocks;
        if (activateAfterBlock[msg.sender] < target) {
            activateAfterBlock[msg.sender] = target;
        }

        emit Deposited(msg.sender, msg.value, activateAfterBlock[msg.sender]);
    }

    /**
     * @notice 激活投票权（将 pendingStake 转为 staked，并写入投票权快照）
     */
    function activate() external nonReentrant {
        require(pendingStake[msg.sender] > 0, "no pending");
        require(block.number >= activateAfterBlock[msg.sender], "not ready");

        uint256 amount = pendingStake[msg.sender];
        pendingStake[msg.sender] = 0;

        staked[msg.sender] += amount;

        // 投票权增加：address(0) -> delegatee
        address delegatee = delegates(msg.sender);
        _moveVotingPower(address(0), delegatee, amount);

        // 总票权增加（仅统计已激活 staked）
        _writeTotalCheckpoint(_add, amount);

        emit Activated(msg.sender, amount);
    }

    // -------------------- 退出（冷却期） --------------------

    /**
     * @notice 申请退出：立即减少投票权，但资金要等 cooldown 才能提现
     * @dev 这能防止“投完票立刻退出”，并降低治理短期攻击面
     */
    function requestWithdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "amount=0");
        require(staked[msg.sender] >= amount, "insufficient staked");

        staked[msg.sender] -= amount;
        pendingWithdraw[msg.sender] += amount;

        // 立即减少投票权：delegatee -> address(0)
        address delegatee = delegates(msg.sender);
        _moveVotingPower(delegatee, address(0), amount);

        // 总票权减少
        _writeTotalCheckpoint(_subtract, amount);

        uint256 unlockTime = block.timestamp + cooldownSeconds;
        if (withdrawAfterTime[msg.sender] < unlockTime) {
            withdrawAfterTime[msg.sender] = unlockTime;
        }

        emit WithdrawRequested(msg.sender, amount, withdrawAfterTime[msg.sender]);
    }

    /**
     * @notice 冷却期结束后提取原生币
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

    // -------------------- IVotes：委托与快照 --------------------

    function delegates(address account) public view override returns (address) {
        address d = _delegates[account];
        return d == address(0) ? account : d;
    }

    function delegate(address delegatee) external override {
        _delegate(msg.sender, delegatee);
    }

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

    function getVotes(address account) external view override returns (uint256) {
        return _delegateCheckpoints[account].latest();
    }

    function getPastVotes(address account, uint256 blockNumber) external view override returns (uint256) {
        
        // 边界检查
        require(blockNumber < block.number, "block not yet mined");
        require(blockNumber <= type(uint32).max, "blockNumber too large");

        return _delegateCheckpoints[account].upperLookupRecent(uint32(blockNumber));
    }

    function getPastTotalSupply(uint256 blockNumber) external view override returns (uint256) {
        require(blockNumber < block.number, "block not yet mined");
        require(blockNumber <= type(uint32).max, "blockNumber too large");
        return _totalCheckpoints.upperLookupRecent(uint32(blockNumber));
    }

    // -------------------- 内部实现 --------------------

    function _delegate(address delegator, address delegatee) internal {
        address oldDelegate = delegates(delegator);
        _delegates[delegator] = delegatee;

        // 只对“已激活 staked”产生投票权迁移；pendingStake 不计票
        uint256 balance = staked[delegator];
        _moveVotingPower(oldDelegate, delegatee, balance);

        emit DelegateChanged(delegator, oldDelegate, delegatee);
    }

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

    function _writeTotalCheckpoint(function(uint256,uint256) pure returns (uint256) op, uint256 delta) internal {
        _totalCheckpoints.push(uint32(block.number), uint224(op(_totalCheckpoints.latest(), delta)));
    }

    function _writeCheckpoint(
        Checkpoints.Trace224 storage ckpts,
        function(uint256,uint256) pure returns (uint256) op,
        uint256 delta
    ) internal returns (uint256 oldVal, uint256 newVal) {
        oldVal = ckpts.latest();
        newVal = op(oldVal, delta);
        ckpts.push(uint32(block.number), uint224(newVal));
    }

    function _add(uint256 a, uint256 b) private pure returns (uint256) { return a + b; }
    function _subtract(uint256 a, uint256 b) private pure returns (uint256) { return a - b; }

    /// @dev 禁止直接收币，避免“误转账不记票权”
    receive() external payable {
        revert("use deposit()");
    }
}