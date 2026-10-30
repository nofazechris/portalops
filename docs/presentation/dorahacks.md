# DoraHacks text: paste-ready

Three lengths. Counts are characters including spaces and are checked by a test, so they stay true if you edit the text (keep the `<!-- limit -->` markers).

## One line (tagline)

<!-- limit:100 -->
The event layer for Portaldot: watch, decode, deliver and verify every contract event.
<!-- /limit -->

## Short description (960 characters or fewer)

<!-- limit:960 -->
Smart contracts are brilliant at doing things and terrible at telling anyone. PortalOps is the missing event layer for Portaldot. It watches contracts (Solidity and Rust ink!), decodes raw logs into named events, tells you how final each one is from the node itself, and delivers it to your server as a signed webhook with retries and replay. The testnet's public events were unreadable hex (32 contracts, 225 events, none decodable without an ABI), and every team would otherwise rebuild this plumbing. Don't trust us: every EVM event has a "Verify against the chain" button that runs in your browser against the public RPC, and a public registry proves a contract's source is what runs on chain. Try it with no signup: send a real free ping from the playground and watch it travel. SDK and Claude tools on npm, open source (MIT), 260+ tests. Testnet only, honest limits in the README.
<!-- /limit -->

## Full description (long field)

<!-- limit:3000 -->
**Smart contracts are brilliant at doing things, and terrible at telling anyone about it.**

Picture a game on Portaldot. A player finishes a quest, the contract pays the reward, and it emits an event. Your server has to hear that and act. What the chain gives you is hex: when we measured the testnet's public events (32 contracts, 225 events), none were readable without the contract's ABI. Then blocks get reorganised, your server goes down at 3 a.m., a webhook fails and nobody retries. Every team builds the same plumbing, slowly and with different bugs.

**PortalOps is that plumbing, built once for Portaldot.** It watches your contracts (Solidity and Rust ink!), decodes logs into named events, tells you how final each event is straight from the node's own finalized head, delivers it as an HMAC-signed webhook with retries, and replays anything you missed without touching the chain.

**Don't trust us, check.** Every EVM event has a "Verify against the chain" button that runs in your own browser against the public RPC: transaction, status, block hash, contract, topics and data. A public registry of verified contracts compiles submitted source and proves it equals the code at the address. `npm run verify:evidence` re-checks every claim about our deployed contracts (24 checks) without using our database.

**Try it in sixty seconds, no signup:** open the playground, send a real free ping to our PortalPing contract, and watch it get captured, decoded, finalized and delivered. Then verify it against the chain.

**Why Portaldot specifically:** two contract engines on one chain, an archive-style native node, weight-based gas, and only the last ~256 blocks fetchable by number. We wrote those quirks down as open field notes and built around them.

**Also included:** dashboard, REST API, TypeScript SDK and a Claude (MCP) assistant on npm, an Arena Lab with graded game-contract challenges, tutorials, two-factor sign-in, expiring API keys.

**Honest limits:** testnet software on free hosting, no outside users yet, and our own Rust contract is built and tested but not deployed live (it needs about 420 tPOT locked). Track: Modular Cloud and Middleware.
<!-- /limit -->

## Links to paste

- App: https://portalops.onrender.com
- Playground (no signup): https://portalops.onrender.com/playground
- Verified contracts: https://portalops.onrender.com/registry
- Code: https://github.com/nofazechris/portalops
- Walkthrough video: https://youtu.be/fau4mVZS1iY
- Pitch deck: https://portalops.onrender.com/pitch
