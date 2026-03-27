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
        bool deleted;
        uint256 latestVersion;
        uint256 lastUpdatedAt;
    }

    struct ContentVersion {
        string ipfsHash;
        string title;
        string description;
        uint256 timestamp;
    }

    uint256 public contentCount;

    mapping(uint256 => Content) public contents;
    mapping(uint256 => uint256) public contentVersionCount;
    mapping(uint256 => mapping(uint256 => ContentVersion)) private contentVersions;

    mapping(address => mapping(uint256 => bool)) public hasVoted;

    uint256 public minVotesToReward;
    uint256 public rewardPerVote;
    uint256 public minStakeToVote;
    uint256 public editLockVotes;
    bool public allowDeleteAfterVote;
    uint256 public maxVersionsPerContent;

    IVotesLike public votesContract;
    ITreasuryNative public treasury;

    uint256 public constant MAX_MIN_VOTES_TO_REWARD = 10000;
    uint256 public constant MAX_REWARD_PER_VOTE = 1 ether;
    uint256 public constant MAX_MAX_VERSIONS_PER_CONTENT = 100;

    event ContentRegistered(
        uint256 id,
        address indexed author,
        string ipfsHash,
        string title,
        string description
    );

    event Voted(uint256 indexed contentId, address indexed voter);

    event ContentUpdated(
        uint256 indexed id,
        address indexed author,
        string ipfsHash,
        string title,
        string description
    );

    event ContentVersionStored(
        uint256 indexed id,
        uint256 indexed version,
        string ipfsHash,
        string title,
        string description
    );

    event ContentDeleted(
        uint256 indexed id,
        address indexed operator,
        address indexed author
    );

    event ContentRestored(
        uint256 indexed id,
        address indexed operator,
        address indexed author
    );

    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);

    event AntiSybilUpdated(address votesContract, uint256 minStakeToVote);

    event TreasuryUpdated(address treasury);

    event ContentPolicyUpdated(
        uint256 editLockVotes,
        bool allowDeleteAfterVote,
        uint256 maxVersionsPerContent
    );

    event RewardAccrueRequested(
        uint256 indexed contentId,
        address indexed author,
        uint256 amount
    );

    constructor() {
        minVotesToReward = 1;
        rewardPerVote = 1e15;
        minStakeToVote = 1 ether;
        editLockVotes = 1;
        allowDeleteAfterVote = false;
        maxVersionsPerContent = 20;

        emit RewardRulesUpdated(minVotesToReward, rewardPerVote);
        emit ContentPolicyUpdated(
            editLockVotes,
            allowDeleteAfterVote,
            maxVersionsPerContent
        );
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

    function setContentPolicy(
        uint256 _editLockVotes,
        bool _allowDeleteAfterVote,
        uint256 _maxVersionsPerContent
    ) external onlyOwner {
        require(_editLockVotes > 0, "bad edit lock");
        require(
            _maxVersionsPerContent > 0 &&
            _maxVersionsPerContent <= MAX_MAX_VERSIONS_PER_CONTENT,
            "bad max versions"
        );

        editLockVotes = _editLockVotes;
        allowDeleteAfterVote = _allowDeleteAfterVote;
        maxVersionsPerContent = _maxVersionsPerContent;

        emit ContentPolicyUpdated(
            _editLockVotes,
            _allowDeleteAfterVote,
            _maxVersionsPerContent
        );
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

            rewardAccrued: false,
            deleted: false,
            latestVersion: 1,
            lastUpdatedAt: block.timestamp
        });

        contentVersionCount[contentCount] = 1;
        contentVersions[contentCount][1] = ContentVersion({
            ipfsHash: _ipfsHash,
            title: _title,
            description: _description,
            timestamp: block.timestamp
        });

        emit ContentRegistered(
            contentCount,
            msg.sender,
            _ipfsHash,
            _title,
            _description
        );
        emit ContentVersionStored(
            contentCount,
            1,
            _ipfsHash,
            _title,
            _description
        );
    }

    function updateContent(
        uint256 contentId,
        string memory _ipfsHash,
        string memory _title,
        string memory _description
    ) external whenNotPaused {

        require(contentId > 0 && contentId <= contentCount, "bad id");
        require(bytes(_ipfsHash).length > 0, "CID empty");
        require(bytes(_title).length > 0, "title empty");

        Content storage c = contents[contentId];

        require(c.author == msg.sender, "not author");
        require(!c.deleted, "content deleted");
        require(c.voteCount < editLockVotes, "edit locked");
        require(!c.rewardAccrued, "reward already accrued");
        require(
            contentVersionCount[contentId] < maxVersionsPerContent,
            "max versions reached"
        );

        uint256 nextVersion = contentVersionCount[contentId] + 1;

        contentVersionCount[contentId] = nextVersion;
        contentVersions[contentId][nextVersion] = ContentVersion({
            ipfsHash: _ipfsHash,
            title: _title,
            description: _description,
            timestamp: block.timestamp
        });

        c.ipfsHash = _ipfsHash;
        c.title = _title;
        c.description = _description;
        c.latestVersion = nextVersion;
        c.lastUpdatedAt = block.timestamp;

        emit ContentUpdated(
            contentId,
            msg.sender,
            _ipfsHash,
            _title,
            _description
        );
        emit ContentVersionStored(
            contentId,
            nextVersion,
            _ipfsHash,
            _title,
            _description
        );
    }

    function deleteContent(uint256 contentId) external whenNotPaused {

        require(contentId > 0 && contentId <= contentCount, "bad id");

        Content storage c = contents[contentId];

        require(!c.deleted, "already deleted");

        bool isAuthor = c.author == msg.sender;
        bool isOwnerCaller = owner() == msg.sender;

        require(isAuthor || isOwnerCaller, "not authorized");

        if (isAuthor) {
            require(
                allowDeleteAfterVote || c.voteCount == 0,
                "delete locked"
            );
            require(!c.rewardAccrued, "reward already accrued");
        }

        c.deleted = true;

        emit ContentDeleted(contentId, msg.sender, c.author);
    }

    function restoreContent(uint256 contentId) external whenNotPaused {

        require(contentId > 0 && contentId <= contentCount, "bad id");

        Content storage c = contents[contentId];

        require(c.deleted, "not deleted");

        bool isAuthor = c.author == msg.sender;
        bool isOwnerCaller = owner() == msg.sender;

        require(isAuthor || isOwnerCaller, "not authorized");

        c.deleted = false;

        emit ContentRestored(contentId, msg.sender, c.author);
    }

    function getContentVersion(
        uint256 contentId,
        uint256 version
    )
        external
        view
        returns (
            string memory ipfsHash,
            string memory title,
            string memory description,
            uint256 timestamp
        )
    {
        require(contentId > 0 && contentId <= contentCount, "bad id");
        require(
            version > 0 && version <= contentVersionCount[contentId],
            "bad version"
        );

        ContentVersion storage v = contentVersions[contentId][version];
        return (v.ipfsHash, v.title, v.description, v.timestamp);
    }

    function vote(uint256 contentId) external whenNotPaused {

        require(contentId > 0 && contentId <= contentCount, "bad id");

        require(!contents[contentId].deleted, "content deleted");

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
        require(!c.deleted, "content deleted");

        require(c.voteCount >= minVotesToReward, "not enough votes");

        require(!c.rewardAccrued, "already accrued");

        uint256 amount = c.voteCount * rewardPerVote;

        c.rewardAccrued = true;

        treasury.accrueReward(c.author, amount);

        emit RewardAccrueRequested(contentId, c.author, amount);
    }
}
