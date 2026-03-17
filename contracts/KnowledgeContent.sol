// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * KnowledgeContent
 * 内容注册 + 投票 + 奖励计算
 * （标题 + 描述上链版本）
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IVotesLike {
    function getVotes(address account) external view returns (uint256);
}

interface ITreasuryNative {
    function accrueReward(address beneficiary, uint256 amount) external;
    function pendingRewards(address beneficiary) external view returns (uint256);

}

contract KnowledgeContent is Ownable, Pausable, ReentrancyGuard {

    struct Content {
        uint256 id;
        address author;

        string ipfsHash;
        string title;
        string description;

        uint256 voteCount;
        uint256 timestamp;

        bool rewardAccrued;
    }

    uint256 public contentCount;

    mapping(uint256 => Content) public contents;

    mapping(address => mapping(uint256 => bool)) public hasVoted;

    uint256 public minVotesToReward;
    uint256 public rewardPerVote;
    uint256 public minStakeToVote;

    IVotesLike public votesContract;
    ITreasuryNative public treasury;

    uint256 public constant MAX_MIN_VOTES_TO_REWARD = 10000;
    uint256 public constant MAX_REWARD_PER_VOTE = 1 ether;

    event ContentRegistered(
        uint256 id,
        address indexed author,
        string ipfsHash,
        string title,
        string description
    );

    event Voted(uint256 indexed contentId, address indexed voter);

    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);

    event AntiSybilUpdated(address votesContract, uint256 minStakeToVote);

    event TreasuryUpdated(address treasury);

    event RewardAccrueRequested(
        uint256 indexed contentId,
        address indexed author,
        uint256 amount
    );

    constructor() {
        minVotesToReward = 10;
        rewardPerVote = 1e15;
        minStakeToVote = 1 ether;

        emit RewardRulesUpdated(minVotesToReward, rewardPerVote);
    }

    // ---------------- Admin ----------------

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury=0");

        treasury = ITreasuryNative(_treasury);

        emit TreasuryUpdated(_treasury);
    }

    function setAntiSybil(
        address _votesContract,
        uint256 _minStakeToVote
    ) external onlyOwner {

        require(_votesContract != address(0), "votes=0");

        votesContract = IVotesLike(_votesContract);

        require(_minStakeToVote <= 1000 ether, "minStake too high");

        minStakeToVote = _minStakeToVote;

        emit AntiSybilUpdated(_votesContract, _minStakeToVote);
    }

    function setRewardRules(
        uint256 _minVotesToReward,
        uint256 _rewardPerVote
    ) external onlyOwner {

        require(
            _minVotesToReward > 0 &&
            _minVotesToReward <= MAX_MIN_VOTES_TO_REWARD,
            "bad minVotes"
        );

        require(
            _rewardPerVote > 0 &&
            _rewardPerVote <= MAX_REWARD_PER_VOTE,
            "bad reward"
        );

        minVotesToReward = _minVotesToReward;
        rewardPerVote = _rewardPerVote;

        emit RewardRulesUpdated(_minVotesToReward, _rewardPerVote);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------- Content ----------------

    function registerContent(
        string memory _ipfsHash,
        string memory _title,
        string memory _description
    ) external whenNotPaused {

        require(bytes(_ipfsHash).length > 0, "CID empty");
        require(bytes(_title).length > 0, "title empty");

        contentCount++;

        contents[contentCount] = Content({

            id: contentCount,

            author: msg.sender,

            ipfsHash: _ipfsHash,
            title: _title,
            description: _description,

            voteCount: 0,

            timestamp: block.timestamp,

            rewardAccrued: false
        });

        emit ContentRegistered(
            contentCount,
            msg.sender,
            _ipfsHash,
            _title,
            _description
        );
    }

    function vote(uint256 contentId) external whenNotPaused {

        require(contentId > 0 && contentId <= contentCount, "bad id");

        require(!hasVoted[msg.sender][contentId], "Already voted");

        require(address(votesContract) != address(0), "votes not set");

        uint256 power = votesContract.getVotes(msg.sender);

        require(power >= minStakeToVote, "stake too low");

        hasVoted[msg.sender][contentId] = true;

        contents[contentId].voteCount++;

        emit Voted(contentId, msg.sender);
    }

    function distributeReward(uint256 contentId)
        external
        whenNotPaused
        nonReentrant
    {

        require(address(treasury) != address(0), "treasury not set");

        Content storage c = contents[contentId];

        require(contentId > 0 && contentId <= contentCount, "bad id");

        require(c.voteCount >= minVotesToReward, "not enough votes");

        require(!c.rewardAccrued, "already accrued");

        uint256 amount = c.voteCount * rewardPerVote;

        c.rewardAccrued = true;

        treasury.accrueReward(c.author, amount);

        emit RewardAccrueRequested(contentId, c.author, amount);
    }
}