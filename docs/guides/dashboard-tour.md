# Dashboard tour

Every screen of the PortalOps dashboard, what it shows, and when you would use it. Open `/app` (sign in, or browse the public explorer
signed out) and follow along.

## The frame around every screen

- **Sidebar (left).** Overview, then Workspace (Events, Webhooks, Automations, Contracts), Operations (Replay, Logs, Diagnostics), Developer
  (AI Setup, API/SDK) and Settings. The small connection light at the bottom shows whether the Portaldot RPC is reachable and the latest
  block number.
- **Collapse the sidebar.** The panel icon at the top left of the top bar (or the `[` key) shrinks the sidebar to icons. Your choice is
  remembered. Hover an icon to see its name.
- **The logo** takes you to the Overview.
- **Project switcher (top, next to the panel icon).** Your projects are listed with a check on the current one. **+ New project** creates
  another. Each project has its own contracts, events, webhooks and keys.
- **Network pill (top right).** "Portaldot V3.0 Testnet · Connected" is checked live. If it turns red the chain is unreachable and no new
  events will arrive until it recovers; nothing already captured is lost.
- **Account menu (top right).** Your email and *Sign out*.
- **Email banner.** If you signed up with a password and have not confirmed your address, a banner at the top offers *Resend email*.

Documentation is not inside the dashboard: it lives on the public site at `/docs`, linked from the landing page.

## Signed out: the public explorer

Without an account, `/app` is a read-only **public testnet explorer**: live events from every contract on the chain, undecoded, with
finality and the live timeline. It exists so you can see what PortalOps does before signing up. The note at the top has **Sign in** and
**Create account** buttons.

## First visit: create your first project

A new account lands on **Create your first project**. A project is your workspace: its contracts, events, webhooks and API keys live in it.
Creating the first one opens the **Quick start** (below). Later projects skip it.

## Quick start

Three steps, about two minutes. A faint line at the top confirms the network connection; it only becomes a warning if something is wrong.

1. **What to watch.** Choose a ready-made contract: *PortalOps Quest board* (deployed by us on the testnet) or *A busy token* (a real
   contract from another team, with constant activity), or **My own contract** (paste an address, then either pick which example it is a
   copy of, paste an ABI, or leave it to capture raw data; optionally a start block). **Start watching** registers it.
   A collapsible *"New to this? Three words you need"* defines contract, event and webhook.
2. **Where events go.** *Test receiver* (recommended; nothing to run) or *My own server* (an `https://` address). Optionally *Only send some
   events* to filter by name. **Create webhook.** The signing secret is shown once; the test receiver does not need it.
3. **Watch it work.** A five-item checklist ticks off as things happen: network connected, watching a contract, a webhook is ready, first
   event captured, first delivery succeeded. **Send a test delivery** proves the path works (and, for the test receiver, shows the signature
   was verified). The live timeline shows events arriving.

You can come back to it from the setup card on the Overview any time you have unfinished steps.

## Overview

Your project at a glance.

- **Four numbers:** events received (and when the last one arrived), deliveries succeeded (and how many are in flight), deliveries failed
  (red when something needs a replay), and active webhooks.
- **Live timeline.** Events as they are captured, newest first, grouped under their block ("Block #145,103 · 2 deep"). A small three-part
  meter on each event shows its finality at a glance, with its delivery status on the right. New arrivals flash and are tagged *new*.
  **Pause** freezes the list so you can read it (it counts what arrives meanwhile); the tiny chart shows events per minute over the last
  15 minutes. Click an event to open it.
- **Network panel.** Connection, head block, ingestion health (*healthy*, *stalled*, *not started*) with how many blocks behind it is, and
  when something was last ingested.
- **Setup card.** The checklist with the next best step, and a button to continue the Quick start.
- **Recent delivery failures** (when there are any), with a shortcut to the Replay Centre.

## Events

Every captured event, newest first.

- **Filters:** All, Delivered, Failed, Retrying, Finalized, Orphaned. **Search** matches a transaction hash, contract address, event name
  or event id. Pages of 25.
- **Columns:** the event name (or "Undecoded log" when no ABI matched), contract, transaction, block, **chain status** and **delivery
  status**.

### One event

Click any row.

- **Finality panel.** A three-step progression: *Seen → Confirmed → Finalized*, with a depth bar that fills as blocks are added ("7 of 12
  blocks deep: 5 more until confirmed") and a plain-language sentence about what you can safely do at this point. An *orphaned* event shows
  a red branch: its block was replaced by a reorganisation.
- **Details:** contract, transaction hash (with copy), block, block hash, when PortalOps first saw it, the network.
- **Decoded payload** (the arguments by name) and the **raw log** (topics and data) with copy buttons.
- **Actions:** *Replay to all endpoints*, or *Diagnose failures*. Replay re-sends the stored event with the same id; the chain is not touched.
- **Delivery history.** For every delivery of this event, a flow diagram: *Queued → Attempt 1 (status, time) → backoff wait → Attempt 2 →
  … → Delivered or Failed*. A scheduled retry shows a live countdown ("next retry in 12s"); a failure says why ("Not retried: HTTP 401 is a
  permanent error" or "Retries exhausted after 5 attempts"). *Attempt details* lists each response.

## Webhooks

The list shows each webhook's address (or "built-in receiver"), status and filter. **Create webhook** takes an https address (or the
built-in receiver), an optional description and an optional list of event names to receive (empty means everything, including undecoded logs).

### One webhook

- **Send test delivery**, **Pause/Enable**, **Rotate secret** (the old secret stops working immediately; the new one is shown once) and
  **Delete**.
- **Configuration:** the event filter and the **retry policy** as set for this webhook: maximum attempts, the backoff (first delay, longest
  delay, always with jitter) and the per-attempt timeout. The signing secret is stored encrypted and cannot be viewed, only rotated. (The API
  also lets you set how long PortalOps keeps trying; see the [API reference](../reference/api.md).)
- **Recent deliveries** with their attempts.
- **Built-in test receiver** (only for those webhooks): shows what the receiver saw (signature verified, outcome) and a **mode** switch:
  *Healthy*, *Fail with HTTP 500*, *Fail with HTTP 400*, or *Time out*. This is how you rehearse failures: flip it, replay an event, watch
  the retries, flip it back.

## Automations

Rules of the form "when an event named *X* (optionally from contract *Y*) is captured, deliver it to webhook *Z*". A rule delivers to its
webhook even if that webhook's own filter would not match. Each rule can be switched on and off or deleted. Rules run when events are
ingested and show up in the Logs.

## Contracts

The contracts being watched in this project: address, name, whether it has an ABI, and which event types that ABI declares. **Register
contract** adds one (address, optional name, optional ABI, optional start block). **Test contract** is a read-only check that code exists at
the address on the connected network.

## Replay Centre

A focused place to recover from failures. It lists deliveries that **failed** or are still **retrying**. Pick one, press **Replay**, and
PortalOps re-sends the stored event and shows the result live (delivered, retrying or failed, with the HTTP status). Use it after fixing
whatever was wrong on your side. The blockchain transaction is never resubmitted.

## Logs

A searchable operational log of ingestion passes, delivery attempts, retries, replays and configuration changes. Credentials are redacted
before anything is stored. Use it to answer "what did the system actually do?".

## Diagnostics

Answers "**Why did this delivery fail?**" for the failed deliveries in the project. It lists the facts PortalOps recorded (status codes,
timings, error codes), states a **likely cause** with a confidence level (for example that your server answered 401 so the signature check is
probably failing), and gives a short list of **what to check**. That analysis is rule-based on the recorded evidence, always available and free.

If the server operator has turned on AI explanations, an **Explain with Claude** button appears. Press **See exactly what is sent** first: it
shows the evidence a Claude model would receive (event name, destination host and path, status codes, timings and a short reply snippet),
which never includes your signing secrets, API keys, query strings or the event payload. The written explanation comes back marked as
AI-written, for you to check against your own logs; nothing is changed automatically. Buttons jump to the Logs or to Replay.

## AI Setup

Generates a prompt for a coding agent (Claude Code, Codex) that wires up webhook handling in *your* codebase. For the chat-based setup that
acts directly on PortalOps, see [Set up with Claude](claude-setup.md).

## API / SDK

The REST API the dashboard itself uses, a TypeScript SDK snippet and the signature-verification snippet. The full reference is in the docs:
[REST API](../reference/api.md), [SDK](sdk.md).

## Settings

- **Project details** (name, description).
- **Environment:** the network and chain id, head block, and a *Test connection* button.
- **API keys.** Create a `read` or `write` key (shown once, stored only as a hash), see when each was last used, and revoke with one click.
  A key works inside this project only and can never create projects or other keys.
- **Audit log.** Who did what and when: sign-ins, webhook changes, key creation, replays.

## Where to go from here

- The words used above are defined in [Core concepts](concepts.md).
- If a delivery fails, start at [Troubleshooting](troubleshooting.md).
- To build something, see [Use cases and recipes](use-cases.md).
