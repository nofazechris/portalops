# Changelog

Notable changes, newest first. The npm packages (`@portalops/sdk`, `@portalops/mcp`) follow [semantic versioning](https://semver.org); the app is
deployed continuously from `main`.

## Unreleased

- **Rust (ink!) contracts**: a native reader for `Contracts.ContractEmitted` events, decoded with the contract's metadata; register by SS58 address and
  metadata file. Verified against real testnet events.
- **Security**: API keys expire (90 days by default); two-factor sign-in (TOTP with recovery codes); bounded parallel deliveries; optional database-backed
  rate limits for several API instances.
- **Contract metadata upload** (ABI, compiler artifact or ink! metadata, auto-detected).
- **Delivery diagnostics**: rule-based cause, confidence and checklist for every failed delivery; optional AI explanation that shows the exact evidence it would send.
- **`npm run verify:evidence`**: re-checks every on-chain claim against the public testnet RPC (and the live service with `--live`), including that each deployed contract's code is byte for byte what the repository's Solidity compiles to.
- Line endings are LF everywhere (`.gitattributes`), so committed contract artifacts match their sources on every platform.
- Node version check before `npm test`; `.nvmrc`; `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`.

## 0.1.0 (SDK and Claude server)

- First npm release of `@portalops/sdk` (typed REST client and webhook signature verification) and `@portalops/mcp` (ten Claude tools).

## Earlier

- Arena game example and **Arena Lab** (graded challenges and a delivery simulator); tutorials and a game-development guide.
- Public playground, documentation site, pitch deck, landing page, three demo videos.
- Deployed `PortalQuest` and `PortalPing` to the Portaldot V3.0 testnet and captured, decoded and delivered their events end to end.
- Core pipeline: ingestion with reorg handling and real finality, signed webhooks with retry and replay, SSRF guard, encrypted secrets, accounts with email
  verification and GitHub sign-in, project API keys, PostgreSQL and SQLite stores.
