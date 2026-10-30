# PortalOps and the Portaldot ecosystem

A page you can share. It says what PortalOps is for, what it gives the Portaldot ecosystem, how to check every claim yourself, what it does **not** do
yet, and the questions we expect to be asked, with straight answers.

## In one paragraph

Every application on a blockchain needs to know, reliably and quickly, **what just happened on the chain**: a game needs every move and reward, a
payment app needs every transfer, an AI agent needs every event it should react to. On Portaldot that means reading raw logs, working around the
quirks of a new network, surviving reorganisations, and building your own delivery and retry system. PortalOps is that layer, built once and open for
everyone: it **watches** contracts (Solidity and Rust), **decodes** their events, tells you honestly **how final** each one is, **delivers** it to your
server as a signed webhook with retries, and lets you **replay** anything your server missed. Alongside it sits a public **verified contract registry**:
proof that a contract's source is the code that really runs on chain.

## The problem on Portaldot today

- **Raw logs are unreadable.** An event on the chain is hex. Turning it into `QuestCompleted { player, reward }` needs the contract's ABI, and nothing
  checks that the ABI someone pastes is the right one.
- **The network has its own behaviour.** Portaldot V3.0 runs an EVM on a Substrate chain (pallet-revive), plus a native ink! (Rust) side. Only about the
  last 256 blocks can be fetched by number, finality comes from the node's own finalized head, and gas is weight based. Every team meets these one at
  a time. We wrote them down once, in [Portaldot field notes](../architecture/network-compatibility.md).
- **Rust contracts are invisible to EVM tools.** ink! events are not EVM logs, so an EVM indexer never sees them.
- **Delivery is its own project.** Signing, retrying, backing off, not delivering twice, and recovering after your server was down are weeks of work
  that every team repeats.

## What PortalOps gives, and to whom

| If you are... | You get |
| --- | --- |
| **A builder with a contract** | Paste an address (and ABI, or none if it is verified). Within seconds every event is captured, decoded by name, and POSTed to your URL as a signed webhook. Failed deliveries retry with backoff and can be replayed. |
| **A game team** | Every move, quest and reward becomes an event your backend reacts to. The Arena Lab (`/arena` on the site) teaches this with graded challenges, and the examples (quest board, token, bounty board, ping, arena) deploy in one command. |
| **An AI-agent or Claude user** | `@portalops/mcp` lets Claude set up a project, register contracts, create webhooks, replay events and diagnose a failed delivery. `@portalops/sdk` is the same for code. |
| **Another Portaldot project** | A public [verified contract registry](verified-contracts.md): submit source, it is compiled and proven equal to the code on chain, and then **everyone** gets the ABI, named events and live activity. |
| **The Portaldot community** | An open-source (MIT) reference for how the network really behaves, with every claim re-checkable by one command. |

## What we contribute beyond the product

1. **An event layer that did not exist for Portaldot**, for both runtimes: EVM logs by JSON-RPC and ink! `ContractEmitted` events by a native reader.
2. **The verified contract registry**: a public good. One verification helps every future builder of that contract.
3. **Field notes**: the network's real behaviour, each point with how to re-check it.
4. **Packages on npm** (`@portalops/sdk`, `@portalops/mcp`), so integrating takes minutes, not weeks.
5. **Teaching material**: tutorials, game-development and ink! guides, and the Arena Lab.
6. **Evidence you can rerun**: `npm run verify:evidence` asks the public testnet for every deployment, the code at each address and each emitted event,
   and fails loudly if any claim is wrong. It also proves the code on chain equals the Solidity in this repository.

## Check it yourself

| Claim | Command or page |
| --- | --- |
| The tests pass on a clean clone | `git clone https://github.com/nofazechris/portalops && cd portalops && npm ci && npm test` (250+ tests) |
| Our contracts are on the testnet and emitted the events we say | `npm run verify:evidence` (24 read-only checks against the public RPC) |
| The service really captured them | `npm run verify:evidence -- --live https://portalops.onrender.com` |
| An event is real | open any event and click **Verify against the chain** (it runs in your browser, against the public RPC) |
| The registry is real | open `/registry`, click a contract, compare its source with the code on chain |
| Events travel end to end | open `/playground`, click **Send a free ping**, and watch the transaction get captured, decoded, finalized and delivered |

## Honest limits

We would rather you hear these from us.

- **Testnet only.** Portaldot V3.0 testnet. Nothing here claims mainnet readiness.
- **One small instance.** The hosted demo is a single service on a free plan. It is a demonstration, not a production service level.
- **The Rust (ink!) reader sees recent blocks only** (about the last 240) because the native node's block lookup is limited. Older ink! events need a
  start block inside that window.
- **The registry takes single-file Solidity** (no imports; flatten first) and verifies EVM contracts. Rust contracts describe themselves through
  their metadata file instead.
- **Verification means "same code"**, not "safe code". A match proves the source is what runs; it says nothing about whether the source is good.
- **No outside users yet.** The tooling is built and public; adoption is the next job, not something we claim to have.

## Questions we expect, and straight answers

**Why would Portaldot need this? Couldn't anyone build it?**
Anyone could, and every team would have to, and each would hit the same network quirks one at a time. On other chains this layer exists as services.
For Portaldot's EVM-on-Substrate plus ink! design it did not. PortalOps builds it once, documents the quirks, and makes it open.

**Is it only for Portaldot?**
Yes, deliberately. It verifies the network's chain id and refuses to run against the wrong chain. Depth on one network beats a thin layer over many.

**Why trust an indexer at all?**
You do not have to. Every EVM event has a **Verify against the chain** button: your own browser asks the public Portaldot RPC for the transaction receipt and
compares it with what we stored: same transaction, success status, block hash, contract, topics and data. A forged or altered event fails, a transaction that was
reorganised away is reported as such, and a copyable `curl` command lets you check it without PortalOps or its page. (The API has the same check at
`GET /events/:id/verify`.) Anchoring records on chain can show an indexer did not change history; checking against the chain shows the record is true.

**What makes the numbers trustworthy?**
Finality is read from the node's own finalized head, never guessed. Reorganised events are marked orphaned, not silently dropped. Every claim about our
deployed contracts is re-checked by a command that does not use our database.

**What happens if my server is down?**
Deliveries retry with backoff and then wait. When you are back, **replay** re-sends the stored event with the same id: the chain is never touched again,
and a duplicate id lets you ignore anything you already handled.

**How is it secured?**
Webhooks are signed (HMAC-SHA256) and verify with a timestamp, webhook targets are checked against server-side request forgery, secrets are encrypted at
rest (AES-256-GCM), API keys expire, sign-in supports two-factor, and the public endpoints are rate limited. See the [security review](../security/review.md).

**What does the registry prove, exactly?**
That the compiled source equals the code on chain, either byte for byte or apart from the compiler's metadata tail. It does not prove the source is safe,
and it does not cover imports (yet).

**Does it work with Rust contracts?**
Yes. Register the contract's SS58 address and its metadata file; PortalOps reads `ContractEmitted` events from the native runtime and decodes them with
the metadata. See [Rust (ink!) contracts](ink-contracts.md) for what has been verified on the live testnet and what has not.

**Who is it for first?**
Game and agent teams, because they live on events. The Arena Lab and the Claude tools exist to make their first hour short.

**What is next?**
Security alert rules (unlimited approvals, ownership changes), agent triggers and an audit trail, one-step deploy and watch, and more of Portaldot's
ink! side as the node's history window allows.

**Where is the code, and is it free?**
https://github.com/nofazechris/portalops, MIT licensed. Contributions and security reports are welcome: see CONTRIBUTING and SECURITY in the repository.

## Links

- Live: https://portalops.onrender.com (playground, registry, docs, Arena Lab, pitch)
- Code: https://github.com/nofazechris/portalops
- npm: `@portalops/sdk`, `@portalops/mcp`
- Start here: [Quickstart](quickstart.md) · [Core concepts](concepts.md) · [Verified contracts](verified-contracts.md) · [Rust (ink!) contracts](ink-contracts.md)
