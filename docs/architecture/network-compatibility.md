# Portaldot V3.0 testnet — compatibility findings (Phase 0, read-only)

Run: 2026-10-19 · script: `scripts/network-preflight/preflight.mjs` · raw output: `preflight-report.json`

Re-run with `node scripts/network-preflight/preflight.mjs`. It is read-only and needs no key.

## Verified (observed against the public endpoints)

| Area | Result |
|---|---|
| EVM RPC `https://test-evm-rpc-v3.portaldot.dev` | Reachable. Client `eth-rpc/main-fddd431`. |
| EVM chain ID | `420420777` — matches the announcement. |
| Block production | ~6 s per block. Both RPCs fully synced; heads agree (~#99,5xx). |
| Core methods | `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBalance`, `eth_getCode`, `eth_gasPrice`, `eth_feeHistory`, `eth_maxPriorityFeePerGas`, `eth_estimateGas`, `eth_getTransactionCount` all respond. |
| Event logs | `eth_getLogs` works for ranges up to at least **100,000 blocks** (the whole chain so far) with no range error. 22 real logs from 5 contracts already exist. |
| Contract bytecode | Existing contracts carry standard solc bytecode (`0x6080…`), so **Solidity on the EVM endpoint is in use by other participants**. |
| Native RPC `wss://test-node-v3.portaldot.dev` | Reachable. Chain `PortaldotV3 Test`, node `3.0.0-dev`, runtime `portaldot-v3` spec 3002. Token `tPOT`, 14 decimals, SS58 prefix 42. |
| Native subscriptions | `chain_subscribeNewHeads` delivers live headers. |
| Runtime pallets | Metadata contains `Contracts`, `Revive`, `EVM`, `Ethereum`. Both an ink!/Contracts path and an EVM path exist in the runtime. |
| Historical logs | `eth_getLogs` from genesis returns all logs (22 at time of writing) and every log carries its own `blockHash`. |

## Important limit found with live data

`eth_getBlockByNumber` only works for roughly the **latest 256 blocks** (~26 min at 6 s/block). Older blocks fail with
`UnknownBlock: State already discarded`. `eth_getTransactionReceipt` for a months-old transaction also returned nothing.
Consequences, all handled in `apps/worker/ingest.ts`:

- Backfill must use `eth_getLogs` (works to genesis), never per-block lookups.
- Reorg detection is only possible near the head. If the worker is down longer than the horizon the cursor block can no
  longer be verified; it resumes forward and records a warning instead of flagging a false reorg.
- Block timestamps and receipts for old events cannot be fetched later, so capture what we need at ingestion time.
- A "replay after the node forgot the block" feature must replay from OUR stored event, which is exactly what PortalOps does.


## Chain-tip behaviour (observed 2026-10-19)

- **Short reorgs at the tip are routine.** The hash of `head-1` changed between polls within a minute. Ingestion handles this
  (rewind window + orphan marking); expect `included` events to occasionally become `orphaned`.
- **`finalized` and `safe` block tags are supported** (`eth_getBlockByNumber("finalized")` trailed `latest` by ~2 blocks). True
  finality is therefore available; PortalOps uses it: events at or below the finalized height are promoted to `finalized` after verifying their block hash (see `apps/worker/finality.ts`); `confirmed` remains a 12-block depth heuristic.

## Not yet verified (needs a funded testnet account)

These are PRD Phase 0 exit criteria and are **not proven**:

- Transaction submission and receipt retrieval.
- Contract deployment and invocation.
- An emitted event from *our own* contract being read back.
- Real fee behaviour. Read-only signals look odd: `eth_gasPrice` = 38,980 wei, priority fee 0, and `eth_estimateGas` for a plain transfer returned ~3.2e11 gas. Treat these as unexplained until a real transaction is sent.

## Open questions

1. **No EVM WebSocket URL** was announced, so `eth_subscribe` is untested. The EVM ingestion worker should poll `eth_getLogs` by block range (cheap here: 6 s blocks, wide ranges allowed).
2. **Account model (resolved).** The runtime has `Balances`, `Contracts` and `Revive` (no `EVM`/`Ethereum` pallet): EVM execution is **pallet-revive** (`allowEVMBytecode = true`, `chainId = 420420777`, `nativeToEthRatio = 10000`). An Ethereum account is a native account whose 32-byte id is `<20-byte 0x address> ++ 0xEE × 12`; fund *that* `5…` address and `eth_getBalance` shows the balance. Verified on 2026-10-22 against a real funded EVM account (native free `82060166227314765` at 14 decimals ≈ EVM balance `820501662273147651250` at 18 decimals, less the 0.1 tPOT existential deposit). The standard Frontier mapping (`blake2("evm:" ++ h160)`) is **not** used here: an address derived that way holds nothing. `npm run contract:fund-address` prints the right address. Costs: `depositPerByte` is 0.06 tPOT, so contract code carries a refundable deposit of roughly 0.06 tPOT per byte.
3. Whether `debug_*` / `trace_*` exist: `debug_traceTransaction` is recognised (returns "No Ethereum extrinsic found" for an unknown hash), so it is probably available.

## Decision (provisional)

Pursue **Solidity + EVM adapter first**. The evidence so far supports it: standard bytecode and logs already exist on chain, `eth_getLogs` is generous, and chain ID matches. This stays provisional until a deploy + invoke + log round-trip succeeds on the public testnet. The native/ink! adapter remains the fallback; the runtime has `Contracts` and `Revive` pallets, so it is viable.

No local-only substitute should be presented as proof of public-testnet deployment.

## Pipeline status (local, against real testnet logs)

`npm run pipeline:test` ingests the real logs on the chain (other participants' contracts, undecoded), persists them
idempotently, delivers signed webhooks to a local receiver, injects HTTP 500s through retry exhaustion, then replays
successfully. 36 unit tests cover IDs, normalisation, signing (with an independent OpenSSL vector), retry policy, SSRF
blocking, secret encryption, log redaction, cursor/restart/reorg/pruning behaviour and the failure -> replay flow.

This does **not** prove our own contract deployment; that still needs a funded account.
