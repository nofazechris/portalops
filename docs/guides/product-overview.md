# What is PortalOps?

PortalOps is **middleware for blockchain events**. It watches smart contracts on the Portaldot V3.0 testnet and delivers what happens on
them to your application as **signed, retried, replayable webhooks**, with a dashboard to see and control all of it, and an assistant
(Claude) that can set the whole thing up for you.

If you have ever wanted to say "when this contract does X, do Y in my app", and you did not want to build the plumbing that makes that
reliable, this is the plumbing.

## The problem

A smart contract records everything it does as **events**: a token moved, a quest was completed, a payment was approved. Writing events
down is the easy part. The hard part is what the people and apps that depend on the contract need next: to **notice** each event quickly,
**understand** it, **trust** it, and **never miss one**.

Doing that yourself means solving the same four problems every time:

| Problem | Why it hurts |
|---|---|
| **Events are raw** | On chain, an event is hex: a list of topics and a blob of data. Turning it into "Alice sent 5 tokens to Bob" needs the contract's ABI and careful decoding. |
| **Chains reorganise** | The newest blocks can be replaced. An app that acts on an event too early can act on something that never really happened. |
| **Apps go down** | If your server is offline for ten minutes, the chain does not wait. Without storage, retries and replay, those events are simply gone. |
| **Everyone rebuilds it** | Polling a node, remembering where you stopped, surviving restarts, signing and retrying notifications: each team writes the same code, usually after the first missed event. |

We measured how real this is on the Portaldot testnet itself. Pointing PortalOps at it (2026-10-22), **32 different contracts** had already
emitted **225 events of 65 different kinds**, and, because no ABIs were available to us, every one of them was unreadable hex. That is the
gap PortalOps fills: events turned into something a developer can act on.

## What PortalOps does about it

```
  Portaldot chain ──► Worker ──────────► Store ───────────► Webhook delivery ──► Your app
   (events as hex)   reads blocks,       every event       signs, sends,         verifies the signature,
                     decodes with ABI,   kept exactly      retries with          acts once per event id
                     tracks finality     once, forever     backoff, records
                                                           every attempt
                                    ▲
         API + dashboard + SDK + Claude: see it, control it, replay anything
```

1. **It reads the chain for you.** A worker follows the network block by block and remembers exactly where it stopped, so a restart
   never loses or repeats anything.
2. **It decodes events into names.** Give it a contract's ABI (or pick one of the built-in examples) and a raw log becomes
   `Transfer { from, to, value }`.
3. **It tells you how final each event is.** Every event moves through *included → confirmed → finalized* (or *orphaned* if its block was
   replaced), using the network's own finality signal, never a guess.
4. **It delivers to your app reliably.** Each event is sent as a signed HTTP request. If your server is down, PortalOps retries with growing
   gaps, records every attempt, and lets you **replay** the stored event when you are ready.
5. **It gives you a cockpit.** A dashboard shows events arriving live, each delivery's journey, and what went wrong when something did.

## The features, one by one

| Feature | What it means for you |
|---|---|
| **Event ingestion** | Captures the logs of the contracts you register, from a block you choose, and keeps going. Each event is stored exactly once. |
| **ABI decoding** | Readable event names and arguments instead of hex. Large numbers stay exact (delivered as strings). Without an ABI, events are still captured as raw data. |
| **Finality tracking** | `included`, `confirmed` (12 blocks deep), `finalized` (the network says so, and the block hash was re-checked), or `orphaned`. Only `finalized` is safe for irreversible actions. |
| **Signed webhooks** | Every request carries an HMAC-SHA256 signature over the exact body, so your server can prove it came from PortalOps and was not altered. |
| **Retries** | Network errors, timeouts and server errors are retried with exponential backoff and jitter. Configurable per webhook. |
| **Replay** | Re-send any stored event, with the same event id, to one webhook or all. The chain is never touched. |
| **Idempotency** | Every delivery carries the event id so your app can recognise and ignore duplicates. Delivery is at-least-once, by design. |
| **Built-in test receiver** | A hosted webhook target that verifies signatures and can be switched to fail on purpose. Try everything with no server of your own. |
| **Automations** | Rules like "when `Transfer` happens, send it to this webhook". |
| **Live dashboard** | Overview, a live event timeline, finality progress bars, and a flow diagram for every delivery's attempts. |
| **API and TypeScript SDK** | Everything the dashboard does is available over a documented REST API, with project-scoped keys. |
| **Claude (MCP) setup** | Ask Claude to register a contract, create a webhook and test it. Secrets never enter the chat. |
| **Accounts** | Email and password with confirmation and reset by email, or GitHub sign-in. |

## Who it is for

- **Dapp developers** who need their backend to react to contract activity (credit a balance, send a notification, update a database).
- **Teams building on Portaldot** who would rather ship product than operate event infrastructure.
- **Anyone exploring the network**: the public explorer shows live testnet events with no account.
- **People who like to delegate setup to an assistant**: Claude can do the setup from a chat.

## What it is not (yet)

Being clear about the edges is part of being trustworthy:

- It is **not a historical query engine**. It delivers and records events for the contracts you watch; it is not a general-purpose
  analytics database like a GraphQL indexer. The two are complementary.
- It reads the **EVM side** of the **Portaldot V3.0 testnet** today. Portaldot also supports Rust (ink!) contracts; reading those is a
  planned adapter, not a shipped feature.
- It is **testnet software**: no real funds are involved, and it has not been through an external security audit (see the
  [security review](../security/review.md) for what was checked).
- Webhooks are **at-least-once**. Exactly-once is not possible over HTTP; PortalOps makes duplicates harmless instead.

## Proof it works on the real network

PortalOps ingests the live Portaldot testnet continuously. We also deployed our own demo contract there and watched PortalOps capture it:
`PortalQuest` at `0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649` (block 145,098). Three transactions (`createQuest`, `completeQuest`,
`issueReward`) produced three events, which PortalOps captured, decoded and delivered. The addresses and transaction hashes are in the
README under *Testnet evidence*.

## Where to go next

- **Try it in two minutes:** the [Quickstart](quickstart.md).
- **Understand the words and the model:** [Core concepts](concepts.md).
- **See every screen explained:** the [Dashboard tour](dashboard-tour.md).
- **See what you can build:** [Use cases and recipes](use-cases.md).
- **Let Claude do the setup:** [Set up with Claude](claude-setup.md).
