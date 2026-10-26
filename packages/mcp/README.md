# @portalops/mcp

Claude (MCP) server for [PortalOps](https://github.com/nofazechris/portalops): the middleware that watches Portaldot contracts and delivers
their events as signed, retried, replayable webhooks. With this server Claude can register your contract, create a webhook, send a signed
test, show events and replay failures, in plain conversation. **No secret ever enters the chat**: the API key stays in the server's
environment and a webhook's signing secret is written straight to a local env file.

## Use it

Create a **write** API key in the PortalOps dashboard (Settings → API keys), then:

```bash
claude mcp add portalops \
  --env PORTALOPS_API_URL=https://portalops.onrender.com \
  --env PORTALOPS_API_KEY=pops_your_key_here \
  -- npx -y @portalops/mcp
```

For Claude Desktop, add this to its config file:

```json
{
  "mcpServers": {
    "portalops": {
      "command": "npx",
      "args": ["-y", "@portalops/mcp"],
      "env": { "PORTALOPS_API_URL": "https://portalops.onrender.com", "PORTALOPS_API_KEY": "pops_your_key_here" }
    }
  }
}
```

Then ask: *"Set up PortalOps for my contract."* Eleven tools: setup status, list/get example contracts, register contract, create webhook,
send test delivery, list/get events, failed deliveries, diagnose a failed delivery, replay. Without a key the example tools still work.

Full guide: https://portalops.onrender.com/docs (Set up with Claude). Requires Node 20.12+. MIT licensed.
