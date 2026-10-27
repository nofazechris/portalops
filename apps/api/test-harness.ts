import http from "node:http";
import { randomBytes } from "node:crypto";
import { makeTestStore } from "../../packages/database/testing.ts";
import { normalizeEvmLog } from "../../packages/event-engine/normalize.ts";
import { createApp } from "./app.ts";
import { RateLimiter } from "./http.ts";

/**
 * The REAL API (createApp over a real HTTP server and a fresh store on the suite's backend) with a signed-in "dashboard" session
 * that creates a project and API keys exactly as a customer would. Shared by the SDK and MCP tests, so a change to the API that
 * breaks either fails here instead of in a customer's integration.
 */
export async function startApi(limits?: Record<string, RateLimiter>, allOverrides: Record<string, unknown> = {}) {
  const { verify, ...overrides } = allOverrides; // `verify` is a dependency of the app, not part of its config
  const store = await makeTestStore();
  const key = randomBytes(32);
  const config = { networkId: "portaldot-v3-testnet", networkLabel: "Portaldot V3.0 Testnet", chainId: 420420777, encryptionKey: key, allowedOrigins: [], cookieSecure: false, sessionTtlMs: 3_600_000, allowPrivateWebhookTargets: true, maxProjectsPerUser: 5, receiverBaseUrl: null as string | null, receiverTimeoutHoldMs: 200, ...overrides };
  const handler = createApp({
    store, config, verify: verify as undefined | typeof import("../../packages/verification/verify.ts").verifySource,
    network: { check: async () => ({ chainIdVerified: true, reportedChainId: 420420777, headBlock: 5000, latencyMs: 2, error: null }), getCode: async (a) => (a.endsWith("1") ? "0x6080" : "0x") },
    rateLimits: { auth: new RateLimiter(1000, 60_000), global: new RateLimiter(100_000, 60_000), actions: new RateLimiter(1000, 60_000), ...limits },
  });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  config.receiverBaseUrl = base;

  // A signed-in "dashboard" session creates the project and keys, exactly as a customer would.
  let cookie = "";
  const call = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(base + p, { method: m, headers: { ...(b ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const s = r.headers.get("set-cookie"); if (s) cookie = s.split(";")[0];
    return (await r.json() as { data: any }).data;
  };
  await call("POST", "/api/v1/auth/signup", { email: `sdk${Date.now()}${Math.random()}@example.com`, password: "sdk-test-password-123" });
  const project = await call("POST", "/api/v1/projects", { name: "SDK" });
  const mkKey = async (scope: "read" | "write") => (await call("POST", `/api/v1/projects/${project.id}/api-keys`, { name: scope, scope })).key as string;

  const seed = async (n: number, addr = "0x" + "11".repeat(20)) => {
    const e = normalizeEvmLog({ address: addr, topics: ["0xaa"], data: "0x", blockNumber: n, blockHash: "0xb" + n, transactionHash: "0xtx" + n, transactionIndex: 0, logIndex: 0, removed: false }, { projectId: project.id, chainId: 420420777 });
    await store.insertEvent(e);
    return e;
  };
  return { base, store, key, project, mkKey, seed, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
