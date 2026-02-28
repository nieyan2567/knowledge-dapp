// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title NativeVotes
 * @dev 用“原生币质押”产生治理投票权，并提供快照接口给 Governor（IVotes）
 *
 * 设计要点（接近真实 DeFi / PoS）：
 * 1) deposit(): 用户质押原生币，staked 增加，投票权增加
 * 2) withdraw(amount): 赎回质押，staked 减少，投票权减少
 * 3) delegate(): 委托投票权（与 ERC20Votes 一致的用户习惯）
 * 4) getPastVotes/getPastTotalSupply: Governor 计票/法定人数需要历史快照
 *
 * 注意：
 * - 这是治理权合约，不负责奖励发放
 * - 原生币不能 mint，只能锁定/释放用户存入的币
 */

import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "@openzeppelin/contracts/utils/Checkpoints.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract NativeVotes is IVotes, EIP712 {
    using Checkpoints for Checkpoints.Trace224;

    /// @dev 每个账户的质押余额（原生币 wei）
    mapping(address => uint256) public staked;

    /// @dev 委托关系：delegator -> delegatee
    mapping(address => address) private _delegates;

    /// @dev delegatee 的投票权快照（历史可查）
    mapping(address => Checkpoints.Trace224) private _delegateCheckpoints;

    /// @dev 总投票权快照（= 全网总质押）
    Checkpoints.Trace224 private _totalCheckpoints;

    /// @dev EIP712 delegateBySig 需要的 nonce
    mapping(address => uint256) public nonces;

    bytes32 private constant _DELEGATION_TYPEHASH =
        keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)");

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    constructor() EIP712("NativeVotes", "1") {}

    /**
     * @notice 质押原生币，获得投票权
     * @dev 投票权默认委托给自己（如果用户未显式 delegate）
     */
    function deposit() external payable {
        require(msg.value > 0, "deposit=0");

        staked[msg.sender] += msg.value;

        // 投票权增加：从 address(0) -> delegatee
        address delegatee = delegates(msg.sender);
        _moveVotingPower(address(0), delegatee, msg.value);

        // 总票权增加
        _writeTotalCheckpoint(_add, msg.value);

        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice 赎回质押
     */
    function withdraw(uint256 amount) external {
        require(amount > 0, "amount=0");
        require(staked[msg.sender] >= amount, "insufficient");

        staked[msg.sender] -= amount;

        address delegatee = delegates(msg.sender);

        // 投票权减少：delegatee -> address(0)
        _moveVotingPower(delegatee, address(0), amount);

        // 总票权减少
        _writeTotalCheckpoint(_subtract, amount);

        // 返还原生币
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @dev 若用户从未委托，则默认委托给自己（投票权即时可用）
     */
    function delegates(address account) public view override returns (address) {
        address d = _delegates[account];
        return d == address(0) ? account : d;
    }

    /**
     * @notice 委托投票权给 delegatee
     */
    function delegate(address delegatee) external override {
        _delegate(msg.sender, delegatee);
    }

    /**
     * @notice 通过签名委托（更贴近真实 DeFi，前端可用）
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
     * @notice 获取当前投票权（delegatee 维度）
     */
    function getVotes(address account) external view override returns (uint256) {
        return _delegateCheckpoints[account].latest();
    }

    /**
     * @notice 获取历史区块投票权（Governor 快照计票用）
     */
    function getPastVotes(address account, uint256 blockNumber) external view override returns (uint256) {
        
        // 边界检查：查询未来区块没有意义，且 upperLookupRecent 只能接受 uint32 的 blockNumber
        require(blockNumber < block.number, "block not yet mined");
        require(blockNumber <= type(uint32).max, "blockNumber too large");

        // OZ 4.9.6 中 getAtBlock 是一个internal函数，不能直接调用
        // 使用 upperLookupRecent 查历史快照
        return _delegateCheckpoints[account].upperLookupRecent(uint32(blockNumber));
    }

    /**
     * @notice 获取历史区块总投票权（quorum 用）
     */
    function getPastTotalSupply(uint256 blockNumber) external view override returns (uint256) {
        require(blockNumber < block.number, "block not yet mined");
        require(blockNumber <= type(uint32).max, "blockNumber too large");
        return _totalCheckpoints.upperLookupRecent(uint32(blockNumber));
    }

    // ---------------- internal ----------------

    function _delegate(address delegator, address delegatee) internal {
        address oldDelegate = delegates(delegator);
        _delegates[delegator] = delegatee;

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

    /// @dev 允许直接转账进合约（不计入投票权，作为保险/赞助）
    receive() external payable {}
}