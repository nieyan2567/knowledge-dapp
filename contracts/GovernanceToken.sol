// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GovernanceToken
 * @dev 治理 Token（ERC20Votes）
 * 真实 DeFi：投票权需要 delegate 才生效，Governor 按历史快照读取投票权。
 */

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes, Ownable {
    constructor()
        ERC20("Knowledge Governance Token", "KGT")
        ERC20Permit("Knowledge Governance Token")
    {}

    /// @dev 仅用于毕业设计演示：管理员铸币分发治理权
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // ====== OZ 4.x: ERC20Votes 必需 override（和 OZ5 不同！） ======
    function _afterTokenTransfer(address from, address to, uint256 amount)
        internal
        override(ERC20, ERC20Votes)
    {
        super._afterTokenTransfer(from, to, amount);
    }

    function _mint(address to, uint256 amount)
        internal
        override(ERC20, ERC20Votes)
    {
        super._mint(to, amount);
    }

    function _burn(address account, uint256 amount)
        internal
        override(ERC20, ERC20Votes)
    {
        super._burn(account, amount);
    }
}