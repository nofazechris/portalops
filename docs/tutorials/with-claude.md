# Tutorial 4: Set it all up with Claude

**Goal:** have Claude register a contract, create a signed webhook, watch events arrive and replay a failure, entirely in conversation. No
secret ever enters the chat.

## 1. Make a write key

In the dashboard: **Settings → API keys → New key**, scope **write**. The key (`pops_…`) is shown once. Do not paste it into a chat.

## 2. Connect Claude

The MCP server runs on your machine and is published on npm as `@portalops/mcp` (Node 20.12+, nothing to clone):

```bash
claude mcp add portalops \
  --env PORTALOPS_API_URL=https://portalops.onrender.com \
  --env PORTALOPS_API_KEY=pops_your_key_here \
  -- npx -y @portalops/mcp
```

For Claude Desktop, use the config snippet in [Set up with Claude](../guides/claude-setup.md).

## 3. Ask

> Set up PortalOps for my contract. What examples do you have?

Claude calls `portalops_setup_status` and `portalops_list_examples`, and explains the four examples (Quest board, Token, Bounty board,
Arena game). Then:

> Register the Arena game at `0x…` and send all its events to the built-in test receiver.

Claude calls `portalops_register_contract` (with the Arena ABI) and `portalops_create_webhook`. The signing secret goes straight to
`.env.portalops`; Claude only sees a masked preview.

> Send a test delivery.

`portalops_send_test_delivery` returns the receiver's answer, including whether the signature was verified.

## 4. Watch

> What happened in the last few minutes? Show me the battles.

Claude calls `portalops_list_events` filtered to `BattleResolved` and summarises winners, losers and finality. Ask for one event in detail
and `portalops_get_event` returns every delivery attempt.

## 5. Break it and replay

In the dashboard, set the test receiver to **fail with 500**, and trigger a new event. Then ask:

> Why is my webhook failing?

`portalops_failed_deliveries` shows the failed deliveries with the response each attempt got. Fix the receiver (set it back to **OK**) and:

> Replay the failed event now that it's fixed.

`portalops_replay_event` re-sends the stored event with the same id. The chain is not touched.

## What Claude cannot do

It cannot see your API key or any webhook secret, cannot deploy a contract (that needs a private key, and the tools have no way to receive
one), and cannot do anything the key's scope forbids: a **read** key only looks. Full list in [Set up with Claude](../guides/claude-setup.md).

**Next:** [Automate with the SDK](with-the-sdk.md).
