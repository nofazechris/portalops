# Tutorial 1: Your first webhook

**Goal:** see a real Portaldot event arrive as a signed webhook, then break a delivery on purpose and replay it. No code, no server.

## 1. Create a project

Sign up (or sign in) and create a project. The name is only a label. The first project opens the **Quick start**.

## 2. Watch a contract

Step 1 of the Quick start is **What to watch**. Choose **PortalOps Quest board**: a contract we deployed on the testnet. Click
**Start watching**. PortalOps now reads that contract's events from the chain, decodes them with the Quest board's ABI and stores them.

## 3. Choose where events go

Step 2 is **Where events go**. Pick **Test receiver**. It is an endpoint PortalOps hosts for you, so there is nothing to run. Click
**Create webhook**.

## 4. Watch it work

Step 3 shows a checklist and a live timeline. Click **Send a test delivery**. The receiver reports that the **signature was verified**: the
request carried an HMAC-SHA256 signature that only PortalOps could produce.

Open **Events** and click one (for example `QuestCompleted`). You will see:

- the **decoded payload** (named arguments instead of hex),
- the **block** it came from,
- its **finality**: *included*, then *confirmed*, then *finalized* once the network finalizes the block,
- every **delivery attempt** with the response.

## 5. Break it, then fix it

This loop is the whole point of PortalOps.

1. Open the webhook and set the test receiver to **fail with 500**.
2. On an event, press **Replay**. The delivery fails and PortalOps schedules a **retry with backoff**. The attempt list shows each try.
3. Set the receiver back to **OK**.
4. Press **Replay** again. It is delivered. It is the **same event id**, and the chain was never touched.

Because the id is stable, your own receiver can de-duplicate on it, which is what makes retries and replays safe.

## What you learned

Capture, decode, finality, signed delivery, retry and replay, all on real testnet data.

**Next:** [Build a game feed](game-feed.md), or [do this with Claude](with-claude.md).
