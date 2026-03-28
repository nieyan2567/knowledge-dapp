// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TreasuryNative
 * @notice 原生币奖励金库，负责统一保管奖励资金并采用 Pull Payment 方式发放。
 * @dev
 * 核心职责：
 * 1. 接收外部注资，作为内容奖励或协议支出的资金池。
 * 2. 只允许授权的业务合约为用户记账奖励，避免任意地址直接修改奖励数据。
 * 3. 用户通过 `claim` 主动领取奖励，降低批量转账带来的 DoS 风险。
 * 4. 通过 Epoch 周期预算限制单个周期内最多可记账的奖励总额。
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract TreasuryNative is Ownable, Pausable, ReentrancyGuard {
    /// @notice 记录每个地址当前累计待领取的奖励金额。
    mapping(address => uint256) public pendingRewards;
    /// @notice 所有用户待领取奖励的总和，用于保护金库保留余额。
    uint256 public totalPendingRewards;

    /// @notice 记录哪些业务合约被授权调用 `accrueReward` 记账奖励。
    mapping(address => bool) public isSpender;

    /// @notice 单个预算周期的时长，单位为秒。
    uint256 public epochDuration; 
    /// @notice 单个预算周期内允许累计记账的最大金额。
    uint256 public epochBudget;   
    /// @notice 当前预算周期开始的时间戳。
    uint256 public epochStart;
    /// @notice 当前预算周期内已经记账的奖励总额。
    uint256 public epochSpent;

    /// @notice 单个预算周期允许设置的最大预算。
    uint256 public constant MAX_EPOCH_BUDGET = 10_000 ether;
    /// @notice 预算周期时长的最小值。
    uint256 public constant MIN_EPOCH_DURATION = 1 hours;
    /// @notice 预算周期时长的最大值。
    uint256 public constant MAX_EPOCH_DURATION = 30 days;

    /**
     * @notice 金库收到资金时触发。
     * @param from 资金发送方地址。
     * @param amount 本次注入的金额。
     */
    event Funded(address indexed from, uint256 amount);

    /**
     * @notice Spender 授权状态更新时触发。
     * @param spender 被更新的业务合约地址。
     * @param allowed 是否允许该地址调用 `accrueReward`。
     */
    event SpenderUpdated(address indexed spender, bool allowed);

    /**
     * @notice Epoch 预算配置更新时触发。
     * @param epochDuration 新的预算周期时长。
     * @param epochBudget 新的预算周期总额度。
     */
    event BudgetUpdated(uint256 epochDuration, uint256 epochBudget);

    /**
     * @notice 授权业务合约为用户记账奖励时触发。
     * @param spender 发起记账的授权业务合约地址。
     * @param beneficiary 获得奖励的用户地址。
     * @param amount 本次记账的奖励金额。
     */
    event RewardAccrued(address indexed spender, address indexed beneficiary, uint256 amount);

    /**
     * @notice 用户领取奖励成功时触发。
     * @param beneficiary 领取奖励的用户地址。
     * @param amount 本次领取的金额。
     */
    event RewardClaimed(address indexed beneficiary, uint256 amount);

    /**
     * @notice Owner 提走金库中未预留余额时触发。
     * @param to 接收提取资金的地址。
     * @param amount 本次提取金额。
     */
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    /**
     * @notice 部署 Treasury 并初始化预算周期参数。
     * @param _epochDuration 单个预算周期的时长。
     * @param _epochBudget 单个预算周期内允许累计记账的最大金额。
     */
    constructor(uint256 _epochDuration, uint256 _epochBudget) {
        require(_epochDuration >= MIN_EPOCH_DURATION && _epochDuration <= MAX_EPOCH_DURATION, "bad duration");
        require(_epochBudget <= MAX_EPOCH_BUDGET, "bad budget");
        
        epochDuration = _epochDuration;
        epochBudget = _epochBudget;
        epochStart = block.timestamp;

        emit BudgetUpdated(_epochDuration, _epochBudget);
    }

    /**
     * @notice 设置某个业务合约是否具备奖励记账权限。
     * @param spender 业务合约地址。
     * @param allowed 是否授权该地址调用 `accrueReward`。
     */
    function setSpender(address spender, bool allowed) external onlyOwner {
        require(spender != address(0), "spender=0");
        isSpender[spender] = allowed;
        emit SpenderUpdated(spender, allowed);
    }

    /**
     * @notice 更新预算周期和周期预算。
     * @param _epochDuration 新的预算周期时长。
     * @param _epochBudget 新的预算周期额度。
     */
    function setBudget(uint256 _epochDuration, uint256 _epochBudget) external onlyOwner {
        require(_epochDuration >= MIN_EPOCH_DURATION && _epochDuration <= MAX_EPOCH_DURATION, "bad duration");
        require(_epochBudget <= MAX_EPOCH_BUDGET, "bad budget");
        epochDuration = _epochDuration;
        epochBudget = _epochBudget;
        emit BudgetUpdated(_epochDuration, _epochBudget);
    }

    /**
     * @notice 暂停奖励记账与用户领取。
     */
    function pause() external onlyOwner { _pause(); }

    /**
     * @notice 解除暂停，恢复金库正常运行。
     */
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice 紧急提取金库中的可用余额。
     * @dev
     * 仅限 owner 或其背后的 Timelock 调用。
     * 提款后仍必须保证剩余余额不低于 `totalPendingRewards`，避免挪用已为用户记账的奖励。
     * @param to 接收提款的目标地址。
     * @param amount 本次提取金额。
     */
    function withdrawTreasury(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(address(this).balance >= amount, "insufficient balance");
        require(address(this).balance - amount >= totalPendingRewards, "reserved rewards");
        
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
        
        emit TreasuryWithdrawn(to, amount);
    }

    /**
     * @notice 主动向金库注资。
     * @dev 任何地址都可以调用，为奖励池补充原生币。
     */
    function fund() external payable {
        require(msg.value > 0, "fund=0");
        emit Funded(msg.sender, msg.value);
    }

    /**
     * @notice 直接向合约转账时接收资金。
     * @dev 与 `fund` 一样，只负责接收资金并记录事件。
     */
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /**
     * @notice 授权业务合约为用户累计待领取奖励。
     * @dev
     * 1. 仅允许 `isSpender[msg.sender] == true` 的合约调用。
     * 2. 此函数只做记账，不直接转账给用户。
     * 3. 会校验 Epoch 预算上限，以及金库是否有足够余额覆盖新增记账。
     * @param beneficiary 奖励接收人地址。
     * @param amount 本次要累计的奖励金额。
     */
    function accrueReward(address beneficiary, uint256 amount) external whenNotPaused {
        require(isSpender[msg.sender], "not authorized spender");
        require(beneficiary != address(0), "beneficiary=0");
        require(amount > 0, "amount=0");

        _rollEpochIfNeeded();

        // 预算硬限制：当前周期内累计记账不能超过预算。
        require(epochSpent + amount <= epochBudget, "epoch budget exceeded");
        
        // 余额保护：确保记账后，金库余额仍能覆盖全部待领取奖励。
        require(address(this).balance >= totalPendingRewards + amount, "insufficient pool");

        // 更新待领取奖励和当前周期已使用预算。
        epochSpent += amount;
        pendingRewards[beneficiary] += amount;
        totalPendingRewards += amount;

        emit RewardAccrued(msg.sender, beneficiary, amount);
    }

    /**
     * @notice 用户主动领取自己已累计的奖励。
     * @dev
     * 使用 Pull Payment 模式，由用户自己发起提款。
     * 为防止重入攻击，采用 `nonReentrant` 并遵循 CEI 顺序。
     */
    function claim() external whenNotPaused nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "no reward available");

        // 先更新状态，再执行外部转账，避免重入。
        pendingRewards[msg.sender] = 0;
        totalPendingRewards -= amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");

        emit RewardClaimed(msg.sender, amount);
    }

    /**
     * @notice 在跨周期时重置当前 Epoch 的已使用预算。
     * @dev 若当前时间已超过当前周期结束时间，则开启新周期并清零 `epochSpent`。
     */
    function _rollEpochIfNeeded() internal {
        if (block.timestamp >= epochStart + epochDuration) {
            epochStart = block.timestamp;
            epochSpent = 0;
        }
    }
}
