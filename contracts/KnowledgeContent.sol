// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeContent
 * @dev 内容注册 + 投票 + 奖励计算 (Treasury 模块化版)
 *
 * 安全增强：
 * - 继承 ReentrancyGuard 并在关键函数使用 nonReentrant
 * - 遵循 CEI 模式 (先更新状态，再调用外部合约)
 * - 资金与逻辑分离
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
        uint256 voteCount;
        uint256 timestamp;
        bool rewardAccrued; // 防止重复发放
    }

    uint256 public contentCount;
    mapping(uint256 => Content) public contents;

    // 投票记录：address -> contentId -> hasVoted
    mapping(address => mapping(uint256 => bool)) public hasVoted;

    // DAO 可治理参数
    uint256 public minVotesToReward;
    uint256 public rewardPerVote;  // wei/票
    uint256 public minStakeToVote; // 投票门槛 (投票权数量)

    // 外部依赖
    IVotesLike public votesContract;
    ITreasuryNative public treasury;

    // 参数上限
    uint256 public constant MAX_MIN_VOTES_TO_REWARD = 10_000;
    uint256 public constant MAX_REWARD_PER_VOTE = 1 ether;

    // Events
    event ContentRegistered(uint256 id, address indexed author, string ipfsHash);
    event Voted(uint256 indexed contentId, address indexed voter);
    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);
    event AntiSybilUpdated(address votesContract, uint256 minStakeToVote);
    event TreasuryUpdated(address treasury);
    event RewardAccrueRequested(uint256 indexed contentId, address indexed author, uint256 amount);

    constructor() {
        minVotesToReward = 10;
        rewardPerVote = 1e15;     // 0.001 ETH/票
        minStakeToVote = 1 ether; // 默认门槛
        emit RewardRulesUpdated(minVotesToReward, rewardPerVote);
    }

    // -------- Admin / DAO --------

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury=0");
        treasury = ITreasuryNative(_treasury);
        emit TreasuryUpdated(_treasury);
    }

    function setAntiSybil(address _votesContract, uint256 _minStakeToVote) external onlyOwner {
        require(_votesContract != address(0), "votes=0");
        votesContract = IVotesLike(_votesContract);
        require(_minStakeToVote <= 1000 ether, "minStake too high");
        minStakeToVote = _minStakeToVote;
        emit AntiSybilUpdated(_votesContract, _minStakeToVote);
    }

    function setRewardRules(uint256 _minVotesToReward, uint256 _rewardPerVote) external onlyOwner {
        require(_minVotesToReward > 0 && _minVotesToReward <= MAX_MIN_VOTES_TO_REWARD, "bad minVotes");
        require(_rewardPerVote > 0 && _rewardPerVote <= MAX_REWARD_PER_VOTE, "bad rewardPerVote");
        minVotesToReward = _minVotesToReward;
        rewardPerVote = _rewardPerVote;
        emit RewardRulesUpdated(_minVotesToReward, _rewardPerVote);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // -------- Business Logic --------

    function registerContent(string memory _ipfsHash) external whenNotPaused {
        require(bytes(_ipfsHash).length > 0, "IPFS hash empty");

        contentCount++;
        contents[contentCount] = Content({
            id: contentCount,
            author: msg.sender,
            ipfsHash: _ipfsHash,
            voteCount: 0,
            timestamp: block.timestamp,
            rewardAccrued: false
        });

        emit ContentRegistered(contentCount, msg.sender, _ipfsHash);
    }

    function vote(uint256 contentId) external whenNotPaused {
        require(contentId > 0 && contentId <= contentCount, "bad id");
        require(!hasVoted[msg.sender][contentId], "Already voted");

        require(address(votesContract) != address(0), "votes contract not set");
        uint256 power = votesContract.getVotes(msg.sender);
        require(power >= minStakeToVote, "stake too low");

        hasVoted[msg.sender][contentId] = true;
        contents[contentId].voteCount++;

        emit Voted(contentId, msg.sender);
    }

    /**
     * @notice 计算并发放奖励
     * @dev 关键安全点：
     * 1. 使用 nonReentrant 防止重入
     * 2. 遵循 CEI 模式：先更新本地状态 (rewardAccrued=true)，再调用外部合约
     */
    function distributeReward(uint256 contentId) external whenNotPaused nonReentrant {
        require(address(treasury) != address(0), "treasury not set");

        Content storage c = contents[contentId];
        require(contentId > 0 && contentId <= contentCount, "bad id");
        require(c.voteCount >= minVotesToReward, "Not enough votes");
        require(!c.rewardAccrued, "Reward already accrued");

        uint256 amount = c.voteCount * rewardPerVote;

        // --- CEI Pattern: Effects before Interactions ---
        
        // 1. [Effect] 先标记为已发放
        // 如果后续 accrueReward 失败 revert，整个交易回滚，此标记也会自动撤销，状态一致
        c.rewardAccrued = true; 

        // 2. [Interaction] 调用外部金库记账
        treasury.accrueReward(c.author, amount);

        emit RewardAccrueRequested(contentId, c.author, amount);
    }
}