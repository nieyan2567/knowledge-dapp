// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeContent
 * @dev 内容注册 + 投票 + 原生币奖励（安全增强版）
 *
 * 修复点：
 * 1) 防 Sybil：投票要求达到 minStakeToVote（读取 NativeVotes.getVotes）
 * 2) 防 DoS：奖励改为 Pull Payment（pendingRewards + claim）
 * 3) 防掏空：参数 cap + epochBudget 周期预算控制
 * 4) 运维治理：pause/unpause + withdrawTreasury（onlyOwner=Timelock/DAO）
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IVotesLike {
    function getVotes(address account) external view returns (uint256);
}

contract KnowledgeContent is Ownable, Pausable, ReentrancyGuard {
    struct Content {
        uint256 id;
        address author;
        string ipfsHash;
        uint256 voteCount;
        uint256 timestamp;
    }

    uint256 public contentCount;
    mapping(uint256 => Content) public contents;

    // 仍然保留“每地址每内容一次投票”
    mapping(address => mapping(uint256 => bool)) public hasVoted;

    // Pull payment：作者待领取奖励
    mapping(address => uint256) public pendingRewards;

    // DAO 可治理参数
    uint256 public minVotesToReward;
    uint256 public rewardPerVote;     // wei/票
    uint256 public minStakeToVote;    // 投票门槛（需要多少投票权，wei）

    // 预算控制（epoch）
    uint256 public epochDuration;     // 秒
    uint256 public epochBudget;       // 每个 epoch 最大发放额度
    uint256 public epochStart;        // 当前 epoch 起点（timestamp）
    uint256 public epochSpent;        // 当前 epoch 已发放额度（累计到 pendingRewards 即算支出）

    // 绑定 NativeVotes（用于反女巫投票门槛）
    IVotesLike public votesContract;

    // 参数上限（cap）
    uint256 public constant MAX_MIN_VOTES_TO_REWARD = 10_000;
    uint256 public constant MAX_REWARD_PER_VOTE = 1 ether;
    uint256 public constant MAX_EPOCH_BUDGET = 10_000 ether;
    uint256 public constant MIN_EPOCH_DURATION = 1 hours;
    uint256 public constant MAX_EPOCH_DURATION = 30 days;

    event ContentRegistered(uint256 id, address indexed author, string ipfsHash);
    event Voted(uint256 indexed contentId, address indexed voter);
    event RewardAccrued(uint256 indexed contentId, address indexed author, uint256 amount);
    event RewardClaimed(address indexed author, uint256 amount);
    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);
    event AntiSybilUpdated(address votesContract, uint256 minStakeToVote);
    event BudgetUpdated(uint256 epochDuration, uint256 epochBudget);
    event Funded(address indexed from, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    constructor() {
        // 默认规则（你可以按论文调整）
        minVotesToReward = 10;
        rewardPerVote = 1e15;          // 0.001 原生币/票
        epochDuration = 7 days;
        epochBudget = 100 ether;       // 每周最多发 100 原生币
        epochStart = block.timestamp;

        // 默认投票门槛：需要至少 1 原生币投票权（激活后 staked 才算）
        minStakeToVote = 1 ether;

        emit RewardRulesUpdated(minVotesToReward, rewardPerVote);
        emit BudgetUpdated(epochDuration, epochBudget);
    }

    // -------------------- 管理 / DAO 可治理 --------------------

    /**
     * @notice 绑定 votes 合约地址，并设置投票门槛（反 Sybil）
     * @dev onlyOwner = Timelock/DAO
     */
    function setAntiSybil(address _votesContract, uint256 _minStakeToVote) external onlyOwner {
        require(_votesContract != address(0), "votes=0");
        votesContract = IVotesLike(_votesContract);

        // 允许设置为 0 表示关闭反女巫（不推荐），这里给出下限保护
        require(_minStakeToVote <= 1000 ether, "minStake too high");
        minStakeToVote = _minStakeToVote;

        emit AntiSybilUpdated(_votesContract, _minStakeToVote);
    }

    /**
     * @notice 修改奖励规则（带 cap）
     */
    function setRewardRules(uint256 _minVotesToReward, uint256 _rewardPerVote) external onlyOwner {
        require(_minVotesToReward > 0 && _minVotesToReward <= MAX_MIN_VOTES_TO_REWARD, "bad minVotes");
        require(_rewardPerVote > 0 && _rewardPerVote <= MAX_REWARD_PER_VOTE, "bad rewardPerVote");

        minVotesToReward = _minVotesToReward;
        rewardPerVote = _rewardPerVote;

        emit RewardRulesUpdated(_minVotesToReward, _rewardPerVote);
    }

    /**
     * @notice 修改预算规则（带 cap）
     */
    function setBudget(uint256 _epochDuration, uint256 _epochBudget) external onlyOwner {
        require(_epochDuration >= MIN_EPOCH_DURATION && _epochDuration <= MAX_EPOCH_DURATION, "bad duration");
        require(_epochBudget <= MAX_EPOCH_BUDGET, "bad budget");

        epochDuration = _epochDuration;
        epochBudget = _epochBudget;

        emit BudgetUpdated(_epochDuration, _epochBudget);
    }

    /**
     * @notice 紧急暂停（停止投票/发奖/领取）
     */
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice 国库提现（迁移/应急），onlyOwner=Timelock/DAO
     * @dev 生产环境建议加白名单/额度制度；论文简化版保留接口即可
     */
    function withdrawTreasury(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(address(this).balance >= amount, "insufficient");

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");

        emit TreasuryWithdrawn(to, amount);
    }

    // -------------------- 业务：充值 / 注册 / 投票 --------------------

    function fund() external payable {
        require(msg.value > 0, "fund=0");
        emit Funded(msg.sender, msg.value);
    }

    function registerContent(string memory _ipfsHash) external whenNotPaused {
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

    /**
     * @notice 投票（反 Sybil：要求 votesContract.getVotes >= minStakeToVote）
     */
    function vote(uint256 contentId) external whenNotPaused {
        require(contentId > 0 && contentId <= contentCount, "bad id");
        require(!hasVoted[msg.sender][contentId], "Already voted");

        // 反女巫门槛：必须先质押并激活投票权
        require(address(votesContract) != address(0), "votes not set");
        uint256 power = votesContract.getVotes(msg.sender);
        require(power >= minStakeToVote, "stake too low");

        hasVoted[msg.sender][contentId] = true;
        contents[contentId].voteCount++;

        emit Voted(contentId, msg.sender);
    }

    // -------------------- 奖励：记账 + 领取（Pull Payment） --------------------

    /**
     * @notice 将奖励计入作者待领取余额（不会直接转账，避免 DoS）
     */
    function distributeReward(uint256 contentId) external whenNotPaused {
        require(contentId > 0 && contentId <= contentCount, "bad id");

        Content memory c = contents[contentId];
        require(c.voteCount >= minVotesToReward, "Not enough votes");

        _rollEpochIfNeeded();

        uint256 amount = c.voteCount * rewardPerVote;

        // 预算限制：防止被治理参数/刷票掏空
        require(epochSpent + amount <= epochBudget, "epoch budget exceeded");
        require(address(this).balance >= amount, "insufficient pool");

        epochSpent += amount;
        pendingRewards[c.author] += amount;

        emit RewardAccrued(contentId, c.author, amount);
    }

    /**
     * @notice 作者主动领取奖励（可重试，失败不会影响系统）
     */
    function claim() external whenNotPaused nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "no reward");

        pendingRewards[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "transfer failed");

        emit RewardClaimed(msg.sender, amount);
    }

    // -------------------- internal --------------------

    function _rollEpochIfNeeded() internal {
        if (block.timestamp >= epochStart + epochDuration) {
            // 滚动到新 epoch：重置已支出，设置新起点
            epochStart = block.timestamp;
            epochSpent = 0;
        }
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }
}