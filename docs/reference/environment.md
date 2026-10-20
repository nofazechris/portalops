# Configuration reference

PortalOps is configured only through environment variables. Locally they come from a git-ignored `.env`; in production from your host's
settings (or `.env.production` with docker compose). Values already set in the real environment win over the file.

> The services drop the deploy-script private keys from their own environment at start-up, and a production `.env.production` should
> never contain them. See [Security](../security/review.md).

## Database

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | empty | `postgres://user:password@host:5432/db?sslmode=require` selects PostgreSQL for **both** the API and the worker. Empty means SQLite. Use the same value for both processes. Check it with `npm run db:check` |
| `PORTALOPS_DB_PATH` | `data/portalops.sqlite` | SQLite file when `DATABASE_URL` is empty. The API and worker must share it (one host, a local disk) |

## Required for the API and worker

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_ENCRYPTION_KEY` | none | 32 random bytes as 64 hex characters or base64. Encrypts webhook signing secrets at rest (AES-256-GCM). Losing it makes stored secrets unreadable; changing it has the same effect. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

## Chain

| Variable | Default | Meaning |
|---|---|---|
| `PORTALDOT_EVM_RPC_URL` | `https://test-evm-rpc-v3.portaldot.dev` | The EVM JSON-RPC endpoint to read from |
| `PORTALDOT_EVM_CHAIN_ID` | `420420777` | The chain id the endpoint **must** report. A mismatch refuses ingestion rather than ingesting from the wrong network |

## API

| Variable | Default | Meaning |
|---|---|---|
| `PORTALOPS_API_PORT` | `8787` (falls back to `PORT`) | Port to listen on. Hosts that inject `PORT` work without extra setup |
| `PORTALOPS_API_HOST` | `127.0.0.1` | Interface to listen on. Containers set `0.0.0.0` and sit behind a TLS-terminating proxy |
| `PORTALOPS_PUBLIC_URL` | `http://localhost:5173` | The browser-facing origin. If it starts with `https://` the session cookie is `Secure` and HSTS is sent; it is also an allowed origin for browser writes |
| `PORTALOPS_API_PUBLIC_URL` | `http://127.0.0.1:<port>` | Where the **worker** reaches the API; used to build built-in test receiver URLs. In production it must be a public https URL the worker can reach (it is validated like any webhook target) |
| `PORTALOPS_TRUSTED_PROXY_HOPS` | `0` | How many reverse proxies sit in front of the API. `0` ignores `X-Forwarded-For` completely (spoof-proof); `1` trusts the last hop. Wrong values break per-IP rate limiting |
| `PORTALOPS_STATIC_DIR` | unset | If set, the API also serves the built web app from this folder (the Docker image sets it to `dist`) |
| `PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS` | unset | `1` allows webhooks to loopback and private addresses over http. **Development only**: the API refuses to start with it on an https deployment |
| `PORT` | none | Used only if `PORTALOPS_API_PORT` is unset |

## Email (verification and password reset)

| Variable | Default | Meaning |
|---|---|---|
| `RESEND_API_KEY` | unset | A [Resend](https://resend.com) API key with **sending access**. Set it only in your host's environment settings and your local `.env`, never in a committed file. Without it, emails are printed to the server log instead of being sent (development) |
| `EMAIL_FROM` | unset | The sender, for example `PortalOps <no-reply@yourdomain.com>`. The domain must be verified in Resend (`onboarding@resend.dev` works for testing, but only delivers to your own Resend account address) |

## GitHub sign-in

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_CLIENT_ID` | unset | The Client ID of a GitHub OAuth App. With the secret below it turns on "Continue with GitHub" |
| `GITHUB_CLIENT_SECRET` | unset | The OAuth App's client secret. Set only in your host's settings and your local `.env`; never committed, never in the browser, and dropped from the worker process. Both values must be set or the feature stays off |

The OAuth App's **Authorization callback URL** must be exactly `<PORTALOPS_PUBLIC_URL>/api/v1/auth/github/callback`. Setup steps: [Accounts](../guides/accounts.md#github-sign-in).

## Worker

| Variable | Default | Meaning |
|---|---|---|
| `PORTALOPS_POLL_MS` | `6000` | How often the worker polls for new blocks |
| `PORTALOPS_DEMO_LOOKBACK_BLOCKS` | `120000` | How far back the public explorer project reads on its first run |

Per-project capture starts at the contract's `startBlock`, or about the last 1,000 blocks when none is given.

## Your own application and tools

| Variable | Who reads it | Meaning |
|---|---|---|
| `PORTALOPS_WEBHOOK_SECRET` | **your receiver** | The convention used by the generated handlers and the Claude tool for the signing secret. Not read by PortalOps itself |
| `PORTALOPS_API_KEY` | SDK, MCP server | A project API key (`pops_…`) |
| `PORTALOPS_API_URL` | SDK, MCP server | The PortalOps server address, for example `https://portalops.example.com`. Plain `http` is only accepted for `localhost` |

## Testing

| Variable | Meaning |
|---|---|
| `TEST_DB` | `postgres` runs the suite against PostgreSQL; anything else uses in-memory SQLite |
| `TEST_DATABASE_URL` | The server `TEST_DB=postgres` uses. `npm run test:pg` starts a throwaway one for you if this is unset |

## Contract deployment scripts (never on a server)

Used only by `npm run contract:deploy` and friends, from your own machine's `.env`:
`PORTALDOT_DEPLOYER_PRIVATE_KEY` (a **throwaway** testnet key), `PORTALDOT_PARTICIPANT_PRIVATE_KEY`, `PORTALDOT_GAS_LIMIT`,
`DEMO_CONTRACT_ADDRESS`, `PORTALDOT_NATIVE_RPC_URL`. They default to a dry run; `--send` is required to broadcast anything.

## Examples

```bash
# local development (SQLite)
WEBHOOK_ENCRYPTION_KEY=<64 hex>

# production on Neon + Render
DATABASE_URL=postgres://…@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
WEBHOOK_ENCRYPTION_KEY=<64 hex or base64>
PORTALOPS_PUBLIC_URL=https://portalops.example.com
PORTALOPS_API_PUBLIC_URL=https://portalops.example.com
PORTALOPS_TRUSTED_PROXY_HOPS=1
```
