# Portaldot V3.0 testnet: field notes

What we learned building on the Portaldot V3.0 testnet, written for the next developer. Everything here was observed against the public
endpoints, and each claim says how to check it. Written to be useful to anyone building on Portaldot, not only to PortalOps.

| | |
|---|---|
| EVM RPC | `https://test-evm-rpc-v3.portaldot.dev` (chain id `420420777`) |
| Native RPC | `wss://test-node-v3.portaldot.dev` (chain `PortaldotV3 Test`, runtime `portaldot-v3`, token `tPOT`, 14 decimals, SS58 prefix 42) |
| Block time | about 6 seconds |
| Re-check the basics | `npm run preflight` (read-only, no key) |
| Re-check our own on-chain claims | `npm run verify:evidence` (read-only, no key; 24 checks against the public RPC, including that the code on chain equals what the repo's Solidity compiles to) |

## 1. Two contract engines, one chain

The runtime has `Balances`, `Contracts` and `Revive` pallets side by side.

- **Solidity runs on pallet-revive** (`allowEVMBytecode = true`, `chainId = 420420777`). Standard solc bytecode works; use the **`paris`** EVM version
  (no `PUSH0`). The EVM RPC speaks the normal `eth_*` methods.
- **Rust ink! runs on the Contracts pallet**, reached through the native RPC. The pallet is recent (it has `maxTransientStorageSize`,
  `maxDelegateDependencies`), compatible with **ink! 5** and `cargo-contract` 5. Contracts emit `Contracts.ContractEmitted` runtime events, not
  EVM logs, so an EVM tool never sees them. (PortalOps reads both: see [Rust (ink!) contracts](../guides/ink-contracts.md).)

## 2. Accounts and funding

An Ethereum account is a native account whose 32-byte id is `<20-byte 0x address> ++ 0xEE × 12`. **Fund that `5…` address** and
`eth_getBalance` shows the balance. The usual Frontier mapping (`blake2("evm:" ++ h160)`) is not used here: an address derived that way holds
nothing. Native balances use 14 decimals and the EVM view 18 (`nativeToEthRatio = 10000`). Verified against a real funded account: native free
`82060166227314765` (14 dp) matched EVM balance `820501662273147651250` (18 dp) less the 0.1 tPOT existential deposit.

## 3. Gas is weight-based, so estimate it, never hard-code it

- `eth_estimateGas` returns very large numbers (about `5e15` for a 2 KB contract) because gas here is Substrate weight, priced at `eth_gasPrice`
  (about 30,000 wei). A hand-picked "reasonable" gas limit such as 2,000,000 fails with `Invalid Transaction` (1010). Use the node's estimate with a small pad.
- **Contract code carries a refundable deposit** of about 0.06 tPOT per byte (`depositPerByte`). A 2 KB contract is therefore expensive on a
  small balance; a lean contract is cheap. Measured: `PortalQuest` (2,162 bytes of runtime code) used `5.23e15` gas; `PortalPing` (454 bytes, one event)
  cost roughly 50 tPOT to deploy and call; a 2.3 KB game contract needed a maximum of about 196 tPOT.
- Run the deploy script as a dry run first: `npm run contract:deploy -- --example arena` prints balance, estimate and the maximum cost and sends nothing.

## 4. What the EVM RPC does and does not keep

| Question | Answer | Check it |
|---|---|---|
| `eth_getLogs` over a huge range | Works from genesis to head in one call (100,000+ blocks) | `npm run preflight` |
| `eth_getBlockByNumber` for an old block | Only roughly the **latest 256 blocks**; older ones fail with `State already discarded` | any block older than head − 300 |
| `eth_getTransactionReceipt` for an old transaction | **Works** (receipts for blocks 60,000 behind the head were read back) | `npm run verify:evidence` |
| `eth_getCode` | Works at `latest` | `npm run verify:evidence` |
| `finalized` / `safe` block tags | Supported; `finalized` trails `latest` by about 2 blocks, so real finality exists | `eth_getBlockByNumber("finalized")` |
| WebSocket subscriptions on the EVM side | No EVM WebSocket URL is published; poll `eth_getLogs` by range (cheap here) | n/a |

Consequences for any indexer: backfill with `eth_getLogs`, never per-block lookups; reorg checks only work near the head; capture block data
when you see it. Short reorganisations of the latest block or two are **routine**: expect `included` events to occasionally become `orphaned`.

## 5. The native side is an archive node

Unlike the EVM block lookup, the native RPC serves old state: `state_getStorage` on `System.Events` answered for blocks as old as 5,800 when the
head was 205,000. That makes native backfill from a contract's deployment block possible.

- A single `state_queryStorage` over a range lists only the blocks where `System.Events` **changed**; the chain repeats identical event lists
  often (3 distinct sequences in 15 consecutive real blocks), and an unlisted block inherits the previous block's events. We confirmed that
  reconstruction against per-block reads: no differences. It makes a 4,000-block scan a handful of requests (about 950 blocks per second).
- **Do not hammer it block by block.** Asking for every block's state (or using polkadot-js `ApiPromise`'s per-block `api.at`) made the node close
  the WebSocket (`1000 Normal Closure`) after a few dozen requests, and polkadot-js then throws from inside the socket handler, which can take a
  Node process down. A plain JSON-RPC provider with range queries was stable.
- Real ink! events exist on the testnet (for example two `ContractEmitted` events in blocks 130,828 and 130,847). They carry the event's
  **signature topic** as the first topic, which is how ink! 5 metadata identifies an event.
- Integers decode to decimal strings and accounts to SS58 (prefix 42).

## 6. Finality

True finality exists and is cheap to use: events at or below the finalized head are final once their block hash is confirmed canonical; the
EVM RPC offers `eth_getBlockByNumber("finalized")` and the native RPC `chain_getFinalizedHead`. PortalOps only ever says `finalized` from those
signals, and uses a 12-block depth only for the weaker `confirmed` label. See [Core concepts](../guides/concepts.md#finality).

## 7. Things we could not explain, so we do not claim

- `eth_gasPrice` of about 30,000 wei with a priority fee of 0 looks odd next to the very large gas figures; treat prices as testnet-only.
- `debug_traceTransaction` is recognised by the node (it answers "No Ethereum extrinsic found" for an unknown hash); we did not rely on it.

## Evidence this page is based on

- Raw read-only report from the preflight script: [`preflight-report.json`](preflight-report.json) (first run 2026-10-19).
- Deployments and transactions: [`deployment.json`](deployment.json), [`deployment-ping.json`](deployment-ping.json), [`evidence.json`](evidence.json), [`evidence-ping.json`](evidence-ping.json).
- `npm run verify:evidence -- --live https://portalops.onrender.com` checks all of them against the chain and against what the live service captured.
- `npm run pipeline:test` ingests real testnet logs, delivers signed webhooks to a local receiver, injects failures through retry exhaustion and replays.
