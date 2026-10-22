# FAQ

## The basics

### What does PortalOps actually do?
It watches smart contracts on the Portaldot testnet, decodes what they emit, stores every event once, and sends each one to your app as a
signed webhook, retrying if your app is down and letting you replay anything later. See [What is PortalOps?](product-overview.md).

### Do I need to deploy a contract to use it?
No. PortalOps watches **any** contract on the testnet. You can start with a real contract another team deployed (the quick start offers one
with constant activity), or with our demo contract. You only deploy your own contract when you want to produce events yourself.

### Do I need tokens (tPOT)?
Not to use PortalOps: watching contracts and receiving webhooks costs nothing. You need tPOT only to **deploy** a contract or send
transactions on the testnet.

### Is this a blockchain indexer like a GraphQL subgraph?
Not exactly. An indexer is built to **query** history flexibly. PortalOps is built to **deliver** events to your application reliably
(signing, retries, replay, monitoring). They solve neighbouring problems and can be used together.

### Which network does it support?
The **Portaldot V3.0 testnet** (EVM chain id 420420777) today. See [Portaldot network notes](../architecture/network-compatibility.md).

### Which language are the contracts written in?
The example contracts are **Solidity**, compiled to EVM bytecode and deployed to Portaldot's EVM layer. Portaldot also supports Rust
(ink!) contracts; PortalOps does not read those yet (a native adapter is planned).

## Events and delivery

### Why does my event say "included" and not "finalized"?
New events always start as `included`. They become `confirmed` after 12 blocks and `finalized` when the network's own finality passes them
and their block hash is re-verified. This takes a little while by design. See [Finality](concepts.md#finality).

### When can I safely act on an event?
For anything irreversible (crediting funds, shipping goods), only when it is `finalized`. For notifications, `included` is usually fine.

### I received the same event twice. Is that a bug?
No. Delivery is **at-least-once**: a retry after a lost acknowledgement, or a replay, resends the same event id. De-duplicate on the id in
durable storage ([how](webhooks.md#idempotency-handle-the-same-event-twice)).

### What does an event look like when there is no ABI?
It is still captured, with `eventName: null` and `decoded: false`, plus the raw `topics` and `data`. Add the ABI later and new events decode.

### Can I get events from before I registered a contract?
Yes, up to what the chain still serves: set a **start block** when registering and PortalOps reads history from there. Without one it reads
roughly the last 1,000 blocks.

### How fast do events arrive?
The worker polls the chain every few seconds. Expect a new event in your webhook within seconds of it being mined, plus up to a minute the
first time you register a contract while it reads history.

### What happens if my server is down?
PortalOps retries with growing gaps (5 attempts over up to 24 hours by default, configurable). If all fail, the delivery shows as failed and
waits for you to fix things and replay it. Nothing is lost.

### Does replay send a new blockchain transaction?
Never. Replay re-sends the **stored** event to your webhook. The chain is not touched.

### Can I receive only some events?
Yes: set the webhook's event filter (names), or use [automations](dashboard-tour.md#automations) to route by event and contract. Filtering by
argument values (for example one address) is done in your receiver; see [use cases](use-cases.md).

## Security

### How do I know a webhook really came from PortalOps?
Every request has a `PortalOps-Signature` header: an HMAC-SHA256 over the exact body with your webhook's secret, plus a timestamp. Verify it
with the [SDK or the recipes](webhooks.md#verify-the-signature) before doing anything.

### Where is my webhook secret?
Shown **once** when you create the webhook (or rotate it). It is stored encrypted and cannot be read back. Lost it? Rotate it.

### What can an API key do?
A key belongs to one project and is `read` or `write`. It cannot create projects or other keys, or read the audit log. Revoke it any time in
Settings.

### Does Claude see my keys?
No. Your API key stays in the Claude connection's environment, and a webhook's signing secret is written straight to a local file. See
[Set up with Claude](claude-setup.md#how-secrets-are-handled).

### Can a webhook point at my laptop or an internal service?
Not on the hosted service: PortalOps refuses addresses that resolve to private or internal networks, and re-checks on every send. Use a
tunnel (such as `cloudflared` or `ngrok`) for local development.

## Accounts

### How do I sign in?
Email and password (with email confirmation and reset), or GitHub. See [Accounts](accounts.md).

### I did not get a confirmation or reset email.
Check spam first. On a server still using Resend's test sender, mail only reaches the account owner's own address. Details in
[Accounts](accounts.md#troubleshooting).

## Using Claude

### What can Claude do with PortalOps?
Register a contract (using an example's ABI or yours), create a webhook, send a test delivery, list and inspect events, find failed
deliveries and replay them. It cannot create accounts, projects or keys, and it never receives secrets. See
[Set up with Claude](claude-setup.md).

### Do I need Claude to use PortalOps?
No. Everything is available in the dashboard, the REST API and the SDK.

## Running it yourself

### Can I host PortalOps myself?
Yes: it is open source, ships a Dockerfile and a Render blueprint, and runs on SQLite (one host) or PostgreSQL. See
[Put it live](../operations/live-deploy.md) and [Deployment](../operations/deployment.md).

### Where are the limits?
Rate limits are in memory (run one API instance), one worker per database, EVM side only, testnet only. The
[architecture page](../architecture/overview.md#limits) lists them.

## Still stuck?

[Troubleshooting](troubleshooting.md) walks through the usual causes in order. If a delivery failed, open its event: every attempt shows
the status, timing and your endpoint's (sanitised) answer.
