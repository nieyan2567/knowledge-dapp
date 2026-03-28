// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeContent
 * @notice 内容登记、版本管理、社区投票与奖励记账合约。
 * @dev
 * 设计目标：
 * 1. 允许作者登记内容的基础元数据，并把正文内容通过 IPFS 等链下存储保存。
 * 2. 允许符合门槛的地址对内容投票，并记录单个地址是否已经投过票。
 * 3. 支持作者在内容尚未进入锁定状态前更新内容，并保留历史版本。
 * 4. 当内容满足奖励条件时，由本合约向 Treasury 发起奖励记账请求。
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @notice 投票权合约的最小接口。
 * @dev 当前只依赖 `getVotes` 用于查询地址的治理投票权或质押权重。
 */
interface IVotesLike {
    /**
     * @notice 查询指定账户当前可用的投票权数量。
     * @param account 要查询的账户地址。
     * @return 该账户当前的投票权数值。
     */
    function getVotes(address account) external view returns (uint256);
}

/**
 * @notice 奖励金库合约的最小接口。
 * @dev KnowledgeContent 通过该接口向 Treasury 发起奖励记账，而不直接转账。
 */
interface ITreasuryNative {
    /**
     * @notice 为指定地址累计待领取奖励。
     * @param beneficiary 奖励接收人地址。
     * @param amount 本次增加的奖励金额。
     */
    function accrueReward(address beneficiary, uint256 amount) external;

    /**
     * @notice 查询指定地址当前待领取的奖励金额。
     * @param beneficiary 奖励接收人地址。
     * @return 该地址当前累计但尚未领取的奖励金额。
     */
    function pendingRewards(address beneficiary) external view returns (uint256);

}

contract KnowledgeContent is Ownable, Pausable, ReentrancyGuard {
    /**
     * @notice 内容主记录。
     * @dev 该结构体保存当前最新版本对应的展示字段，以及投票和奖励状态。
     */
    struct Content {
        /// @notice 内容唯一编号，自增生成。
        uint256 id;
        /// @notice 内容作者地址。
        address author;

        /// @notice 当前最新版本对应的 IPFS 哈希或内容标识。
        string ipfsHash;
        /// @notice 当前最新版本标题。
        string title;
        /// @notice 当前最新版本描述。
        string description;

        /// @notice 当前内容累计获得的投票数量。
        uint256 voteCount;
        /// @notice 内容首次创建时间戳。
        uint256 timestamp;

        /// @notice 该内容是否已经触发过奖励记账。
        bool rewardAccrued;
        /// @notice 该内容当前是否处于删除状态。
        bool deleted;
        /// @notice 当前最新版本号。
        uint256 latestVersion;
        /// @notice 最近一次更新的时间戳。
        uint256 lastUpdatedAt;
    }

    /**
     * @notice 内容的历史版本记录。
     * @dev 每次 register 或 update 时都会写入一个版本快照。
     */
    struct ContentVersion {
        /// @notice 该版本对应的 IPFS 哈希或内容标识。
        string ipfsHash;
        /// @notice 该版本标题。
        string title;
        /// @notice 该版本描述。
        string description;
        /// @notice 该版本写入的时间戳。
        uint256 timestamp;
    }

    /// @notice 当前已登记内容总数，同时也是最新内容编号。
    uint256 public contentCount;

    /// @notice 内容编号到内容主记录的映射。
    mapping(uint256 => Content) public contents;
    /// @notice 内容编号到版本总数的映射。
    mapping(uint256 => uint256) public contentVersionCount;
    /// @dev 内容编号 => 版本号 => 版本详情，仅通过读取函数对外暴露。
    mapping(uint256 => mapping(uint256 => ContentVersion)) private contentVersions;

    /// @notice 记录某个地址是否已经对某条内容投过票，防止重复投票。
    mapping(address => mapping(uint256 => bool)) public hasVoted;

    /// @notice 内容满足奖励条件所需的最少票数。
    uint256 public minVotesToReward;
    /// @notice 每张有效票可为作者累计的奖励金额。
    uint256 public rewardPerVote;
    /// @notice 用户参与投票所需的最少投票权或质押权重。
    uint256 public minStakeToVote;
    /// @notice 当票数达到该阈值后，作者将不能再编辑内容。
    uint256 public editLockVotes;
    /// @notice 是否允许作者在已有投票后删除内容。
    bool public allowDeleteAfterVote;
    /// @notice 单条内容允许保留的最大版本数。
    uint256 public maxVersionsPerContent;

    /// @notice 投票权合约地址，用于校验投票门槛。
    IVotesLike public votesContract;
    /// @notice 奖励金库合约地址，用于发起奖励记账。
    ITreasuryNative public treasury;

    /// @notice `minVotesToReward` 的安全上限，避免治理误配过大参数。
    uint256 public constant MAX_MIN_VOTES_TO_REWARD = 10000;
    /// @notice `rewardPerVote` 的安全上限，单位为原生币。
    uint256 public constant MAX_REWARD_PER_VOTE = 1 ether;
    /// @notice `maxVersionsPerContent` 的安全上限，避免单条内容存储无限膨胀。
    uint256 public constant MAX_MAX_VERSIONS_PER_CONTENT = 100;

    /**
     * @notice 新内容登记成功时触发。
     * @param id 新内容编号。
     * @param author 内容作者地址。
     * @param ipfsHash 内容哈希或链下存储标识。
     * @param title 内容标题。
     * @param description 内容描述。
     */
    event ContentRegistered(
        uint256 id,
        address indexed author,
        string ipfsHash,
        string title,
        string description
    );

    /**
     * @notice 用户对内容投票成功时触发。
     * @param contentId 被投票的内容编号。
     * @param voter 投票人地址。
     */
    event Voted(uint256 indexed contentId, address indexed voter);

    /**
     * @notice 内容更新成功时触发。
     * @param id 被更新的内容编号。
     * @param author 进行更新的作者地址。
     * @param ipfsHash 更新后的内容哈希。
     * @param title 更新后的标题。
     * @param description 更新后的描述。
     */
    event ContentUpdated(
        uint256 indexed id,
        address indexed author,
        string ipfsHash,
        string title,
        string description
    );

    /**
     * @notice 新版本快照写入成功时触发。
     * @param id 内容编号。
     * @param version 版本号。
     * @param ipfsHash 该版本的内容哈希。
     * @param title 该版本标题。
     * @param description 该版本描述。
     */
    event ContentVersionStored(
        uint256 indexed id,
        uint256 indexed version,
        string ipfsHash,
        string title,
        string description
    );

    /**
     * @notice 内容被删除时触发。
     * @param id 被删除的内容编号。
     * @param operator 触发删除的人，可能是作者也可能是 owner。
     * @param author 内容作者地址。
     */
    event ContentDeleted(
        uint256 indexed id,
        address indexed operator,
        address indexed author
    );

    /**
     * @notice 内容被恢复时触发。
     * @param id 被恢复的内容编号。
     * @param operator 执行恢复操作的人。
     * @param author 内容作者地址。
     */
    event ContentRestored(
        uint256 indexed id,
        address indexed operator,
        address indexed author
    );

    /**
     * @notice 奖励规则更新时触发。
     * @param minVotesToReward 新的最少奖励票数门槛。
     * @param rewardPerVote 新的每票奖励金额。
     */
    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);

    /**
     * @notice 反女巫参数更新时触发。
     * @param votesContract 新的投票权合约地址。
     * @param minStakeToVote 新的最少投票权门槛。
     */
    event AntiSybilUpdated(address votesContract, uint256 minStakeToVote);

    /**
     * @notice 奖励金库地址更新时触发。
     * @param treasury 新的 Treasury 合约地址。
     */
    event TreasuryUpdated(address treasury);

    /**
     * @notice 内容策略更新时触发。
     * @param editLockVotes 新的编辑锁定票数阈值。
     * @param allowDeleteAfterVote 是否允许投票后删除。
     * @param maxVersionsPerContent 单条内容允许的最大版本数。
     */
    event ContentPolicyUpdated(
        uint256 editLockVotes,
        bool allowDeleteAfterVote,
        uint256 maxVersionsPerContent
    );

    /**
     * @notice 向 Treasury 发起奖励记账请求时触发。
     * @param contentId 触发奖励的内容编号。
     * @param author 奖励接收的作者地址。
     * @param amount 本次累计的奖励金额。
     */
    event RewardAccrueRequested(
        uint256 indexed contentId,
        address indexed author,
        uint256 amount
    );

    /**
     * @notice 部署合约并初始化默认治理参数。
     * @dev 默认值适合测试和初期运行，后续可由 owner 或治理调整。
     */
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

    /**
     * @notice 设置奖励金库合约地址。
     * @dev 只有 owner 可以更新，地址不能为零地址。
     * @param _treasury 新的 Treasury 合约地址。
     */
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury=0");

        treasury = ITreasuryNative(_treasury);

        emit TreasuryUpdated(_treasury);
    }

    /**
     * @notice 设置反女巫检查所依赖的投票权合约和最低投票门槛。
     * @dev 用户调用 `vote` 时，需要在 `votesContract` 中拥有至少 `minStakeToVote` 的票权。
     * @param _votesContract 投票权合约地址。
     * @param _minStakeToVote 最低投票权门槛。
     */
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

    /**
     * @notice 设置内容奖励规则。
     * @dev 该规则决定一条内容达到多少票后可记账奖励，以及每票奖励金额。
     * @param _minVotesToReward 触发奖励所需的最少票数。
     * @param _rewardPerVote 每张票对应的奖励金额。
     */
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

    /**
     * @notice 设置内容编辑与删除策略。
     * @dev 可配置编辑锁定阈值、是否允许投票后删除，以及版本数量上限。
     * @param _editLockVotes 达到该票数后内容不再允许作者编辑。
     * @param _allowDeleteAfterVote 是否允许内容在被投票后仍可由作者删除。
     * @param _maxVersionsPerContent 单条内容允许保存的最大版本数。
     */
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

    /**
     * @notice 暂停内容登记、编辑、投票和奖励记账等核心流程。
     * @dev 仅 owner 可调用，通常用于紧急事件处置。
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice 解除暂停，恢复合约正常使用。
     * @dev 仅 owner 可调用。
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice 登记一条新的内容记录。
     * @dev
     * 1. 必须提供非空的 IPFS 哈希和标题。
     * 2. 会创建内容主记录。
     * 3. 会同步写入第一个版本快照。
     * @param _ipfsHash 内容正文或元数据对应的链下哈希。
     * @param _title 内容标题。
     * @param _description 内容描述或摘要。
     */
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

    /**
     * @notice 更新已有内容并生成一个新的历史版本。
     * @dev
     * 仅作者本人可更新，且内容不能被删除、不能已奖励、不能达到编辑锁定票数。
     * 同时版本总数不能超过 `maxVersionsPerContent`。
     * @param contentId 要更新的内容编号。
     * @param _ipfsHash 新版本内容哈希。
     * @param _title 新版本标题。
     * @param _description 新版本描述。
     */
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

    /**
     * @notice 将一条内容标记为已删除。
     * @dev
     * 1. 作者本人可删除自己的内容，但需要满足删除策略约束。
     * 2. owner 可以出于治理或风控目的强制删除内容。
     * 3. 删除仅改变状态标记，不清除历史记录。
     * @param contentId 要删除的内容编号。
     */
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

    /**
     * @notice 恢复一条已删除的内容。
     * @dev 作者本人或 owner 均可恢复，恢复后内容重新可见。
     * @param contentId 要恢复的内容编号。
     */
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

    /**
     * @notice 读取指定内容的某个历史版本。
     * @param contentId 内容编号。
     * @param version 要读取的版本号。
     * @return ipfsHash 该版本对应的 IPFS 哈希。
     * @return title 该版本标题。
     * @return description 该版本描述。
     * @return timestamp 该版本写入时间戳。
     */
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

    /**
     * @notice 对指定内容投票。
     * @dev
     * 每个地址对同一条内容只能投一次票。
     * 调用者必须在 `votesContract` 中拥有不少于 `minStakeToVote` 的投票权。
     * @param contentId 要投票的内容编号。
     */
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

    /**
     * @notice 为满足条件的内容作者向 Treasury 发起奖励记账。
     * @dev
     * 奖励金额 = `voteCount * rewardPerVote`。
     * 该函数只负责记账，不在本合约内直接向作者转账。
     * 为避免重复奖励，一条内容只能成功记账一次。
     * @param contentId 要发起奖励记账的内容编号。
     */
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
