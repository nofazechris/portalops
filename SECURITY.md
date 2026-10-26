# Security policy

PortalOps is **testnet software** with no real funds involved, and it has not had an external audit. It is still built as if it mattered: the
design and what was checked are in the [security review](docs/security/review.md).

## Reporting a vulnerability

Please report privately, not in a public issue:

- Use GitHub's **private vulnerability reporting** on this repository (Security tab → Report a vulnerability), or
- email the maintainer listed on the GitHub profile of [@nofazechris](https://github.com/nofazechris).

Include what you found, how to reproduce it, and what it lets an attacker do. We aim to acknowledge within 3 days and to fix or explain within 14.
Please give us that time before disclosing publicly; we are glad to credit you.

## What is in scope

The API, dashboard, worker, SDK (`@portalops/sdk`), Claude server (`@portalops/mcp`) and the deployment files in this repository. Of particular interest:
authentication and sessions (including two-factor), API-key handling, webhook signing and the SSRF guard on destination URLs, secret storage, rate limits,
cross-project access (we answer 404 rather than 403 to avoid revealing what exists), and anything that could put a secret into a log, an event payload or an AI prompt.

## What is out of scope

Denial of service by volume against the free hosted demo, findings that need a compromised machine or browser, and missing hardening that is already
listed under "Accepted risks and known gaps" in the security review.

## Never share

Private keys, seed phrases, signing secrets, API keys (`pops_…`) or `.env` files: not in a report, an issue or a screenshot. If you find one in this
repository or its history, tell us privately so it can be rotated.
