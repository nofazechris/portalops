// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PortalArena: a tiny on-chain game. Join, fight other players, earn XP, level up, find loot.
/// @notice Demo only. It holds no value, and the "randomness" (a hash of the previous block) is predictable: never use it for real stakes.
/// Every move emits an event, which is what makes a game a good fit for webhooks: a Discord bot, a leaderboard or a loot feed can react in seconds.
contract PortalArena {
    struct Player {
        uint32 level;
        uint32 xp;
        uint32 wins;
        uint32 losses;
        bool joined;
    }

    uint256 public battleCount;
    uint256 public lootCount;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint32 public constant XP_PER_LEVEL = 100;
    mapping(address => Player) public players;

    event PlayerJoined(address indexed player, string name);
    event BattleResolved(uint256 indexed battleId, address indexed winner, address indexed loser, uint32 xpGained);
    event LevelUp(address indexed player, uint32 level);
    event LootDropped(address indexed player, uint256 indexed itemId, string item);

    error NameTooLong();
    error AlreadyJoined();
    error NotJoined();
    error CannotFightYourself();

    function join(string calldata name) external {
        if (bytes(name).length > MAX_NAME_BYTES) revert NameTooLong();
        Player storage p = players[msg.sender];
        if (p.joined) revert AlreadyJoined();
        p.joined = true;
        p.level = 1;
        emit PlayerJoined(msg.sender, name);
    }

    function fight(address opponent) external returns (uint256 battleId) {
        if (opponent == msg.sender) revert CannotFightYourself();
        Player storage a = players[msg.sender];
        Player storage b = players[opponent];
        if (!a.joined || !b.joined) revert NotJoined();

        battleId = ++battleCount;
        // Higher level wins more often, but never always. Predictable on purpose: it is a demo.
        uint256 roll = uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), battleId, msg.sender, opponent)));
        bool attackerWins = roll % (uint256(a.level) + uint256(b.level)) < a.level;

        (address winner, address loser) = attackerWins ? (msg.sender, opponent) : (opponent, msg.sender);
        Player storage w = players[winner];
        Player storage l = players[loser];
        w.wins += 1;
        l.losses += 1;
        uint32 gained = 25 + l.level * 5;
        emit BattleResolved(battleId, winner, loser, gained);
        _grantXp(winner, w, gained);

        // Every third battle the winner finds loot.
        if (battleId % 3 == 0) {
            uint256 itemId = ++lootCount;
            emit LootDropped(winner, itemId, itemId % 2 == 0 ? "Iron Sword" : "Healing Potion");
        }
    }

    function _grantXp(address who, Player storage p, uint32 amount) private {
        p.xp += amount;
        while (p.xp >= XP_PER_LEVEL * p.level) {
            p.xp -= XP_PER_LEVEL * p.level;
            p.level += 1;
            emit LevelUp(who, p.level);
        }
    }
}
