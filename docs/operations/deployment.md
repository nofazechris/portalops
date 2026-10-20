# Deploying PortalOps

PortalOps is two processes sharing one database (SQLite by default, PostgreSQL when `DATABASE_URL` is set; see [Database](#database)):

| Process | What it does | Port |
|---|---|---|
| **api** | REST API, serves the built web app, hosts the built-in test receiver | 8787 |
| **worker** | ingests chain events, runs webhook deliveries, writes a heartbeat | none |

Both are the same Docker image (`Dockerfile`); `docker-compose.yml` wires them to a shared volume.

> **Status of this document:** the Dockerfile and compose file were written on a machine without Docker, so they have **not been
> run locally**. CI (`.github/workflows/ci.yml`) builds the image and smoke-tests the container on every push; treat the first CI
> run as the real verification. Everything the container runs (API, worker, static serving, health, backups) has automated tests.

## Quick start (single host)

```bash
# create .env.production by hand (git-ignored; NOT your dev .env, which holds deploy-script private keys). It needs:
#   WEBHOOK_ENCRYPTION_KEY (32 random bytes hex), PORTALOPS_PUBLIC_URL (https), PORTALOPS_TRUSTED_PROXY_HOPS
#   (all variables: docs/reference/environment.md)
docker compose up -d --build
curl http://127.0.0.1:8787/api/v1/ready         # 200 once the worker has reported
```

The API binds to `127.0.0.1:8787` on the host. Put a TLS-terminating reverse proxy in front.

### Reverse proxy (Caddy example)

```caddyfile
portalops.example.com {
    encode zstd gzip
    request_body { max_size 1MB }
    reverse_proxy 127.0.0.1:8787
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
}
```

Caddy appends the real client address to `X-Forwarded-For`, so keep `PORTALOPS_TRUSTED_PROXY_HOPS=1`. With nginx, set
`proxy_set_header X-Forwarded-For $remote_addr;` (replace, don't append) and the same hop count. **If you run without a proxy, set it to `0`.**
The API also sends the CSP (including `frame-ancestors 'none'`), `X-Frame-Options`, `nosniff` and, when `PORTALOPS_PUBLIC_URL` is https, HSTS.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `WEBHOOK_ENCRYPTION_KEY` | yes | 32 random bytes (hex/base64). Encrypts webhook secrets at rest. **Back it up with the database**: without it stored secrets cannot be decrypted. |
| `PORTALOPS_PUBLIC_URL` | yes (compose) | The https URL users visit. Enables `Secure` cookies and HSTS; also the allowed browser origin. |
| `PORTALOPS_API_PUBLIC_URL` | for the built-in receiver | URL at which the **worker** reaches the API. In compose: `http://api:8787` (internal network). Outside compose it must be a URL the worker can reach; it is validated like any webhook target. |
| `PORTALOPS_TRUSTED_PROXY_HOPS` | recommended | Reverse proxies in front of the API (default 0). |
| `PORTALDOT_EVM_RPC_URL`, `PORTALDOT_EVM_CHAIN_ID` | defaults set | The chain endpoint and the chain id it must report. |
| `DATABASE_URL` | optional | `postgres://user:pass@host:5432/db` selects PostgreSQL for **both** processes. Unset = SQLite at `PORTALOPS_DB_PATH`. |
| `PORTALOPS_DB_PATH` | set by image | `/data/portalops.sqlite` on the `portalops-data` volume. |
| `PORTALOPS_STATIC_DIR`, `PORTALOPS_API_HOST`, `PORTALOPS_API_PORT` | set by image | Serve the web app from `dist`, listen on all interfaces inside the container, port 8787. |
| `PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS` | **never in production** | Dev only. The API refuses to start if it is combined with an https URL. |

## Operating it

**Health and monitoring**

- `GET /api/v1/health`: liveness. 200 while the API answers; the body includes the worker's state (`ok` / `stale` / `never`).
- `GET /api/v1/ready`: readiness. **503** if the worker has not reported in the last 2 minutes. Alert on this one.
- The dashboard's network panel shows ingestion lag and a *stalled* state; `GET /api/v1/public/status` exposes `worker`, head block and connection.
- Logs: `docker compose logs -f api worker`. Both processes log how they ended (`uncaughtException`, signal name, `exit code=…`).
  See `docs/operations/crash-investigation.md`.

**Backups.** `npm run db:backup` (or the same script inside the container) writes a consistent copy with `VACUUM INTO`, verifies its
integrity, and refuses to overwrite. It is safe while everything is running.

```bash
docker compose exec api node scripts/backup-db.mjs /data/backup-$(date +%F).sqlite   # then copy it off the volume
```

Back up the `.env.production` encryption key separately from the database (a backup without the key cannot decrypt webhook secrets).
**Restore:** stop `api` and `worker`, replace `/data/portalops.sqlite` with the backup, delete `portalops.sqlite-wal` and `-shm`, start again.

**Upgrades.** `git pull && docker compose up -d --build`. Schema changes are additive (`CREATE TABLE IF NOT EXISTS` plus guarded
`ALTER`); take a backup first. Run exactly one worker per database; a delivery claim lease prevents double sends if two overlap briefly.

## Database

One store interface, two backends, the same SQL (`packages/database/sql-store.ts`), and the same test suite runs against both.

| | SQLite (default) | PostgreSQL |
|---|---|---|
| Select | `PORTALOPS_DB_PATH` (file) | `DATABASE_URL=postgres://…` (API and worker must use the same one) |
| Schema | `schema.sql`, applied at start | `schema.pg.sql`, applied at start under an advisory lock, so API and worker may boot together |
| Hosts | API and worker on one host, local volume | any hosts that can reach the server |
| Backup | `npm run db:backup` (`VACUUM INTO`) | `pg_dump` / your provider's snapshots; `db:backup` refuses a Postgres URL |
| Transactions | `BEGIN IMMEDIATE`, one writer at a time | one pinned pooled connection per transaction |

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build   # adds a postgres service and sets DATABASE_URL
```

Notes: timestamps are ISO-8601 `TEXT` in both backends (identical ordering and comparison semantics); equal-timestamp rows are ordered
by `id`. There is **no data migration tool** between backends: pick one per deployment. Use TLS to a remote server
(`?sslmode=require`) and a dedicated least-privilege role (the app needs `CREATE` on its schema on first start, then only DML).

Running the tests against PostgreSQL: `npm run test:pg` starts a throwaway server (the `embedded-postgres` dev dependency) and gives
every test its own schema. Set `TEST_DATABASE_URL` to use a server you already have (this is what CI does).

## Limits you should know about

- **SQLite** keeps this to one host. PostgreSQL removes that limit for the database (see [Database](#database)); the in-memory rate limiters still assume one API process.
- Rate limiters are in-process memory: correct for one API process, not for several.
- No email verification, password reset or OAuth; account recovery is manual.
- Backfill: a contract registered after a project's cursor exists is captured from that point forward.

## Production checklist

See `docs/security/review.md` (deployment checklist) and confirm:

1. HTTPS end to end; `PORTALOPS_PUBLIC_URL` is https.
2. `.env.production` has **no** `PORTALDOT_*_PRIVATE_KEY` and no `PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS`.
3. `PORTALOPS_TRUSTED_PROXY_HOPS` matches your proxy chain.
4. `GET /api/v1/ready` is 200 and monitored; backups run on a schedule and a restore has been rehearsed.
5. `npm audit --omit=dev` is clean (CI enforces it).
