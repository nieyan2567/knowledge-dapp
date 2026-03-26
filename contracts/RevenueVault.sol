// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title RevenueVault
 * @dev Collects protocol income or block rewards and distributes them between
 *      TreasuryNative and a faucet wallet.
 */
contract RevenueVault is Ownable, Pausable, ReentrancyGuard {
    uint16 public constant MAX_BPS = 10_000;
    uint256 public constant MAX_TARGET_TREASURY_BALANCE = 100_000 ether;
    uint256 public constant MAX_REFILL_COOLDOWN = 30 days;

    address payable public treasury;
    address payable public faucetWallet;

    uint16 public faucetShareBps;
    uint256 public faucetPending;
    uint256 public minFaucetPayout;

    uint256 public refillThreshold;
    uint256 public targetTreasuryBalance;
    uint256 public minRefillAmount;
    uint256 public refillCooldown;
    uint256 public lastRefillAt;

    uint256 public totalRevenueProcessed;
    uint256 public totalTreasuryRefilled;
    uint256 public totalFaucetReleased;
    uint256 public totalRevenueWithdrawn;

    bool public autoRefillEnabled;
    bool public autoFaucetEnabled;

    event RevenueReceived(address indexed from, uint256 amount);
    event RevenueSynced(
        uint256 newRevenue,
        uint256 faucetAllocated,
        uint256 faucetPendingTotal
    );
    event TreasuryUpdated(address indexed treasury);
    event FaucetConfigUpdated(
        address indexed faucetWallet,
        uint16 faucetShareBps,
        uint256 minFaucetPayout,
        bool autoFaucetEnabled
    );
    event RefillPolicyUpdated(
        uint256 refillThreshold,
        uint256 targetTreasuryBalance,
        uint256 minRefillAmount,
        uint256 refillCooldown
    );
    event AutoRefillUpdated(bool enabled);
    event TreasuryRefilled(
        address indexed caller,
        address indexed treasury,
        uint256 amount,
        uint256 treasuryBalanceAfter
    );
    event FaucetPaid(
        address indexed caller,
        address indexed faucetWallet,
        uint256 amount
    );
    event RevenueWithdrawn(address indexed to, uint256 amount);

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

    function setTreasury(address payable _treasury) external onlyOwner {
        _setTreasury(_treasury);
    }

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

    function setAutoRefillEnabled(bool enabled) external onlyOwner {
        autoRefillEnabled = enabled;
        emit AutoRefillUpdated(enabled);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function totalObservedRevenue() public view returns (uint256) {
        return
            address(this).balance +
            totalTreasuryRefilled +
            totalFaucetReleased +
            totalRevenueWithdrawn;
    }

    function unprocessedRevenue() public view returns (uint256) {
        uint256 observed = totalObservedRevenue();
        if (observed <= totalRevenueProcessed) {
            return 0;
        }

        return observed - totalRevenueProcessed;
    }

    function projectedFaucetPending() public view returns (uint256) {
        return faucetPending + (unprocessedRevenue() * faucetShareBps) / MAX_BPS;
    }

    function availableForTreasury() public view returns (uint256) {
        uint256 projectedPending = projectedFaucetPending();
        uint256 vaultBalance = address(this).balance;
        if (projectedPending >= vaultBalance) {
            return 0;
        }

        return vaultBalance - projectedPending;
    }

    function treasuryBalance() public view returns (uint256) {
        return treasury.balance;
    }

    function treasuryDeficit() public view returns (uint256) {
        uint256 currentTreasuryBalance = treasury.balance;
        if (currentTreasuryBalance >= targetTreasuryBalance) {
            return 0;
        }

        return targetTreasuryBalance - currentTreasuryBalance;
    }

    function maxRefillAmount() public view returns (uint256) {
        uint256 deficit = treasuryDeficit();
        uint256 available = availableForTreasury();

        if (deficit == 0 || available == 0) {
            return 0;
        }

        return deficit < available ? deficit : available;
    }

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

    function needsFaucetPayout() public view returns (bool) {
        if (!autoFaucetEnabled) {
            return false;
        }

        return projectedFaucetPending() >= minFaucetPayout;
    }

    function syncRevenue() external whenNotPaused returns (uint256 newRevenue) {
        newRevenue = _syncRevenue();
    }

    function rebalance()
        external
        whenNotPaused
        nonReentrant
        returns (uint256 faucetAmount, uint256 treasuryAmount)
    {
        _syncRevenue();

        faucetAmount = _releaseFaucetIfNeeded();
        treasuryAmount = _refillTreasuryIfNeeded();
    }

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

    function _setTreasury(address payable _treasury) internal {
        require(_treasury != address(0), "treasury=0");
        treasury = _treasury;

        emit TreasuryUpdated(_treasury);
    }

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

    function _releaseFaucetIfNeeded() internal returns (uint256 amount) {
        if (!autoFaucetEnabled || faucetPending < minFaucetPayout) {
            return 0;
        }

        amount = faucetPending;
        _payFaucet(amount);
    }

    function _refillTreasuryIfNeeded() internal returns (uint256 amount) {
        require(needsRefill(), "refill not needed");

        amount = maxRefillAmount();
        require(amount >= minRefillAmount, "refill too small");

        _transferToTreasury(amount);
    }

    function _transferToTreasury(uint256 amount) internal {
        totalTreasuryRefilled += amount;
        lastRefillAt = block.timestamp;

        (bool ok, ) = treasury.call{value: amount}("");
        require(ok, "treasury transfer failed");

        emit TreasuryRefilled(msg.sender, treasury, amount, treasury.balance);
    }

    function _payFaucet(uint256 amount) internal {
        faucetPending -= amount;
        totalFaucetReleased += amount;

        (bool ok, ) = faucetWallet.call{value: amount}("");
        require(ok, "faucet transfer failed");

        emit FaucetPaid(msg.sender, faucetWallet, amount);
    }

    receive() external payable {
        emit RevenueReceived(msg.sender, msg.value);
    }
}
