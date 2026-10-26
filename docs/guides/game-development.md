# Game development

A game on Portaldot keeps its rules and its important moments on chain: a player joins, a battle is won, an item drops. Each of those is an
**event**. PortalOps turns those events into signed webhooks, so the rest of your game (the server, the Discord bot, the website, the
leaderboard) can react in seconds without anyone writing chain-reading code.

```
player acts ─► contract emits event ─► PortalOps captures + decodes ─► signed webhook ─► your game backend reacts
 (wallet)        (on chain)             (retried, replayable)                          (leaderboard, loot feed, rewards)
```

## What PortalOps gives a game

| You want to | How PortalOps helps |
|---|---|
| Show a live leaderboard | `BattleResolved` and `LevelUp` events update a table as they arrive |
| Announce loot, wins and level-ups in Discord or an app feed | One webhook per event type, filtered by event name |
| Grant a reward exactly once | The event id is stable, so de-duplicating on it makes a retry or replay harmless |
| Never miss a move while your server restarts | Deliveries retry with backoff, and any event can be replayed later |
| Wait until a result is final before paying out | Every event carries a finality status; act on `finalized` for anything irreversible |
| Let an AI agent or Claude wire it up | The [Claude tools](claude-setup.md) register a contract and create the webhook in conversation |

## The sample game: Arena

The [example gallery](contracts-and-examples.md) includes **Arena** (`PortalArena`), a small game with the moves every game has:

| Move | Event |
|---|---|
| a player joins | `PlayerJoined(player, name)` |
| two players fight | `BattleResolved(battleId, winner, loser, xpGained)` |
| a player levels up | `LevelUp(player, level)` |
| a winner finds an item | `LootDropped(player, itemId, item)` |

Import it into PortalOps from **Guided setup → Add contract** (pick *Arena game*, then paste the address of your deployed copy), or try the
same flow on the public [playground](https://portalops.onrender.com/playground) with any contract that has this shape: choose *Arena game* in the decoding menu.
[Tutorial 2](../tutorials/game-feed.md) builds a leaderboard and a loot feed from it, step by step.

## Using your own game contract

Any contract that emits events works. A few habits make a game easier to build on:

1. **Emit an event for every state change a player or the UI cares about**, with the player's address as an `indexed` argument so it can be filtered.
2. **Put ids in the event** (`battleId`, `itemId`) so your backend can de-duplicate and join records.
3. **Keep events small.** Large numbers arrive as strings in the webhook; keep names and text short.
4. **Compile for the `paris` EVM version** and deploy with the tool's own gas estimate (see [Contracts and examples](contracts-and-examples.md)).

Then follow [Tutorial 3: import your own contract](../tutorials/import-your-contract.md) to register the address and ABI.

## Patterns that work well

- **Leaderboard:** keep a table keyed by player address; apply `BattleResolved` and `LevelUp` as deltas. Because events carry ids, replays do not double-count.
- **Loot and achievement feed:** subscribe a second webhook filtered to `LootDropped` and post to chat.
- **Season and tournament snapshots:** replay a season's events into a fresh table to rebuild standings without re-reading the chain.
- **Rewards:** credit only when the event's `finalityStatus` is `finalized` (see [Core concepts](concepts.md#finality)).
- **Moderation and anti-cheat signals:** alert on unusual event rates, for example one address winning dozens of battles in a minute.

## What it does not do

- It is not a game engine, an indexer for game state, or a source of randomness. It reports what the contract emitted.
- It reads **events**, not stored state. If you need "what is this player's level right now", keep it in your backend from the events (the Arena leaderboard in tutorial 2 does this) or read it from the contract.
- Demo game contracts here are not audited and their pseudo-randomness is predictable. Do not put value behind them.
