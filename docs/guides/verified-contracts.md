# Verified contracts

Anyone can paste an ABI and say "this is the contract at that address". Nothing checks it. A wrong or malicious ABI decodes events into the
wrong names and the wrong numbers, and a developer who wants to build on a contract has only a bytecode blob to read.

The **verified contract registry** fixes that for Portaldot. You submit the Solidity source of a contract and its address. PortalOps compiles
the source, fetches the code that is really at that address (`eth_getCode`), and compares them. Only a match is stored, and a match is
proof that the source is what runs on chain. Everything is public, at `/registry` on the PortalOps site, with no signup.

## What a verified contract gives everyone

- **The source and ABI**, open to read and copy, with the exact compiler settings that reproduce the on-chain code.
- **Events decoded by name, with no setup.** Add a verified address to a project (or the playground) without an ABI and PortalOps fills in the
  verified one. Named events, named arguments, webhooks filtered by event name: no pasting.
- **Live activity.** How many events PortalOps has captured from the contract and when the last one happened.

The two contracts PortalOps deployed (the quest board and the ping contract) are verified when the service starts, so the claim "the code on
chain is the code in the repository" is a row anyone can open.

## Verify a contract

On the registry page, enter the address and paste the source. Or use the API:

```bash
curl -X POST https://portalops.onrender.com/api/v1/registry/verify \
  -H "content-type: application/json" \
  -d '{ "address": "0x6a8705e4621dd87a261b1c5f97b73871616537ec", "source": "…the Solidity source…" }'
```

The rules, so a result is never a surprise:

- **One file, no imports.** Flatten a project first (`forge flatten`, or Hardhat's `flatten` task). The compiler is given no way to read files.
- **Settings.** If you do not say which, PortalOps tries `paris` with the optimizer on at 200 runs, `paris` with it off, then `shanghai` and
  `cancun`. If you deployed with something else, pass `evmVersion` and `optimizerRuns` (a number, or `null` for off).
- **Several contracts in the file?** Name the one you deployed with `contractName`, or let PortalOps find the one whose code matches.
- **Immutables are handled.** Values a constructor bakes into the code are masked before comparing, as they differ from the compiled template.
- **Limits.** 100 KB of source, 40 seconds of compile time, three submissions per IP every ten minutes, and a short queue: the compiler is heavy.

## What "match" means

| Match | Meaning |
| --- | --- |
| **Exact match** (`full`) | The code on chain is byte for byte what the source compiles to. |
| **Same code** (`partial`) | Identical, apart from the metadata tail the compiler appends (a hash of the source file and the compiler version). The logic is the same; only the file name or build environment differed. |

Both are proof of the logic. If neither matches, the response says what was tried and the size of the code on each side. The usual causes: a
different compiler version, different settings, or source that changed after deployment. Note what a match does **not** prove: parameter
names in the ABI are not part of the code, so two sources can differ in them and still match. Events, functions and types cannot differ.

## One registration per address

The first match wins and is never overwritten, except that an exact match replaces a same-code one. The code at an address does not change,
so a second submission cannot make the first wrong.

## Rust (ink!) contracts

The registry covers Solidity on the EVM side of Portaldot. Rust contracts are already self-describing: their metadata file carries the full
description, and PortalOps takes it when you [register the contract](ink-contracts.md).
