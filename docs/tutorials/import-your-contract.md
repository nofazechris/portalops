# Tutorial 3: Import your own contract

**Goal:** track a contract you wrote yourself, so its events arrive decoded, with names and arguments instead of hex. PortalOps needs two
things: the contract's **address** and its **ABI**. It never needs your source code or any key.

## 1. Write and compile

Any Solidity tool works. A contract only needs to `emit` events:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Guestbook {
    event Signed(address indexed visitor, string message);
    function sign(string calldata message) external { emit Signed(msg.sender, message); }
}
```

Compile for the **`paris`** EVM version (no `PUSH0` or newer opcodes). The testnet's EVM is not verified to support later ones.

- **Remix:** Solidity compiler → Advanced configurations → EVM version `paris` → Compile.
- **Foundry:** `evm_version = "paris"` in `foundry.toml`, then `forge build`.
- **Hardhat:** `solidity: { settings: { evmVersion: "paris" } }`, then `npx hardhat compile`.

## 2. Deploy to the Portaldot V3.0 testnet

Deploy with the tool you compiled with (network: chain id `420420777`, RPC `https://test-evm-rpc-v3.portaldot.dev`). You need a funded
testnet account. Note the **contract address** and the **block** the deployment landed in.

Gas on this chain is weight-based, so always use the tool's own estimate; a hand-picked low gas limit fails with `Invalid Transaction`.

## 3. Get the ABI

- Remix: Compile tab → **ABI** button copies it.
- Foundry: the `abi` field of `out/Guestbook.sol/Guestbook.json`.
- Hardhat: the `abi` field of `artifacts/contracts/Guestbook.sol/Guestbook.json`.

You can paste the **whole artifact file**: PortalOps reads its `abi` field. Or paste only the array.

## 4. Add it to PortalOps

In the dashboard: **Guided setup → Add contract** (or **Contracts → Add contract**).

1. **Address:** paste the `0x…` address.
2. **ABI:** paste the ABI (or the compiler artifact). Without it, logs are still stored but undecoded.
3. **Start block:** the block you deployed in, so nothing before your contract is scanned.
4. Click **Add**, then **Test contract**: it checks that bytecode exists at the address. Nothing is signed or sent.

Prefer code? The same thing through the [SDK](../guides/sdk.md):

```ts
await portal.contracts.add({ address: "0x…", name: "Guestbook", abi, startBlock: 152_000 });
```

## 5. Cause an event and see it decode

Call `sign("hello")` from your wallet or Remix. Within seconds **Events** shows:

```
Signed   visitor: 0xYou…   message: "hello"     included → confirmed → finalized
```

If you see **"Raw log"** with an event signature `0x…` instead of a name, PortalOps captured the log but the ABI did not contain that event.
Add the right ABI: new events decode from then on; stored ones keep what they were captured as. Details in
[Contracts and examples](../guides/contracts-and-examples.md).

## 6. Send it somewhere

Create a [webhook](../guides/webhooks.md) (filter it to `Signed` if you like) and send a test delivery.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "No code at that address" | Wrong address, wrong network, or the deployment has not been included yet |
| Events show as raw logs | The ABI is missing or does not contain that event |
| Old events missing | Start block was set after them; add the contract again with an earlier start block |
| Nothing arrives | Check the network pill is *Connected* and that the transaction actually emitted an event |

**Next:** [Set it all up with Claude](with-claude.md).
