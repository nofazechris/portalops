# @portalops/sdk

> Full guide with recipes: [docs/guides/sdk.md](../../docs/guides/sdk.md)

TypeScript client for the PortalOps REST API, plus webhook signature verification. Node 20+, no runtime dependencies.

```bash
npm i @portalops/sdk
```

Working from a checkout of the repository? Build it with `npm run sdk:build` (output in `packages/sdk/dist`), or import the TypeScript source
directly (`packages/sdk/index.ts`) under Node 24 / a TS-aware bundler.

```ts
import { PortalOps } from "@portalops/sdk";

const portal = new PortalOps({
  apiKey: process.env.PORTALOPS_API_KEY!,        // pops_… from Settings → API keys. Server-side only.
  baseUrl: "https://portalops.example.com",      // or set PORTALOPS_API_URL
});

// Read events (newest first)
const { items, total } = await portal.events.list({ finality: "finalized", limit: 20 });
for await (const e of portal.events.iterate({ delivery: "failed" })) console.log(e.id, e.eventName);

// Recover a failed delivery: re-sends the STORED event; the chain is not touched
await portal.events.replay(items[0].id);

// Manage webhooks (write key)
const hook = await portal.webhooks.create({ url: "https://api.example.com/portal-events", eventFilter: ["QuestCompleted"] });
console.log(hook.secret); // shown once: store it now
await portal.webhooks.test(hook.id);
```

## Verify webhooks in your receiver

```ts
import { constructEvent } from "@portalops/sdk";

app.post("/portal-events", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = constructEvent(process.env.PORTALOPS_WEBHOOK_SECRET!, req.body, req.header("portalops-signature"));
    // De-duplicate on event.id: replays and retries re-send the same id.
    res.sendStatus(200);
  } catch {
    res.sendStatus(400);
  }
});
```

Verify against the **raw body bytes**, not re-serialised JSON. Stale timestamps (> 5 min) are rejected.

## What you get

| | |
|---|---|
| `portal.events` | `list`, `get` (with full delivery history), `replay`, `iterate` |
| `portal.webhooks` | `list`, `create`, `update`, `delete`, `test`, `rotateSecret`, `deliveries`, `setReceiverMode` |
| `portal.contracts` | `list`, `add`, `test` |
| `portal.deliveries` | `list({ status })` across the project |
| `portal.automations` | `list`, `create`, `setEnabled`, `delete` |
| `portal.project` | `get`, `overview`, `networkStatus` |
| `portal.examples` | `list`, `get`: the public catalog of example contracts (source, ABI, deploy command, receiver code) |
| `verifyWebhookSignature`, `constructEvent` | receiver-side verification |

## Behaviour worth knowing

- **Keys** belong to one project and are `read` or `write`. Read keys cannot change anything. Keys cannot create projects or other keys.
- **Errors** are always `PortalOpsError` with `status`, `code` (`invalid_api_key`, `not_found`, `validation_failed`, `insufficient_scope`,
  `rate_limited`, `timeout`, `network_error`…), optional field `details`, and `retryAfterSeconds` on 429.
- **Retries:** GET requests are retried (default 2×) on network errors, 429 and 5xx, honouring `Retry-After`. **Writes are never retried automatically.**
- **Safety:** `baseUrl` must be `https` (plain http only for localhost); redirects are refused so the key is never forwarded to another host.
- **Finality:** `event.finalityStatus` is `included` → `confirmed` (depth heuristic) → `finalized` (network finality, verified) or `orphaned`.
  Wait for `finalized` before irreversible actions.

The SDK's tests run against the real API implementation, not mocks of it (`packages/sdk/sdk.test.ts`).
