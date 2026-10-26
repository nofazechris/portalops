# Tutorials

Short, hands-on walkthroughs. Each one ends with something you can see working, and each builds on real Portaldot testnet activity.
Do them in order the first time; after that, jump to the one you need.

| # | Tutorial | You will | Time |
|---|---|---|---|
| 1 | [Your first webhook](first-webhook.md) | Watch a live contract, receive a signed event, break a delivery and replay it | 10 min |
| 2 | [Build a game feed](game-feed.md) | Run the Arena game contract and turn its events into a leaderboard and a loot feed | 25 min |
| 3 | [Import your own contract](import-your-contract.md) | Compile, deploy and track a contract of your own with its ABI | 15 min |
| 4 | [Set it all up with Claude](with-claude.md) | Let Claude register a contract, create the webhook, watch events and replay failures | 10 min |
| 5 | [Automate with the SDK](with-the-sdk.md) | Do the same from a script: register, watch for failures and replay them | 15 min |

## Before you start

- A PortalOps account at the live site, or your own server ([Put it live](../operations/live-deploy.md)).
- Nothing else for tutorial 1 and 4. Tutorials 2 and 3 deploy a contract, which needs a **funded Portaldot V3.0 testnet account** on your own
  machine (PortalOps itself never needs a key). If you do not have one, use the already-deployed Quest board and the public explorer instead.
- Node 24+ for the code in tutorials 2, 3 and 5.

## Words used everywhere

- **Event:** a note a contract writes to the chain when something happens (a quest completed, a battle fought).
- **Webhook:** an HTTPS request PortalOps sends to your server when an event happens.
- **Replay:** re-sending a stored event with the same id, without touching the chain. See [Core concepts](../guides/concepts.md).
