// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title FaucetVault
 * @notice 在链上托管 Faucet 资金，并根据后端授权签名发放启动资金。
 * @dev
 * 与“服务端热钱包直接转账”的做法不同，本合约将 Faucet 余额保存在链上：
 * 1. 服务端只负责对 claim 请求签名，不直接控制 Faucet 余额。
 * 2. 任意 relayer 都可以代为提交 claim 交易，但资金始终从本合约转出。
 * 3. 链上强制校验冷却时间、钱包余额门槛、预算上限、签名有效性与重放保护。
 * 4. 所有关键参数通过 onlyOwner 管理，部署后可将 owner 交给 Timelock 治理。
 */
contract FaucetVault is Ownable, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;

    /// @notice 每个预算周期允许发放的最大金额。
    uint256 public epochBudget;
    /// @notice 预算周期长度，单位为秒。
    uint256 public epochDuration;
    /// @notice 当前预算周期开始时间戳。
    uint256 public epochStartAt;
    /// @notice 当前预算周期内已发放金额。
    uint256 public epochSpent;

    /// @notice 单次领取金额。
    uint256 public claimAmount;
    /// @notice 允许领取时的钱包余额上限；当钱包余额大于等于该值时不能领取。
    uint256 public minAllowedBalance;
    /// @notice 同一钱包两次领取之间的冷却时间，单位为秒。
    uint256 public claimCooldown;
    /// @notice 用于对 claim 授权进行签名的后端地址。
    address public signer;

    /// @notice 记录每个钱包最近一次成功领取的时间戳。
    mapping(address => uint256) public lastClaimAt;
    /// @notice 记录已使用过的授权请求哈希，防止重放。
    mapping(bytes32 => bool) public usedClaims;

    /**
     * @notice 当后端签名地址更新时触发。
     * @param signer 新的授权签名地址。
     */
    event SignerUpdated(address indexed signer);

    /**
     * @notice 当领取规则更新时触发。
     * @param claimAmount 新的单次领取金额。
     * @param minAllowedBalance 新的钱包余额上限。
     * @param claimCooldown 新的领取冷却时间。
     */
    event ClaimConfigUpdated(
        uint256 claimAmount,
        uint256 minAllowedBalance,
        uint256 claimCooldown
    );

    /**
     * @notice 当预算规则更新时触发。
     * @param epochDuration 新的预算周期长度。
     * @param epochBudget 新的周期预算上限。
     */
    event BudgetConfigUpdated(uint256 epochDuration, uint256 epochBudget);

    /**
     * @notice 当合约收到资金时触发。
     * @param from 资金来源地址。
     * @param amount 本次收到的金额。
     */
    event RevenueReceived(address indexed from, uint256 amount);

    /**
     * @notice 当成功发放 Faucet 资金时触发。
     * @param relayer 提交 claim 交易的地址。
     * @param recipient 实际收到资金的钱包地址。
     * @param amount 本次发放金额。
     * @param deadline 本次授权的截止时间。
     * @param nonce 本次授权使用的随机 nonce。
     */
    event Claimed(
        address indexed relayer,
        address indexed recipient,
        uint256 amount,
        uint256 deadline,
        bytes32 indexed nonce
    );

    /**
     * @notice 部署 FaucetVault 并初始化签名地址、领取规则和预算配置。
     * @param _signer 后端授权签名地址。
     * @param _claimAmount 单次领取金额。
     * @param _minAllowedBalance 允许领取的钱包余额上限。
     * @param _claimCooldown 同一钱包领取冷却时间。
     * @param _epochDuration 预算周期长度。
     * @param _epochBudget 每个预算周期的预算上限。
     */
    constructor(
        address _signer,
        uint256 _claimAmount,
        uint256 _minAllowedBalance,
        uint256 _claimCooldown,
        uint256 _epochDuration,
        uint256 _epochBudget
    ) {
        _setSigner(_signer);
        _setClaimConfig(_claimAmount, _minAllowedBalance, _claimCooldown);
        _setBudgetConfig(_epochDuration, _epochBudget);
        epochStartAt = block.timestamp;
    }

    /**
     * @notice 接收 RevenueVault 或人工转入的原生币。
     */
    receive() external payable {
        emit RevenueReceived(msg.sender, msg.value);
    }

    /**
     * @notice 更新后端授权签名地址。
     * @param _signer 新的授权签名地址。
     */
    function setSigner(address _signer) external onlyOwner {
        _setSigner(_signer);
    }

    /**
     * @notice 更新领取规则。
     * @param _claimAmount 单次领取金额。
     * @param _minAllowedBalance 允许领取的钱包余额上限。
     * @param _claimCooldown 同一钱包领取冷却时间。
     */
    function setClaimConfig(
        uint256 _claimAmount,
        uint256 _minAllowedBalance,
        uint256 _claimCooldown
    ) external onlyOwner {
        _setClaimConfig(_claimAmount, _minAllowedBalance, _claimCooldown);
    }

    /**
     * @notice 更新预算规则。
     * @param _epochDuration 预算周期长度。
     * @param _epochBudget 周期预算上限。
     */
    function setBudgetConfig(
        uint256 _epochDuration,
        uint256 _epochBudget
    ) external onlyOwner {
        _setBudgetConfig(_epochDuration, _epochBudget);
    }

    /**
     * @notice 暂停 Faucet 发放。
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice 恢复 Faucet 发放。
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice 查询当前预算周期剩余可发放金额。
     * @return 当前周期剩余预算。
     */
    function availableBudget() public view returns (uint256) {
        if (_isCurrentEpochExpired()) {
            return epochBudget;
        }

        if (epochSpent >= epochBudget) {
            return 0;
        }

        return epochBudget - epochSpent;
    }

    /**
     * @notice 检查某个钱包当前是否满足领取条件。
     * @param recipient 待检查的钱包地址。
     * @return eligible 是否满足领取条件。
     * @return reason 不满足条件时的原因。
     */
    function canClaim(
        address recipient
    ) external view returns (bool eligible, string memory reason) {
        if (paused()) return (false, "paused");
        if (recipient == address(0)) return (false, "recipient=0");
        if (recipient.balance >= minAllowedBalance) return (false, "balance high");

        uint256 nextClaimAt = lastClaimAt[recipient] + claimCooldown;
        if (lastClaimAt[recipient] != 0 && block.timestamp < nextClaimAt) {
            return (false, "cooldown");
        }

        if (address(this).balance < claimAmount) {
            return (false, "insufficient faucet balance");
        }

        if (availableBudget() < claimAmount) {
            return (false, "budget exceeded");
        }

        return (true, "");
    }

    /**
     * @notice 根据后端授权签名发放 Faucet 资金。
     * @dev 任意 relayer 都可提交该交易，但资金始终由本合约转出。
     * @param recipient 接收 Faucet 资金的钱包地址。
     * @param amount 本次领取金额，必须等于当前 claimAmount。
     * @param deadline 本次授权的截止时间。
     * @param nonce 本次授权使用的随机 nonce。
     * @param signature 后端签名地址对 claim 请求生成的签名。
     */
    function claim(
        address payable recipient,
        uint256 amount,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        require(recipient != address(0), "recipient=0");
        require(amount == claimAmount, "bad amount");
        require(block.timestamp <= deadline, "expired");
        require(recipient.balance < minAllowedBalance, "balance high");

        uint256 nextClaimAt = lastClaimAt[recipient] + claimCooldown;
        require(
            lastClaimAt[recipient] == 0 || block.timestamp >= nextClaimAt,
            "cooldown"
        );

        _rollEpochIfNeeded();
        require(epochSpent + amount <= epochBudget, "budget exceeded");

        bytes32 requestHash = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                recipient,
                amount,
                deadline,
                nonce
            )
        );

        require(!usedClaims[requestHash], "already used");

        address recoveredSigner = requestHash.toEthSignedMessageHash().recover(signature);
        require(recoveredSigner == signer, "bad signer");
        require(address(this).balance >= amount, "insufficient balance");

        usedClaims[requestHash] = true;
        lastClaimAt[recipient] = block.timestamp;
        epochSpent += amount;

        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "transfer failed");

        emit Claimed(msg.sender, recipient, amount, deadline, nonce);
    }

    /**
     * @notice 判断当前预算周期是否已经结束。
     * @return 是否到达下一个预算周期。
     */
    function _isCurrentEpochExpired() internal view returns (bool) {
        return block.timestamp >= epochStartAt + epochDuration;
    }

    /**
     * @notice 在需要时滚动到新的预算周期，并重置当前周期已花费金额。
     */
    function _rollEpochIfNeeded() internal {
        if (!_isCurrentEpochExpired()) {
            return;
        }

        uint256 elapsed = block.timestamp - epochStartAt;
        uint256 cycles = elapsed / epochDuration;
        epochStartAt += cycles * epochDuration;
        epochSpent = 0;
    }

    /**
     * @notice 内部更新授权签名地址。
     * @param _signer 新的授权签名地址。
     */
    function _setSigner(address _signer) internal {
        require(_signer != address(0), "signer=0");
        signer = _signer;
        emit SignerUpdated(_signer);
    }

    /**
     * @notice 内部更新领取规则。
     * @param _claimAmount 单次领取金额。
     * @param _minAllowedBalance 允许领取的钱包余额上限。
     * @param _claimCooldown 同一钱包领取冷却时间。
     */
    function _setClaimConfig(
        uint256 _claimAmount,
        uint256 _minAllowedBalance,
        uint256 _claimCooldown
    ) internal {
        require(_claimAmount > 0, "claimAmount=0");
        require(_minAllowedBalance > 0, "minBalance=0");

        claimAmount = _claimAmount;
        minAllowedBalance = _minAllowedBalance;
        claimCooldown = _claimCooldown;

        emit ClaimConfigUpdated(_claimAmount, _minAllowedBalance, _claimCooldown);
    }

    /**
     * @notice 内部更新预算规则。
     * @param _epochDuration 预算周期长度。
     * @param _epochBudget 周期预算上限。
     */
    function _setBudgetConfig(
        uint256 _epochDuration,
        uint256 _epochBudget
    ) internal {
        require(_epochDuration > 0, "epochDuration=0");
        require(_epochBudget > 0, "epochBudget=0");

        epochDuration = _epochDuration;
        epochBudget = _epochBudget;

        emit BudgetConfigUpdated(_epochDuration, _epochBudget);
    }
}