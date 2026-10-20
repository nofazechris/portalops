#!/usr/bin/env node
// PortalOps MCP server over stdio. Configure it in Claude (see docs/guides/claude-setup.md):
//
//   claude mcp add portalops -e PORTALOPS_API_URL=https://… -e PORTALOPS_API_KEY=pops_… -- node --no-warnings=ExperimentalWarning packages/mcp/main.ts
//
// PORTALOPS_API_KEY and PORTALOPS_API_URL are read from the environment (and from ./.env.local / ./.env if present).
// Without a key the example tools still work and the others explain how to get one.
// IMPORTANT: stdout is the protocol channel: this process must never print anything else to it. Diagnostics go to stderr.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PortalOps } from "../sdk/index.ts";
import { createPortalOpsMcpServer } from "./server.ts";

const cwd = process.cwd();
for (const f of [".env.local", ".env"]) if (existsSync(resolve(cwd, f))) try { process.loadEnvFile(resolve(cwd, f)); } catch { /* unreadable env file: ignore */ }

const apiKey = (process.env.PORTALOPS_API_KEY || "").trim();
const baseUrl = (process.env.PORTALOPS_API_URL || "").trim();
let portal: PortalOps | null = null;
if (apiKey) {
  try {
    portal = new PortalOps({ apiKey, baseUrl: baseUrl || undefined });
  } catch (e) {
    // Report the problem without ever echoing the key.
    console.error(`portalops-mcp: the API settings are invalid: ${e instanceof Error ? e.message.replace(apiKey, "[key]") : "unknown error"}`);
  }
}
console.error(`portalops-mcp: ${portal ? `connected to ${baseUrl || "(PORTALOPS_API_URL)"}` : "no API key configured: only the example tools are available"}`);

const server = createPortalOpsMcpServer({ portal, cwd, dashboardUrl: baseUrl || undefined });
await server.connect(new StdioServerTransport());
