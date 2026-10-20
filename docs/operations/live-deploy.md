# Put PortalOps live (Neon + Render, about 20 minutes)

You end up with a public HTTPS URL that anyone can open: a read-only live explorer of the Portaldot V3.0 testnet, and sign-up with the
guided setup. The database is Neon (managed PostgreSQL); the app is one Render web service that runs the API, the web app and the worker.

Any host that runs a Docker image works the same way (Fly.io, Railway, a VPS with `docker compose`): the only differences are where you
type the environment variables.

## What stays secret

| Value | Where it goes | Never |
|---|---|---|
| Neon connection string (`DATABASE_URL`) | local `.env`, and the host's environment settings | in chat, in git, in a screenshot |
| `WEBHOOK_ENCRYPTION_KEY` | the host's environment settings, plus one offline backup | in git; do not change it later |
| Testnet deployer private key | local `.env` only, for deploying contracts from your machine | on the server at all: the live service never needs it |

If a secret ever lands somewhere it should not, rotate it (Neon: reset the role password; key: see below).

## 1. Check the database from your machine

1. In Neon, open your project, then **Connect**, and copy the connection string. Prefer the **direct** one (host without `-pooler`).
   Pooled works too (the schema lock is pooler-safe), but the app already pools connections itself.
2. Put it in `.env`:
   ```
   DATABASE_URL=postgres://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
   ```
3. Run:
   ```bash
   npm run db:check
   ```
   It connects, creates the tables, does a write/read/rollback round trip, and prints latency. It never prints the password.
   A suspended Neon database can take a few seconds to wake; run it again if the first try times out.

**Region:** put Render in the same region as Neon (for example both in `us-east`). Every request makes several queries, so
a database an ocean away makes the dashboard feel slow.

## 2. Put the code on GitHub

`.env`, `data/` and `backups/` are git-ignored; check with `git status` that no `.env*` file other than the two `*.example` files is listed.

## 3. Create the Render service

1. Render, **New**, **Blueprint**, pick the repository. It reads `render.yaml`.
2. Fill the three prompts:
   - `DATABASE_URL`: your Neon string.
   - `PORTALOPS_PUBLIC_URL`: `https://<service-name>.onrender.com` (the name you chose; you can edit it after the first deploy).
   - `PORTALOPS_API_PUBLIC_URL`: the same URL.
3. After the first deploy, open the service's **Environment** tab and **copy `WEBHOOK_ENCRYPTION_KEY` into your password manager**.
4. The plan is `free` in the blueprint. A free service sleeps when idle, and the worker sleeps with it (it catches up from its cursor on
   wake). Switch to a paid plan for an always-on demo, or run the worker as a separate always-on service.

## 4. Verify it end to end

| Check | Expected |
|---|---|
| `https://<url>/api/v1/health` | `{"ok":true,…}` |
| `https://<url>/api/v1/ready` | 200 once the worker has reported (up to ~1 minute after start) |
| `https://<url>/api/v1/public/status` | `connection: "connected"`, a head block, `worker: "ok"` |
| The site | the landing page, the live testnet explorer, sign-up |
| Sign up, **Guided setup**, add an example contract, create a built-in receiver webhook, **Send test delivery** | signature verified in the receiver |

## Operating it

- **Logs:** the service's Logs tab. Both processes log how they ended.
- **Backups:** Neon keeps history (point-in-time restore); also keep the encryption key backup. `npm run db:backup` is SQLite-only.
- **Rotating the encryption key:** not supported in place. Changing it makes stored webhook secrets unreadable; recreate the webhooks.
- **Moving to two services** (API and worker separately, to scale or isolate): the same image, the same `DATABASE_URL`, and
  `node --no-warnings=ExperimentalWarning apps/worker/main.ts` as the worker's command. Run exactly one worker.
- **Never** set `PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS` in production: the API refuses to start with it on an https URL.

## Limits to know about

- Rate limiters live in memory, so run one API instance.
- The built-in test receiver delivers through the public URL, so `PORTALOPS_API_PUBLIC_URL` must be reachable from the worker.
- Docker, the Blueprint and the CI deploy path were written and unit-tested here but have not been run on Render itself. The first deploy is the real test:
  if something fails, the service logs name the cause (`db:check` isolates database problems).
