// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title RevenueVault
 * @dev Collects protocol income and refills TreasuryNative when liquidity is low.
 *      Intended to be used as the QBFT mining beneficiary or as a revenue sink.
 */
contract RevenueVault is Ownable, Pausable, ReentrancyGuard {
    address payable public treasury;

    uint256 public refillThreshold;
    uint256 public targetTreasuryBalance;
    uint256 public minRefillAmount;
    uint256 public refillCooldown;
    uint256 public lastRefillAt;

    bool public autoRefillEnabled;

    uint256 public constant MAX_TARGET_TREASURY_BALANCE = 100_000 ether;
    uint256 public constant MAX_REFILL_COOLDOWN = 30 days;

    event RevenueReceived(address indexed from, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
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
    event RevenueWithdrawn(address indexed to, uint256 amount);

    constructor(
        address payable _treasury,
        uint256 _refillThreshold,
        uint256 _targetTreasuryBalance,
        uint256 _minRefillAmount,
        uint256 _refillCooldown
    ) {
        _setTreasury(_treasury);
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
        uint256 vaultBalance = address(this).balance;

        if (deficit == 0 || vaultBalance == 0) {
            return 0;
        }

        return deficit < vaultBalance ? deficit : vaultBalance;
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

    function refillTreasuryIfNeeded()
        external
        whenNotPaused
        nonReentrant
        returns (uint256 amount)
    {
        require(needsRefill(), "refill not needed");

        amount = maxRefillAmount();
        require(amount >= minRefillAmount, "refill too small");

        _transferToTreasury(amount);
    }

    function manualRefill(uint256 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        require(amount > 0, "amount=0");
        require(address(this).balance >= amount, "insufficient revenue");

        _transferToTreasury(amount);
    }

    function withdrawRevenue(address payable to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(address(this).balance >= amount, "insufficient revenue");

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");

        emit RevenueWithdrawn(to, amount);
    }

    function _setTreasury(address payable _treasury) internal {
        require(_treasury != address(0), "treasury=0");
        treasury = _treasury;

        emit TreasuryUpdated(_treasury);
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

    function _transferToTreasury(uint256 amount) internal {
        (bool ok, ) = treasury.call{value: amount}("");
        require(ok, "treasury transfer failed");

        lastRefillAt = block.timestamp;

        emit TreasuryRefilled(msg.sender, treasury, amount, treasury.balance);
    }

    receive() external payable {
        emit RevenueReceived(msg.sender, msg.value);
    }
}
