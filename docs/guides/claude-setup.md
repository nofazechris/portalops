# Set up with Claude

Instead of clicking through the dashboard, you can ask Claude to do the setup. PortalOps ships an **MCP server** (Model Context Protocol:
the standard way to give an assistant tools). With it, Claude can show you the example contracts, register your contract, create a signed
webhook, send a test delivery, look at events and replay failures, in plain conversation.

```
You:     Track my token contract 0x… and send transfers to my API at https://api.myapp.dev/portal.
Claude:  (checks setup status → registers the contract with the Token ABI → creates the webhook →
          saves the signing secret to .env.portalops → sends a test delivery)
         Done. The test delivery returned 200. Add PORTALOPS_WEBHOOK_SECRET from .env.portalops to your server.
```

## What it can and cannot do

| Can | Cannot (by design) |
|---|---|
| List and explain the example contracts, hand you a ready webhook receiver | Hold or ask for your **private keys**: deploying a contract is a command you run yourself |
| Register a contract (with an example's ABI or your own) | See your **API key** or webhook **secrets** in the conversation (see below) |
| Create webhooks, send test deliveries | Create accounts or projects, manage API keys, or read the audit log (a key cannot do those) |
| Show events, delivery history and failures; replay events | Do anything its API key's scope does not allow: a read-only key can only look |

## 1. Create an API key

In the dashboard: **Settings → API keys → New key**. Choose **write** if you want Claude to set things up, **read** if you only want it to look.
The key (`pops_…`) is shown **once**. Do not paste it into a chat.

## 2. Add the server to Claude

The server runs on your machine and talks to your PortalOps server over HTTPS using that key.
From a checkout of this repository:

### Claude Code

```bash
claude mcp add portalops \
  --env PORTALOPS_API_URL=https://portalops.example.com \
  --env PORTALOPS_API_KEY=pops_your_key_here \
  -- node --no-warnings=ExperimentalWarning packages/mcp/main.ts
```

Or create a project-level `.mcp.json` (this repository git-ignores it) that reads the key from **your shell environment**, so the file contains no secret:

```json
{
  "mcpServers": {
    "portalops": {
      "command": "node",
      "args": ["--no-warnings=ExperimentalWarning", "packages/mcp/main.ts"],
      "env": {
        "PORTALOPS_API_URL": "https://portalops.example.com",
        "PORTALOPS_API_KEY": "${PORTALOPS_API_KEY}"
      }
    }
  }
}
```

### Claude Desktop

Edit the config file (Settings → Developer → Edit Config) and add, with the **absolute** path to this repository:

```json
{
  "mcpServers": {
    "portalops": {
      "command": "node",
      "args": ["--no-warnings=ExperimentalWarning", "C:/path/to/portalops/packages/mcp/main.ts"],
      "env": {
        "PORTALOPS_API_URL": "https://portalops.example.com",
        "PORTALOPS_API_KEY": "pops_your_key_here"
      }
    }
  }
}
```

Restart Claude. Requires **Node 24+** (the server runs TypeScript directly) and `npm install` in the repository.

> No key yet? The server still starts: the example tools work, and `portalops_setup_status` tells you how to get a key.

## 3. Ask

Start with: *"Set up PortalOps for my contract."* There is also a built-in prompt, **set_up_portalops**, that runs the whole guided flow
(in Claude Code it appears as the slash command `/mcp__portalops__set_up_portalops`; in Claude Desktop, look for it in the `+` menu).

Good requests:

- "What example contracts are there? I want something for a marketplace."
- "Register the Bounty board example at `0x…` and send `BountyApproved` to the built-in test receiver."
- "Why is my webhook failing?" (it reads failed deliveries and the receiver's responses)
- "Replay the last failed event now that I've fixed my server."
- "Write me a receiver for the token example in Express."

## The tools

| Tool | What it does | Changes things? |
|---|---|---|
| `portalops_setup_status` | Where you are (network, contract, webhook, first event, first delivery) and the next step | no |
| `portalops_list_examples` | The example contracts and their events | no |
| `portalops_get_example` | One example: event meanings, sample payloads, deploy command, receiver code (`include` adds `source`, `abi`, `bytecode`) | no |
| `portalops_register_contract` | Track a contract; `example` fills in a ready ABI; then checks code exists at the address | yes |
| `portalops_create_webhook` | Signed webhook to your URL or the built-in receiver; filter by event names | yes |
| `portalops_send_test_delivery` | One signed test request; reports the response | contacts your URL |
| `portalops_list_events` | Newest events; filter by name, finality, delivery state, or search | no |
| `portalops_get_event` | One event with every delivery attempt | no |
| `portalops_failed_deliveries` | Deliveries waiting for a fix | no |
| `portalops_replay_event` | Re-send a stored event; the chain is not touched | contacts your URL |

Tools that only read are marked **read-only**, which lets Claude clients run them without asking each time; the others are marked as changing things, and clients normally ask you before running them.

## How secrets are handled

The design goal: **no secret ever enters the conversation**, because conversations are logged, cached and shared.

- The **API key** lives only in the MCP server's environment. Tools never return it, and error messages never echo it.
- A webhook's **signing secret** is shown by the API exactly once. `portalops_create_webhook` receives it and writes it straight to a local
  env file, by default `.env.portalops` in the working directory, as `PORTALOPS_WEBHOOK_SECRET=…`. Claude only sees a masked preview
  (`whsec_…ab12`) and the file name. A second webhook is saved under a different variable name instead of overwriting the first.
- The file is chosen from `.env`-style names **inside the project directory** only (`../x.env`, `config.json`, absolute paths and similar
  are refused), and the file is created and proven writable **before** the webhook is created, so the one-time secret cannot be lost.
- If the file is not covered by your `.gitignore`, the tool warns you. Add it before you commit.
- Deploying contracts needs a private key. That is a command you run in your own terminal with your own `.env`; Claude is told never to
  ask for keys and the tools have no way to receive one.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Claude says no API key is configured | Set `PORTALOPS_API_KEY` (and `PORTALOPS_API_URL`) in the server's environment and restart Claude |
| "The API key was rejected" | The key is wrong or revoked. Create a new one (Settings → API keys) |
| "This key is read-only" | Create a **write** key |
| "could not be reached" | Check `PORTALOPS_API_URL` (must be https, except `localhost`) and that the server is up: `curl …/api/v1/health` |
| The built-in receiver "isn't available" | The server needs `PORTALOPS_API_PUBLIC_URL` set to its public https URL, or use your own endpoint |
| Nothing shows in Claude's tool list | Run `node --no-warnings=ExperimentalWarning packages/mcp/main.ts` by hand: it should print `portalops-mcp: …` to stderr and wait. Node must be 24+ |
| Where are the server's diagnostics? | On stderr (never stdout, which carries the protocol). Most Claude clients keep an MCP log you can open |

## For developers

- Code: `packages/mcp/` (`server.ts` builds the server from an injected API client, `main.ts` is the stdio entry, `secrets.ts` is the file logic).
- It is a thin layer over the public API and the [SDK](sdk.md): everything it does is one a key could do by hand, and it adds no privileges.
- Tests (`packages/mcp/mcp.test.ts`) drive it through a real MCP client against the real API, including the guarantee that neither the key
  nor a secret appears in any tool output.
- The SDK and the MCP server are both publish-ready (`npm run sdk:build`, `npm run mcp:build`; `npm pack --dry-run` in each package folder). Until they are on npm, use them from a checkout. Once `@portalops/mcp` is published, `npx -y @portalops/mcp` replaces the `node …/packages/mcp/main.ts` command above.
- Step-by-step: [Tutorial 4](../tutorials/with-claude.md).
