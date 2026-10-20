# Concepts

The whole product in one picture:

```
 Portaldot chain ──► worker ──► event store ──► webhook engine ──► your receiver
   (logs)          reads &      (immutable,      signs, sends,     (verifies, de-duplicates,
                   decodes      de-duplicated)   retries, records  acts)
                                    ▲
                      API + dashboard + SDK + Claude read and operate it
```

## Projects

A **project** is the unit of ownership: it has its own contracts, events, webhooks, API keys and history, and nothing is shared between
projects, even when two projects watch the same contract (each gets its own copy of every event). Another user can never see your
project: the API answers `404`, not `403`, so even its existence is not revealed.

There is also one built-in **public explorer** project, read-only for everyone, that follows every log on the testnet without decoding.
It exists so the product is explorable before sign-up; it cannot be written to.

## Contracts and ABIs

You register a contract by address. If you also give its **ABI**, the worker decodes each log into an event name and named arguments.
Without an ABI the log is still stored and delivered, with `eventName: null` and `decoded: false` (raw `topics` and `data` included).
Stored events are never rewritten: an ABI only affects events captured after it is registered.

Capture starts at `startBlock` if you give one, otherwise roughly the last 1,000 blocks. The worker remembers how far it has read
(its **cursor**) per project, so a restart resumes exactly where it stopped.

## Events

An **event** is one log emitted by a contract, stored exactly once. Its id is a hash:

```
evt_ + sha256(projectId : chainId : blockHash : transactionHash : logIndex)
```

Two consequences you can rely on:

- Reading the same block twice (overlapping reads, restarts) never creates a duplicate: the id is the same.
- If a block is **reorganised** and the same log appears in a different block, that is a *different* event (different block hash),
  and the old one is marked `orphaned`.

Decoded numbers (`uint256`) are delivered as **strings** so no precision is lost.

### Finality

Every event carries a `finalityStatus`. It only ever moves forward:

| Status | Meaning | Safe to credit money? |
|---|---|---|
| `included` | Seen in a block less than 12 blocks deep. Tip reorganisations are routine on this testnet. | No |
| `confirmed` | At least 12 blocks deep. This is a **depth heuristic**, not a protocol guarantee. | For low-value actions |
| `finalized` | At or below the node's own `finalized` block, **and** the stored block hash was verified to still be the canonical one. Terminal: never downgraded. | Yes |
| `orphaned` | The block it was in is no longer on the canonical chain. | Ignore it |

PortalOps never *guesses* finality from depth: if the node gives no finality signal, events stay `confirmed`. Old blocks can no longer be
fetched by number (the testnet keeps about 256 recent blocks), so verification of older events goes through log queries, and the
*absence* of data is never treated as proof.

What a webhook sees: a delivery is created **once**, when the event is first stored (usually as `included`); a later status change does
not trigger another delivery. The body is built from the stored event **at the moment of each attempt**, so `finalityStatus` is the
status at that attempt: the first try says `included`, a retry minutes later may say `confirmed`, and a replay days later says
`finalized`. If your logic depends on finality (crediting funds, say), act only when `finalityStatus` is `finalized`; otherwise
check the status through the API ([`GET /events/:id`](../reference/api.md#get-apiv1eventseventid)) or replay the event later.

## Webhooks and deliveries

A **webhook** (called an *endpoint* in the data model) is a URL plus an **event filter** (a list of event names, empty = all) and a
**retry policy**. When an event is stored, every enabled webhook whose filter matches gets one **delivery**.

A delivery is a small state machine, with every try recorded as an **attempt** (time, HTTP status, duration, sanitised response):

```
pending ──► delivered                     (any 2xx)
   │
   └──► retrying ──► delivered
            │
            └──► failed                   (attempts exhausted, too old, or a permanent error)
```

- **Retried:** network failures, timeouts, `408`, `425`, `429` and every `5xx`.
- **Not retried** (permanent): other `4xx` responses, a blocked or invalid URL, an oversized response.
- **Schedule:** exponential backoff with full jitter, never faster than 1 s. Defaults: 5 attempts, base 5 s, cap 1 h, give up after
  24 h, 10 s timeout per attempt. All five numbers are per-webhook settings.
- **At-least-once:** a delivery can arrive more than once (a retry after a lost acknowledgement, or a replay). Your receiver
  de-duplicates on the event id. Exactly-once is not promised, because no one can promise it over HTTP.

## Replay

**Replay** re-sends a *stored* event to one webhook (or all enabled ones). It creates a new delivery marked `replay`, leaves the event
untouched, never resubmits anything to the chain, and sends the **same event id**, so a correct receiver treats it as a duplicate unless
it failed the first time. This is how you recover after an outage in your own system: fix the receiver, replay the failures.

## Signing

Every request carries `PortalOps-Signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 over `"<t>.<raw body>"` with the webhook's secret.
The secret is generated by PortalOps, encrypted at rest, and **shown once**; rotate it to replace it (the old one stops working
immediately). Full details and code in [Webhooks](webhooks.md).

## Automations

An **automation** is a rule: "when an event named *X* (optionally only from contract *Y*) is captured, deliver it to webhook *Z*".
It routes by rule instead of by the webhook's own filter: the rule delivers to its webhook even when that webhook's filter would not
match (the webhook only has to be enabled). A rule and a filter that point at the same webhook still send **once**, because a delivery
is unique per event and webhook.

## API keys

A **project API key** (`pops_…`) lets code use the API on one project. Scopes: `read` (list and get) and `write` (also create and
change). Keys are shown once, stored only as a hash, rate-limited per key, revocable, and capped at 10 active per project. A key can
never create projects, manage keys, or read the audit log: those need a signed-in session.

## The built-in test receiver

A webhook can point at a receiver hosted by PortalOps itself. It verifies signatures, de-duplicates event ids, keeps a short history of
what it saw, and has a **failure mode** switch (`ok`, `fail500`, `fail400`, `timeout`) so you can rehearse retries and replay with no
backend. It needs the server's public URL to be reachable from the worker.

## Networks

PortalOps currently watches the **Portaldot V3.0 testnet** (EVM chain id `420420777`). It verifies the chain id on connect and refuses to
ingest from an endpoint that reports a different one. Portaldot's native (non-EVM) runtime is not ingested yet.
