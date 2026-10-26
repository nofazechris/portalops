# Tutorial 2: Build a game feed

**Goal:** run the **Arena** example game on the Portaldot testnet and turn its events into a live leaderboard and a loot feed. This is the
pattern behind every game integration: the contract only emits events, and your server reacts to them.

## The game

`PortalArena` is a tiny on-chain game. The source is in the example gallery and in `contracts/examples/PortalArena.sol`.

| You call | The contract does | Event emitted |
|---|---|---|
| `join("Ada")` | registers you as a level 1 player | `PlayerJoined(player, name)` |
| `fight(opponent)` | resolves a battle, the winner gains XP | `BattleResolved(battleId, winner, loser, xpGained)` |
| (automatic) | enough XP raises your level | `LevelUp(player, level)` |
| (automatic) | every third battle the winner finds an item | `LootDropped(player, itemId, item)` |

It holds no value and its randomness (a hash of the previous block) is predictable. It is a demo, not something to put money behind.

## 1. Get the contract on the testnet

You need a funded Portaldot V3.0 testnet account on your machine. PortalOps never sees the key.

```bash
npm run examples:build                          # only if you edited the Solidity
npm run contract:deploy -- --example arena       # dry run: checks chain, balance and gas, sends nothing
npm run contract:deploy -- --example arena --send
```

Deploying is the one step that costs test tokens. Read the dry run's "max cost" line first. It prints the contract address and saves a record
in `docs/architecture/deployment-arena.json`.

No funded account? Skip to step 2 with any Arena copy someone else deployed, or follow along with the Quest board: only the event names change.

## 2. Register it

In the dashboard open **Guided setup → Add contract**. In the **Example gallery** pick **Arena game** and click **Use this ABI**, then paste
the address of your deployed copy. Set the **start block** to the block you deployed in so that you capture the whole game from the beginning.

Use **Test contract** afterwards: it checks that bytecode exists at that address. Nothing is signed or sent.

## 3. Create the webhook

Create a webhook pointing at your server (step 4) or the built-in receiver while you experiment. Leave the event filter empty to receive all
four events, or narrow it, for example to `BattleResolved` and `LootDropped`. Copy the **signing secret**; it is shown once.

## 4. Write the receiver

Install the SDK (see [TypeScript SDK](../guides/sdk.md)) and create `server.ts`:

```ts
import express from "express";
import { constructEvent } from "@portalops/sdk";

type Row = { name: string; level: number; wins: number; losses: number };
const board = new Map<string, Row>();      // a database table in real life
const loot: string[] = [];
const seen = new Set<string>();            // retries and replays resend the same event id

const row = (addr: string): Row => board.get(addr) ?? board.set(addr, { name: addr.slice(0, 8), level: 1, wins: 0, losses: 0 }).get(addr)!;

const app = express();
app.post("/arena", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(process.env.PORTALOPS_WEBHOOK_SECRET!, req.body, req.header("portalops-signature"));
  } catch {
    return res.sendStatus(400);                              // not from PortalOps
  }
  if (seen.has(event.id)) return res.sendStatus(200);
  seen.add(event.id);
  if (event.data.finalityStatus === "orphaned") return res.sendStatus(200);

  const p = event.data.payload as Record<string, string>;   // big numbers arrive as strings
  switch (event.data.eventName) {
    case "PlayerJoined":   row(p.player).name = p.name; break;
    case "BattleResolved": row(p.winner).wins++; row(p.loser).losses++; break;
    case "LevelUp":        row(p.player).level = Number(p.level); break;
    case "LootDropped":    loot.unshift(`${row(p.player).name} found a ${p.item}`); break;
  }
  res.sendStatus(200);
});

app.get("/leaderboard", (_req, res) => res.json([...board.values()].sort((a, b) => b.level - a.level || b.wins - a.wins)));
app.get("/loot", (_req, res) => res.json(loot.slice(0, 20)));
app.listen(3000);
```

Your endpoint must be reachable from the PortalOps server over HTTPS. While developing, a tunnel such as `cloudflared` or `ngrok` gives your
laptop a public URL.

## 5. Play

From two different accounts (Remix, a wallet, or a script), call `join("Ada")` and `join("Bo")`, then `fight(<other address>)` a few times.
Within seconds each move appears on **Events** and at your server:

- `curl localhost:3000/leaderboard` shows levels, wins and losses.
- The third battle drops loot: `curl localhost:3000/loot`.

## 6. Do it safely

- **Wait for finality before anything irreversible.** Updating a leaderboard on `included` is fine; awarding a real prize is not. Fetch the
  event with the SDK and act only when `finalityStatus` is `finalized` (see [Core concepts](../guides/concepts.md#finality)).
- **De-duplicate on the event id**, as above. A replay resends the same id.
- **Keep the secret out of git.** Put `PORTALOPS_WEBHOOK_SECRET` in an env file your `.gitignore` covers.

## What you learned

A whole game loop (join, fight, level, loot) becomes four events, and one small server turns them into product features.

**Next:** [Import your own contract](import-your-contract.md).
