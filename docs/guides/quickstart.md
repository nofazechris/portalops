# Quickstart: your first delivered event

Goal: a contract's event arrives at your application, signed, and you can prove it. Choose a path.

- **Path A: the dashboard** (no code). About 5 minutes. Uses a hosted test receiver so you do not need a backend yet.
- **Path B: with Claude** (no clicking). See [Set up with Claude](claude-setup.md).
- **Path C: your own code.** Dashboard for the one-time setup, then a receiver you write (about 15 minutes).

## What you need

- A PortalOps server to talk to: your own (see [Put it live](../operations/live-deploy.md)) or `npm run dev` + `npm run api` locally.
- A contract deployed on the **Portaldot V3.0 testnet** (EVM). No contract yet? Use one of the [examples](contracts-and-examples.md);
  deploying one needs a funded testnet account, which PortalOps itself never needs.

## Path A: the dashboard

1. **Create an account** and a project (the name is only a label).
2. Open **Guided setup**. Each step explains why it matters and checks itself:
   1. *Connect network*: PortalOps checks the RPC answers and reports chain id `420420777`.
   2. *Add contract*: paste the address, or pick an example and click **Use this ABI**. With an ABI, events are decoded into names and arguments.
      Without one, raw logs are still stored and delivered (undecoded).
   3. *Select events*: tick the ones you want, or leave all unticked for everything.
   4. *Configure delivery*: choose the **built-in test receiver** (nothing to host) or your own HTTPS URL. The **signing secret is shown once**: copy it.
   5. *Test integration*: **Send test delivery**. The receiver shows the signature was verified.
3. Make a transaction on your contract that emits an event. Within a few seconds it appears on **Events** with its status
   (`included`, then `confirmed`, then `finalized`: see [Finality](concepts.md#finality)) and a delivery.
4. Break something on purpose: set the built-in receiver to *fail 500*, replay an event, watch the retries, set it back and replay again.
   That loop (fail, retry, replay) is the product.

## Path C: your own receiver

After the dashboard setup, point a webhook at your endpoint and verify every request:

```ts
import express from "express";
import { constructEvent } from "@portalops/sdk"; // build it from this repo: npm run sdk:build

const app = express();
const seen = new Set<string>(); // a database table in real life

app.post("/portal-events", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(process.env.PORTALOPS_WEBHOOK_SECRET!, req.body, req.header("portalops-signature"));
  } catch {
    return res.sendStatus(400);               // not from PortalOps, or too old
  }
  if (seen.has(event.id)) return res.sendStatus(200);   // retries and replays resend the same id
  seen.add(event.id);
  console.log(event.data.eventName, event.data.payload);
  res.sendStatus(200);                          // any 2xx means "delivered"
});
app.listen(3000);
```

Your endpoint must be reachable **from the PortalOps server** over HTTPS (private and loopback addresses are blocked in production).
While developing, a tunnel such as `cloudflared` or `ngrok` gives your laptop a public URL.

The three rules every receiver follows (details in [Webhooks](webhooks.md)):

1. Verify the signature over the **raw** body before trusting anything.
2. De-duplicate on the event `id`: the same event can arrive more than once.
3. Answer quickly with a 2xx; do slow work afterwards.

## Check your work

```bash
curl -s https://portalops.example.com/api/v1/public/status
```

`connection: "connected"`, a `headBlock`, and `worker: "ok"` mean the server is watching the chain.

## Next

- [Tutorials](../tutorials/index.md): hands-on walkthroughs, including a game feed and importing your own contract.
- [Concepts](concepts.md) for the model behind what you just did.
- [Contracts and examples](contracts-and-examples.md) to track your own contract.
- [Troubleshooting](troubleshooting.md) if the first event does not arrive.
