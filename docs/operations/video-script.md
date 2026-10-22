# Demo videos: scripts and narration

DoraHacks asks for **one** demo: a link, or a video of **at most 3 minutes**. A 3-minute video cannot also teach someone how to use the
whole product, so make **two** videos from this one document:

| Video | Length | Purpose | Where it goes |
|---|---|---|---|
| **A. The submission cut** | 3:00 max | The problem, the product working on the real testnet, Claude setting it up | DoraHacks "Demo" field |
| **B. The full walkthrough** | about 8 to 10 minutes | Everything from the problem to every screen and the quick start, step by step | README, YouTube/Loom link, "Project progress" field |

Everything in quotes below is **narration**: lines for you to say in your own voice over a screen recording. If you would rather send me
your own words (a typed transcript or notes), I will rewrite these lines to match how you talk. (I cannot use a voice recording directly:
send text, or record yourself reading these.) Never show or read out keys, secrets or your wallet.

---

## Part 1: The story (use this for the opening of both videos)

### The problem, in plain words

> "Every smart contract on a blockchain leaves a public trail: events. Someone sends a token, creates a quest, approves a payment, and the contract writes it down. But writing it down isn't enough. The apps and teams that depend on that contract have to *notice* it, quickly, reliably, and without ever missing one. And that is surprisingly hard."

Why it is hard (all true of any chain, say them in your own words):

1. **Events are raw.** On chain an event is hex: topics and data. Turning it into "Alice sent 5 tokens to Bob" needs the contract's ABI and code to decode it.
2. **Chains reorganise.** The newest blocks can be replaced. An app that acts on an event too early can act on something that never really happened.
3. **Apps go down.** If your server is offline for ten minutes, the chain does not wait. Without storage, retries and replay you simply lose events.
4. **Everyone rebuilds the same plumbing.** Polling nodes, tracking where you stopped, handling restarts, signing and retrying notifications. Each team writes it again, usually badly, usually after the first missed event.

### Our own research on the Portaldot testnet

We measured this on the live Portaldot V3.0 testnet using PortalOps' public explorer (measured 2026-10-22, the explorer reads the last
~120,000 blocks, blocks 91,528 to 145,105):

| Measurement | Result |
|---|---|
| Events emitted by contracts | **225** |
| Different contracts emitting them | **32** |
| Different event types (signatures) | **65** |
| Events that anyone had decoded for us (we had no ABIs) | **0**: all raw hex |
| Contracts that emit the standard token `Transfer` event | 11 |

> "We pointed PortalOps at the Portaldot testnet and just listened. In a young network, 32 different contracts had already produced 225 events of 65 different kinds. To a developer reading the chain, every one of them is an unreadable blob of hex. Nobody was watching them for the people who care. That is the gap."

Be careful with these claims: "**we had no ABIs for them**" is true and provable; "nobody is watching them" is **not** something we measured, so
say it as your conclusion ("these are not readable out of the box"), not as a statistic. Re-run the numbers before you record (open
`https://portalops.onrender.com/app`, signed out) because the chain keeps moving. Do not quote industry statistics unless you can name the
source on screen.

### Why developers need this

> "Developers shouldn't have to become infrastructure engineers to react to a contract. They need three things: events captured reliably, decoded into names they understand, and delivered to their app with guarantees: signed so they can trust it, retried if their server is down, and replayable when something goes wrong. That is PortalOps."

### One sentence for the title card

> "PortalOps: the operational event layer for Portaldot. Watch any contract, get signed, retried, replayable webhooks, and let Claude set it up for you."

---

## Part 2: Video A, the submission cut (3:00 max)

Record in one take per beat, then trim. Prepare first (see **Before you record** at the end).

| Time | On screen | Narration (say this) |
|---|---|---|
| 0:00 to 0:25 | Title card, then the landing page | The problem (shortened): "Contracts emit events, but reading them, trusting them and never missing one is hard. Every team rebuilds the same plumbing. I built PortalOps so they don't have to." |
| 0:25 to 0:50 | `/app` signed out: the **Live timeline** and the network pill | "This is the live Portaldot V3.0 testnet. On our scan, 32 contracts had emitted 225 events, all raw hex. PortalOps captures all of them, and shows how final each one is." Click one event: the **Finality** panel. |
| 0:50 to 1:25 | New account, **Create your first project**, **Quick start** step 1: pick **PortalOps Quest board** | "Setup is three steps. First: what to watch. I'll watch a contract we deployed on this testnet. Here is its address and the transactions that created it." |
| 1:25 to 1:50 | Step 2: the test receiver, then step 3 | "Second: where events go. I'll use the built-in receiver so there is nothing to run. Third: watch it work." Events appear: `QuestCreated`, `QuestCompleted`, `RewardIssued`. "Real events from our contract, decoded and delivered." |
| 1:50 to 2:30 | **Claude** | "Now the same setup by just asking." Paste the prompt below. Let the tools scroll. "Claude registered the contract, created the webhook and tested it. Notice the signing secret went to a local file. Claude never saw it." |
| 2:30 to 2:55 | Event page: **Delivery history**; switch the receiver to fail; replay | "Break it on purpose: the receiver fails, PortalOps retries with backoff. Fix it, replay, delivered. The chain was never touched." |
| 2:55 to 3:00 | README architecture diagram | "Open source, tested against the real testnet. PortalOps." |

### The prompt for Claude

> Set up PortalOps for me. Watch the contract `0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649` using the Quest example's ABI, starting from block 145090, and send all events to the built-in test receiver. Then send a test delivery and show me the events.

(Claude should call `portalops_setup_status`, `portalops_register_contract` with `example: "quest"`, `portalops_create_webhook` with
`builtinReceiver: true`, `portalops_send_test_delivery` and `portalops_list_events`. If it ever asks you for a key or a secret, that is a bug.)

---

## Part 3: Video B, the full walkthrough (8 to 10 minutes)

Goal: someone who has never used PortalOps can follow along and finish with a delivered event. Say what you are about to click **before** you click.

### 1. The problem and the research (about 1:45)
Use Part 1 above, in full: the problem, the four reasons it is hard, the measurements table, why developers need it, the title-card sentence.

### 2. What PortalOps is (about 0:45)
Show the README architecture diagram.

> "PortalOps has two parts that talk only through a database. A worker reads the chain: it fetches events, decodes them, tracks how final they are, and delivers them. An API and dashboard let you control it, from a screen, from code, or from Claude. In between, nothing is lost: every event is stored once, every delivery is recorded, and anything can be replayed."

### 3. Three words you need (about 0:30)
Open the quick start's "New to this? Three words you need".

> "A **contract** is a small program on the blockchain. An **event** is the public record it leaves, like 'Alice sent 5 tokens to Bob'. A **webhook** is a web address PortalOps sends each event to, signed so you know it's genuine and re-sent if your app is down."

### 4. Create an account and a project (about 0:45)
Sign up. Show the password strength bar and checklist. Show the "Confirm your email" banner. Then:

> "A project is your workspace: its contracts, events, webhooks and keys live in it. You can have several and switch between them from this menu."

Click **Create project**.

### 5. Quick start, step by step (about 3:00)
This is the heart of the video. Slow down.

**Step 1, what to watch.**
> "Three options. The first is a contract we deployed on the Portaldot testnet: the Quest board. The second is a real, busy token deployed by another team, which has activity all the time. The third is your own contract: paste its address. I'll pick ours."

Click **Start watching**. Point at the confirmation: "PortalOps is now reading its history."

**Step 2, where events go.**
> "A webhook is where events are delivered. If you don't have a server, the test receiver is perfect: nothing to run. If you do, give us your https address. You can also choose to receive only some event types. I'll keep all of them."

Click **Create webhook**. Point at the signing secret: "This is shown once. For the test receiver you don't need it. For your own server you would copy it now."

**Step 3, see it work.**
> "Here's the loop. These checks tick off as things happen. Send a test delivery: one signed message to the receiver. It says the signature was verified. And below, the live timeline: the Quest board's three events, QuestCreated, QuestCompleted and RewardIssued, captured from the chain and delivered."

Wait for the events (up to a minute the first time). If the page is quiet, say so: "It's reading the contract's history. This takes a few seconds."

### 6. Look closer at one event (about 1:00)
Click `QuestCreated`.

> "The finality panel: seen, then confirmed twelve blocks later, then finalized by the network itself. Only finalized is safe for anything irreversible. Here is the decoded payload, the transaction and block it came from, and the delivery history: queued, attempt one succeeded, delivered."

### 7. Break it on purpose (about 1:15)
Webhooks, open the test receiver, switch it to **Fail with HTTP 500**. Replay the event.

> "Now the receiver is down. PortalOps tries, waits, tries again, with growing gaps, and tells you exactly why it gives up. This is what stops you losing events when your server has a bad day." Switch it back to healthy and replay: "Fixed. Replay sends the stored event again, with the same id so your app can recognise it. The blockchain was never touched."

### 8. Let Claude do it (about 1:00)
Show Claude with the PortalOps connection.

> "Everything I just clicked, Claude can do. I give it a key that is limited to this project, and ask in plain language." Paste the prompt from Part 2. "It checks where I am, registers the contract with the right ABI, creates the webhook, and tests it. Secrets never enter the chat: the signing secret was written to a local file."

### 9. Wrap-up (about 0:30)
> "PortalOps: watch any contract on Portaldot, readable events, signed webhooks, retries, replay, and an assistant that sets it up. It's open source and tested against the real testnet."

---

## Before you record

1. `https://portalops.onrender.com/api/v1/health` and `/api/v1/ready` answer 200. (The free plan sleeps when idle: open the site a minute before.)
2. For **Video B** use a fresh account so every screen appears naturally. For the Claude parts: in **Settings, API keys**, create a **write** key and add the connection on your computer (see [Set up with Claude](../guides/claude-setup.md)):
   ```bash
   claude mcp add portalops \
     --env PORTALOPS_API_URL=https://portalops.onrender.com \
     --env PORTALOPS_API_KEY=<your key> \
     -- node --no-warnings=ExperimentalWarning packages/mcp/main.ts
   ```
   Ask Claude "what PortalOps tools do you have?": ten should appear. Hide the key on screen.
3. Rehearse once. The first events can take up to a minute to appear after you start watching a contract.
4. Close anything with secrets: `.env`, Render settings, your wallet, password manager.

## What is real and what to say about it

| Item | Value |
|---|---|
| Our contract (deployed 2026-10-22) | `PortalQuest` at `0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649`, block 145,098 |
| Deployment transaction | `0xe2590bb80b8d81067a1af092a76e5ee9ea22d9c277b0bf2da752813fc21f8a4d` |
| `createQuest` | `0xd267e8a0610c73a4f21e24d0d69319307e52346dc65ad2e72ed280a26630f17c` (block 145,103) |
| `completeQuest` | `0x11a6d7a86de919ad2b5da0c5098e3904cf23683733d53ff30b13c86d6af1c4b3` (block 145,104) |
| `issueReward` | `0x999f0cb2a1c04bce8edcd2b1ac37a3f98408162277428ada87b56b5fed7d32fb` (block 145,105) |
| A real contract by another team (busy) | `0xe0114adc0a2072b602c645f5a07eefa1eadbdbc2` (token `Transfer` events) |

Contract language: **Solidity**, compiled to EVM bytecode, deployed to Portaldot's EVM layer (pallet-revive). Portaldot also supports Rust
(ink!) contracts; PortalOps reads EVM events today, and a native adapter for Rust contracts is planned (the reader is built around an
interface for exactly that). Say "planned", not "supported".

## The dashboard in plain language

| Screen | What it is for |
|---|---|
| **Overview** | Health at a glance: events, deliveries, the network, a live timeline, and your setup checklist |
| **Events** | Every captured event with its finality and delivery status; click one for the payload, finality progression and delivery flow |
| **Webhooks** | Where events are sent. Each has a signing secret (shown once), an event filter and a retry policy. The test receiver needs no server |
| **Automations** | Rules like "when `Transfer` happens, send it to this webhook" |
| **Contracts** | The contracts being watched, with their ABI so events have names |
| **Replay** | Failed deliveries waiting for you to fix something and re-send |
| **Logs, Diagnostics** | What the system did, and a checklist when something is not arriving |
| **API/SDK, AI Setup, Documentation** | Build on it from code, or hand setup to Claude |
| **Settings** | Project details, API keys, audit log |

## How Claude knows what to set up

Claude does not guess. The PortalOps connection gives it ten tools, each with a description of what it does and whether it changes anything,
plus a short instruction: check setup status first, then register the contract, create the webhook, test it, and never ask for keys. It
reads the example catalog to choose an ABI and drives the same public API the dashboard uses, with exactly the permissions of the key you
gave it. When a step fails, the tool returns a plain-language fix ("this key is read-only: create a write key"), so Claude can recover.

## DoraHacks checklist

| Required | Where it is |
|---|---|
| Public GitHub repo, complete README | `github.com/nofazechris/portalops` (make sure the repository is **public**) |
| Architecture diagram | README, Architecture section |
| Updated development records | `git log` and `docs/` |
| Testnet evidence: contract address and transaction hash | The table above; also `docs/architecture/deployment.json` and `evidence.json` |
| Demo (link or video of at most 3 minutes) | Video A, plus the live site `https://portalops.onrender.com` |
| Optional Week 2 fields: progress and remaining tasks | Remaining: native (Rust/ink!) adapter, public playground, more chains |
