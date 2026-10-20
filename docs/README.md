# PortalOps documentation

PortalOps watches smart contracts on the Portaldot V3.0 testnet and delivers what happens on them to your application as signed,
retried, replayable webhooks. These pages are the full manual.

## Start here

| I want to… | Read |
|---|---|
| Get my first event delivered in ten minutes | [Quickstart](guides/quickstart.md) |
| Let Claude set everything up for me | [Set up with Claude](guides/claude-setup.md) |
| Understand the model (events, finality, deliveries, replay) | [Concepts](guides/concepts.md) |
| Set up sign-in: GitHub, email verification, password reset | [Accounts](guides/accounts.md) |
| Receive webhooks safely (Node, Python, Go, PHP) | [Webhooks](guides/webhooks.md) |
| Track a contract, or start from an example | [Contracts and examples](guides/contracts-and-examples.md) |
| Call the API from code | [TypeScript SDK](guides/sdk.md) and the [REST API reference](reference/api.md) |
| Something is not working | [Troubleshooting](guides/troubleshooting.md) |

## Reference

- [REST API](reference/api.md): every endpoint, request, response and error code.
- [Configuration](reference/environment.md): every environment variable.
- [Architecture](architecture/overview.md): the modules, the data flow and how to extend it (a new chain, store or delivery target).
- [Network compatibility](architecture/network-compatibility.md): what was verified about the Portaldot V3.0 testnet.

## Running it

- [Put it live (Neon + Render)](operations/live-deploy.md)
- [Deployment, backups and upgrades](operations/deployment.md)
- [Security review](security/review.md) and [threat notes](security/)
- [Crash investigation](operations/crash-investigation.md) and [demo script](operations/demo-script.md)

## Conventions used in these docs

- `evt_…` is an **event id**, `ep_…` a **webhook (endpoint) id**, `dlv_…` a **delivery id**, `prj_…` a **project id**, `pops_…` an **API key**,
  `whsec_…` a **webhook signing secret**.
- Examples use the placeholder host `https://portalops.example.com`; use your own server's address.
- Everything marked *verified* was checked against the real testnet or by the automated tests; *not yet verified* is called out where it applies.
