// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract FaucetVault is Ownable, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;

    uint256 public epochBudget;
    uint256 public epochDuration;
    uint256 public epochStartAt;
    uint256 public epochSpent;

    uint256 public claimAmount;
    uint256 public minAllowedBalance;
    uint256 public claimCooldown;
    address public signer;

    mapping(address => uint256) public lastClaimAt;
    mapping(bytes32 => bool) public usedClaims;

    event SignerUpdated(address indexed signer);
    event ClaimConfigUpdated(
        uint256 claimAmount,
        uint256 minAllowedBalance,
        uint256 claimCooldown
    );
    event BudgetConfigUpdated(uint256 epochDuration, uint256 epochBudget);
    event RevenueReceived(address indexed from, uint256 amount);
    event Claimed(
        address indexed relayer,
        address indexed recipient,
        uint256 amount,
        uint256 deadline,
        bytes32 indexed nonce
    );

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

    receive() external payable {
        emit RevenueReceived(msg.sender, msg.value);
    }

    function setSigner(address _signer) external onlyOwner {
        _setSigner(_signer);
    }

    function setClaimConfig(
        uint256 _claimAmount,
        uint256 _minAllowedBalance,
        uint256 _claimCooldown
    ) external onlyOwner {
        _setClaimConfig(_claimAmount, _minAllowedBalance, _claimCooldown);
    }

    function setBudgetConfig(
        uint256 _epochDuration,
        uint256 _epochBudget
    ) external onlyOwner {
        _setBudgetConfig(_epochDuration, _epochBudget);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function availableBudget() public view returns (uint256) {
        if (_isCurrentEpochExpired()) {
            return epochBudget;
        }

        if (epochSpent >= epochBudget) {
            return 0;
        }

        return epochBudget - epochSpent;
    }

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

    function _isCurrentEpochExpired() internal view returns (bool) {
        return block.timestamp >= epochStartAt + epochDuration;
    }

    function _rollEpochIfNeeded() internal {
        if (!_isCurrentEpochExpired()) {
            return;
        }

        uint256 elapsed = block.timestamp - epochStartAt;
        uint256 cycles = elapsed / epochDuration;
        epochStartAt += cycles * epochDuration;
        epochSpent = 0;
    }

    function _setSigner(address _signer) internal {
        require(_signer != address(0), "signer=0");
        signer = _signer;
        emit SignerUpdated(_signer);
    }

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