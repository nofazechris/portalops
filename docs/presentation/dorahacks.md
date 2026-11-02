# DoraHacks text: paste-ready

Three lengths. Counts are characters including spaces and are checked by a test, so they stay true if you edit the text (keep the `<!-- limit -->` markers).

## One line (tagline)

<!-- limit:100 -->
The event layer for Portaldot: set up once, and PortalOps watches, delivers and verifies.
<!-- /limit -->

## Short description (960 characters or fewer)

<!-- limit:960 -->
Smart contracts are brilliant at doing things and terrible at telling anyone. Developers and AI agents are arriving on Portaldot to build real-world assets, games, payments and agents, and none of them should have to learn chain plumbing. PortalOps is where they start: point it at a contract (Solidity or Rust ink!) and it watches, decodes raw hex into named events, confirms how final each one is from the node itself, and delivers it as a signed webhook with retries and replay. We measured the testnet's public events: 32 contracts, 225 events, none readable without an ABI. Don't trust us: every EVM event has a "Verify against the chain" button that runs in your browser against the public RPC, and a public registry proves a contract's source is what runs on chain. Try it, no signup: send a real free ping from the playground. SDK and Claude tools on npm, MIT, 260+ tests. Testnet only; limits are in the README.
<!-- /limit -->

## Full description (long field)

<!-- limit:3000 -->
**Smart contracts are brilliant at doing things, and terrible at telling anyone about it.**

Picture a game on Portaldot. A player finishes a quest, the contract pays the reward, and it emits an event. Your server has to hear that and act. What the chain gives you is hex: when we measured the testnet's public events (32 contracts, 225 events), none were readable without the contract's ABI. Then blocks get reorganised, your server goes down at 3 a.m., a webhook fails and nobody retries. Every team builds the same plumbing, slowly and with different bugs.

**A developer should never have to learn the plumbing.** Portaldot is built, and developers (and the AI agents working beside them) are arriving to build on it: real-world assets, games, payment flows, agents. They came to build their product, not to learn reorganisations, finality or webhook retries. PortalOps is where they start: point it at a contract, say where events should go, and the watching, decoding, confirming, delivering and recovering is done for them. You build on Portaldot. PortalOps understands Portaldot.

**What it does:** watches your contracts (Solidity and Rust ink!), decodes logs into named events, tells you how final each one is straight from the node's own finalized head, delivers it as an HMAC-signed webhook with retries, and replays anything you missed without touching the chain.

**For developers and agents:** a dashboard, REST API and TypeScript SDK, plus a Claude (MCP) server on npm. Ask Claude to track a contract and it registers it, creates a signed webhook and sends a test; later it can read events, replay failures and diagnose a failed delivery. An agent never sees your private keys, so deploying stays a command you run.

**Don't trust us, check.** Every EVM event has a "Verify against the chain" button that runs in your own browser against the public RPC. A public registry of verified contracts compiles submitted source and proves it equals the code at the address. `npm run verify:evidence` re-checks every claim about our deployed contracts without using our database.

**Try it in sixty seconds, no signup:** open the playground, send a real free ping, and watch it get captured, decoded, finalized and delivered. Then verify it against the chain.

**Why Portaldot specifically:** two contract engines on one chain, weight-based gas, and only the last ~256 blocks fetchable by number. We wrote those quirks down as open field notes and built around them.

**Honest limits:** testnet software on free hosting, no outside users yet, our own Rust contract is built and tested but not deployed live (it needs about 420 tPOT locked), and one-step deploy and agent triggers are roadmap, not product. Track: Modular Cloud and Middleware.
<!-- /limit -->

## Links to paste

- App: https://portalops.onrender.com
- Playground (no signup): https://portalops.onrender.com/playground
- Verified contracts: https://portalops.onrender.com/registry
- Code: https://github.com/nofazechris/portalops
- Walkthrough video: https://youtu.be/fau4mVZS1iY
- Pitch deck: https://portalops.onrender.com/pitch
