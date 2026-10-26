# REST API reference

Base URL: `https://<your-server>/api/v1`. All bodies are JSON (`Content-Type: application/json`).

## Conventions

**Envelope.** Success is `{ "data": … }`. Failure is `{ "error": { "code": "…", "message": "…", "details": [ … ] } }` (`details` only for
validation errors, as `{ "path", "message" }` items).

**Authentication.** Two ways, never mixed up:

| | How | Can do |
|---|---|---|
| **Session** | the `pops_session` cookie set by sign-up or login (`HttpOnly`, `SameSite=Lax`, `Secure` over https) | everything, for the projects you own |
| **API key** | `Authorization: Bearer pops_…` | work inside **one** project: `read` keys can `GET`; `write` keys can also create and change. Never account-level actions |

If an `Authorization` header is present it must be valid: a bad key is a `401`, it is never silently treated as anonymous.

Access levels used below:

| Level | Meaning |
|---|---|
| **Public** | no authentication |
| **Read** | the project's owner (session or key), or anyone for the public explorer project |
| **Owner** | the project's owner only (a `read` key may `GET`; a `write` key or session may change) |
| **Session** | a signed-in session only; API keys are refused with `403 session_required` |

**Other people's data is a `404`**, never a `403`, so ids cannot be probed for existence.

**Cross-origin writes.** Browsers must send an `Origin` that matches the host or an allowed origin, otherwise `403 origin_not_allowed`.
Non-browser clients (no `Origin`) are unaffected.

**Limits.** Request bodies are limited to 1 MB (`413 payload_too_large`); a wrong content type is `415`. Rate limits return `429` with a
`Retry-After` header (seconds): per IP globally, per key for API keys (600/min), on sign-up and login attempts, and on actions that
contact the outside (replay, test delivery, contract test). The SDK retries `GET`s on `429`/`5xx` automatically and never retries writes.

**Pagination.** List endpoints that return many rows take `limit` and `offset` and return `{ items, total, limit, offset }`.

**Error codes**

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_json` | the body is not valid JSON |
| 400 | `invalid_token` | an email link (verify or reset) is wrong, expired or already used |
| 401 | `unauthenticated` | no valid session |
| 401 | `invalid_api_key` | the key is wrong, malformed or revoked |
| 401 | `invalid_credentials` | wrong email or password (the same message for both) |
| 403 | `insufficient_scope` | a `read` key tried to change something |
| 403 | `session_required` | an API key tried an account-level action |
| 403 | `origin_not_allowed` | cross-origin browser write |
| 404 | `not_found` | missing, or not yours |
| 405 | `method_not_allowed` | wrong method (an `Allow` header lists the right ones) |
| 409 | `email_taken`, `project_limit`, `key_limit`, `contract_exists`, `no_endpoints`, `receiver_unavailable` | the request is valid but conflicts with current state |
| 413 | `payload_too_large` | body over the limit |
| 415 | `unsupported_media_type` | not `application/json` |
| 422 | `validation_failed` | invalid input (see `details`); `receiver_unreachable` for an undeliverable built-in receiver URL |
| 429 | `rate_limited` | slow down; see `Retry-After` |
| 502 | `rpc_unavailable` | the server could not reach the chain |
| 503 | `worker_unavailable` | readiness: the worker is not reporting |
| 503 | `email_unavailable` | the email provider could not send right now (only reported to the signed-in owner of the address) |
| 404 | `github_unavailable` | GitHub sign-in is not configured on this server |

---

## Service

### GET /api/v1/health
**Public.** Liveness: `{ "ok": true, "worker": { "status": "ok" | "stale" | "never", "lastBeatAt", "ageSeconds" } }`. Always `200` while the API process is alive.

### GET /api/v1/ready
**Public.** Readiness. `200` when the worker has reported within the last 120 s; otherwise `503 worker_unavailable` (`details.status` is `stale` or `never`). Point load-balancer checks here.

### GET /api/v1/networks
**Public.** Supported networks: `[{ "id": "portaldot-v3-testnet", "label", "runtime": "evm", "evmChainId": 420420777 }]`.

### GET /api/v1/public/status
**Public.** `{ network, connection: "connected" | "disconnected" | "wrong_chain", headBlock, checkedAt, worker, demo }`. `headBlock` is `null` when the chain is unreachable: it is never invented.

### GET /api/v1/examples
**Public.** The example contract catalog: `[{ id, title, tagline, category, contractName, events: [{ name, meaning }] }]`. See [Contracts and examples](../guides/contracts-and-examples.md).

### GET /api/v1/examples/featured
**Public.** Contracts a new user can start watching with one click, each with a known ABI: `[{ id, title, origin: "ours" | "community", blurb, address, example, startBlock, events: [names…], evidence? }]`. `ours` are deployed by this project (with the deployment and transaction hashes in `evidence`); `community` are other teams' contracts on the testnet, watched read-only.

### GET /api/v1/examples/:id
**Public.** One example with `description`, `eventDetails` (meaning, sample payload, typical use), `source`, `abi`, `bytecode`, `deployCommand`, a ready `handler` (Node.js receiver) and the `compiler` used. `404` for an unknown id.

### GET /api/v1/playground
**Public, no signup.** The shared sandbox: `{ projectId, network, pinned: [address…], maxContracts, contracts: […], events: […], receiver: [{ outcome, httpStatus, signatureOk, eventId, receivedAt }…] }`. No secrets are ever returned.

### POST /api/v1/playground/watch
**Public, no signup.** Body `{ address (0x + 40 hex), example? }`. Adds a contract to the shared playground (rate-limited per IP; built-in receiver only; capped, with the example contracts always pinned). Returns the contract. `409 playground_full` when the sandbox is at its cap.

### POST /api/v1/playground/test-delivery
**Public, no signup.** Sends one signed test delivery to the playground's built-in receiver (rate-limited per IP). Returns `{ ok, status, errorCode, durationMs }`.

---

## Accounts

### POST /api/v1/auth/signup
**Public.** Body `{ "email", "password" }` (password 12–200 characters). `201` with `{ user }` and a session cookie. `409 email_taken`. Rate limited per IP. A verification email is sent best-effort (it never makes sign-up fail or wait more than a few seconds). The `user` object is `{ id, email, mfaEnabled, emailVerified, githubLinked, githubLogin, hasPassword }`; the password hash is never returned.

### POST /api/v1/auth/login
**Public.** Body `{ "email", "password" }`. `200` with `{ user }` and a session cookie. The same `401 invalid_credentials` is returned whether the email exists or not, and the work done is the same, so timing does not leak it. Rate limited per IP and per email.

If the account has two-factor sign-in on, a correct password does **not** start a session: the answer is `200 { mfaRequired: true, challenge }` (no cookie), and the client finishes with [`POST /auth/login/mfa`](#post-apiv1authloginmfa) within 5 minutes.

### POST /api/v1/auth/login/mfa
**Public.** Body `{ "challenge", "code" }`: the challenge from the login answer and either a 6-digit authenticator code or an unused recovery code. `200 { user }` and a session cookie. `401 invalid_code` (wrong, stale or already-used code; the challenge stays usable until it expires or is answered) and `401 challenge_expired` (unknown, used or older than 5 minutes). A code works once; rate limited per IP and per account.

### GET /api/v1/auth/mfa
**Session.** Two-factor status: `{ enabled, recoveryCodesLeft }`.

### POST /api/v1/auth/mfa/setup
**Session.** Starts two-factor setup: `{ secret, otpauthUri }` (a fresh secret to add to an authenticator app by key or `otpauth://` link; stored encrypted, not active yet). `409 mfa_already_enabled` while it is on.

### POST /api/v1/auth/mfa/enable
**Session.** Body `{ "code" }`, the first code from the authenticator. Turns two-factor on and returns `{ enabled: true, recoveryCodes }`: ten one-time codes, **shown only this once** (only hashes are kept). `401 invalid_code`; `409 mfa_not_pending` if setup was not started.

### POST /api/v1/auth/mfa/recovery-codes
**Session.** Body `{ "code" }` (an authenticator or recovery code). Replaces the recovery codes with ten new ones, returned once as `{ recoveryCodes }`; the old ones stop working.

### POST /api/v1/auth/mfa/disable
**Session.** Body `{ "code", "password" }`: turns two-factor off after checking both the current password (accounts without a password, created through GitHub, skip it) and a code. `{ enabled: false }`.

### POST /api/v1/auth/logout
Revokes the session and clears the cookie. `{ "ok": true }`.

### GET /api/v1/auth/me
**Session.** `{ user: { id, email, mfaEnabled, emailVerified, githubLinked, githubLogin, hasPassword } }`.

### GET /api/v1/auth/providers
**Public.** Which sign-in options this server offers: `{ github: boolean, email: boolean }`. `email` is `true` only when a real email provider is configured, so a UI can warn when reset emails cannot be sent.

### POST /api/v1/auth/verify-email
**Public.** Body `{ "token" }`, the token from the emailed link (`/auth#verify=<token>`). Marks the address verified: `{ verified: true }`. A token works once and expires after 24 hours; anything else is `400 invalid_token`. It needs no session, so the link works from any browser.

### POST /api/v1/auth/resend-verification
**Session.** Sends a fresh verification link and invalidates the previous one. `{ sent: true }`, or `{ sent: false, alreadyVerified: true }`. One per minute (`429`); `503 email_unavailable` if the provider could not send.

### POST /api/v1/auth/forgot-password
**Public.** Body `{ "email" }`. **Always** answers `200 { sent: true, message }` in the same way whether or not the address has an account, so it cannot be used to discover who is registered; the email, if any, is sent in the background. Rate limited per IP and per address. The link (`/auth#reset=<token>`) works once and expires after 1 hour; a newer request replaces the older link.

### POST /api/v1/auth/reset-password
**Public.** Body `{ "token", "password" }` (12–200 characters). Sets the password, marks the address verified (the user proved they own the inbox), and **revokes every session** of the account. `{ reset: true }`, or `400 invalid_token` and the token stays unused if the password was rejected with `422`. Works for GitHub-only accounts too, which adds a password.

### GET /api/v1/auth/github/start
**Public.** Begins "Continue with GitHub": `302` to GitHub's authorization page with a random `state`, also stored in a short-lived (10 min) `HttpOnly; SameSite=Lax` cookie scoped to the GitHub routes. `404 github_unavailable` when not configured.

### GET /api/v1/auth/github/callback
**Public.** Where GitHub sends the browser back. Always answers with a `302`: to `/app` with a session cookie on success, or to `/auth#error=<code>` with no session. Codes: `state_mismatch` (forged, replayed or expired), `access_denied`, `github_failed`, `github_no_verified_email`, `github_account_mismatch`, `github_unavailable`, `rate_limited`. See [Accounts](../guides/accounts.md) for exactly how an account is matched.

---

## Projects

### POST /api/v1/projects
**Session.** Body `{ "name" (1–80), "description"? (≤500), "networkId"? }`. `201` with the project. `409 project_limit` at the per-user cap (default 20).

### GET /api/v1/projects
Your projects (with an API key: just the key's project).

### GET /api/v1/projects/:projectId
**Read.** One project: `{ id, name, description, ownerId, kind: "user" | "public_demo", networkId, createdAt }`.

### PATCH /api/v1/projects/:projectId
**Session.** Body `{ "name"?, "description"? }`.

### GET /api/v1/projects/:projectId/network/status
**Read.** Network health for the project: `{ network, chainId, connection, headBlock, rpcLatencyMs, rpcError, ingestion: "never_run" | "healthy" | "stalled" | "unknown", cursorBlock, lagBlocks, lastIngestionAt, lastEventObservedAt }`. `stalled` means the cursor has not moved for over two minutes.

### POST /api/v1/projects/:projectId/network/test
**Owner.** Runs a fresh connectivity and chain-id check and returns it with `expectedChainId`. Rate limited.

### GET /api/v1/projects/:projectId/overview
**Read.** Everything the dashboard's first screen needs: `project`, `metrics { eventsReceived, delivered, failed, retrying, pending, activeWebhooks }`, `network`, `recentEvents`, `recentFailures` (owner only), `setup { networkConnected, contractAdded, webhookConfigured, firstEventReceived, firstDeliverySucceeded, completed, total }`, and `nextAction` (a plain-language next step, owner only).

---

## Contracts

### POST /api/v1/projects/:projectId/contracts
**Owner.** Body `{ "address" (0x + 40 hex), "name"?, "abi"? (array, ≤ 256 KiB), "startBlock"?, "deploymentTxHash"? }`. `201` with the contract. `409 contract_exists` if it is already registered. Without `abi`, events are stored undecoded.

### GET /api/v1/projects/:projectId/contracts
**Read.** `[{ id, projectId, address, name, runtimeType, startBlock, deploymentTxHash, status, createdAt, hasAbi, eventCount, events: [names…] }]`. The ABI body is not returned; `events` lists the event names it declares.

### GET /api/v1/contracts/:contractId
**Read.** One contract, same shape.

### POST /api/v1/contracts/:contractId/test
**Owner.** Read-only check that bytecode exists at the address on the connected network: `{ address, codeFound, runtimeCodeBytes, note }`. Nothing is signed or sent. `502 rpc_unavailable` if the chain cannot be reached. Rate limited.

---

## Events

### GET /api/v1/projects/:projectId/events
**Read.** Newest first. Query: `q` (search tx hash, address, event name or id), `contract` (address), `event` (name), `finality` (`included` | `confirmed` | `finalized` | `orphaned`), `delivery` (`pending` | `retrying` | `delivered` | `failed`), `limit` (1–200, default 50), `offset`.
Response `{ items, total, limit, offset }`; each item is an event (below) plus `delivery: { status, count } | null`.

**Event object**

| Field | Description |
|---|---|
| `id` | `evt_…`, deterministic and unique per project |
| `contractAddress`, `eventName`, `decoded` | `eventName` is `null` and `decoded` `false` when it could not be decoded |
| `payload` | decoded arguments (large numbers as strings), or `null` |
| `topics`, `data` | the raw log |
| `transactionHash`, `transactionIndex`, `blockNumber`, `blockHash`, `eventIndex` | where it happened |
| `observedAt` | when PortalOps first stored it |
| `finalityStatus` | `included` → `confirmed` → `finalized`, or `orphaned` (see [Concepts](../guides/concepts.md#finality)) |

### GET /api/v1/events/:eventId
**Read.** The event plus `deliveries`: every delivery to every webhook, each with its `attempts` (number, times, HTTP status, duration, sanitised response, error code). Deliveries are included for the owner only.

### POST /api/v1/events/:eventId/replay
**Owner.** Body `{ "endpointId"? }`: replays to that webhook, or to every enabled one. `202` with `{ deliveryIds: [...] }`. The stored event is re-delivered; nothing is sent to the chain. `409 no_endpoints` if there is nothing to replay to. Rate limited.

### GET /api/v1/projects/:projectId/deliveries
**Owner.** Deliveries across the project, newest first. Query `status`, `limit` (≤ 200). Each item is a delivery plus a small `event` summary. `?status=failed` is the "needs a replay" list.

**Delivery object:** `{ id, eventId, endpointId, kind: "initial" | "replay", status, attemptCount, nextAttemptAt, lastResponseStatus, lastError, createdAt, updatedAt }`.

---

## Webhooks

### POST /api/v1/projects/:projectId/webhooks
**Owner.** Body:

| Field | |
|---|---|
| `url` | HTTPS endpoint. Required unless `builtinReceiver` is true |
| `builtinReceiver` | `true` to use the hosted test receiver (`409 receiver_unavailable` if the server has no public URL configured) |
| `description` | ≤ 200 characters |
| `eventFilter` | event names; empty = all (≤ 50 names) |
| `retryPolicy` | any of `maxAttempts` (1–10), `baseDelayMs` (≥1000), `maxDelayMs`, `maxAgeMs` (≥ 60000, ≤ 7 days), `timeoutMs` (1000–30000); the rest default (5, 5 s, 1 h, 24 h, 10 s) |
| `enabled` | default `true` |

`201` with the webhook **and a one-time `secret`** (`whsec_…`). It cannot be read again; rotate to replace it. The URL is checked against the [delivery rules](../guides/webhooks.md#where-it-can-be-delivered): `422` if it is blocked.

### GET /api/v1/projects/:projectId/webhooks
**Owner.** `[{ id, projectId, url, description, enabled, eventFilter, retryPolicy, createdAt, builtinReceiver }]`. Secrets are never included.

### PATCH /api/v1/webhooks/:webhookId
**Owner.** Any of `url`, `description` (or `null`), `eventFilter`, `retryPolicy` (merged with the current one), `enabled`.

### POST /api/v1/webhooks/:webhookId/rotate-secret
**Owner.** `{ id, secret }`: the new secret, shown once. The old one stops working immediately.

### DELETE /api/v1/webhooks/:webhookId
**Owner.** `{ "ok": true }`. Its delivery history is removed with it.

### POST /api/v1/webhooks/:webhookId/test
**Owner.** Sends one signed request and returns `{ ok, status, errorCode, durationMs, response }`. The body is `{ "id": "evt_test_…", "type": "webhook.test", "network", "data": { "message": … } }` with `PortalOps-Event-Id: test`: it is **not** a chain event, is not stored, and cannot be replayed. Rate limited.

### GET /api/v1/webhooks/:webhookId/deliveries
**Owner.** Deliveries to this webhook, each with its `attempts`. Query `status`, `limit`.

---

## Built-in test receiver

### POST /api/v1/hooks/:token
**Public, addressed by an unguessable token** (the URL of a webhook created with `builtinReceiver`). This is where PortalOps itself delivers. It verifies the signature, rejects stale timestamps, de-duplicates event ids, and answers according to the receiver's mode: `200` (`{ received: true, duplicate }`), `401` for a bad signature, `500` / `400` / a held connection and `504` for the failure modes. Unknown tokens are a uniform `404`. Bodies over 256 KB are `413`; the history is capped at 100 requests per receiver.

### GET /api/v1/webhooks/:webhookId/receiver
**Owner.** `{ mode, requests: [...] }`: the latest 50 requests the receiver saw (event id, attempt, signature result, outcome). Signatures and secrets are never stored.

### PATCH /api/v1/webhooks/:webhookId/receiver
**Owner.** Body `{ "mode": "ok" | "fail500" | "fail400" | "timeout" }`. Use it to rehearse retries and replay.

---

## Automations

### POST /api/v1/projects/:projectId/automations
**Owner.** Body `{ "name", "triggerEventName"?, "triggerContract"?, "endpointId" }`. `201`. `422` if `endpointId` is not a webhook in this project. See [Concepts](../guides/concepts.md#automations).

### GET /api/v1/projects/:projectId/automations
**Owner.** `[{ id, projectId, name, triggerEventName, triggerContract, endpointId, enabled, createdAt }]`.

### PATCH /api/v1/automations/:automationId
**Owner.** Body `{ "enabled": boolean }`.

### DELETE /api/v1/automations/:automationId
**Owner.** `{ "ok": true }`.

---

## Delivery diagnostics

### GET /api/v1/deliveries/:deliveryId/diagnosis
**Owner or API key (read).** Why a delivery failed, derived only from the attempts PortalOps recorded:
`{ rules: { summary, cause, confidence, facts, fixes, replay }, evidence, ai: { available, model } }`. `rules` is deterministic and always there.
`evidence` is **exactly what an AI explanation would be given**: the event name and finality, the destination's host and path (no credentials, no query
string, opaque path tokens hidden), the retry settings, and up to eight attempts with status, error code, duration and a reply snippet of at most 300
characters with secrets redacted. It never contains webhook secrets or the event payload. `404` for a delivery that is not yours.

### POST /api/v1/deliveries/:deliveryId/diagnosis/ai
**Owner or API key (write).** Asks a Claude model to explain the failure from that same evidence: `{ explanation: { summary, likelyCause, suggestedFixes, missingEvidence }, source: "model", model, rules, evidence }`. `503 ai_unavailable` when the server has no Anthropic key (`ANTHROPIC_API_KEY`); `502 ai_failed` if the model service fails (provider details are not forwarded; the rule-based diagnosis still works); `429` at 10 per minute. Suggestions are text for a person to review; nothing is applied.

---

## API keys

### POST /api/v1/projects/:projectId/api-keys
**Session.** Body `{ "name", "scope": "read" | "write", "expiresInDays" }`. `scope` defaults to `read`. `expiresInDays` is 1 to 365; **omitted means 90 days**, and `null` means the key never expires. `201` with the key record (including `expiresAt`) **and the one-time `key`** (`pops_…`). `409 key_limit` at 10 active keys. Only a hash is stored. A key past its expiry is refused with `401 api_key_expired`.

### GET /api/v1/projects/:projectId/api-keys
**Session.** `[{ id, name, scope, prefix, createdAt, lastUsedAt, revokedAt, expiresAt }]` (`expiresAt` is null for a key that never expires). The full key is never shown again.

### DELETE /api/v1/api-keys/:keyId
**Session.** Revokes the key immediately. `{ "ok": true }`.

---

## Operations data

### GET /api/v1/projects/:projectId/logs
**Owner.** Recent operational log lines for the project (`limit` ≤ 500): ingestion, deliveries, configuration changes. Credentials are redacted before they are stored.

### GET /api/v1/projects/:projectId/audit
**Session.** The last 100 security-relevant actions on the project (who did what, when). API keys cannot read it.
