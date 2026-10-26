import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PortalOpsError, type PortalOps, type Webhook } from "../sdk/index.ts";
import { getExample, listExamples } from "../examples/catalog.ts";
import { isGitIgnored, prepareSecretFile, resolveSecretFile, saveSecret } from "./secrets.ts";

/**
 * PortalOps for Claude (Model Context Protocol).
 *
 * Lets an assistant set up and operate event tracking for a Portaldot contract: pick an example or register your own, create a
 * signed webhook, send a test delivery, look at events, replay failures. Everything goes through the public REST API with a
 * project API key, so it can do exactly what that key can do and nothing more.
 *
 * Design rules:
 *  - Secrets never enter the conversation. The API key comes from the environment; a webhook's signing secret (shown once by the
 *    API) is written to a local env file and only a masked preview is returned.
 *  - Tools say what they changed, and read-only tools are marked as such so the client can skip approval prompts for them.
 *  - Failures come back as readable instructions ("create a write key"), not stack traces.
 */

export interface McpDeps {
  /** The API client, or null when no key is configured (read-only example tools still work). */
  portal: PortalOps | null;
  /** Where "create an API key" points. */
  dashboardUrl?: string;
  /** Working directory that secrets files must stay inside. */
  cwd: string;
  version?: string;
}

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const problem = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

const NO_KEY = (dashboard?: string) =>
  "No PortalOps API key is configured, so I can't change or read your project yet.\n" +
  `1. In the PortalOps dashboard${dashboard ? ` (${dashboard})` : ""} open Settings, then API keys, and create a key (choose "write" so I can set things up).\n` +
  "2. Put it in your environment as PORTALOPS_API_KEY (and PORTALOPS_API_URL for the server's address), then restart this MCP server.\n" +
  "Do not paste the key into this chat.";

/** Turns an SDK error into something the user can act on. */
export function explain(e: unknown, dashboard?: string): CallToolResult {
  if (e instanceof PortalOpsError) {
    const unauthorized = "The API key was rejected (wrong, revoked or expired). Create a new one in Settings → API keys and update PORTALOPS_API_KEY.";
    const readOnly = "This key is read-only, so it can't change anything. Create a key with the write scope in Settings → API keys.";
    const hints: Record<string, string> = {
      invalid_api_key: unauthorized,
      unauthenticated: unauthorized,
      insufficient_scope: readOnly,
      session_required: "That action is only available in the dashboard (signed in), not with an API key.",
      rate_limited: `Slow down: the API asked to retry${e.retryAfterSeconds ? ` in ${e.retryAfterSeconds}s` : " shortly"}.`,
      network_error: "The PortalOps server could not be reached. Check PORTALOPS_API_URL and that the server is running.",
      timeout: "The PortalOps server did not answer in time. Try again.",
      contract_exists: "That contract is already registered in this project. Use it as is.",
      no_endpoints: "This project has no enabled webhook yet: create one with portalops_create_webhook.",
      receiver_unavailable: "The built-in receiver isn't available on this server (it needs a public API URL). Use your own HTTPS endpoint instead.",
      validation_failed: "The request was invalid: " + ((e.details ?? []).map((d) => `${d.path || "input"}: ${d.message}`).join("; ") || e.message),
    };
    const hint = hints[e.code] ?? (e.status === 401 ? unauthorized : "");
    return problem(`${e.code} (HTTP ${e.status}): ${e.message}${hint ? "\n" + hint : ""}${e.status === 401 && dashboard ? `\nDashboard: ${dashboard}` : ""}`);
  }
  return problem(e instanceof Error ? e.message : String(e));
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "A 0x-prefixed 20-byte contract address");

export function createPortalOpsMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "portalops", version: deps.version ?? "0.1.0" }, {
    instructions:
      "PortalOps tracks events from Portaldot V3.0 testnet contracts and delivers them to webhooks. " +
      "To set a developer up: (1) portalops_setup_status to see where they are, (2) portalops_list_examples or ask for their contract address, " +
      "(3) portalops_register_contract, (4) portalops_create_webhook, (5) portalops_send_test_delivery. " +
      "Never ask for or accept private keys, API keys or webhook secrets in the conversation: they belong in environment variables and local env files.",
  });

  const run = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try { return text(await fn()); } catch (e) { return explain(e, deps.dashboardUrl); }
  };
  const withKey = async (fn: (p: PortalOps) => Promise<unknown>): Promise<CallToolResult> => {
    if (!deps.portal) return problem(NO_KEY(deps.dashboardUrl));
    const p = deps.portal;
    return run(() => fn(p));
  };

  const READ = { readOnlyHint: true, openWorldHint: false } as const;

  // ------------------------------------------------------------------------------------------------ examples (no key)
  server.registerTool("portalops_list_examples", {
    title: "List example contracts",
    description: "Ready-made example contracts a developer can deploy and track right away (quest board, token, bounty board, arena game), with the events each emits. No API key needed.",
    annotations: READ,
  }, async () => text(listExamples()));

  server.registerTool("portalops_get_example", {
    title: "Get an example contract",
    description:
      "Details of one example: what each event means, a sample payload, the deploy command and a ready-to-use Node.js webhook receiver. " +
      "The Solidity source, ABI and bytecode are large, so they are only included when asked for. No API key needed.",
    inputSchema: { id: z.string().describe('Example id: "quest", "token", "bounty" or "arena"'), include: z.array(z.enum(["source", "abi", "bytecode"])).optional() },
    annotations: READ,
  }, async ({ id, include }) => {
    const ex = getExample(id);
    if (!ex) return problem(`Unknown example "${id}". Available: ${listExamples().map((e) => e.id).join(", ")}.`);
    const { source, abi, bytecode, ...rest } = ex;
    const want = new Set(include ?? []);
    return text({ ...rest, ...(want.has("source") ? { source } : {}), ...(want.has("abi") ? { abi } : {}), ...(want.has("bytecode") ? { bytecode } : {}) });
  });

  // ------------------------------------------------------------------------------------------------ status / diagnosis
  server.registerTool("portalops_setup_status", {
    title: "Check setup progress",
    description:
      "Shows how far this project's setup is (network, contract, webhook, first event, first delivery) and the single best next step. " +
      "Also works without an API key: it then explains how to get one. Start here.",
    annotations: READ,
  }, async () => {
    if (!deps.portal) return text({ ready: false, steps: [{ step: "api_key", done: false, how: NO_KEY(deps.dashboardUrl) }] });
    return run(async () => {
      const p = deps.portal!;
      const [ov, contracts, hooks, failed] = await Promise.all([p.project.overview(), p.contracts.list(), p.webhooks.list(), p.deliveries.list({ status: "failed", limit: 5 })]);
      const s = ov.setup;
      const steps = [
        { step: "network", done: s.networkConnected, detail: `${ov.network.network}: ${ov.network.connection}, head block ${ov.network.headBlock ?? "unknown"}` },
        { step: "contract", done: s.contractAdded, detail: contracts.map((c) => `${c.name ?? "contract"} ${c.address} (${c.events.length ? c.events.join(", ") : "no ABI: logs are stored undecoded"})`) },
        { step: "webhook", done: s.webhookConfigured, detail: hooks.map((h) => `${h.id} → ${h.builtinReceiver ? "built-in test receiver" : h.url}${h.enabled ? "" : " (disabled)"}`) },
        { step: "first_event", done: s.firstEventReceived, detail: `${ov.metrics.eventsReceived} events captured` },
        { step: "first_delivery", done: s.firstDeliverySucceeded, detail: `${ov.metrics.delivered} delivered, ${ov.metrics.failed} failed, ${ov.metrics.retrying} retrying` },
      ];
      const next: string[] = [];
      if (!s.networkConnected) next.push("The network check is failing: confirm the PortalOps server can reach the Portaldot RPC.");
      else if (!s.contractAdded) next.push("Register a contract: portalops_register_contract (try an example via portalops_list_examples).");
      else if (!s.webhookConfigured) next.push("Create a webhook: portalops_create_webhook (use builtinReceiver for a no-backend test).");
      else if (!s.firstEventReceived) next.push("Waiting for the first event. Make a transaction on the contract, or widen the start block. Ingestion: " + ov.network.ingestion + (ov.network.lagBlocks ? `, ${ov.network.lagBlocks} blocks behind` : "") + ".");
      else if (!s.firstDeliverySucceeded) next.push("Send a test delivery: portalops_send_test_delivery, then check failed deliveries.");
      if (failed.length) next.push(`${failed.length}+ failed deliveries: see portalops_failed_deliveries, fix the receiver, then portalops_replay_event.`);
      return { project: ov.project.name, progress: `${s.completed}/${s.total}`, steps, nextSteps: next.length ? next : ["Everything is set up. Use portalops_list_events to watch activity."], serverHint: ov.nextAction };
    });
  });

  // ------------------------------------------------------------------------------------------------ contracts
  server.registerTool("portalops_register_contract", {
    title: "Track a contract",
    description:
      "Starts tracking a deployed contract. Either pass `example` (an example id: its ABI is filled in for you) or your own `abi`; without an ABI, events are stored undecoded. " +
      "Then checks that code exists at the address. Changes the project.",
    inputSchema: {
      address: addressSchema,
      name: z.string().max(80).optional(),
      example: z.string().optional().describe("Use the ABI of an example contract (quest, token, bounty, arena), when the deployed contract is a copy of it"),
      abi: z.array(z.record(z.string(), z.unknown())).optional().describe("The contract ABI array"),
      startBlock: z.number().int().nonnegative().optional().describe("Capture history from this block (default: the last ~1,000 blocks)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ address, name, example, abi, startBlock }) => withKey(async (p) => {
    if (example && abi) throw new Error("Pass either `example` or `abi`, not both.");
    let useAbi = abi as Record<string, unknown>[] | undefined;
    let label = name;
    if (example) {
      const ex = getExample(example);
      if (!ex) throw new Error(`Unknown example "${example}". Available: ${listExamples().map((e) => e.id).join(", ")}.`);
      useAbi = ex.abi as Record<string, unknown>[];
      label ??= ex.title;
    }
    const c = await p.contracts.add({ address, ...(label ? { name: label } : {}), ...(useAbi ? { abi: useAbi } : {}), ...(startBlock !== undefined ? { startBlock } : {}) });
    const check = await p.contracts.test(c.id).catch(() => null);
    return {
      contract: { id: c.id, address: c.address, name: c.name, events: c.events },
      codeFoundOnChain: check?.codeFound ?? "unknown",
      note: check ? check.note : "Could not check the address on chain.",
      next: check && !check.codeFound ? "No code at that address on the connected network: confirm the contract is deployed on the Portaldot V3.0 testnet." : "Create a webhook next: portalops_create_webhook.",
    };
  }));

  // ------------------------------------------------------------------------------------------------ webhooks
  server.registerTool("portalops_create_webhook", {
    title: "Create a webhook",
    description:
      "Creates a signed webhook. Use `builtinReceiver: true` for a hosted test receiver (no backend needed) or `url` for your own HTTPS endpoint. " +
      "Pick which events to receive with `events` (empty = all). The signing secret is shown by the API only once, so it is saved to a local env file " +
      "(default .env.portalops in the working directory) and only a masked preview is returned: the secret never appears in this conversation. Changes the project.",
    inputSchema: {
      url: z.url().optional().describe("Your HTTPS endpoint. Leave out when using builtinReceiver."),
      builtinReceiver: z.boolean().optional(),
      events: z.array(z.string()).optional().describe('Event names such as ["Transfer"]. Empty or omitted = every event.'),
      description: z.string().max(200).optional(),
      secretsFile: z.string().optional().describe('Env file for the signing secret, inside the working directory. Default ".env.portalops".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ url, builtinReceiver, events, description, secretsFile }) => withKey(async (p) => {
    if (!!url === !!builtinReceiver) throw new Error("Pass exactly one of `url` or `builtinReceiver: true`.");
    // Prove the secret has somewhere to go BEFORE creating the webhook: the API shows the secret only once.
    const target = resolveSecretFile(deps.cwd, secretsFile);
    prepareSecretFile(target);
    const hook = await p.webhooks.create({ ...(url ? { url } : { builtinReceiver: true }), ...(events?.length ? { eventFilter: events } : {}), ...(description ? { description } : {}) });
    const saved = saveSecret(target, hook.id, hook.secret);
    const { secret: _omit, ...safe } = hook;
    return {
      webhook: safe as Webhook,
      secret: { savedTo: target.display, variable: saved.variable, preview: saved.preview, note: "The full secret is in that file, not in this conversation. Load it in your receiver as an environment variable." },
      ...(isGitIgnored(deps.cwd, target) ? {} : { warning: `${target.display} is not listed in .gitignore. Add it before committing, or the signing secret will be published.` }),
      next: hook.builtinReceiver ? "Run portalops_send_test_delivery to see a signed delivery arrive." : "Verify the signature in your receiver (portalops_get_example gives a ready-made one), then run portalops_send_test_delivery.",
    };
  }));

  server.registerTool("portalops_send_test_delivery", {
    title: "Send a test delivery",
    description: "Sends one signed test request to a webhook and reports the receiver's response. It is not stored as a chain event. Contacts the webhook's URL.",
    inputSchema: { webhookId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ webhookId }) => withKey(async (p) => {
    const r = await p.webhooks.test(webhookId);
    return { ...r, meaning: r.ok ? "Delivered and acknowledged: the signing and the path to your endpoint work." : "Not acknowledged. Check the URL is reachable from the PortalOps server, returns 2xx, and verifies the signature with this webhook's secret." };
  }));

  // ------------------------------------------------------------------------------------------------ events & deliveries
  server.registerTool("portalops_list_events", {
    title: "List captured events",
    description: "Newest-first events captured for this project, with their latest delivery status. Filter by event name, finality (included, confirmed, finalized, orphaned) or delivery state.",
    inputSchema: {
      event: z.string().optional(),
      finality: z.enum(["included", "confirmed", "finalized", "orphaned"]).optional(),
      delivery: z.enum(["pending", "retrying", "delivered", "failed"]).optional(),
      q: z.string().optional().describe("Search tx hash, contract address, event name or event id"),
      limit: z.number().int().min(1).max(50).default(10),
    },
    annotations: READ,
  }, async ({ event, finality, delivery, q, limit }) => withKey(async (p) => {
    const page = await p.events.list({ ...(event ? { event } : {}), ...(finality ? { finality } : {}), ...(delivery ? { delivery } : {}), ...(q ? { q } : {}), limit });
    return { total: page.total, shown: page.items.length, events: page.items.map((e) => ({ id: e.id, event: e.eventName, contract: e.contractAddress, block: e.blockNumber, finality: e.finalityStatus, delivery: e.delivery, payload: e.payload })) };
  }));

  server.registerTool("portalops_get_event", {
    title: "Get one event with its delivery history",
    description: "One event with every delivery attempt: status codes, durations and the receiver's (sanitised) response. Use it to see why a delivery failed.",
    inputSchema: { eventId: z.string() },
    annotations: READ,
  }, async ({ eventId }) => withKey((p) => p.events.get(eventId)));

  server.registerTool("portalops_failed_deliveries", {
    title: "List failed deliveries",
    description: "Deliveries that exhausted their retries and are waiting for a fix and a replay.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    annotations: READ,
  }, async ({ limit }) => withKey(async (p) => (await p.deliveries.list({ status: "failed", limit })).map((d) => ({ deliveryId: d.id, eventId: d.event.id, event: d.event.eventName, endpointId: d.endpointId, attempts: d.attemptCount, lastError: d.lastError, lastResponseStatus: d.lastResponseStatus }))));

  server.registerTool("portalops_replay_event", {
    title: "Replay an event",
    description:
      "Re-sends a STORED event to one webhook (or all enabled ones). The chain is not touched and the event is unchanged; receivers should de-duplicate on the event id. " +
      "Use after fixing a receiver that was failing. Contacts the webhook URL.",
    inputSchema: { eventId: z.string(), webhookId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ eventId, webhookId }) => withKey((p) => p.events.replay(eventId, webhookId ? { endpointId: webhookId } : {})));

  // ------------------------------------------------------------------------------------------------ guided prompt
  server.registerPrompt("set_up_portalops", {
    title: "Set up PortalOps for my contract",
    description: "A guided, no-jargon walkthrough: pick or register a contract, create a webhook, verify a delivery.",
    argsSchema: { contractAddress: z.string().optional(), goal: z.string().optional() },
  }, ({ contractAddress, goal }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
          "Set up PortalOps event tracking for me, step by step, in plain language.\n" +
          (contractAddress ? `My contract address: ${contractAddress}\n` : "I don't have a contract yet: offer me the example contracts.\n") +
          (goal ? `What I want to build: ${goal}\n` : "") +
          "\nUse the PortalOps tools: portalops_setup_status first, then register the contract (use the matching example's ABI if it is a copy of an example), " +
          "create a webhook (built-in test receiver unless I give you a URL), send a test delivery, and show me the result. " +
          "If I need a receiver, write one from portalops_get_example's handler. Never ask me to paste private keys, API keys or secrets into this chat; " +
          "if something is missing, tell me which environment variable to set.",
      },
    }],
  }));

  return server;
}
