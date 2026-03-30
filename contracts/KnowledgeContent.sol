// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KnowledgeContent
 * @notice 内容登记、版本管理、社区投票与奖励记账合约。
 * @dev
 * 设计目标：
 * 1. 允许作者登记内容的基础元数据，并将正文通过 IPFS 等链下存储保存。
 * 2. 允许满足门槛的地址对内容投票，并记录是否重复投票。
 * 3. 支持作者在内容未进入锁定状态前更新内容，并保留历史版本。
 * 4. 当内容满足奖励条件时，由作者触发向 Treasury 进行奖励记账。
 * 5. 通过可治理的发布费与更新费，为协议提供可持续的费用消耗口。
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @notice 投票权合约的最小接口。
 * @dev 当前只依赖 `getVotes` 查询地址的治理投票权或质押权重。
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
     * @return 该地址当前尚未领取的奖励金额。
     */
    function pendingRewards(address beneficiary) external view returns (uint256);
}

contract KnowledgeContent is Ownable, Pausable, ReentrancyGuard {
    /**
     * @notice 内容主记录。
     * @dev 保存当前最新版本的展示字段，以及投票和奖励状态。
     * @param id 内容唯一编号。
     * @param author 内容作者地址。
     * @param ipfsHash 当前最新版本对应的链下内容哈希。
     * @param title 当前最新版本标题。
     * @param description 当前最新版本描述。
     * @param voteCount 当前累计获得的有效投票数。
     * @param timestamp 内容首次创建时间。
     * @param rewardAccrued 是否至少发生过一次奖励记账。
     * @param deleted 当前内容是否处于删除状态。
     * @param latestVersion 当前最新版本号。
     * @param lastUpdatedAt 最近一次更新的时间戳。
     */
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

    /**
     * @notice 内容历史版本快照。
     * @param ipfsHash 该版本对应的链下内容哈希。
     * @param title 该版本标题。
     * @param description 该版本描述。
     * @param timestamp 该版本写入时间。
     */
    struct ContentVersion {
        string ipfsHash;
        string title;
        string description;
        uint256 timestamp;
    }

    /// @notice 当前已登记内容总数，同时也是最新内容编号。
    uint256 public contentCount;

    /// @notice 内容编号到内容主记录的映射。
    mapping(uint256 => Content) public contents;
    /// @notice 内容编号到版本总数的映射。
    mapping(uint256 => uint256) public contentVersionCount;
    /// @dev 内容编号 => 版本号 => 版本详情。
    mapping(uint256 => mapping(uint256 => ContentVersion)) private contentVersions;

    /// @notice 记录某地址是否已对某条内容投过票，防止重复投票。
    mapping(address => mapping(uint256 => bool)) public hasVoted;
    /// @notice 已完成奖励记账时对应的累计票数，用于增量奖励结算。
    mapping(uint256 => uint256) public rewardSettledVotes;
    /// @notice 内容累计发生过多少次奖励记账。
    mapping(uint256 => uint256) public rewardAccrualCount;

    /// @notice 触发奖励所需的最少票数。
    uint256 public minVotesToReward;
    /// @notice 每张有效票对应的奖励金额。
    uint256 public rewardPerVote;
    /// @notice 参与内容投票所需的最小投票权。
    uint256 public minStakeToVote;
    /// @notice 达到该票数后内容不再允许作者编辑。
    uint256 public editLockVotes;
    /// @notice 是否允许在已有投票后删除内容。
    bool public allowDeleteAfterVote;
    /// @notice 单条内容允许保留的最大版本数。
    uint256 public maxVersionsPerContent;

    /// @notice 投票权合约地址，用于校验投票门槛。
    IVotesLike public votesContract;
    /// @notice 奖励金库地址，用于执行奖励记账。
    ITreasuryNative public treasury;
    /// @notice 协议费用接收地址，通常为 Revenue Vault。
    address payable public revenueVault;
    /// @notice 注册新内容时需要支付的协议费用。
    uint256 public registerFee;
    /// @notice 创建新版本时需要支付的协议费用。
    uint256 public updateFee;

    /// @notice `minVotesToReward` 的安全上限。
    uint256 public constant MAX_MIN_VOTES_TO_REWARD = 10000;
    /// @notice `rewardPerVote` 的安全上限。
    uint256 public constant MAX_REWARD_PER_VOTE = 1 ether;
    /// @notice `maxVersionsPerContent` 的安全上限。
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
     * @param author 执行更新的作者地址。
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
     * @param operator 执行删除的人。
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
     * @param operator 执行恢复的人。
     * @param author 内容作者地址。
     */
    event ContentRestored(
        uint256 indexed id,
        address indexed operator,
        address indexed author
    );

    /**
     * @notice 奖励规则更新时触发。
     * @param minVotesToReward 新的最少获奖票数门槛。
     * @param rewardPerVote 新的单票奖励金额。
     */
    event RewardRulesUpdated(uint256 minVotesToReward, uint256 rewardPerVote);

    /**
     * @notice 反女巫配置更新时触发。
     * @param votesContract 新的投票权合约地址。
     * @param minStakeToVote 新的最小投票权门槛。
     */
    event AntiSybilUpdated(address votesContract, uint256 minStakeToVote);

    /**
     * @notice Treasury 地址更新时触发。
     * @param treasury 新的 Treasury 合约地址。
     */
    event TreasuryUpdated(address treasury);

    /**
     * @notice Revenue Vault 地址更新时触发。
     * @param revenueVault 新的费用接收地址。
     */
    event RevenueVaultUpdated(address indexed revenueVault);

    /**
     * @notice 内容发布费或更新费更新时触发。
     * @param registerFee 新的发布费用。
     * @param updateFee 新的更新费用。
     */
    event ContentFeesUpdated(uint256 registerFee, uint256 updateFee);

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
     * @param amount 本次记账金额。
     * @param voteCountAtAccrual 本次记账发生时内容的累计总票数。
     */
    event RewardAccrueRequested(
        uint256 indexed contentId,
        address indexed author,
        uint256 amount,
        uint256 voteCountAtAccrual
    );

    /**
     * @notice 部署合约并设置默认治理参数。
     * @dev 这些默认值适合本地测试与初始运行，后续可由 owner 或治理修改。
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
        emit ContentFeesUpdated(registerFee, updateFee);
    }

    /**
     * @notice 设置奖励金库合约地址。
     * @dev 仅 owner 可调用，且地址不能为零地址。
     * @param _treasury 新的 Treasury 合约地址。
     */
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury=0");

        treasury = ITreasuryNative(_treasury);

        emit TreasuryUpdated(_treasury);
    }

    /**
     * @notice 设置协议费用接收地址。
     * @dev 仅 owner 或后续的治理 Timelock 可以修改。
     * @param _revenueVault 新的 Revenue Vault 地址。
     */
    function setRevenueVault(address payable _revenueVault) external onlyOwner {
        require(_revenueVault != address(0), "vault=0");

        revenueVault = _revenueVault;

        emit RevenueVaultUpdated(_revenueVault);
    }

    /**
     * @notice 设置内容发布费与新版本更新费。
     * @dev 当任一费用大于 0 时，必须先完成 Revenue Vault 配置。
     * @param _registerFee 注册新内容时需要支付的费用。
     * @param _updateFee 创建新版本时需要支付的费用。
     */
    function setContentFees(
        uint256 _registerFee,
        uint256 _updateFee
    ) external onlyOwner {
        if (_registerFee > 0 || _updateFee > 0) {
            require(revenueVault != address(0), "vault not set");
        }

        registerFee = _registerFee;
        updateFee = _updateFee;

        emit ContentFeesUpdated(_registerFee, _updateFee);
    }

    /**
     * @notice 设置反女巫检查依赖的投票权合约和最小投票门槛。
     * @dev 用户调用 `vote` 时，需要在 `votesContract` 中拥有至少 `minStakeToVote` 的投票权。
     * @param _votesContract 投票权合约地址。
     * @param _minStakeToVote 最小投票权门槛。
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
     * @param _rewardPerVote 单票奖励金额。
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
            _rewardPerVote > 0 && _rewardPerVote <= MAX_REWARD_PER_VOTE,
            "bad reward"
        );

        minVotesToReward = _minVotesToReward;
        rewardPerVote = _rewardPerVote;

        emit RewardRulesUpdated(_minVotesToReward, _rewardPerVote);
    }

    /**
     * @notice 设置内容编辑与删除策略。
     * @dev 可配置编辑锁定票数、投票后是否允许删除，以及版本数量上限。
     * @param _editLockVotes 达到该票数后内容不再允许编辑。
     * @param _allowDeleteAfterVote 是否允许投票后删除。
     * @param _maxVersionsPerContent 单条内容允许保留的最大版本数。
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
     * @notice 暂停登记、编辑、投票和奖励记账等核心流程。
     * @dev 仅 owner 可调用，通常用于紧急处置。
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice 解除暂停并恢复合约使用。
     * @dev 仅 owner 可调用。
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice 注册一条新的内容记录并创建初始版本。
     * @dev
     * 调用方需要提供非空 CID 和标题；如果配置了发布费，还需要附带精确的原生币金额。
     * 成功后会新增内容记录、写入版本 1，并触发内容注册与版本存储事件。
     * @param _ipfsHash 新内容文件对应的 IPFS CID。
     * @param _title 新内容标题。
     * @param _description 新内容描述。
     */
    function registerContent(
        string memory _ipfsHash,
        string memory _title,
        string memory _description
    ) external payable whenNotPaused nonReentrant {
        _collectProtocolFee(registerFee);
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
     * 仅作者本人可更新，且内容不能被删除、不能已发生奖励、不能达到编辑锁定阈值。
     * 如果配置了更新费，还需要附带精确的原生币金额。
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
    ) external payable whenNotPaused nonReentrant {
        _collectProtocolFee(updateFee);
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
     * @notice 删除一条内容。
     * @dev 作者或 owner 可以删除；作者删除时还需满足策略限制。
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
            require(allowDeleteAfterVote || c.voteCount == 0, "delete locked");
            require(!c.rewardAccrued, "reward already accrued");
        }

        c.deleted = true;

        emit ContentDeleted(contentId, msg.sender, c.author);
    }

    /**
     * @notice 恢复一条已删除的内容。
     * @dev 作者或 owner 可以恢复已删除内容。
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
     * @notice 读取指定内容的历史版本。
     * @param contentId 内容编号。
     * @param version 版本号。
     * @return ipfsHash 该版本的内容哈希。
     * @return title 该版本标题。
     * @return description 该版本描述。
     * @return timestamp 该版本写入时间。
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
     * @notice 校验并收取协议费用。
     * @dev 当 amount 为 0 时直接返回；否则要求 msg.value 精确匹配，并把费用转入 Revenue Vault。
     * @param amount 当前操作应收取的费用。
     */
    function _collectProtocolFee(uint256 amount) internal {
        require(msg.value == amount, "bad fee");

        if (amount == 0) {
            return;
        }

        require(revenueVault != address(0), "vault not set");

        (bool ok, ) = revenueVault.call{value: amount}("");
        require(ok, "fee transfer failed");
    }

    /**
     * @notice 为指定内容投票。
     * @dev 同一地址对同一内容只能投一次，且需要满足最小投票权门槛。
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
     * @notice 为内容作者执行一次奖励记账。
     * @dev
     * 仅内容作者本人可调用。
     * 记账采用增量结算：每次仅对上次结算后新增的票数计算奖励。
     * @param contentId 需要执行奖励记账的内容 ID。
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
        require(c.author == msg.sender, "not author");
        require(c.voteCount >= minVotesToReward, "not enough votes");

        uint256 settledVotes = rewardSettledVotes[contentId];
        require(c.voteCount > settledVotes, "no new votes");

        uint256 newVotes = c.voteCount - settledVotes;
        uint256 amount = newVotes * rewardPerVote;

        rewardSettledVotes[contentId] = c.voteCount;
        rewardAccrualCount[contentId] += 1;
        c.rewardAccrued = true;

        treasury.accrueReward(c.author, amount);

        emit RewardAccrueRequested(contentId, c.author, amount, c.voteCount);
    }
}
