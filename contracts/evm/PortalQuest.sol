// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PortalQuest — demo contract for PortalOps
/// @notice Exists only to emit verifiable events on the Portaldot V3.0 testnet.
///         It holds no value and issues no tokens: "rewards" are recorded as events.
contract PortalQuest {
    struct Quest {
        address creator;
        string title;
        bool exists;
    }

    uint256 public questCount;
    uint256 public constant MAX_TITLE_BYTES = 64;
    uint256 public constant MAX_REWARD = 1_000;

    mapping(uint256 => Quest) public quests;
    mapping(uint256 => mapping(address => bool)) public completed;

    event QuestCreated(uint256 indexed questId, address indexed creator, string title);
    event QuestCompleted(uint256 indexed questId, address indexed participant);
    event RewardIssued(uint256 indexed questId, address indexed recipient, uint256 amount);

    error TitleTooLong();
    error UnknownQuest();
    error AlreadyCompleted();
    error NotCreator();
    error RewardTooLarge();
    error NotCompleted();

    function createQuest(string calldata title) external returns (uint256 questId) {
        if (bytes(title).length > MAX_TITLE_BYTES) revert TitleTooLong();
        questId = ++questCount;
        quests[questId] = Quest({creator: msg.sender, title: title, exists: true});
        emit QuestCreated(questId, msg.sender, title);
    }

    function completeQuest(uint256 questId) external {
        if (!quests[questId].exists) revert UnknownQuest();
        if (completed[questId][msg.sender]) revert AlreadyCompleted();
        completed[questId][msg.sender] = true;
        emit QuestCompleted(questId, msg.sender);
    }

    /// @notice Records a test reward for a participant who completed the quest. Creator only.
    function issueReward(uint256 questId, address recipient, uint256 amount) external {
        Quest storage q = quests[questId];
        if (!q.exists) revert UnknownQuest();
        if (q.creator != msg.sender) revert NotCreator();
        if (!completed[questId][recipient]) revert NotCompleted();
        if (amount > MAX_REWARD) revert RewardTooLarge();
        emit RewardIssued(questId, recipient, amount);
    }
}
