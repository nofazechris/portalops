# Video B: the full developer walkthrough (9 minutes)

**Purpose.** After this video a developer who has never seen PortalOps understands what it does, how it works and how to use it end to end:
create a project, watch a contract, receive and verify signed webhooks, survive failures with retry and replay, drive it from code or from
Claude, and trust what is under the hood. It is uploaded to the documentation, so it is chaptered and every chapter points at the page that
goes deeper.

**Length.** Target 9:00 (anything from 8:45 to 9:15 is fine). About 1,000 words of narration (about 7:20 at a calm 135 to 140 words a minute), plus about
1:40 for the screen to breathe while things load and you click. Chapters are written to be re-timed independently: if one runs long, trim words, not demos.

**Audience.** Developers. Plain language first, the precise term second. Say what you are about to click **before** you click it.

**Tone.** Same voice as the 3-minute cut ([Video A](video-script.md)), but slower and more concrete. Short sentences. Name the file, the
header, the field.

**Format.** 1080p screen recording, your voice, no face needed. Zoom the browser to 125 % so code is readable. Burn in captions. Use a
chapter title card of 1.5 seconds at the start of each chapter. Soft music only under the intro and the outro.

**Never show** an API key, a signing secret, `.env` files, Render or Neon settings, or your wallet. Blur or crop the Claude connection line
that holds the key.

---

## Chapter list (paste into the video description for YouTube chapters)

```
0:00 What you will learn
0:40 The problem, and what PortalOps is
1:30 Five ideas that explain everything
2:20 Create an account and a project
3:20 Quick start: from nothing to a delivered event
4:40 Inside one event: payload, id and finality
5:30 Build a receiver and verify the signature
6:30 When things fail: retries and replay
7:10 Automations, the API and the SDK
7:50 Let Claude set it up
8:25 Under the hood, and why you can trust it
8:50 Where to go next
```

---

## 0:00 What you will learn (0:40)

**On screen:** the landing page hero, then the "Everything that happens after an on-chain event exists" cards (Watch, Decode, Deliver, Recover) animating.

> "If you build on Portaldot, your contract is only half of your product. The other half is everything that has to happen *after* the contract emits an event: noticing it, decoding it, telling your app, and not losing it when something breaks.
>
> This is PortalOps, middleware that does that part for you. In the next nine minutes I'll show you how it works and how to use every piece of it: setting up, receiving signed webhooks, retries and replay, the API and SDK, and letting Claude do the setup. By the end you'll have a real event from the real Portaldot testnet landing in your app."

(about 100 words) **Docs:** [What is PortalOps?](../guides/product-overview.md)

## 0:40 The problem, and what PortalOps is (0:50)

**On screen:** the architecture diagram from [Architecture](../architecture/overview.md): chain → worker → store → webhook engine → your receiver, with API / dashboard / SDK / Claude underneath.

> "Reading a chain is harder than it looks. Events are raw hex. Recent blocks can be reorganised. Your server can be down when the event happens. And every team ends up rebuilding the same plumbing.
>
> PortalOps is two small processes that only talk through a database. The worker reads the chain, decodes each event with the contract's ABI, stores it exactly once, and delivers it. The API and dashboard let you control all of it, from a screen, from code, or from Claude. Nothing is lost in between: every event is stored, every delivery is recorded, and anything can be replayed."

(about 110 words) **Docs:** [Architecture](../architecture/overview.md)

## 1:30 Five ideas that explain everything (0:50)

**On screen:** the [Concepts](../guides/concepts.md) page. Highlight each term as you say it.

> "Five ideas. A *project* is your workspace. Contracts, events, webhooks and keys all live inside it, and nobody else can see it.
>
> A *contract* is registered by address. Give PortalOps its ABI and each log becomes a named event with typed arguments. Without an ABI you still get the raw topics and data.
>
> An *event* is one log, stored once. Its id is a hash that includes the block hash, so reading the same block twice never duplicates it, and a reorganised log becomes a different event.
>
> A *webhook* is where events are sent. It has a filter and a retry policy, and every request is signed.
>
> And a *delivery* is one event going to one webhook, with every attempt recorded."

(about 130 words) **Docs:** [Concepts](../guides/concepts.md)

## 2:20 Create an account and a project (1:00)

**On screen:** `/auth#signup`. Type an email and a weak password, then a strong one: show the strength bar and checklist. Show the eye toggle. Sign up. Show the "Confirm your email" banner. Then **Create your first project**.

> "Sign up with an email or with GitHub. The form tells you what's wrong in plain language and the strength bar updates as you type. After signing up we send a confirmation email. You can start straight away, but confirm it so you can recover your account later.
>
> Now create a project. It's your workspace: its contracts, events, webhooks and keys live here. You can have several and switch between them from this menu."

(about 85 words) **Docs:** [Accounts](../guides/accounts.md)

## 3:20 Quick start: from nothing to a delivered event (1:20)

**On screen:** the three-step Quick start, one step at a time. Step 1: **PortalOps Quest board** → **Start watching**. Step 2: **Test receiver** → **Create webhook**. Step 3: checklist ticking, **Send a test delivery**, the timeline filling with `QuestCreated`, `QuestCompleted`, `RewardIssued`.

> "The quick start has three steps. First, what to watch. You can pick a contract we deployed on the testnet, a busy token from another team, or paste your own address. I'll choose our Quest board and press Start watching.
>
> Second, where events go. If you don't have a server yet, use the test receiver. It's hosted by PortalOps, so there's nothing to run. If you do, paste your https address. The signing secret is shown once, so copy it now.
>
> Third, watch it work. The checklist ticks off as the network connects, the contract is watched, an event is captured and a delivery succeeds. Send a test delivery and the receiver confirms the signature. And here, the Quest board's real events: QuestCreated, QuestCompleted and RewardIssued, from real transactions, decoded and delivered."

(about 150 words) The first events can take up to a minute: pre-warm the account and cut the wait. **Docs:** [Quick start](../guides/quickstart.md), [Contracts and examples](../guides/contracts-and-examples.md)

## 4:40 Inside one event: payload, id and finality (0:50)

**On screen:** open `QuestCreated`. Pan across the decoded payload, the transaction and block, the finality panel, then the delivery history.

> "Open an event. Here's the decoded payload, large numbers as strings so nothing loses precision, and the transaction and block it came from.
>
> Then finality, which matters if you move money. *Included* means it's in a recent block. *Confirmed* means twelve blocks deep, which is a heuristic. *Finalized* means the node itself has finalized the block and we've verified the hash is still canonical. Only finalized is safe for something irreversible. And if a block is reorganised away, the event becomes *orphaned*.
>
> Below is the delivery history: every attempt, with its HTTP status and duration."

(about 115 words) **Docs:** [Concepts: Finality](../guides/concepts.md#finality)

## 5:30 Build a receiver and verify the signature (1:00)

**On screen:** the code from [Receiving webhooks](../guides/webhooks.md): the header table, then the SDK snippet (`constructEvent` in an Express route with `express.raw`). Then the test vector table.

> "Now your side. Each delivery is a POST with a JSON body and a header called PortalOps-Signature, containing a timestamp and an HMAC of the *raw* body. Verify it before you do anything else.
>
> With the SDK it's one call: constructEvent, with your secret, the raw bytes, and the header. It rejects bad signatures and old timestamps. Three rules: use the raw body, not re-serialised JSON; compare in constant time; and de-duplicate on the event id, because delivery is at-least-once.
>
> If you don't use Node, the docs have Python, Go and PHP versions and a test vector so you can check yours matches."

(about 120 words) **Docs:** [Receiving webhooks](../guides/webhooks.md)

## 6:30 When things fail: retries and replay (0:40)

**On screen:** Webhooks → test receiver → **Fail with HTTP 500** → trigger or replay an event → delivery history shows attempts and `retrying`. Switch back to healthy, **Replay** → `delivered`.

> "Let's break it on purpose. I'll switch the receiver to fail with a 500. PortalOps retries network errors, timeouts and server errors with growing gaps: five attempts by default, backing off up to an hour. A 400-level answer is permanent, so it stops straight away.
>
> Now fix the receiver and press Replay. The stored event is sent again with the same id. The blockchain is never touched."

(about 85 words) **Docs:** [Concepts: Webhooks and deliveries](../guides/concepts.md#webhooks-and-deliveries)

## 7:10 Automations, the API and the SDK (0:40)

**On screen:** Automations → a rule ("when `QuestCompleted` happens, send to this webhook"). Then Settings → API keys (create a **write** key, blur it). Then the SDK snippet "Read events" / "Act only on finalized events" from [SDK](../guides/sdk.md).

> "Automations route by rule: when QuestCompleted is captured, send it to this webhook. Everything the dashboard does is also a REST call. Create a project key with read or write scope, shown once and stored only as a hash. And the typed TypeScript SDK wraps it, including a helper for acting only on finalized events."

(about 65 words) **Docs:** [API reference](../reference/api.md), [SDK](../guides/sdk.md)

## 7:50 Let Claude set it up (0:35)

**On screen:** Claude Code with the PortalOps connection (key hidden). Ask: *"Watch my Quest contract and send its events to the test receiver."* Tool calls scroll. Highlight "signing secret saved to .env.portalops".

> "Or just ask. PortalOps ships a Claude tool server with ten tools. Add it with one command, using a key limited to this project, then describe what you want. Claude checks the project, registers the contract with the right ABI, creates the webhook and sends a signed test. The signing secret is written to a local file. It never enters the conversation."

(about 70 words) **Docs:** [Set up with Claude](../guides/claude-setup.md)

## 8:25 Under the hood, and why you can trust it (0:25)

**On screen:** the evidence card on the landing page (contract address, transaction hashes), then the README test/security lines.

> "Under the hood: events, deliveries and the read position move together or not at all, so a crash can't lose one. Secrets are encrypted at rest, deliveries can't reach internal addresses, and more than a hundred and seventy automated tests run, including against real testnet logs. The Quest contract and its transactions are real, on the Portaldot testnet."

(about 60 words) **Docs:** [Security review](../security/review.md)

## 8:50 Where to go next (0:10)

**On screen:** the docs home, then the repository URL.

> "Start with the quick start, then the docs. PortalOps: watch any contract, never miss an event."

(about 18 words)

---

## Facts to keep straight

| Say | Source |
|---|---|
| Delivery retries: 5 attempts, 5 s base, 1 h cap, give up after 24 h, 10 s timeout (all per-webhook settings) | [Concepts](../guides/concepts.md#webhooks-and-deliveries) |
| `confirmed` is a 12-block depth heuristic; `finalized` is the node's own finalized block **and** a verified hash | [Concepts: Finality](../guides/concepts.md#finality) |
| Delivery is **at-least-once**, not exactly-once; de-duplicate on `PortalOps-Event-Id` | [Receiving webhooks](../guides/webhooks.md) |
| Claude has **ten** tools; secrets go to `.env.portalops` (git-ignored), never into the chat | [Set up with Claude](../guides/claude-setup.md) |
| The SDK is in this repository and **not on npm yet** | [SDK](../guides/sdk.md) |
| Rust/ink! contracts are **planned**, not supported; PortalOps reads the EVM view of the testnet | [Network compatibility](../architecture/network-compatibility.md) |
| The public site runs on free hosting and **sleeps when idle**: open it a minute before recording | [Put it live](live-deploy.md) |
| Test count: "more than a hundred and seventy" (173 when this was written). Re-run `npm test` and say the true number | `npm test` |

## Before you record

1. `https://portalops.onrender.com/api/v1/health` answers 200. Open the site a minute earlier so the free plan is awake.
2. Use a **fresh account** so every screen appears naturally (sign-up, banner, first project, quick start).
3. Create a **write** API key and add the Claude connection ([Set up with Claude](../guides/claude-setup.md)). Check Claude lists the ten PortalOps tools. Keep the key off screen.
4. Have a tiny Express receiver open in an editor for chapter 5 (the snippet from [Receiving webhooks](../guides/webhooks.md)), with the secret in an environment variable, not in the file.
5. Rehearse chapters 3 and 6: the first events take up to a minute, and the retry schedule is slow, so record the failure and replay as two short takes and cut between them.
6. Close anything with secrets: `.env`, Render and Neon settings, your wallet, your password manager.

## After you record

- Upload (unlisted or public), paste the chapter list above into the description, and put the video link in the README and in the DoraHacks "Project progress" field.
- Add the link to the documentation site (ask for a short "Watch the walkthrough" page with the embedded video and these chapters, each linking to the page that goes deeper).
