# PortalOps

Operational event layer for Portaldot applications: ingest on-chain events, deliver signed webhooks, retry, replay, monitor.
Targets the **Portaldot V3.0 testnet** (EVM chain id 420420777). See `docs/architecture/network-compatibility.md` for what has
and has not been verified against the real network.

## Run locally

```bash
npm install
# create a git-ignored .env with WEBHOOK_ENCRYPTION_KEY=<64 hex> (every variable: docs/reference/environment.md)
node -e "console.log('WEBHOOK_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))" > .env
npm run api                 # REST API on :8787
npm run worker              # block ingestion + webhook delivery
npm run dev                 # web app on :5173 (proxies /api to :8787)
```

Open http://localhost:5173. Without an account you get a read-only public explorer of live testnet events.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | 93 unit/integration tests (engine, store, API, receiver, security, ingestion, delivery) |
| `npm run typecheck` | TypeScript check |
| `npm run db:backup` | Verified online backup of the SQLite database |
| `npm run sdk:build` | Compile the TypeScript SDK (`packages/sdk`) to plain JS in `packages/sdk/dist` |
| `npm run preflight` | Read-only testnet compatibility probe |
| `npm run pipeline:test` | Real testnet logs → delivery → forced failure → retries → replay (local receiver) |
| `npm run contract:deploy` / `contract:interact` | Deploy + exercise the demo contract (dry-run unless `-- --send`; needs a funded key in `.env`) |

## Layout

```
apps/api        REST API (node:http, zod, cookie sessions, rate limits)
apps/worker     ingestion loop + delivery runner
packages/       database (SQLite store), event-engine, webhook-engine, chain-adapters, shared-types, sdk (API client)
contracts/evm   PortalQuest demo contract
examples/       webhook receiver with failure injection
src/            React app (landing, docs, auth, dashboard)
design/         original Claude Design files
```

## Guided setup, API keys and SDK

- **Guided setup** (dashboard → *Guided setup*): seven steps from an empty project to a verified delivery, each checked against the real
  network/API (RPC chain-id check, contract code check, one-time webhook secret, test delivery with signature confirmation).
- **API keys** (Settings → API keys): project-scoped `read`/`write` keys for servers and scripts; stored only as a SHA-256 hash, shown once, revocable.
- **TypeScript SDK** in `packages/sdk` (typed client, retries on reads, webhook verification). See its README. Not on npm yet.

## Documentation

The full manual is in [docs/](docs/README.md): [quickstart](docs/guides/quickstart.md), [concepts](docs/guides/concepts.md) (events, finality,
deliveries, replay), [receiving webhooks](docs/guides/webhooks.md) (Node, Python, Go, PHP), [contracts and examples](docs/guides/contracts-and-examples.md),
the [TypeScript SDK](docs/guides/sdk.md), the [REST API reference](docs/reference/api.md), [configuration](docs/reference/environment.md),
[architecture](docs/architecture/overview.md) and [troubleshooting](docs/guides/troubleshooting.md). The API reference, the environment
reference and every link are checked by tests, so they cannot silently drift from the code.

## Set up with Claude

`packages/mcp` is an MCP server that lets Claude register your contract, create a signed webhook, send a test delivery, show events and replay
failures. Secrets never enter the conversation: the API key stays in the server's environment and a webhook's signing secret is written
straight to a local env file. See [docs/guides/claude-setup.md](docs/guides/claude-setup.md); `npm run mcp` starts it over stdio.

## Example contracts

The guided setup's **Add contract** step has a gallery of ready-made contracts (Quest board, Token, Bounty board). Each one gives you
its Solidity source, ABI, a deploy command, a description of every event with a sample payload, and a copy-paste webhook receiver.
`npm run examples:build` recompiles them into `packages/examples/generated.json`; deploy one with
`npm run contract:deploy -- --example token` (dry run) and add `--send` once the key in `.env` is funded.
The same catalog is served at `GET /api/v1/examples` and `GET /api/v1/examples/:id`.

## Deploying

- **Live on the internet (Neon + Render):** [docs/operations/live-deploy.md](docs/operations/live-deploy.md). `npm run db:check` verifies your
  `DATABASE_URL` first; `render.yaml` is the Blueprint; `scripts/start-all.mjs` runs the API and worker in one container.
- **Your own host:** `docker compose up -d --build` runs the API (which also serves the web app) and the worker on a shared SQLite volume, or
  add `-f docker-compose.postgres.yml` for PostgreSQL. See [docs/operations/deployment.md](docs/operations/deployment.md) (config, TLS proxy,
  health/readiness, backups) and [docs/operations/demo-script.md](docs/operations/demo-script.md). The Docker files have not been run locally (no Docker here); CI builds and smoke-tests them.

## Event status

Each event carries an honest chain status: **included** (seen in a block) → **confirmed** (12+ blocks deep, a heuristic) →
**finalized** (at or below the node's `finalized` block *and* its block hash verified canonical; terminal) — or **orphaned** if its
block was reorganised away. `finalized` is only ever set from the network's own finality signal; if a node does not expose one,
PortalOps never guesses.

## Built-in test receiver

Create a webhook with **Use the built-in test receiver** and PortalOps hosts the endpoint for you: it verifies the signature,
rejects stale timestamps, ignores duplicate event ids, and shows every request it got. Switch it to *fail with 500 / 400 / never
answer* to try retries and replay with no backend. Needs `PORTALOPS_API_PUBLIC_URL` to be a URL the worker can reach.

## Security

See [docs/security/review.md](docs/security/review.md): findings, fixes, accepted risks and a production checklist.

## Known gaps

- Storage is SQLite (no Postgres/Docker was available); the schema is portable.
- Our own demo contract is **not deployed yet** (needs a funded testnet account). Events shown today are real logs from other participants' contracts, stored undecoded.
- No email verification / password reset / OAuth, or real AI-agent verification. The SDK is in-repo only (not on npm).
- A contract registered after a project's cursor exists is captured from the cursor forward (no per-contract backfill).
