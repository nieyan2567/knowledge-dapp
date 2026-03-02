// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TreasuryNative
 * @dev 模块化金库（原生币）
 *
 * 核心功能：
 * - 统一存放奖励资金
 * - 仅允许授权的 Spender 合约记账 (accrueReward)
 * - 用户主动提款 (claim)，防止 DoS
 * - Epoch 周期预算控制
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract TreasuryNative is Ownable, Pausable, ReentrancyGuard {
    // ====== Pull Payment：用户待领取余额 ======
    mapping(address => uint256) public pendingRewards;

    // ====== 授权业务合约 (Spender) ======
    mapping(address => bool) public isSpender;

    // ====== 预算控制 (Epoch) ======
    uint256 public epochDuration; 
    uint256 public epochBudget;   
    uint256 public epochStart;
    uint256 public epochSpent; // 当前 Epoch 已记账总额

    // 常量限制
    uint256 public constant MAX_EPOCH_BUDGET = 10_000 ether;
    uint256 public constant MIN_EPOCH_DURATION = 1 hours;
    uint256 public constant MAX_EPOCH_DURATION = 30 days;

    // Events
    event Funded(address indexed from, uint256 amount);
    event SpenderUpdated(address indexed spender, bool allowed);
    event BudgetUpdated(uint256 epochDuration, uint256 epochBudget);
    event RewardAccrued(address indexed spender, address indexed beneficiary, uint256 amount);
    event RewardClaimed(address indexed beneficiary, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    constructor(uint256 _epochDuration, uint256 _epochBudget) {
        require(_epochDuration >= MIN_EPOCH_DURATION && _epochDuration <= MAX_EPOCH_DURATION, "bad duration");
        require(_epochBudget <= MAX_EPOCH_BUDGET, "bad budget");
        
        epochDuration = _epochDuration;
        epochBudget = _epochBudget;
        epochStart = block.timestamp;

        emit BudgetUpdated(_epochDuration, _epochBudget);
    }

    // ---------------- Admin / DAO ----------------

    function setSpender(address spender, bool allowed) external onlyOwner {
        require(spender != address(0), "spender=0");
        isSpender[spender] = allowed;
        emit SpenderUpdated(spender, allowed);
    }

    function setBudget(uint256 _epochDuration, uint256 _epochBudget) external onlyOwner {
        require(_epochDuration >= MIN_EPOCH_DURATION && _epochDuration <= MAX_EPOCH_DURATION, "bad duration");
        require(_epochBudget <= MAX_EPOCH_BUDGET, "bad budget");
        epochDuration = _epochDuration;
        epochBudget = _epochBudget;
        emit BudgetUpdated(_epochDuration, _epochBudget);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice 紧急提现 (仅限 Owner/Timelock)
     */
    function withdrawTreasury(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(address(this).balance >= amount, "insufficient balance");
        
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
        
        emit TreasuryWithdrawn(to, amount);
    }

    // ---------------- Funds In ----------------

    function fund() external payable {
        require(msg.value > 0, "fund=0");
        emit Funded(msg.sender, msg.value);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ---------------- Rewards Out (Pull Payment) ----------------

    /**
     * @notice 业务合约记账发放
     * @dev 仅允许 isSpender=true 的合约调用。
     *      此处不直接转账，只增加 pendingRewards。
     */
    function accrueReward(address beneficiary, uint256 amount) external whenNotPaused {
        require(isSpender[msg.sender], "not authorized spender");
        require(beneficiary != address(0), "beneficiary=0");
        require(amount > 0, "amount=0");

        _rollEpochIfNeeded();

        // 1. 预算检查 (硬限制)
        require(epochSpent + amount <= epochBudget, "epoch budget exceeded");
        
        // 2. 余额检查 (可选策略)
        // 如果希望严格保证“记账即有钱”，保留此行。
        // 如果希望允许“先记账后充值”(赊账模式)，请注释掉此行。
        require(address(this).balance >= amount, "insufficient pool");

        // 更新状态
        epochSpent += amount;
        pendingRewards[beneficiary] += amount;

        emit RewardAccrued(msg.sender, beneficiary, amount);
    }

    /**
     * @notice 用户领取奖励
     * @dev 使用 nonReentrant 防止重入攻击
     */
    function claim() external whenNotPaused nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "no reward available");

        // 遵循 CEI 模式：先清零状态，再交互
        pendingRewards[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");

        emit RewardClaimed(msg.sender, amount);
    }

    // ---------------- Internal Helpers ----------------

    function _rollEpochIfNeeded() internal {
        if (block.timestamp >= epochStart + epochDuration) {
            epochStart = block.timestamp;
            epochSpent = 0;
        }
    }
}