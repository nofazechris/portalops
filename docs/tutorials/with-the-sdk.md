# Tutorial 5: Automate with the SDK

**Goal:** a short script that registers a contract, creates a webhook, then keeps watch: it finds failed deliveries and replays them. This
is what you would run from a cron job or a deploy pipeline.

## 1. Install and authenticate

The SDK is `@portalops/sdk` (Node 20+, no runtime dependencies). From a checkout of the repository build it with `npm run sdk:build` and
import it by path; once it is on npm, `npm i @portalops/sdk`.

Create an API key in **Settings → API keys** (scope **write**) and keep it server-side:

```bash
export PORTALOPS_API_KEY=pops_…
export PORTALOPS_API_URL=https://portalops.onrender.com
```

## 2. Set up from code

```ts
import { PortalOps } from "@portalops/sdk";

const portal = new PortalOps({ apiKey: process.env.PORTALOPS_API_KEY!, baseUrl: process.env.PORTALOPS_API_URL });

// Start from an example, or pass your own ABI
const arena = await portal.examples.get("arena");
const contract = await portal.contracts.add({ address: process.env.ARENA_ADDRESS!, name: arena.title, abi: arena.abi });

const check = await portal.contracts.test(contract.id);
if (!check.codeFound) throw new Error(check.note);

const hook = await portal.webhooks.create({ url: "https://api.myapp.dev/arena", eventFilter: ["BattleResolved", "LootDropped"] });
console.log("save this once:", hook.secret);          // returned ONCE; store it in your secret manager, not in the repo
console.log(await portal.webhooks.test(hook.id));    // a signed test delivery
```

## 3. Watch for failures and replay

```ts
async function sweep() {
  const failed = await portal.deliveries.list({ status: "failed", limit: 100 });
  for (const d of failed) {
    console.log(d.event.eventName, d.lastResponseStatus, d.lastError);
    await portal.events.replay(d.eventId, { endpointId: d.endpointId });   // same event id, so your receiver de-duplicates
  }
  return failed.length;
}

setInterval(() => sweep().then((n) => n && console.log(`replayed ${n}`)), 60_000);
```

Only replay after you have fixed the cause; otherwise you are just retrying a known failure. The built-in receiver is perfect for
rehearsing it:

```ts
const rehearsal = await portal.webhooks.create({ builtinReceiver: true });
await portal.webhooks.setReceiverMode(rehearsal.id, "fail500");   // ok | fail500 | fail400 | timeout
// ... trigger an event, watch the retries ...
await portal.webhooks.setReceiverMode(rehearsal.id, "ok");
```

## 4. Read events, act on finalized ones

```ts
for await (const e of portal.events.iterate({ event: "LootDropped", finality: "finalized" })) {
  console.log(e.blockNumber, e.payload);
}
```

Finality matters for anything irreversible: a webhook fires when an event is first stored, usually long before it is final.

## 5. Handle errors

Every failure is a `PortalOpsError` with a `code` (`invalid_api_key`, `insufficient_scope`, `rate_limited`, `network_error`, ...). Reads are
retried automatically; **writes never are**, because a repeated write could do the thing twice. See [TypeScript SDK](../guides/sdk.md).

## What you learned

Everything the dashboard does is available from code, with the same safety properties: scoped keys, one-time secrets and safe replay.
