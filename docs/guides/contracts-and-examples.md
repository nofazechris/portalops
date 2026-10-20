# Contracts and examples

## Tracking your own contract

You need three things: the **address**, ideally the **ABI**, and optionally a **start block**.

1. **Address:** a `0x…` EVM address of a contract deployed on the Portaldot V3.0 testnet. PortalOps checks the format, and the
   *Test contract* action (or `POST /contracts/:id/test`) checks that bytecode exists there: it never signs or sends anything.
2. **ABI:** the JSON array from your compiler (`solc`, Hardhat `artifacts/…json`, Foundry `out/…json`: paste the whole file and PortalOps
   uses its `abi` field in the dashboard; through the API, send the array). With it, every log becomes a named event with named arguments.
   Without it, logs are stored and delivered raw (`eventName: null`).
3. **Start block:** capture history from this block. Default: about the last 1,000 blocks. Set it to your deployment block to see everything
   from the beginning. The testnet only keeps recent blocks fetchable by number, but PortalOps reads history with log queries, which reach back further.

Then create a [webhook](webhooks.md) and, if you like, narrow it to specific event names.

### How a log becomes an event

```
log (address, topics[], data)
   │  topics[0] = keccak256("Transfer(address,address,uint256)")  ← identifies the event
   ▼
match against the ABI of that contract ──► named arguments (indexed ones from topics, the rest from data)
   │
   ▼
{ eventName: "Transfer", decoded: true, payload: { from, to, value: "1000…" }, topics, data, … }
```

If the ABI does not contain an event with that signature, the log is kept as an undecoded event (it is never dropped and never given a
guessed name). Add the right ABI and *new* events decode; stored ones keep what they were captured as.

## The example contracts

The setup wizard's **Add contract** step has an **Example gallery**. Each example is a small, readable contract with an honest purpose:
to emit real events so you can see capture, decoding, delivery, retry and replay working before you write your own contract.

| Example | Good for | Events |
|---|---|---|
| **Quest board** (`PortalQuest`) | gaming, engagement, loyalty | `QuestCreated`, `QuestCompleted`, `RewardIssued` |
| **Token** (`PortalToken`) | DeFi, wallets, analytics: transfers and approvals | `Transfer`, `Approval` |
| **Bounty board** (`PortalBounty`) | marketplace and workflow: post, submit, approve, cancel | `BountyPosted`, `WorkSubmitted`, `BountyApproved`, `BountyCancelled` |

None of them holds value: "rewards" and "bounties" are numbers in events. They are demo contracts and are **not audited**: do not copy
them into production.

For each example the gallery gives you, with one click to copy:

- **Events**: what each means in plain language, a sample payload and a typical use.
- **Deploy it**: the exact commands and the creation bytecode (for any EVM deployment tool).
- **Webhook code**: a Node.js receiver that verifies the signature, ignores duplicates and has a branch for every event of that contract.
- **Solidity** and **ABI**.

The same data is available as JSON from the public API (`GET /api/v1/examples` and `/examples/:id`), the SDK (`portal.examples`), and the
[Claude tools](claude-setup.md) (`portalops_list_examples`, `portalops_get_example`).

### Deploying an example

You need a **funded Portaldot V3.0 testnet account**. PortalOps never needs one: only your own machine does, to deploy.

1. Put a **throwaway** testnet private key in your local `.env` (git-ignored) as `PORTALDOT_DEPLOYER_PRIVATE_KEY`. Never paste a key into a chat, an issue or a commit.
2. Dry run (checks the chain, the balance and the gas; sends nothing):
   ```bash
   npm run contract:deploy -- --example token
   ```
3. Deploy:
   ```bash
   npm run contract:deploy -- --example token --send
   ```
   It prints the contract address and saves a record under `docs/architecture/`.
4. Paste the address into the wizard (or call `portalops_register_contract` with `example: "token"`). The ABI is already filled in.
5. Cause an event: for the token, call `transfer`; for the quest board, `createQuest("hello")`. Within seconds it shows on **Events** and is delivered.

`npm run contract:interact -- --send` exercises the Quest board end to end (create, complete, reward) with the keys in `.env`.

Prefer another tool? Deploy the printed bytecode with Remix, Foundry or Hardhat, then use the address.

### Rebuilding the examples

The compiled output is committed (`packages/examples/generated.json`) so servers never need a compiler. After editing a `.sol` file run:

```bash
npm run examples:build
```

A test fails if the committed artifacts are older than the Solidity sources.

### Compiler settings

The examples are compiled with `solc` 0.8.x for the **`paris`** EVM version (no `PUSH0` or newer opcodes), optimiser on at 200 runs, because
the testnet's EVM was not verified to support later opcodes. If you compile your own contracts for this network, use `paris` as well.

## What has and has not been verified

- Capture and decoding were verified against **real testnet logs** from other participants' contracts.
- The three example contracts compile and their ABIs, sample payloads and handlers are covered by automated tests (including encoding real
  logs and decoding them back).
- Deploying them to the live testnet from this repository is **not done yet** because the project's deployer account has no testnet funds;
  the deploy scripts have only ever run as dry runs.
