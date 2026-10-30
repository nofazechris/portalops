# Rust (ink!) contracts

Portaldot's runtime has two contract engines side by side: pallet-revive for **Solidity** (the EVM view PortalOps has always read) and the
**Contracts pallet** for **Rust ink!** contracts. PortalOps reads both. An ink! contract's events arrive as the same decoded, signed,
retried, replayable webhooks as a Solidity contract's; only the way you register the contract differs.

| | Solidity (EVM) | Rust (ink!) |
|---|---|---|
| Address | `0x…` (20 bytes) | SS58, starts with `5` (e.g. `5GrwvaEF…`) |
| What decodes the events | the ABI | the contract **metadata** file |
| Event source | `eth_getLogs` over the EVM RPC | `Contracts.ContractEmitted` runtime events over the native RPC |
| How far back PortalOps can read | far (log queries reach back) | as far as the node keeps state: the public testnet node is an archive node, so your start block is honoured; a pruning node keeps only about 256 blocks |

## Register an ink! contract

1. **Build it.** `cargo contract build --release` writes `target/ink/<name>.contract` (and `<name>.json`). Both contain the metadata.
   PortalOps only needs the metadata; if you upload the `.contract` bundle it drops the compiled code before sending.
2. **Deploy it** to the native Portaldot testnet (`wss://test-node-v3.portaldot.dev`) with `cargo contract instantiate`, or with the
   Contracts UI on polkadot.js. Note the contract's SS58 address.
3. **Register it.** In the dashboard open **Contracts → Register contract** (or the guided setup's **My own contract**), choose
   **Rust (ink!)**, drop the metadata file, paste the SS58 address, and register. PortalOps shows the events it found in the metadata.
4. **Make a call.** `cargo contract call --contract <address> --message ping --args "hello" --suri <your key> --url wss://test-node-v3.portaldot.dev -x`
   (use your own funded testnet account; never paste its secret anywhere but your own terminal).
5. Within seconds the event appears on **Events**, decoded with its arguments, and is delivered to your webhooks.

From code it is the same call with two extra fields:

```ts
await portal.contracts.add({
  type: "ink",
  address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  name: "PortalPing (ink!)",
  abi: JSON.parse(readFileSync("target/ink/portal_ping_ink.json", "utf8")),   // the metadata object
});
```

## A ready example

`contracts/ink/portal_ping_ink` in the repository is PortalPing written in Rust: `ping(note)` emits `Ping { from, seq, note }` and
`reward(to, amount)` emits `Rewarded { to, amount }`. Its metadata is committed as `packages/examples/ink/portal_ping_ink.metadata.json`
and is what the automated tests decode events against.

```bash
cd contracts/ink/portal_ping_ink
cargo contract build --release        # needs the wasm32 target and rust-src: rustup target add wasm32-unknown-unknown; rustup component add rust-src
```

## What an ink! event looks like in a webhook

The same envelope as any other event (see [Receiving webhooks](webhooks.md)):

```json
{
  "id": "evt_…",
  "type": "event.received",
  "data": {
    "eventName": "Ping",
    "decoded": true,
    "contractAddress": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    "payload": { "from": "5FHneW46…", "seq": "7", "note": "hello" },
    "transactionHash": "0x…",
    "blockNumber": 205590,
    "finalityStatus": "included"
  }
}
```

Integers are decimal strings (like the Solidity events), accounts are SS58, byte arrays are hex. `transactionHash` is the extrinsic hash.
An event the metadata cannot decode is kept raw (`eventName: null`), never given a guessed name.

## Finality and reorganisations

Handled the same way as for EVM events: `finalized` is set only from the node's own finalized head (`chain_getFinalizedHead`), `confirmed`
means 12 blocks deep (a depth heuristic), and if a block is replaced the events in it become `orphaned`. The native reader keeps its own
position, separate from the EVM reader, so the two never disturb each other.

## Limits to know about

- **How far back.** PortalOps starts at the **start block** you give (or about 100 blocks behind the head if you give none) and keeps up
  block by block. It can only read as far back as the node keeps state. The public testnet node keeps all of it, so a start block at
  your deployment backfills everything; a pruning node (about 256 blocks) refuses older blocks, and PortalOps skips them and says so in
  the log. `PORTALOPS_NATIVE_MAX_LOOKBACK_BLOCKS` (default 100,000) is the furthest behind the head a read may start.
- **One RPC.** It uses `PORTALDOT_NATIVE_RPC_URL` (default `wss://test-node-v3.portaldot.dev`), connected to on first use and reconnected
  after a failure. If the native node is down, EVM ingestion for the same project carries on.
- **Building needs an older Rust.** `cargo-contract` 5.0.3 (the version for ink! 5) fails on Rust 1.95 with "panic_immediate_abort is now a real
  panic strategy", because that Rust removed a flag it relies on. Rust 1.85 works: `rustup toolchain install 1.85.0 -c rust-src -t wasm32-unknown-unknown`,
  then `rustup override set 1.85.0` inside the contract's folder. Built that way, `portal_ping_ink` is 7.0 KB optimised and its interface (constructor,
  three messages, two events) is the same as the committed metadata.
- **Deploying is priced by the byte.** The Contracts pallet holds a refundable deposit of 0.06 tPOT per byte of code (`depositPerByte`, 14 decimals)
  plus 0.15 tPOT per stored item. By that price `portal_ping_ink` needs about **420 tPOT** locked to deploy (7.0 KB). A dry run with a 22 tPOT account
  was refused with `Contracts::StorageDepositNotEnoughFunds`. This is an estimate from the chain's constants, not a completed deployment. A leaner
  contract (fewer messages, no string handling) costs proportionally less.
- **Not in the playground.** The public playground watches Solidity contracts only.
- **Verified how.** The decoder is tested against real ink! 5 metadata (events with signature topics, integer, account and string
  arguments), and the reader against reorganisations, finality and skipped blocks. On the live testnet it was run over real history:
  two `ContractEmitted` events emitted by an ink! contract in blocks 130828 and 130847 were captured through the same code the worker uses,
  stored as native events, marked `finalized` from the node's own finalized head, and their extrinsic hashes were confirmed inside the
  real blocks. They are stored raw (undecoded) because that contract's metadata is not ours. Decoding a live deployment of
  `portal_ping_ink` needs it deployed from a native account holding about 420 tPOT (see above). We have **not** done that, so we do not claim a live decode of our own ink! contract.
