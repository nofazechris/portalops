# Judging demo script

A repeatable walkthrough that shows what is **genuinely live** and is explicit about what is not. Everything marked ⛔ needs our own
contract deployed on the public testnet, which is **blocked on a funded account** and has not been done.

## Before you start (2 min)

```bash
npm install      # then create a git-ignored .env with WEBHOOK_ENCRYPTION_KEY (docs/reference/environment.md)
npm run api        # terminal 1
npm run worker     # terminal 2
npm run dev        # terminal 3  → http://localhost:5173
```

Or run API and worker together: `node --no-warnings=ExperimentalWarning scripts/start-all.mjs`.

Check `curl localhost:8787/api/v1/ready` returns 200 (the worker is reporting). With a database URL set (`npm run db:check` verifies it), the same demo runs on PostgreSQL.

## 1. The public explorer: real data, no account (1 min)

Open `/app` while signed out. **Say:** "These are real logs from the Portaldot V3.0 testnet, captured by our worker. They belong to
other participants' contracts, so they are undecoded. Nothing here is mocked." Show the network pill (chain id verified, head block),
the **Live timeline** on the Overview (it refreshes every few seconds, groups events under their block with "N deep", flags new arrivals, and has a **Pause** button so you can talk over it), then open one event. The **Finality** panel shows *Seen → Confirmed → Finalized* with the depth bar filling ("7/12 deep, 5 more blocks"); `finalized` means the node's own finality signal passed it and we verified its block hash. If you can find an `orphaned` one, show the red branch: that is a reorganisation handled honestly.

## 2. Guided setup to a verified delivery (3 min)

Create an account → **Guided setup**. Walk the seven steps:

1. Network: verified against the live RPC (chain 420420777), not assumed.
2. Contract: register any testnet contract address (a real one from the explorer works) and an optional ABI.
3. Events → 4. Delivery: choose **Built-in test receiver** (no backend needed). Copy the one-time secret.
5. Test: **Send test delivery**: the receiver reports `signature verified ✓`.
6. Finish: the summary is honest; it shows "a real event was delivered" unchecked until one actually was.

## 3. Failure → retries → replay (3 min)

On the webhook page switch the receiver to **Fail with HTTP 500**. Send a test delivery (fails). From **Events**, open an event → **Replay**.
Open the event and watch the **Delivery history** flow draw itself: *Queued → Attempt 1 ✕ 500 → backoff 17s → Attempt 2 ✕ → … → Failed*, with a live countdown ("next retry in 12s") while it is retrying and the reason at the end ("Retries exhausted after 3 attempts", or "Not retried: HTTP 400 is a permanent error"). Expand **Attempt details** for response bodies and timings.
Switch the receiver back to **Healthy**, open **Replay Centre**, replay: `✓ Replay delivered`. **Say:** "Replay re-sent the *stored* event with the same id.
The transaction was never resubmitted, and the receiver de-duplicates on the event id."

## 4. Programmatic access (2 min)

Settings → **API keys** → create a *write* key. In a scratch script:

```ts
const portal = new PortalOps({ apiKey: process.env.PORTALOPS_API_KEY!, baseUrl: "http://localhost:8787" });
console.log((await portal.events.list({ finality: "finalized", limit: 3 })).items.map((e) => e.id));
```

## 4b. Examples and set-up-with-Claude (3 min)

In **Guided setup → Add contract** open **Start from an example**: pick *Token*, read the events tab (meaning, sample payload, typical use), then
**Webhook code** (a ready receiver) and **Deploy it** (exact commands). Click **Use this ABI**: the form fills itself. **Say:** "A developer who
has never written an ABI is one click from decoded events."

Then the Claude path (needs the MCP server configured, see `docs/guides/claude-setup.md`): ask *"What example contracts are there? Register the Token
example at 0x… and send transfers to the built-in test receiver."* Claude registers the contract with the right ABI, creates the webhook and sends a
test delivery. **Say:** "Notice what it did not do: it never saw my API key or the signing secret. The secret went to `.env.portalops`; Claude only got a masked preview."
If you have no deployed contract, run the same flow with any address: the tool reports honestly that no code was found there.

## 5. ⛔ Our own contract (blocked)

Once the deployer address is funded:

```bash
npm run contract:deploy              # dry run, then:
npm run contract:deploy -- --send
npm run contract:interact -- --send  # createQuest → completeQuest → issueReward
```

Register `docs/architecture/deployment.json`'s `contractAddress` with the ABI from `contracts/evm/artifacts/PortalQuest.json`.
Expected: the three events appear **decoded** (`QuestCreated`, `QuestCompleted`, `RewardIssued`), reach `finalized`, and are delivered.
Evidence to show a judge: the deployment tx hash and block in `deployment.json`, the transaction hashes in `evidence.json`, and the same hashes on the Events screen.
**Until this is done, do not claim our contract is deployed.**

## What not to claim

- The public Playground (create/complete quest buttons) does not exist yet; it needs the deployed contract and a rate-limited signer.
- No email verification, password reset or OAuth. The SDK is in the repo, not on npm. SQLite by default; PostgreSQL via `DATABASE_URL` (tested, but there is no migration tool between them).
- The three example contracts are compiled and tested but **not deployed by us** (same funding block). Do not call any of them "live on testnet".
- Docker, the Render blueprint and CI deploy were not run on a real host; the live URL exists only once you have deployed it.
- The Go and PHP receiver snippets in the docs were not executed here (Node and Python were).
- AI setup produces a prompt; PortalOps cannot verify what the agent did. A successful test delivery is the confirmation.

## If something fails live

| Symptom | Likely cause | Fix |
|---|---|---|
| Network pill red | RPC unreachable | the status is honest; show the explorer's last captured events, retry in a minute |
| No events appearing | worker not running | `curl /api/v1/ready` → 503; start `npm run worker` |
| Built-in receiver step fails | `PORTALOPS_API_PUBLIC_URL` unreachable from the worker | set it to the API's address as the worker sees it |
| Timeline shows old events as `Included` | the project has no registered contract, so the worker does not promote its events | register a contract, or use the public explorer for the finality demo |
| Delivery "retrying" for a long time | receiver left in a failure mode | switch it back to Healthy and replay |
