# Contributing to PortalOps

Thanks for helping make building on Portaldot easier. PortalOps is MIT licensed; contributions are welcome, from a typo to a new chain adapter.

## Set up (2 minutes)

You need **Node 24 or newer** (`nvm use` reads `.nvmrc`). Plain `npm` works on Windows, macOS and Linux.

```bash
git clone https://github.com/nofazechris/portalops.git && cd portalops
npm ci
npm test              # 220+ tests, about a minute
npm run typecheck
npm run verify:evidence   # optional: checks our on-chain claims against the public testnet RPC
```

To run the app locally (API, worker, web) see the [README](README.md#run-it-locally). A `.env` is git-ignored and a secret scan blocks any commit that
contains one or a key (`npm run security:install-hook` installs it as a git hook; CI runs it too).

## Where things live

| Area | Folder | Notes |
|---|---|---|
| EVM and native chain readers | `packages/chain-adapters` | one interface (`ChainAdapter`, `NativeChain`); a new chain is a new adapter |
| Decoding | `packages/event-engine` | Solidity ABI in `normalize.ts`, ink! metadata in `ink.ts` |
| Delivery | `packages/webhook-engine` | signing, retry policy, SSRF guard, runner |
| Storage | `packages/database` | one SQL store over SQLite and PostgreSQL; schemas in `schema.sql` and `schema.pg.sql` |
| API | `apps/api` | routes in `app.ts`; every route must be in `docs/reference/api.md` (a test enforces it) |
| Worker | `apps/worker` | ingestion passes and the delivery loop |
| Web app | `src` | React; docs are rendered from `docs/*.md` |

## Ground rules

- **Tests with the change.** Behaviour changes need a test; bug fixes need a test that fails without the fix. The suite is fast, keep it that way.
- **Docs are tested.** New env vars go in `docs/reference/environment.md`, new routes in `docs/reference/api.md`, new Claude tools in `docs/guides/claude-setup.md`, and
  every relative link must resolve. `npm test` tells you which is missing.
- **Evidence over claims.** If you say something works on the testnet, add the command or transaction that proves it. We would rather say "not verified" than guess.
- **No secrets, ever.** No keys, seed phrases or `.env` files in code, tests, docs, issues or screenshots. Test credentials are generated in the test.
- **Line endings are LF** (`.gitattributes` enforces it), so the committed contract artifacts match the Solidity on every platform.
- Changing a Solidity example? Run `npm run examples:build` and commit the regenerated `packages/examples/generated.json` (a test fails if it is stale).

## Good first contributions

- A receiver snippet in another language (Go, PHP and Python snippets are in the docs and are not all executed in CI: make one runnable and tested).
- An adapter for another Portaldot network or chain: implement `ChainAdapter`/`NativeChain`, register it in the worker, add a fake-chain test like `apps/worker/ingest.test.ts`.
- More Arena Lab challenges (`src/pages/arenaLab.js`): every challenge needs a reference solution that the tests prove passes, and a starter that fails.
- Anything marked "not verified" in the [field notes](docs/architecture/network-compatibility.md): reproduce it and send the evidence.

## Pull requests

Small and focused is best. Describe what changed and how you checked it; link the issue if there is one. CI runs the secret scan, typecheck, tests, the web
and SDK builds, and a production dependency audit.

Security problems: please do **not** open a public issue; see [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the [MIT license](LICENSE).
