# Troubleshooting

Find your symptom, check the likely causes in order. Two tools help with almost everything:

- **Overview → next action:** the dashboard (and `GET /projects/:id/overview`) says in plain language what it thinks is wrong or missing.
- **Logs:** `GET /projects/:id/logs` (the **Logs** screen in the dashboard) records ingestion, delivery and configuration events, with credentials redacted.

## "No events are arriving"

Work down this list; each step rules out one layer.

1. **Is the server watching the chain?** `GET /api/v1/public/status` should show `connection: "connected"`, a `headBlock` and
   `worker: "ok"`. If `worker` is `stale` or `never`, the worker process is not running (or cannot reach the database): start it, or check its logs.
   `GET /api/v1/ready` returns `503 worker_unavailable` in the same situation.
2. **Is the project ingesting?** `GET /projects/:id/network/status`: `ingestion` is `healthy` when the cursor moved recently, `stalled` when it has not for two
   minutes, `never_run` before the first pass. `lagBlocks` is how far behind it is; a large backfill takes a while and reports progress as it goes.
3. **Is the contract registered, with the right address?** The *Test contract* action reports `codeFound`. `false` means no bytecode at that address on this
   network: a typo, the wrong network, or a contract that is not deployed yet.
4. **Did the event happen in the captured range?** Without a `startBlock`, only about the last 1,000 blocks are read on the first run. Register with
   `startBlock` set to the deployment block to see older activity.
5. **Did the event come from that contract?** Events are matched by the emitting contract's address. A proxy emits from the proxy address: register that.
6. **Is it filtered out of the webhook?** The event exists on the **Events** screen but no delivery was made: the webhook's `eventFilter` does not contain its name
   (names are case-sensitive), or the webhook is disabled. An empty filter means all events.

## "Events arrive but are undecoded" (`eventName: null`)

The contract has no ABI, or the ABI does not contain an event with that exact signature (name and argument types, including `indexed`). Raw `topics`
and `data` are always kept. Register the correct ABI; events captured **after** that decode. (A copy of an example contract has the same
ABI as the example, so the example's ABI is the right one.)

## "A delivery failed"

Open the event: every attempt shows the HTTP status, how long it took, and your endpoint's (sanitised) answer.

| What you see | Meaning | Fix |
|---|---|---|
| `401` / `400` from your receiver | Your receiver rejected the signature | See [signature problems](#my-receiver-rejects-the-signature). Not retried: replay after fixing |
| `404`, `410`, other `4xx` | Wrong URL or your route refused it | Fix the URL or route; not retried: replay after fixing |
| `408`, `425`, `429`, `5xx` | Your server was overloaded or erroring | Retried automatically with backoff; if it ends `failed`, fix and replay |
| `timeout` | No answer within the timeout (default 10 s) | Respond first, work after. Or raise `retryPolicy.timeoutMs` (max 30 s) |
| `blocked_target` | The URL resolves to a private, loopback or internal address | Use a public HTTPS URL. For local development, use a tunnel (`cloudflared`, `ngrok`) |
| `invalid_url` | Not https, or malformed | Use `https://…` |
| `response_too_large` | Your response exceeded 64 KB | Return a tiny body |
| `3xx` | Your endpoint redirected; redirects are never followed | Register the final URL |
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` (and other connection error codes) | The PortalOps server cannot reach you | Your endpoint must be reachable **from the server**, not just from your laptop |

When the status is `failed`, nothing more happens automatically. Fix the cause, then replay: `POST /events/:id/replay`, the **Replay** button, or
`portal.events.replay(id)`. Replaying the same event id is safe if your receiver de-duplicates.

## "My receiver rejects the signature"

The signature is valid for the **exact bytes** the server sent. The usual causes, most common first:

1. **The body was parsed and re-serialised** (`express.json()`, `bodyParser`, a framework that decodes JSON before your handler). Verify against the raw body.
2. **Wrong secret.** It is per webhook, it starts with `whsec_`, and it changes when you rotate. Use the whole string, prefix included. If you lost it, rotate.
3. **Clock skew.** Timestamps older than 5 minutes are refused. Check your server's clock (NTP).
4. **A proxy or middleware changed the body** (compression, trimming, newline normalisation).
5. **Wrong header.** It is `PortalOps-Signature` (header names are case-insensitive).

Reproduce with the [test vector](webhooks.md#verify-the-signature): if your code produces the documented `v1`, the algorithm is right and the problem is the
inputs. The built-in receiver reports exactly why it rejected a request (`malformed`, `expired` or `mismatch`) in its history.

## "I receive the same event twice"

Expected: delivery is at-least-once. Retries after a lost acknowledgement and replays resend the **same** event id. De-duplicate on it in durable storage
([how](webhooks.md#idempotency-handle-the-same-event-twice)).

## "The event stays `included` / `confirmed`, never `finalized`"

- `included` becomes `confirmed` once it is 12 blocks deep: the worker must be running.
- `finalized` requires the node to report a finalized block at or above the event's block, and PortalOps to verify the stored block hash is still canonical.
  If the node exposes no finality signal, events stay `confirmed`: PortalOps will not guess. Finality lags the head by design.
- `orphaned` means the block was replaced by a reorganisation; the replacement log arrives as a new event.

## "The built-in test receiver is unavailable"

`409 receiver_unavailable` or `422 receiver_unreachable`: the server's `PORTALOPS_API_PUBLIC_URL` is unset or not a public https URL, so the
worker could not deliver to it. Set it to the server's public address (see [Configuration](../reference/environment.md)), or use your own endpoint.

## Accounts, cookies and the browser

| Symptom | Cause |
|---|---|
| Signed in, but every request is `401` over plain http | The session cookie is `Secure` because `PORTALOPS_PUBLIC_URL` starts with `https://`. Use https, or http only for local development |
| `403 origin_not_allowed` from a browser | A cross-origin write from an origin that is not the server's own host or `PORTALOPS_PUBLIC_URL` |
| `429 rate_limited` right after starting | Behind a proxy with `PORTALOPS_TRUSTED_PROXY_HOPS=0`, every user shares the proxy's IP. Set it to the number of proxies in front of the API |
| `409 project_limit` / `key_limit` | The per-user project cap, or 10 active keys per project. Revoke or delete something |

## Database

`npm run db:check` connects, applies the schema, and prints a readable diagnosis. Common results:

| Message | Fix |
|---|---|
| authentication failed | Copy the connection string again from your database provider |
| host does not resolve | Typo in the host name |
| timeout / connection refused | The database may be waking from suspend (Neon): run it again. Otherwise check the network and `sslmode=require` |
| "pooled endpoint" notice | Works, but the direct endpoint (host without `-pooler`) is the safer choice for the API and worker |
| SQLite: "database is locked" | The API and worker must be on **one host** with a local disk; for anything else use PostgreSQL |

## Claude (MCP)

See [Set up with Claude → Troubleshooting](claude-setup.md#troubleshooting).

## Still stuck?

Collect: the event id, the delivery id, the attempt list from `GET /events/:id`, the project's recent logs, and the output of
`GET /api/v1/public/status`. They contain no secrets and answer most questions on their own.
