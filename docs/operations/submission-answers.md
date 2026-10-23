# DoraHacks submission: answers, ready to paste

Copy each block into the matching field. Two values need you: the **demo video link** (upload the file first) and, once Cloudflare is
working, swapping `portalops.onrender.com` for `portalops.top`.

---

## Project name
PortalOps

## Track
Modular Cloud & Middleware

## One-sentence project overview
PortalOps is open-source middleware that watches Portaldot smart contracts and delivers their events to any app as clean, signed, retried and replayable webhooks, with a dashboard, REST API, TypeScript SDK and a Claude (MCP) assistant that sets it all up.

## Current project progress

**Contracts.** Two Solidity contracts deployed to the Portaldot V3.0 testnet by us: `PortalQuest` (create / complete / reward events) and `PortalPing` (a one-event contract for live demos). Real transactions and real events are captured end to end.

**Core pipeline (done).** A worker reads the chain with `eth_getLogs`, decodes logs with the contract ABI into named events with deterministic ids, handles reorganisations, and tracks finality from the node's own finalized head (seen, confirmed, finalized, never guessed). A delivery engine sends HMAC-SHA256 signed webhooks with exponential-backoff retries, full attempt history and one-click replay. Events, deliveries and the read position are written atomically.

**Frontend (done).** Landing page, a three-step quick-start dashboard, events with finality and delivery history, a replay centre, a public read-only explorer, a no-signup interactive playground (watch a contract, send a signed test delivery), a documentation site and a pitch deck.

**Integration (done).** REST API, a typed TypeScript SDK with webhook verification, and a Claude (MCP) server with ten tools that registers a contract, creates a webhook and sends a signed test while keeping secrets out of the chat. Accounts with email verification, password reset and GitHub sign-in.

**Deployment (done).** Live on Render with a Neon PostgreSQL database. SQLite for local use; the same store runs on both.

**Testing and security (done).** 170+ automated tests, including runs against real testnet logs and a real PostgreSQL. A written security review (SSRF guard checked at save and at send, secrets encrypted with AES-256-GCM and shown once, 404-not-403 ownership checks, rate limits) and a secret scan that runs as a git hook and in CI.

**Documentation and demo (done).** README with architecture diagram, API reference, guides, security review; a 2:40 demo video, a 7:46 developer walkthrough, and a live PortalPing demo recording.

## Outstanding items

- Connect the custom domain (`portalops.top`, DNS on Cloudflare) and switch the app, OAuth callback and email links to it.
- Turn on account email delivery in production (verify the sending domain with the email provider).
- Native Rust / ink! contract adapter. The reader is built around a `ChainAdapter` interface for exactly this; today PortalOps reads the EVM view of the testnet.
- Production hardening noted in the security review: MFA, API-key expiry, bounded concurrent deliveries, and Redis-backed rate limits for multi-instance scale.
- Move off free hosting (the live site sleeps when idle) and publish the SDK to npm.

## GitHub repository
https://github.com/nofazechris/portalops

README with run instructions and an architecture diagram; deployment instructions in `docs/operations/live-deploy.md`; full documentation at https://portalops.onrender.com/docs

## Testnet deployment details

Network: Portaldot V3.0 testnet (EVM chain id 420420777), RPC `https://test-evm-rpc-v3.portaldot.dev`.

**PortalQuest**: `0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649`
- Deployment tx: `0xe2590bb80b8d81067a1af092a76e5ee9ea22d9c277b0bf2da752813fc21f8a4d` (block 145,098)
- `createQuest` → `QuestCreated`: `0xd267e8a0610c73a4f21e24d0d69319307e52346dc65ad2e72ed280a26630f17c` (block 145,103)
- `completeQuest` → `QuestCompleted`: `0x11a6d7a86de919ad2b5da0c5098e3904cf23683733d53ff30b13c86d6af1c4b3` (block 145,104)
- `issueReward` → `RewardIssued`: `0x999f0cb2a1c04bce8edcd2b1ac37a3f98408162277428ada87b56b5fed7d32fb` (block 145,105)

**PortalPing**: `0x6a8705e4621dd87a261b1c5f97b73871616537ec`
- Deployment tx: `0xb6809eeee11d1b4a1a98113da824cfd763131028b4048608883ab3bdb8aee7b8` (block 152,078)
- `ping` → `Ping`: `0x2e603ac3d0b6219098060152af1b5253e38b86bd2bcd654f49d3cfc36ef30cfb` (block 152,082), `0xb6a45130b20950a098eb81cf029fdb562f7be9c815b486e6a50752fa029ed2ee` (block 152,146), `0xb57f0bb8f7d2a180a0627da178674207af65cad9aa1d3889a3993064a7991096` (block 152,148)

Every event was read back with `eth_getLogs`, then captured, decoded and delivered (signature verified) by PortalOps. Evidence files: `docs/architecture/deployment.json`, `deployment-ping.json`, `evidence.json`.

## Demo video link
**[PASTE YOUR PUBLIC LINK HERE]**: upload `demo-video/portalops-demo-3min.mp4` (2:40) to YouTube or Loom as public/unlisted and paste the URL. Actual testnet interactions: the Quest board's real events, the signed delivery, retry and replay.

(Optional second link for a longer look: the 7:46 developer walkthrough, `demo-video/portalops-walkthrough-full.mp4`.)

## Pitch deck link
https://portalops.onrender.com/pitch (PDF: https://portalops.onrender.com/pitch/portalops-pitch.pdf)

Problem addressed, why Portaldot needs it, proof the product works on the live testnet, and the roadmap for continued support.
