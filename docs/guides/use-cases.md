# Use cases and recipes

What people build with PortalOps, with working patterns for each. All recipes assume you have already
[registered a contract and created a webhook](quickstart.md), and that your receiver verifies the signature and de-duplicates on the event
id (see [Receiving webhooks](webhooks.md)). The examples use the Quest board, Token and Bounty contracts from
[Contracts and examples](contracts-and-examples.md), but they apply to any contract.

## 1. Notify a chat when something happens

**Goal:** post to Discord or Slack when a quest is completed.

**Setup:** register the contract, create a webhook with the filter `QuestCompleted`.

```ts
app.post("/portal-events", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try { event = constructEvent(process.env.PORTALOPS_WEBHOOK_SECRET!, req.body, req.header("portalops-signature")); }
  catch { return res.sendStatus(400); }
  if (await alreadyHandled(event.id)) return res.sendStatus(200);

  const { questId, participant } = event.data.payload as { questId: string; participant: string };
  await fetch(process.env.DISCORD_WEBHOOK_URL!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `Quest #${questId} completed by ${participant}` }),
  });
  await markHandled(event.id);
  res.sendStatus(200);
});
```

Why it is reliable: if Discord or your server is down, PortalOps retries; if it ultimately fails, you replay it from the dashboard.

## 2. Credit a user's balance (money-like actions)

**Goal:** when tokens arrive at a deposit address, credit the user in your database.

**The rule that matters:** act only when the event is **finalized**. Earlier statuses can still be reorganised away.

```ts
const e = event.data;
if (e.eventName !== "Transfer") return res.sendStatus(200);
if (e.finalityStatus !== "finalized") return res.sendStatus(200);   // not final yet: do nothing, see below
await db.transaction(async (tx) => {
  const inserted = await tx.query("INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING", [event.id]);
  if (inserted.rowCount === 0) return;                                 // already credited
  await tx.query("UPDATE balances SET amount = amount + $1 WHERE address = $2", [e.payload.value, e.payload.to]);
});
res.sendStatus(200);
```

A webhook fires when an event is first captured (usually `included`), so a deposit will normally arrive *before* it is final. Two clean ways to
handle that:

- **Replay later:** when your receiver sees a non-final event it returns `200` and stores the id as "pending". A small job replays pending
  events a few minutes later (`POST /api/v1/events/:id/replay`); the replayed body carries the **current** status.
- **Look it up:** on each webhook, read the event's current status from the API (`GET /api/v1/events/:id`) and act when it reads `finalized`.

Never credit on `included` or `confirmed` for anything you cannot undo.

## 3. Keep your own database in sync

**Goal:** mirror contract activity into Postgres for your app's pages.

- Create a webhook with no filter (all events) or a filter per table you maintain.
- In the receiver, `INSERT … ON CONFLICT (event_id) DO NOTHING`, keyed by the event id.
- To **backfill** after launching the receiver, replay or re-list history through the API:

```ts
for await (const e of portal.events.iterate({ finality: "finalized" })) {
  await upsert(e.id, e.eventName, e.payload, e.blockNumber);
}
```

Because the event id is deterministic and stored once, running the backfill twice changes nothing.

## 4. React to a specific user or token

**Goal:** only events involving one address.

PortalOps filters by **event name and contract**, not by argument values, so filter in your receiver:

```ts
if (event.data.payload.to?.toLowerCase() !== MY_ADDRESS) return res.sendStatus(200);
```

To limit the *volume* PortalOps delivers, narrow the webhook to the event name (for example `Transfer`) and, if you operate several
contracts, register only the relevant ones in this project.

## 5. Route different events to different services

**Goal:** `BountyPosted` goes to the matching service, `BountyApproved` to the payments service.

Create one webhook per service with its own filter (or use [automations](dashboard-tour.md#automations)). A delivery is created per event
and webhook, so each service gets exactly the events it asked for, with its own retries and history.

## 6. Rehearse failures before they happen

**Goal:** be sure your receiver survives your own bad day.

1. Create a webhook with the **built-in test receiver**.
2. Set its mode to **Fail with HTTP 500** (Webhooks → the receiver).
3. Replay an event and watch the delivery flow: attempt, backoff, attempt, … failed.
4. Set it back to **Healthy**, replay again: delivered, same event id.

You have now seen exactly what your production system will do when your server is down, without risking anything.

## 7. Drive PortalOps from code or from Claude

- **From code:** the [TypeScript SDK](sdk.md) registers contracts, creates webhooks, lists and replays events with a project-scoped key.
- **From Claude:** [Set up with Claude](claude-setup.md) lets you say "watch this contract and send transfers to my API" in plain language.
- **From CI:** use a `write` key to create a webhook and send a test delivery as a smoke test after deploying your receiver.

## 8. Monitor a contract you do not own

**Goal:** watch a public contract (a token, a marketplace) you want to react to.

Register its address with the right ABI. If it matches a standard shape you can use the [Token example's ABI](contracts-and-examples.md); if
it does not, capture it **without an ABI** first: every event is stored as raw topics and data, and you can add the ABI later (new events
decode from then on). The public explorer already shows undecoded events for every contract on the chain, signed out.

## Patterns that apply everywhere

| Pattern | Why |
|---|---|
| Verify the signature on the **raw body** before anything else | Proves the request is from PortalOps and untampered |
| De-duplicate on the event id in durable storage | Retries and replays resend the same id |
| Answer `2xx` quickly, work afterwards | Slow responses time out and are retried |
| Act on money-like events only when `finalized` | Earlier statuses can be reorganised |
| Keep the signing secret in an environment variable or secrets manager | Never in source control, never in logs |
| Replay after fixing, do not re-trigger the chain | Replay re-sends the stored event; the transaction is never repeated |
