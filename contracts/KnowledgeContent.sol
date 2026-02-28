// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title KnowledgeContent
 * @dev 内容注册 + 投票 + 原生币奖励发放
 *
 * 重要变化：
 * - 不再 mint ERC20 奖励；改为从合约余额里直接转出原生币奖励
 * - 奖励池资金来自 fund()/receive() 预存（由管理员或 DAO 国库充值）
 * - 奖励规则仍由 DAO 控制：setRewardRules onlyOwner（owner=Timelock）
 */
contract KnowledgeContent is Ownable {
    struct Content {
        uint256 id;
        address payable author;
        string ipfsHash;
        uint256 voteCount;
        uint256 timestamp;
    }

    uint256 public contentCount;
    mapping(uint256 => Content) public contents;
    mapping(address => mapping(uint256 => bool)) public hasVoted;
    mapping(uint256 => bool) public rewardDistributed;

    // DAO 可治理参数
    uint256 public minVotesToReward;
    uint256 public rewardPerVote; // 每票奖励（wei）

    event ContentRegistered(uint256 id, address author, string ipfsHash);
    event Voted(uint256 contentId, address voter);
    event RewardDistributed(uint256 contentId, address author, uint256 amount);
    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);
    event Funded(address indexed from, uint256 amount);

    constructor() {
        // 默认：10票起发，每票 0.001 原生币（你可按联盟链经济模型调整）
        minVotesToReward = 10;
        rewardPerVote = 1e15;

        emit RewardRulesUpdated(minVotesToReward, rewardPerVote);
    }

    /// @notice 充值奖励池（任何人可充值）
    function fund() external payable {
        require(msg.value > 0, "fund=0");
        emit Funded(msg.sender, msg.value);
    }

    /// @notice DAO 修改奖励规则（owner=Timelock）
    function setRewardRules(uint256 _minVotesToReward, uint256 _rewardPerVote) external onlyOwner {
        require(_minVotesToReward > 0, "minVotes>0");
        require(_rewardPerVote > 0, "rewardPerVote>0");
        minVotesToReward = _minVotesToReward;
        rewardPerVote = _rewardPerVote;
        emit RewardRulesUpdated(_minVotesToReward, _rewardPerVote);
    }

    function registerContent(string memory _ipfsHash) external {
        require(bytes(_ipfsHash).length > 0, "IPFS hash empty");

        contentCount++;
        contents[contentCount] = Content({
            id: contentCount,
            author: payable(msg.sender),
            ipfsHash: _ipfsHash,
            voteCount: 0,
            timestamp: block.timestamp
        });

        emit ContentRegistered(contentCount, msg.sender, _ipfsHash);
    }

    function vote(uint256 _contentId) external {
        require(_contentId > 0 && _contentId <= contentCount, "Invalid content ID");
        require(!hasVoted[msg.sender][_contentId], "Already voted");

        contents[_contentId].voteCount++;
        hasVoted[msg.sender][_contentId] = true;

        emit Voted(_contentId, msg.sender);
    }

    function distributeReward(uint256 _contentId) external {
        require(_contentId > 0 && _contentId <= contentCount, "Invalid content ID");
        require(!rewardDistributed[_contentId], "Already distributed");

        Content memory c = contents[_contentId];
        require(c.voteCount >= minVotesToReward, "Not enough votes");

        uint256 amount = c.voteCount * rewardPerVote;
        require(address(this).balance >= amount, "Insufficient reward pool");

        rewardDistributed[_contentId] = true;

        (bool ok, ) = c.author.call{value: amount}("");
        require(ok, "reward transfer failed");

        emit RewardDistributed(_contentId, c.author, amount);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }
}