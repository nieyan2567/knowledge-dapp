// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RewardToken
 * @dev 激励 Token（onlyOwner 可 mint）
 * OZ4 的 Ownable 构造函数不带参数，owner 默认是部署者。
 */

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract RewardToken is ERC20, Ownable {
    constructor() ERC20("Knowledge Reward Token", "KRT") {
        // 初始给部署者一些代币用于演示/测试
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    /// @dev 只有 owner 能 mint，后续会 transferOwnership 给 KnowledgeContent
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}