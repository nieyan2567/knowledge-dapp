// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title RevenueVault
 * @notice 协议收入金库，用于归集原生币收入，并在 Treasury 与 Faucet 之间分配。
 * @dev
 * 核心职责：
 * 1. 接收协议收入、区块奖励或人工注资。
 * 2. 按 `faucetShareBps` 计算应预留给 Faucet 的份额，并累计到 `faucetPending`。
 * 3. 在满足条件时，自动或手动将资金回填到 Treasury。
 * 4. 在满足条件时，自动或手动向 Faucet 钱包发放资金。
 * 5. 维护收入处理统计，确保“已观察收入”和“已处理收入”之间可追踪。
 */
contract RevenueVault is Ownable, Pausable, ReentrancyGuard {
    /// @notice 基点制分母，10_000 代表 100%。
    uint16 public constant MAX_BPS = 10_000;
    /// @notice Treasury 目标余额上限，防止治理把目标值设置得过高。
    uint256 public constant MAX_TARGET_TREASURY_BALANCE = 100_000 ether;
    /// @notice Treasury 自动回填冷却期的上限。
    uint256 public constant MAX_REFILL_COOLDOWN = 30 days;

    /// @notice Treasury 合约或钱包地址，回填资金会发送到这里。
    address payable public treasury;
    /// @notice Faucet 钱包地址，预留给社区水龙头或补贴发放的资金会发送到这里。
    address payable public faucetWallet;

    /// @notice 收入中分配给 Faucet 的比例，单位为基点。
    uint16 public faucetShareBps;
    /// @notice 已为 Faucet 预留但尚未发放的金额。
    uint256 public faucetPending;
    /// @notice 自动向 Faucet 发放时所需达到的最小金额。
    uint256 public minFaucetPayout;

    /// @notice 当 Treasury 余额低于该阈值时，允许触发自动回填。
    uint256 public refillThreshold;
    /// @notice 希望 Treasury 最终维持到的目标余额。
    uint256 public targetTreasuryBalance;
    /// @notice 单次回填 Treasury 时允许执行的最小金额。
    uint256 public minRefillAmount;
    /// @notice 两次自动回填之间的最小间隔时间。
    uint256 public refillCooldown;
    /// @notice 上次成功向 Treasury 回填的时间戳。
    uint256 public lastRefillAt;

    /// @notice 自部署以来累计已处理的总收入。
    uint256 public totalRevenueProcessed;
    /// @notice 自部署以来累计回填到 Treasury 的总金额。
    uint256 public totalTreasuryRefilled;
    /// @notice 自部署以来累计发放到 Faucet 的总金额。
    uint256 public totalFaucetReleased;
    /// @notice 自部署以来 owner 从 Vault 提走的收入总额。
    uint256 public totalRevenueWithdrawn;

    /// @notice 是否启用 Treasury 自动回填逻辑。
    bool public autoRefillEnabled;
    /// @notice 是否启用 Faucet 自动发放逻辑。
    bool public autoFaucetEnabled;

    /**
     * @notice 合约收到原生币时触发。
     * @param from 资金发送方地址。
     * @param amount 本次收到的金额。
     */
    event RevenueReceived(address indexed from, uint256 amount);

    /**
     * @notice 新收入被同步入账时触发。
     * @param newRevenue 本次新增识别到的收入金额。
     * @param faucetAllocated 本次新收入中分配给 Faucet 的金额。
     * @param faucetPendingTotal 同步完成后 Faucet 的累计待发放金额。
     */
    event RevenueSynced(
        uint256 newRevenue,
        uint256 faucetAllocated,
        uint256 faucetPendingTotal
    );

    /**
     * @notice Treasury 地址更新时触发。
     * @param treasury 新的 Treasury 地址。
     */
    event TreasuryUpdated(address indexed treasury);

    /**
     * @notice Faucet 配置更新时触发。
     * @param faucetWallet 新的 Faucet 钱包地址。
     * @param faucetShareBps 新的 Faucet 分成比例，单位为基点。
     * @param minFaucetPayout 新的自动发放最小金额。
     * @param autoFaucetEnabled 是否启用自动 Faucet 发放。
     */
    event FaucetConfigUpdated(
        address indexed faucetWallet,
        uint16 faucetShareBps,
        uint256 minFaucetPayout,
        bool autoFaucetEnabled
    );

    /**
     * @notice Treasury 回填策略更新时触发。
     * @param refillThreshold 触发自动回填的 Treasury 余额阈值。
     * @param targetTreasuryBalance 希望补足到的 Treasury 目标余额。
     * @param minRefillAmount 单次自动回填的最小金额。
     * @param refillCooldown 自动回填冷却期。
     */
    event RefillPolicyUpdated(
        uint256 refillThreshold,
        uint256 targetTreasuryBalance,
        uint256 minRefillAmount,
        uint256 refillCooldown
    );

    /**
     * @notice 自动回填开关更新时触发。
     * @param enabled 是否启用自动回填。
     */
    event AutoRefillUpdated(bool enabled);

    /**
     * @notice 成功向 Treasury 回填资金时触发。
     * @param caller 触发本次回填的调用者。
     * @param treasury 接收资金的 Treasury 地址。
     * @param amount 本次回填金额。
     * @param treasuryBalanceAfter 回填完成后 Treasury 的余额。
     */
    event TreasuryRefilled(
        address indexed caller,
        address indexed treasury,
        uint256 amount,
        uint256 treasuryBalanceAfter
    );

    /**
     * @notice 成功向 Faucet 发放资金时触发。
     * @param caller 触发本次发放的调用者。
     * @param faucetWallet 接收资金的 Faucet 钱包地址。
     * @param amount 本次发放金额。
     */
    event FaucetPaid(
        address indexed caller,
        address indexed faucetWallet,
        uint256 amount
    );

    /**
     * @notice Owner 从 Vault 提取未预留收入时触发。
     * @param to 接收提取资金的地址。
     * @param amount 本次提取金额。
     */
    event RevenueWithdrawn(address indexed to, uint256 amount);

    /**
     * @notice 部署 RevenueVault 并初始化 Treasury、Faucet 与自动回填策略。
     * @param _treasury 初始 Treasury 地址。
     * @param _faucetWallet 初始 Faucet 钱包地址。
     * @param _faucetShareBps 初始 Faucet 分成比例，单位为基点。
     * @param _minFaucetPayout 初始自动 Faucet 发放的最小金额。
     * @param _refillThreshold Treasury 触发自动回填的余额阈值。
     * @param _targetTreasuryBalance Treasury 目标余额。
     * @param _minRefillAmount 单次自动回填的最小金额。
     * @param _refillCooldown 自动回填冷却期。
     */
    constructor(
        address payable _treasury,
        address payable _faucetWallet,
        uint16 _faucetShareBps,
        uint256 _minFaucetPayout,
        uint256 _refillThreshold,
        uint256 _targetTreasuryBalance,
        uint256 _minRefillAmount,
        uint256 _refillCooldown
    ) {
        _setTreasury(_treasury);
        _setFaucetConfig(
            _faucetWallet,
            _faucetShareBps,
            _minFaucetPayout,
            true
        );
        _setRefillPolicy(
            _refillThreshold,
            _targetTreasuryBalance,
            _minRefillAmount,
            _refillCooldown
        );

        autoRefillEnabled = true;
        emit AutoRefillUpdated(true);
    }

    /**
     * @notice 更新 Treasury 地址。
     * @param _treasury 新的 Treasury 地址。
     */
    function setTreasury(address payable _treasury) external onlyOwner {
        _setTreasury(_treasury);
    }

    /**
     * @notice 更新 Faucet 钱包及其发放策略。
     * @dev 为避免旧收入按新参数被错误计算，更新前会先执行一次收入同步。
     * @param _faucetWallet 新的 Faucet 钱包地址。
     * @param _faucetShareBps 新的 Faucet 分成比例，单位为基点。
     * @param _minFaucetPayout 自动发放所需达到的最小金额。
     * @param _autoFaucetEnabled 是否启用自动 Faucet 发放。
     */
    function setFaucetConfig(
        address payable _faucetWallet,
        uint16 _faucetShareBps,
        uint256 _minFaucetPayout,
        bool _autoFaucetEnabled
    ) external onlyOwner {
        _syncRevenue();
        _setFaucetConfig(
            _faucetWallet,
            _faucetShareBps,
            _minFaucetPayout,
            _autoFaucetEnabled
        );
    }

    /**
     * @notice 更新 Treasury 自动回填策略。
     * @param _refillThreshold Treasury 触发自动回填的余额阈值。
     * @param _targetTreasuryBalance 希望 Treasury 被补到的目标余额。
     * @param _minRefillAmount 单次自动回填的最小金额。
     * @param _refillCooldown 两次自动回填之间的冷却期。
     */
    function setRefillPolicy(
        uint256 _refillThreshold,
        uint256 _targetTreasuryBalance,
        uint256 _minRefillAmount,
        uint256 _refillCooldown
    ) external onlyOwner {
        _setRefillPolicy(
            _refillThreshold,
            _targetTreasuryBalance,
            _minRefillAmount,
            _refillCooldown
        );
    }

    /**
     * @notice 启用或关闭 Treasury 自动回填。
     * @param enabled 新的自动回填开关状态。
     */
    function setAutoRefillEnabled(bool enabled) external onlyOwner {
        autoRefillEnabled = enabled;
        emit AutoRefillUpdated(enabled);
    }

    /**
     * @notice 暂停收入同步、自动回填、自动发放和手动操作等核心流程。
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice 解除暂停，恢复 RevenueVault 正常运行。
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice 计算 Vault 自部署以来累计观察到的总收入。
     * @dev
     * 公式为：当前余额 + 已回填给 Treasury 的金额 + 已发给 Faucet 的金额 + 已被 owner 提走的金额。
     * 这样即便资金已经离开合约，仍能回推历史总收入。
     * @return 自部署以来累计观察到的总收入。
     */
    function totalObservedRevenue() public view returns (uint256) {
        return
            address(this).balance +
            totalTreasuryRefilled +
            totalFaucetReleased +
            totalRevenueWithdrawn;
    }

    /**
     * @notice 查询当前尚未同步入账的新收入。
     * @return 尚未计入 `totalRevenueProcessed` 的收入金额。
     */
    function unprocessedRevenue() public view returns (uint256) {
        uint256 observed = totalObservedRevenue();
        if (observed <= totalRevenueProcessed) {
            return 0;
        }

        return observed - totalRevenueProcessed;
    }

    /**
     * @notice 预测当前若立即同步收入后，Faucet 应累计保留的总金额。
     * @return 当前 `faucetPending` 加上未处理收入对应的 Faucet 份额后的总额。
     */
    function projectedFaucetPending() public view returns (uint256) {
        return faucetPending + (unprocessedRevenue() * faucetShareBps) / MAX_BPS;
    }

    /**
     * @notice 计算在保留 Faucet 预留金后，可用于 Treasury 的资金。
     * @return 当前 Vault 可安全用于回填 Treasury 的金额。
     */
    function availableForTreasury() public view returns (uint256) {
        uint256 projectedPending = projectedFaucetPending();
        uint256 vaultBalance = address(this).balance;
        if (projectedPending >= vaultBalance) {
            return 0;
        }

        return vaultBalance - projectedPending;
    }

    /**
     * @notice 查询 Treasury 当前余额。
     * @return Treasury 地址持有的原生币余额。
     */
    function treasuryBalance() public view returns (uint256) {
        return treasury.balance;
    }

    /**
     * @notice 计算 Treasury 距离目标余额还差多少。
     * @return 若 Treasury 余额低于目标则返回缺口，否则返回 0。
     */
    function treasuryDeficit() public view returns (uint256) {
        uint256 currentTreasuryBalance = treasury.balance;
        if (currentTreasuryBalance >= targetTreasuryBalance) {
            return 0;
        }

        return targetTreasuryBalance - currentTreasuryBalance;
    }

    /**
     * @notice 计算当前理论上最多可回填给 Treasury 的金额。
     * @dev 回填上限取 Treasury 缺口与 Vault 可支配余额中的较小值。
     * @return 当前最大可回填金额。
     */
    function maxRefillAmount() public view returns (uint256) {
        uint256 deficit = treasuryDeficit();
        uint256 available = availableForTreasury();

        if (deficit == 0 || available == 0) {
            return 0;
        }

        return deficit < available ? deficit : available;
    }

    /**
     * @notice 判断当前是否满足自动回填 Treasury 的条件。
     * @return 若自动回填开启、Treasury 余额低于阈值、冷却期已过且金额足够，则返回 true。
     */
    function needsRefill() public view returns (bool) {
        if (!autoRefillEnabled) {
            return false;
        }
        if (treasury.balance >= refillThreshold) {
            return false;
        }
        if (block.timestamp < lastRefillAt + refillCooldown) {
            return false;
        }

        return maxRefillAmount() >= minRefillAmount;
    }

    /**
     * @notice 判断当前是否满足自动向 Faucet 发放的条件。
     * @return 若自动 Faucet 开启且待发放金额达到阈值，则返回 true。
     */
    function needsFaucetPayout() public view returns (bool) {
        if (!autoFaucetEnabled) {
            return false;
        }

        return projectedFaucetPending() >= minFaucetPayout;
    }

    /**
     * @notice 手动同步新收入，把未处理收入计入系统状态。
     * @return newRevenue 本次识别并同步的新增收入金额。
     */
    function syncRevenue() external whenNotPaused returns (uint256 newRevenue) {
        newRevenue = _syncRevenue();
    }

    /**
     * @notice 一次性执行“同步收入 + Faucet 发放 + Treasury 回填”。
     * @dev 若某一步当前不满足条件，则该步骤返回 0，不会强制失败。
     * @return faucetAmount 本次发放到 Faucet 的金额。
     * @return treasuryAmount 本次回填到 Treasury 的金额。
     */
    function rebalance()
        external
        whenNotPaused
        nonReentrant
        returns (uint256 faucetAmount, uint256 treasuryAmount)
    {
        _syncRevenue();

        faucetAmount = _releaseFaucetIfNeeded();
        treasuryAmount = _tryRefillTreasury();
    }

    /**
     * @notice 当满足条件时执行 Treasury 回填。
     * @dev 调用前会先同步收入，并尝试先发放 Faucet，确保 Treasury 只使用可支配余额。
     * @return amount 本次回填到 Treasury 的金额。
     */
    function refillTreasuryIfNeeded()
        external
        whenNotPaused
        nonReentrant
        returns (uint256 amount)
    {
        _syncRevenue();
        _releaseFaucetIfNeeded();
        amount = _refillTreasuryIfNeeded();
    }

    /**
     * @notice 当满足条件时向 Faucet 发放资金。
     * @dev 若当前不满足发放条件会直接 revert。
     * @return amount 本次发放到 Faucet 的金额。
     */
    function releaseFaucetIfNeeded()
        external
        whenNotPaused
        nonReentrant
        returns (uint256 amount)
    {
        _syncRevenue();
        amount = _releaseFaucetIfNeeded();
        require(amount > 0, "faucet payout not needed");
    }

    /**
     * @notice Owner 手动向 Treasury 回填指定金额。
     * @dev 仅允许使用扣除 Faucet 预留金后的可支配余额。
     * @param amount 本次手动回填金额。
     */
    function manualRefill(uint256 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        _syncRevenue();
        require(amount > 0, "amount=0");
        require(amount <= availableForTreasury(), "insufficient treasury reserve");

        _transferToTreasury(amount);
    }

    /**
     * @notice Owner 手动向 Faucet 发放指定金额。
     * @dev 仅允许从 `faucetPending` 预留金额中支出。
     * @param amount 本次手动发放金额。
     */
    function manualPayoutToFaucet(uint256 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        _syncRevenue();
        require(amount > 0, "amount=0");
        require(amount <= faucetPending, "insufficient faucet reserve");

        _payFaucet(amount);
    }

    /**
     * @notice Owner 提取 Vault 中未被预留给 Faucet 的收入。
     * @dev
     * 该函数不会动用 `faucetPending` 预留资金。
     * 若未来还有额外预留逻辑，也应在这里一并扣除。
     * @param to 接收提取资金的目标地址。
     * @param amount 本次提取金额。
     */
    function withdrawRevenue(address payable to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        _syncRevenue();
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(
            amount <= address(this).balance - faucetPending,
            "reserved revenue"
        );

        totalRevenueWithdrawn += amount;

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");

        emit RevenueWithdrawn(to, amount);
    }

    /**
     * @notice 设置 Treasury 地址的内部实现。
     * @param _treasury 新的 Treasury 地址。
     */
    function _setTreasury(address payable _treasury) internal {
        require(_treasury != address(0), "treasury=0");
        treasury = _treasury;

        emit TreasuryUpdated(_treasury);
    }

    /**
     * @notice 设置 Faucet 参数的内部实现。
     * @param _faucetWallet Faucet 钱包地址。
     * @param _faucetShareBps Faucet 分成比例，单位为基点。
     * @param _minFaucetPayout 自动发放最小金额。
     * @param _autoFaucetEnabled 是否启用自动发放。
     */
    function _setFaucetConfig(
        address payable _faucetWallet,
        uint16 _faucetShareBps,
        uint256 _minFaucetPayout,
        bool _autoFaucetEnabled
    ) internal {
        require(_faucetWallet != address(0), "faucet=0");
        require(_faucetShareBps <= MAX_BPS, "bad bps");
        require(_minFaucetPayout > 0, "min faucet=0");

        faucetWallet = _faucetWallet;
        faucetShareBps = _faucetShareBps;
        minFaucetPayout = _minFaucetPayout;
        autoFaucetEnabled = _autoFaucetEnabled;

        emit FaucetConfigUpdated(
            _faucetWallet,
            _faucetShareBps,
            _minFaucetPayout,
            _autoFaucetEnabled
        );
    }

    /**
     * @notice 设置 Treasury 回填策略的内部实现。
     * @param _refillThreshold Treasury 自动回填触发阈值。
     * @param _targetTreasuryBalance Treasury 目标余额。
     * @param _minRefillAmount 单次回填最小金额。
     * @param _refillCooldown 回填冷却期。
     */
    function _setRefillPolicy(
        uint256 _refillThreshold,
        uint256 _targetTreasuryBalance,
        uint256 _minRefillAmount,
        uint256 _refillCooldown
    ) internal {
        require(_targetTreasuryBalance > 0, "target=0");
        require(
            _targetTreasuryBalance <= MAX_TARGET_TREASURY_BALANCE,
            "target too high"
        );
        require(_refillThreshold <= _targetTreasuryBalance, "bad threshold");
        require(_minRefillAmount > 0, "min refill=0");
        require(_refillCooldown <= MAX_REFILL_COOLDOWN, "cooldown too long");

        refillThreshold = _refillThreshold;
        targetTreasuryBalance = _targetTreasuryBalance;
        minRefillAmount = _minRefillAmount;
        refillCooldown = _refillCooldown;

        emit RefillPolicyUpdated(
            _refillThreshold,
            _targetTreasuryBalance,
            _minRefillAmount,
            _refillCooldown
        );
    }

    /**
     * @notice 同步未处理收入到系统状态。
     * @dev
     * 会把新增收入按比例切分出 Faucet 预留份额，并推进 `totalRevenueProcessed`。
     * @return newRevenue 本次新同步的收入金额。
     */
    function _syncRevenue() internal returns (uint256 newRevenue) {
        uint256 observed = totalObservedRevenue();
        if (observed <= totalRevenueProcessed) {
            return 0;
        }

        newRevenue = observed - totalRevenueProcessed;
        uint256 faucetAllocation = (newRevenue * faucetShareBps) / MAX_BPS;

        faucetPending += faucetAllocation;
        totalRevenueProcessed = observed;

        emit RevenueSynced(newRevenue, faucetAllocation, faucetPending);
    }

    /**
     * @notice 若满足条件则向 Faucet 发放全部待发金额。
     * @return amount 本次实际发放金额；若未满足条件则返回 0。
     */
    function _releaseFaucetIfNeeded() internal returns (uint256 amount) {
        if (!autoFaucetEnabled || faucetPending < minFaucetPayout) {
            return 0;
        }

        amount = faucetPending;
        _payFaucet(amount);
    }

    /**
     * @notice 当必须满足回填条件时执行 Treasury 回填。
     * @dev 若当前不满足 `needsRefill` 或金额低于阈值会直接 revert。
     * @return amount 本次实际回填金额。
     */
    function _refillTreasuryIfNeeded() internal returns (uint256 amount) {
        require(needsRefill(), "refill not needed");

        amount = maxRefillAmount();
        require(amount >= minRefillAmount, "refill too small");

        _transferToTreasury(amount);
    }

    /**
     * @notice 尝试执行 Treasury 回填，但在条件不满足时静默返回 0。
     * @return amount 本次实际回填金额；若无需回填则返回 0。
     */
    function _tryRefillTreasury() internal returns (uint256 amount) {
        if (!needsRefill()) {
            return 0;
        }

        amount = maxRefillAmount();
        if (amount < minRefillAmount) {
            return 0;
        }

        _transferToTreasury(amount);
    }

    /**
     * @notice 向 Treasury 实际转账，并更新相关统计信息。
     * @param amount 本次转入 Treasury 的金额。
     */
    function _transferToTreasury(uint256 amount) internal {
        totalTreasuryRefilled += amount;
        lastRefillAt = block.timestamp;

        (bool ok, ) = treasury.call{value: amount}("");
        require(ok, "treasury transfer failed");

        emit TreasuryRefilled(msg.sender, treasury, amount, treasury.balance);
    }

    /**
     * @notice 向 Faucet 钱包实际转账，并扣减预留金额。
     * @param amount 本次发给 Faucet 的金额。
     */
    function _payFaucet(uint256 amount) internal {
        faucetPending -= amount;
        totalFaucetReleased += amount;

        (bool ok, ) = faucetWallet.call{value: amount}("");
        require(ok, "faucet transfer failed");

        emit FaucetPaid(msg.sender, faucetWallet, amount);
    }

    /**
     * @notice 接收原生币收入。
     * @dev 该函数只记录事件，不会自动把收入计入已处理状态，需后续调用同步逻辑。
     */
    receive() external payable {
        emit RevenueReceived(msg.sender, msg.value);
    }
}
