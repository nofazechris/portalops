# TypeScript SDK

`@portalops/sdk` is a typed client for the [REST API](../reference/api.md) plus webhook signature verification. Node 20+, no runtime
dependencies. It lives in `packages/sdk` and is used from this repository (it is not published to npm yet).

```bash
npm run sdk:build            # compiles to packages/sdk/dist (ES modules + .d.ts)
```

Import `@portalops/sdk` from your project by path (a `file:` dependency or a workspace), or import the TypeScript source directly under
Node 24 or any TypeScript-aware bundler.

## Create a client

```ts
import { PortalOps } from "@portalops/sdk";

const portal = new PortalOps({
  apiKey: process.env.PORTALOPS_API_KEY!,      // pops_… created in Settings → API keys. Server-side only.
  baseUrl: process.env.PORTALOPS_API_URL,      // https://portalops.example.com
});
```

Never ship an API key to a browser. Options: `projectId` (skip the lookup), `timeoutMs` (default 30 000), `maxRetries` (default 2, reads
only), `fetch` (inject your own, for tests). `baseUrl` must be `https` except for `localhost`, and redirects are refused so the key can
never be forwarded to another host.

## Recipes

### Set up from code

```ts
const { contracts, webhooks } = portal;

const c = await contracts.add({ address: "0x…", name: "Token", abi, startBlock: 115_000 });
const check = await contracts.test(c.id);               // { codeFound, runtimeCodeBytes, note }
if (!check.codeFound) throw new Error(check.note);

const hook = await webhooks.create({ url: "https://api.myapp.dev/portal", eventFilter: ["Transfer"] });
saveSecretSomewhereSafe(hook.secret);                   // returned ONCE: it cannot be read back
console.log(await webhooks.test(hook.id));              // a signed test delivery
```

Start from an example instead of your own ABI:

```ts
const examples = await portal.examples.list();           // quest, token, bounty
const token = await portal.examples.get("token");        // abi, source, handler, deployCommand…
await contracts.add({ address: deployed, name: token.title, abi: token.abi });
```

### Read events

```ts
const page = await portal.events.list({ event: "Transfer", finality: "finalized", limit: 20 });
for (const e of page.items) console.log(e.blockNumber, e.payload, e.delivery);   // delivery: { status, count } | null

// Every match, newest first, fetching pages as needed
for await (const e of portal.events.iterate({ delivery: "failed" })) console.log(e.id);

// One event with its whole delivery history
const detail = await portal.events.get(page.items[0].id);
for (const d of detail.deliveries) console.log(d.status, d.attempts.map((a) => a.responseStatus));
```

### Act only on finalized events

A webhook fires when an event is first stored, usually long before it is final. For irreversible actions, confirm finality first:

```ts
const e = await portal.events.get(eventIdFromWebhook);
if (e.finalityStatus !== "finalized") return;           // retry later, or replay the event once it is final
creditAccount(e.payload);
```

### Find failures and replay them

```ts
const failed = await portal.deliveries.list({ status: "failed", limit: 100 });
for (const d of failed) {
  console.log(d.event.eventName, d.lastError, d.lastResponseStatus);
}
// After fixing your receiver:
for (const d of failed) await portal.events.replay(d.eventId, { endpointId: d.endpointId });
```

Replay re-sends the stored event and sends the **same event id**, so your receiver's de-duplication makes it safe.

### Rehearse failures with the built-in receiver

```ts
const hook = await portal.webhooks.create({ builtinReceiver: true });
await portal.webhooks.setReceiverMode(hook.id, "fail500");   // ok | fail500 | fail400 | timeout
// … replay an event, watch retries in portal.webhooks.deliveries(hook.id) …
await portal.webhooks.setReceiverMode(hook.id, "ok");
```

### Rotate a secret

```ts
const { secret } = await portal.webhooks.rotateSecret(hook.id);   // the old secret stops working immediately
```

## Verify webhooks (receiver side)

```ts
import { constructEvent, SignatureVerificationError } from "@portalops/sdk";

try {
  const event = constructEvent(secret, rawBody, request.headers["portalops-signature"]);   // throws unless valid and fresh
  event.data.eventName; event.data.payload; event.data.finalityStatus;
} catch (e) {
  if (e instanceof SignatureVerificationError) console.warn(e.reason);   // "malformed" | "expired" | "mismatch"
}
```

`verifyWebhookSignature(secret, rawBody, header, { toleranceSeconds })` returns `{ ok, reason }` instead of throwing. Use the **raw** body
(`express.raw`, `request.text()`, `await request.arrayBuffer()`), never re-serialised JSON. More in [Webhooks](webhooks.md).

## Errors

Every failure is a `PortalOpsError`, whether it came from the API, the network or a timeout:

```ts
import { PortalOpsError } from "@portalops/sdk";

try {
  await portal.webhooks.create({ builtinReceiver: true });
} catch (e) {
  if (!(e instanceof PortalOpsError)) throw e;
  switch (e.code) {
    case "insufficient_scope": /* the key is read-only */ break;
    case "invalid_api_key":    /* revoked or wrong */ break;
    case "validation_failed":  console.log(e.details); /* [{ path, message }] */ break;
    case "rate_limited":       console.log(e.retryAfterSeconds); break;
    case "network_error": case "timeout": /* the server was unreachable */ break;
    default:                   console.log(e.status, e.code, e.message);
  }
}
```

`status` is `0` for network errors and timeouts. Reads are retried automatically (network errors, `429`, `5xx`, honouring `Retry-After`);
**writes are never retried**, because a repeated write could do the thing twice.

## What it can reach

| | |
|---|---|
| `portal.events` | `list`, `get`, `replay`, `iterate` |
| `portal.webhooks` | `list`, `create`, `update`, `delete`, `test`, `rotateSecret`, `deliveries`, `setReceiverMode` |
| `portal.contracts` | `list`, `add`, `test` |
| `portal.deliveries` | `list({ status })` |
| `portal.automations` | `list`, `create`, `setEnabled`, `delete` |
| `portal.project` | `get`, `overview`, `networkStatus` |
| `portal.examples` | `list`, `get` (the public example catalog) |

An API key cannot create projects or keys, or read the audit log. Those are dashboard (session) actions.

## Tested against the real thing

`packages/sdk/sdk.test.ts` runs every SDK feature against the real API over HTTP (not a mock), so an API change that breaks the SDK fails
the build before it reaches you.
