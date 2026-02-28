// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeContent
 * @dev 内容注册 + 投票 + 奖励发放
 * 关键点：奖励规则可被 DAO（Timelock）治理修改 => setRewardRules onlyOwner
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "./RewardToken.sol";

contract KnowledgeContent is Ownable {
    struct Content {
        uint256 id;
        address author;
        string ipfsHash;
        uint256 voteCount;
        uint256 timestamp;
    }

    uint256 public contentCount;

    mapping(uint256 => Content) public contents;
    mapping(address => mapping(uint256 => bool)) public hasVoted;
    mapping(uint256 => bool) public rewardDistributed;

    RewardToken public rewardToken;

    // 可治理参数（DAO通过Timelock修改）
    uint256 public minVotesToReward; // 最少票数
    uint256 public rewardPerVote;    // 每票奖励（单位：wei，1e18=1 token）

    event ContentRegistered(uint256 id, address author, string ipfsHash);
    event Voted(uint256 contentId, address voter);
    event RewardDistributed(uint256 contentId, address author, uint256 amount);
    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);

    constructor(address rewardTokenAddress) {
        rewardToken = RewardToken(rewardTokenAddress);

        // 默认规则：10票起发、每票1 KRT
        minVotesToReward = 10;
        rewardPerVote = 1e18;

        emit RewardRulesUpdated(minVotesToReward, rewardPerVote);
    }

    /// @dev 由 DAO（Timelock）调用：修改奖励规则
    function setRewardRules(uint256 _minVotesToReward, uint256 _rewardPerVote) external onlyOwner {
        require(_minVotesToReward > 0, "minVotes must > 0");
        require(_rewardPerVote > 0, "rewardPerVote must > 0");

        minVotesToReward = _minVotesToReward;
        rewardPerVote = _rewardPerVote;

        emit RewardRulesUpdated(_minVotesToReward, _rewardPerVote);
    }

    function registerContent(string memory _ipfsHash) external {
        require(bytes(_ipfsHash).length > 0, "IPFS hash empty");

        contentCount++;
        contents[contentCount] = Content({
            id: contentCount,
            author: msg.sender,
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
        require(!rewardDistributed[_contentId], "Reward already distributed");

        Content memory c = contents[_contentId];
        require(c.voteCount >= minVotesToReward, "Not enough votes");

        uint256 rewardAmount = c.voteCount * rewardPerVote;

        rewardDistributed[_contentId] = true;

        // 需要 RewardToken.owner 已转移给本合约
        rewardToken.mint(c.author, rewardAmount);

        emit RewardDistributed(_contentId, c.author, rewardAmount);
    }
}