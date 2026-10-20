# Security review

Scope: everything in this repository as of 2026-10-19 (API, worker, delivery engine, store, built-in receiver, React app,
scripts). Method: manual code review against the PRD §16 requirements, adversarial probing of the SSRF guard with
evasion-style inputs, `npm audit`, a secret scan of the tree, and writing tests that fail without each fix.
Not covered: penetration testing of a deployed instance, TLS/hosting configuration, the Portaldot node itself.

93 automated tests pass (63 at the time of this review) (`npm test`).

## Findings and status

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | **SSRF guard allowed IPv6 forms that embed internal IPv4 addresses.** `64:ff9b::7f00:1` (NAT64), `2002:a9fe:a9fe::1` (6to4), `2001::/32` (Teredo) and `::7f00:1` (IPv4-compatible) passed validation. On dual-stack or NAT64 hosts these reach loopback, RFC1918 and the cloud metadata address. | **Fixed.** Rewrote address classification around a real IPv6 parser: embedded IPv4 is judged by the embedded address, mechanisms with no legitimate webhook use are blocked, unparseable input fails closed. Tests cover 30+ forms. |
| 2 | Medium | **Deploy-script private keys were loaded into the API and worker processes** (same `.env`). Anything in `process.env` is visible to every dependency and child process. | **Fixed.** `loadServiceEnv` drops `PORTALDOT_DEPLOYER_PRIVATE_KEY` / `PORTALDOT_PARTICIPANT_PRIVATE_KEY` right after loading. Only the deploy/interact scripts ever see them. |
| 3 | Medium | **Event IDs did not include the project**, so a second project watching the same contract had its events silently dropped as duplicates (data loss / integrity). Found while testing with real chain data. | **Fixed.** Project is part of the event identity. Regression test added. |
| 4 | Medium | **Delivery runner had no claim**: two worker processes (or a restart overlapping a slow attempt) could send the same delivery twice. | **Fixed.** Atomic lease (`claimDelivery`); an unfinished lease expires and the delivery is retried. Delivery is at-least-once; consumers de-duplicate on the event id. |
| 5 | Medium | **Local-dev escape hatch for private webhook targets could be left on in a public deployment**, re-opening finding 1's attack surface. | **Fixed.** The API refuses to start if `PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS=1` is combined with an `https` public URL. |
| 6 | Medium (dev) | **Vite 5 dev-server advisories** (path traversal in optimized-deps `.map` handling, any website could read dev-server responses via esbuild). | **Fixed.** Upgraded to Vite 8. Not part of the shipped bundle, but developers run it on localhost. |
| 7 | Low | Credential redaction in logs had a gap (`Authorization: Bearer …` left the token; `whsec_` secrets kept their prefix + value). | **Fixed** earlier in the build; covered by tests. |
| 8 | Low | scrypt cost N=2^15. | **Raised to N=2^16**, parameters stored per hash so old hashes still verify. Stored parameters are bounds-checked so a corrupted row cannot request unbounded memory. |
| 9 | Low | No clickjacking/XSS hardening headers on the SPA. | **Mitigated.** Production build injects a strict CSP (`script-src 'self'`, `connect-src 'self'`, no inline script); dev/preview servers send `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`. `frame-ancestors` cannot be set from a meta tag, so the production web server must also send it (see checklist). |
| 10 | Low | Rate limiting keyed on the socket address would put every user behind a reverse proxy into one bucket, while trusting `X-Forwarded-For` blindly would let attackers dodge limits. | **Fixed.** `PORTALOPS_TRUSTED_PROXY_HOPS`: 0 ignores the header entirely; N uses the hop appended by your own proxy. |
| 11 | Low | Node's default HTTP timeouts allow slow-client (slowloris) connections for minutes. | **Fixed.** 15 s headers, 60 s request, 16 KiB header cap. Expired/revoked sessions are purged hourly. |

## What was checked and found sound

- **Authorization:** every project-scoped and resource-scoped route resolves the owning project and returns **404, not 403**,
  for non-owners (no existence oracle). Tested across 20+ routes with a second user, anonymous callers, and the public demo project.
- **SQL injection:** all statements are parameterised; the few dynamic fragments (`SET` lists, `AND d.status = ?`) are built from fixed
  column names only. `LIKE` search input is escaped.
- **Sessions:** 256-bit random token, only its SHA-256 stored, `HttpOnly; SameSite=Strict`, `Secure` when served over https, revoked on logout, expiry enforced server-side.
- **Login:** same response and comparable timing for unknown email vs wrong password; per-IP and per-email rate limits.
- **CSRF:** state-changing requests with a foreign `Origin` are rejected; SameSite=Strict as second layer; JSON-only bodies.
- **Webhook secrets:** 256-bit, AES-256-GCM at rest, shown once, never returned by any read endpoint, absent from logs and receiver history. Signatures: HMAC-SHA256 over the raw body, constant-time compare, timestamp tolerance, independently verified test vector.
- **Outbound delivery:** DNS resolved once and the socket pinned to the vetted address (no rebinding window), redirects not followed, response size and time capped, response body sanitised before storage.
- **Built-in receiver:** 192-bit URL token (stored hashed), uniform 404 for unknown tokens, signature verified before any behaviour, 256 KiB body cap, per-token rate limit, history capped at 100 rows, bodies stored as truncated inert text.
- **Frontend:** no `dangerouslySetInnerHTML`, no `eval`, no third-party scripts; chain-derived strings are rendered as text. The only storage use is the selected project id.
- **Secrets in the repo:** none found. every `.env*` file is git-ignored and **no env file of any kind is committed, not even an example**; `npm run security:scan` (also a pre-commit hook and a CI step) enforces it.

## Accepted risks and known gaps

| Item | Why it is acceptable now / what would fix it |
|---|---|
| `npm audit`: `solc → tmp` (high, symlink write). | Dev-time compiler only, used through the JS API (`solc.compile`), never its CLI; not shipped. No upstream fix yet. |
| Signup reveals whether an email exists (409). | Inherent without email verification. Email verification and password reset are **not implemented** (no mail provider). |
| A per-email login limiter lets an attacker briefly lock a specific victim out (≈1 min windows). | Short, self-healing. A per-account lockout with notification is the production answer. |
| No MFA, no OAuth. | Out of scope for this stage; the docs say so rather than implying otherwise. |
| API keys: no expiry date, no per-key IP allow-list. | Keys are project-scoped, read/write, rate-limited, revocable, stored only as a SHA-256 hash and shown once. Expiry/rotation reminders are a reasonable next step. |
| Webhook ports are unrestricted for public IPs. | Only public addresses are reachable, so internal services are not exposed. A port allow-list (443/8443) is a cheap tightening if desired. |
| One static encryption key, no rotation tool. | Envelope format is versioned (`v1.`) so a rotation can be added without a data migration. |
| Delivery runner is sequential. | A slow endpoint delays others for up to its timeout. Bounded concurrency per endpoint is the fix. |
| SQLite file is unencrypted and not backed up. | Dev storage; production would use managed Postgres with encryption at rest. |
| Rate limiters are in-process memory. | Correct for one API process; use Redis when scaling out. |

## Deployment checklist (production)

1. Serve everything over **HTTPS**; set `PORTALOPS_PUBLIC_URL=https://…` (turns on `Secure` cookies and the allow-private interlock).
2. **Do not set** `PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS`. Set `PORTALOPS_API_PUBLIC_URL` to the public https URL the worker can reach (needed for the built-in receiver).
3. Behind a reverse proxy: set `PORTALOPS_TRUSTED_PROXY_HOPS` to the number of proxies, and have the proxy cap request size and send
   `Content-Security-Policy: frame-ancestors 'none'`, `Strict-Transport-Security`, and the headers in `vite.config.js`.
4. Provide `WEBHOOK_ENCRYPTION_KEY` from a secret manager; never commit `.env`. Deploy keys are for scripts only and must not be present on the API/worker host.
5. Run the worker as a single instance per database, or rely on the claim lease; back up the database.
6. Re-run `npm audit` and `npm test` in CI.
