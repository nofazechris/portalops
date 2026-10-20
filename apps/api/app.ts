import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import type { Store, ProjectRecord, ContractRecord } from "../../packages/database/store.ts";
import { decryptSecret, encryptSecret, generateWebhookSecret } from "../../packages/database/secrets.ts";
import { DEFAULT_RETRY_POLICY, type NormalizedEvent, type RetryPolicy, type WebhookEndpoint } from "../../packages/shared-types/index.ts";
import { getExample, listExamples } from "../../packages/examples/catalog.ts";
import { replayEvent } from "../../packages/webhook-engine/runner.ts";
import { sendWebhook } from "../../packages/webhook-engine/send.ts";
import { signHeader, SIGNATURE_HEADER, verifySignature } from "../../packages/webhook-engine/sign.ts";
import { BlockedTargetError, validateWebhookUrl, type GuardOptions } from "../../packages/webhook-engine/url-guard.ts";
import { clearedSessionCookie, dummyHash, hashPassword, hashToken, newSessionToken, SESSION_COOKIE, sessionCookie, verifyPassword } from "./auth.ts";
import { ApiError, clientIp, parseCookies, parseJsonBody, RateLimiter, readRaw, Router, sendJson, MAX_BODY_BYTES, type Ctx } from "./http.ts";

export interface NetworkCheck {
  chainIdVerified: boolean;
  reportedChainId: number | null;
  headBlock: number | null;
  latencyMs: number;
  error: string | null;
}

/** The slice of the chain the API needs. Injected so tests never touch the network. */
export interface NetworkProbe {
  check(): Promise<NetworkCheck>;
  getCode(address: string): Promise<string>;
}

export interface AppConfig {
  networkId: string;
  networkLabel: string;
  chainId: number;
  encryptionKey: Buffer;
  /** Origins allowed to make state-changing requests with a session cookie. Same-origin requests are always allowed. */
  allowedOrigins: string[];
  cookieSecure: boolean;
  sessionTtlMs: number;
  /** Local development only: lets webhooks target 127.0.0.1 / private ranges. Never enable on a public deployment. */
  allowPrivateWebhookTargets: boolean;
  /** Base URL at which the WORKER can reach this API (e.g. https://api.example.com). Enables the built-in test receiver; null disables it. */
  receiverBaseUrl: string | null;
  /** How long the receiver's "timeout" mode holds a connection before answering 504. */
  receiverTimeoutHoldMs?: number;
  /** Number of reverse proxies in front of the API (0 = none; X-Forwarded-For is ignored). */
  trustedProxyHops?: number;
  maxProjectsPerUser: number;
  now?: () => Date;
}

export interface AppDeps {
  store: Store;
  config: AppConfig;
  network: NetworkProbe;
  rateLimits?: { auth?: RateLimiter; global?: RateLimiter; actions?: RateLimiter; keys?: RateLimiter };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

const retryPolicyInput = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    baseDelayMs: z.number().int().min(1_000).max(3_600_000),
    maxDelayMs: z.number().int().min(1_000).max(86_400_000),
    maxAgeMs: z.number().int().min(60_000).max(7 * 86_400_000),
    timeoutMs: z.number().int().min(1_000).max(30_000),
  })
  .partial();

const schemas = {
  signup: z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(12, "At least 12 characters.").max(200) }),
  login: z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(200) }),
  project: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    networkId: z.literal("portaldot-v3-testnet").default("portaldot-v3-testnet"),
  }),
  projectPatch: z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).nullable().optional() }),
  contract: z.object({
    address: z.string().regex(ADDRESS, "Must be a 0x-prefixed 20-byte address."),
    name: z.string().trim().max(80).optional(),
    abi: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
    startBlock: z.number().int().min(0).optional(),
    deploymentTxHash: z.string().regex(HASH).optional(),
  }),
  webhook: z.object({
    url: z.string().trim().min(1).max(2048).optional(),
    builtinReceiver: z.boolean().default(false),
    description: z.string().trim().max(200).optional(),
    eventFilter: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    retryPolicy: retryPolicyInput.optional(),
    enabled: z.boolean().default(true),
  }),
  webhookPatch: z.object({
    url: z.string().trim().min(1).max(2048).optional(),
    description: z.string().trim().max(200).nullable().optional(),
    eventFilter: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    retryPolicy: retryPolicyInput.optional(),
    enabled: z.boolean().optional(),
  }),
  replay: z.object({ endpointId: z.string().min(1).max(64).optional() }),
  automation: z.object({
    name: z.string().trim().min(1).max(80),
    triggerEventName: z.string().trim().min(1).max(100).nullable().default(null),
    triggerContract: z.string().regex(ADDRESS).nullable().default(null),
    endpointId: z.string().min(1).max(64),
  }),
  automationPatch: z.object({ enabled: z.boolean() }),
  apiKey: z.object({ name: z.string().trim().min(1).max(60), scope: z.enum(["read", "write"]).default("read") }),
  receiverPatch: z.object({ mode: z.enum(["ok", "fail500", "fail400", "timeout"]) }),
  eventQuery: z.object({
    q: z.string().trim().max(200).optional(),
    contract: z.string().regex(ADDRESS).optional(),
    event: z.string().max(100).optional(),
    finality: z.enum(["included", "confirmed", "finalized", "orphaned"]).optional(),
    delivery: z.enum(["pending", "retrying", "delivered", "failed"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  }),
  deliveryQuery: z.object({ status: z.enum(["pending", "retrying", "delivered", "failed"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
  limitQuery: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
};

const notFound = () => new ApiError(404, "not_found", "Not found.");

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  try {
    return schema.parse(data ?? {});
  } catch (e) {
    if (e instanceof ZodError) {
      throw new ApiError(422, "validation_failed", "Request validation failed.", e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    throw e;
  }
}

export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, config, network } = deps;
  const now = config.now ?? (() => new Date());
  const authLimiter = deps.rateLimits?.auth ?? new RateLimiter(10, 60_000);
  const globalLimiter = deps.rateLimits?.global ?? new RateLimiter(600, 60_000);
  const actionLimiter = deps.rateLimits?.actions ?? new RateLimiter(60, 60_000);
  const keyLimiter = deps.rateLimits?.keys ?? new RateLimiter(600, 60_000);
  const guard: GuardOptions = { allowPrivate: config.allowPrivateWebhookTargets };
  const router = new Router();

  // ------------------------------------------------------------- helpers
  const requireUser = (ctx: Ctx): string => {
    if (!ctx.userId) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    return ctx.userId;
  };

  /** Account-level actions (creating projects, managing keys, reading the audit log) need a signed-in session, never an API key. */
  const sessionOnly = (ctx: Ctx): void => {
    if (ctx.apiKey) throw new ApiError(403, "session_required", "This action requires a signed-in session; API keys cannot do it.");
  };

  /**
   * Owners get full access. The public demo project is readable by anyone. Everything else is a 404, never a 403.
   * An API key acts for the project owner but only inside the one project it was issued for.
   */
  async function project(ctx: Ctx, id: string, mode: "read" | "write" = "write"): Promise<ProjectRecord> {
    const p = await store.getProject(id);
    if (!p) throw notFound();
    if (ctx.apiKey && p.id !== ctx.apiKey.projectId) {
      if (mode === "read" && p.kind === "public_demo") return p;
      throw notFound();
    }
    if (p.ownerId !== null && ctx.userId === p.ownerId) return p;
    if (mode === "read" && p.kind === "public_demo") return p;
    throw notFound();
  }

  /** Owner-only, even for read: logs, webhooks, deliveries and automations are never public. */
  const ownedProject = async (ctx: Ctx, id: string): Promise<ProjectRecord> => {
    const p = await project(ctx, id, "write");
    return p;
  };

  async function endpointFor(ctx: Ctx, endpointId: string): Promise<{ endpoint: WebhookEndpoint; project: ProjectRecord }> {
    const endpoint = await store.getEndpoint(endpointId);
    if (!endpoint) throw notFound();
    return { endpoint, project: await ownedProject(ctx, endpoint.projectId) };
  }

  const hashReceiverToken = (t: string) => createHash("sha256").update(t).digest("hex");
  const publicEndpoint = async (e: WebhookEndpoint) => ({ id: e.id, projectId: e.projectId, url: e.url, description: e.description, enabled: e.enabled, eventFilter: e.eventFilter, retryPolicy: e.retryPolicy, createdAt: e.createdAt, builtinReceiver: !!await store.getReceiverByEndpoint(e.id) });

  const eventView = (e: NormalizedEvent) => ({
    id: e.id, projectId: e.projectId, network: e.network, source: e.source, contractAddress: e.contractAddress,
    eventName: e.eventName, decoded: e.decoded, payload: e.payload, topics: e.topics, data: e.data,
    transactionHash: e.transactionHash, transactionIndex: e.transactionIndex, blockNumber: e.blockNumber, blockHash: e.blockHash,
    eventIndex: e.eventIndex, observedAt: e.observedAt, processingStatus: e.processingStatus, finalityStatus: e.finalityStatus,
  });

  const mergeRetryPolicy = (base: RetryPolicy, patch: Partial<RetryPolicy> | undefined): RetryPolicy => {
    const merged = { ...base, ...(patch ?? {}) };
    if (merged.maxDelayMs < merged.baseDelayMs) throw new ApiError(422, "validation_failed", "maxDelayMs must be at least baseDelayMs.");
    return merged;
  };

  async function checkWebhookUrl(url: string): Promise<void> {
    try {
      await validateWebhookUrl(url, guard);
    } catch (e) {
      if (e instanceof BlockedTargetError) throw new ApiError(422, e.code, e.message);
      throw e;
    }
  }

  let netCache: { at: number; value: NetworkCheck } | null = null;
  async function liveNetwork(force = false): Promise<NetworkCheck> {
    if (!force && netCache && Date.now() - netCache.at < 5_000) return netCache.value;
    const value = await network.check().catch((e: unknown): NetworkCheck => ({ chainIdVerified: false, reportedChainId: null, headBlock: null, latencyMs: 0, error: e instanceof Error ? e.message : String(e) }));
    netCache = { at: Date.now(), value };
    return value;
  }

  async function networkStatus(projectId: string, live: NetworkCheck) {
    const cursor = await store.getCursor(projectId, config.networkId);
    const stats = await store.projectStats(projectId);
    const connection = live.headBlock === null ? "disconnected" : live.chainIdVerified ? "connected" : "wrong_chain";
    const cursorUpdatedAt = cursor ? await store.getCursorUpdatedAt(projectId, config.networkId) : null;
    const cursorAgeMs = cursorUpdatedAt ? Date.now() - Date.parse(cursorUpdatedAt) : null;
    let ingestion: "never_run" | "healthy" | "stalled" | "unknown" = "never_run";
    if (cursor) ingestion = connection !== "connected" ? "unknown" : (cursorAgeMs ?? Infinity) > 120_000 ? "stalled" : "healthy";
    return {
      network: config.networkLabel,
      chainId: config.chainId,
      connection,
      headBlock: live.headBlock,
      rpcLatencyMs: live.latencyMs,
      rpcError: live.error,
      ingestion,
      cursorBlock: cursor?.block ?? null,
      lagBlocks: cursor && live.headBlock !== null ? Math.max(0, live.headBlock - cursor.block) : null,
      lastIngestionAt: cursorUpdatedAt,
      lastEventObservedAt: stats.lastEventObservedAt,
    };
  }

  // ---------------------------------------------------------- public routes
  /** The background worker is healthy if it recorded a heartbeat recently. Passes run every few seconds; backoff caps at ~60 s. */
  const WORKER_STALE_MS = 120_000;
  const workerHealth = async () => {
    const beat = await store.getServiceStatus("worker");
    if (!beat) return { status: "never" as const, lastBeatAt: null, ageSeconds: null };
    const age = now().getTime() - Date.parse(beat.updatedAt);
    return { status: age > WORKER_STALE_MS ? ("stale" as const) : ("ok" as const), lastBeatAt: beat.updatedAt, ageSeconds: Math.max(0, Math.round(age / 1000)) };
  };

  // Liveness: is the API process up? (Always 200 while it can answer.) The worker's state is reported alongside.
  router.add("GET", "/api/v1/health", async () => ({ ok: true, worker: await workerHealth() }), "none");
  // Readiness: should traffic/alerts treat the whole system as healthy? 503 if the worker is not running.
  router.add("GET", "/api/v1/ready", async () => {
    const worker = await workerHealth();
    if (worker.status !== "ok") throw new ApiError(503, "worker_unavailable", `The ingestion worker is ${worker.status === "never" ? "not running" : "not responding"}.`, worker);
    return { ok: true, worker };
  }, "none");

  router.add("GET", "/api/v1/networks", async () => [{ id: config.networkId, label: config.networkLabel, runtime: "evm", evmChainId: config.chainId }], "none");

  // Example contracts for the setup wizard and docs: public, static, and safe to cache.
  router.add("GET", "/api/v1/examples", async () => listExamples(), "none");
  router.add("GET", "/api/v1/examples/:id", async (ctx) => {
    const ex = getExample(ctx.params.id);
    if (!ex) throw new ApiError(404, "not_found", "No such example.");
    return ex;
  }, "none");

  router.add("GET", "/api/v1/public/status", async () => {
    const live = await liveNetwork();
    const demo = await store.getPublicDemoProject();
    const stats = demo ? await store.projectStats(demo.id) : null;
    return {
      network: config.networkLabel,
      connection: live.headBlock === null ? "disconnected" : live.chainIdVerified ? "connected" : "wrong_chain",
      headBlock: live.headBlock,
      checkedAt: now().toISOString(),
      worker: (await workerHealth()).status,
      demo: demo ? { projectId: demo.id, eventsIndexed: stats!.events, lastEventObservedAt: stats!.lastEventObservedAt, contractsWatched: "all" } : null,
    };
  }, "none");

  // ------------------------------------------------------------------- auth
  router.add("POST", "/api/v1/auth/signup", async (ctx) => {
    const wait = authLimiter.hit("signup:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    const body = parse(schemas.signup, ctx.body);
    const user = await store.createUser(body.email, await hashPassword(body.password));
    if (!user) throw new ApiError(409, "email_taken", "An account with this email already exists.");
    await store.audit("auth.signup", user.id, null);
    return await startSession(ctx, user.id, { id: user.id, email: user.email }, 201);
  }, "none");

  router.add("POST", "/api/v1/auth/login", async (ctx) => {
    const body = parse(schemas.login, ctx.body);
    const wait = Math.max(authLimiter.hit("login:" + ctx.ip), authLimiter.hit("login-email:" + body.email));
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    const user = await store.getUserByEmail(body.email);
    const ok = await verifyPassword(body.password, user ? user.passwordHash : await dummyHash());
    if (!user || !ok) {
      await store.audit("auth.login_failed", user?.id ?? null, null);
      throw new ApiError(401, "invalid_credentials", "Incorrect email or password."); // same message for both cases
    }
    await store.audit("auth.login", user.id, null);
    return await startSession(ctx, user.id, { id: user.id, email: user.email }, 200);
  }, "none");

  async function startSession(ctx: Ctx, userId: string, user: { id: string; email: string }, status: number) {
    const { token, hash } = newSessionToken();
    await store.createSession(hash, userId, new Date(now().getTime() + config.sessionTtlMs));
    return { __status: status, __headers: { "set-cookie": sessionCookie(token, Math.floor(config.sessionTtlMs / 1000), config.cookieSecure) }, data: { user } };
  }

  router.add("POST", "/api/v1/auth/logout", async (ctx) => {
    if (ctx.sessionToken) await store.revokeSession(hashToken(ctx.sessionToken));
    return { __headers: { "set-cookie": clearedSessionCookie(config.cookieSecure) }, data: { ok: true } };
  }, "optional");

  router.add("GET", "/api/v1/auth/me", async (ctx) => {
    sessionOnly(ctx);
    const user = await store.getUser(requireUser(ctx));
    if (!user) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    return { user };
  });

  // --------------------------------------------------------------- projects
  router.add("POST", "/api/v1/projects", async (ctx) => {
    sessionOnly(ctx);
    const userId = requireUser(ctx);
    const body = parse(schemas.project, ctx.body);
    if ((await store.listProjectsByOwner(userId)).length >= config.maxProjectsPerUser) throw new ApiError(409, "project_limit", `You can have up to ${config.maxProjectsPerUser} projects.`);
    const p = await store.createProject({ ownerId: userId, name: body.name, description: body.description ?? null, networkId: body.networkId });
    await store.audit("project.create", userId, p.id, { name: p.name });
    return { __status: 201, data: p };
  });

  // With an API key the list is just the key's own project.
  router.add("GET", "/api/v1/projects", async (ctx) => (ctx.apiKey ? [await store.getProject(ctx.apiKey.projectId)].filter(Boolean) : await store.listProjectsByOwner(requireUser(ctx))));

  router.add("GET", "/api/v1/projects/:projectId", async (ctx) => await project(ctx, ctx.params.projectId, "read"), "optional");

  router.add("PATCH", "/api/v1/projects/:projectId", async (ctx) => {
    sessionOnly(ctx);
    const p = await ownedProject(ctx, ctx.params.projectId);
    const body = parse(schemas.projectPatch, ctx.body);
    await store.updateProject(p.id, body);
    await store.audit("project.update", ctx.userId, p.id, body);
    return await store.getProject(p.id);
  });

  // ---------------------------------------------------------------- network
  router.add("GET", "/api/v1/projects/:projectId/network/status", async (ctx) => {
    const p = await project(ctx, ctx.params.projectId, "read");
    return await networkStatus(p.id, await liveNetwork());
  }, "optional");

  router.add("POST", "/api/v1/projects/:projectId/network/test", async (ctx) => {
    const p = await ownedProject(ctx, ctx.params.projectId);
    const wait = actionLimiter.hit("nettest:" + ctx.userId);
    if (wait) throw new ApiError(429, "rate_limited", `Try again in ${wait}s.`);
    const live = await liveNetwork(true);
    await store.log(live.chainIdVerified ? "info" : "error", "rpc", `Network test: ${live.chainIdVerified ? "ok" : live.error ?? "failed"}`, { headBlock: live.headBlock }, p.id);
    return { ...live, expectedChainId: config.chainId };
  });

  // --------------------------------------------------------------- overview
  router.add("GET", "/api/v1/projects/:projectId/overview", async (ctx) => {
    const p = await project(ctx, ctx.params.projectId, "read");
    const stats = await store.projectStats(p.id);
    const net = await networkStatus(p.id, await liveNetwork());
    const recent = await store.searchEvents({ projectId: p.id, limit: 8 });
    const statusByEvent = await store.deliveryStatusByEvent(recent.items.map((e) => e.id));
    const failures = await store.listProjectDeliveries(p.id, "failed", 5);
    const contracts = await store.listContracts(p.id);
    const isOwner = ctx.userId === p.ownerId;
    const setup = {
      networkConnected: net.connection === "connected",
      contractAdded: contracts.length > 0 || p.kind === "public_demo",
      webhookConfigured: stats.activeEndpoints > 0,
      firstEventReceived: stats.events > 0,
      firstDeliverySucceeded: stats.delivered > 0,
    };
    let nextAction: string | null = null;
    if (isOwner) {
      if (!setup.networkConnected) nextAction = "Check the network connection. The RPC is not reachable or reports a different chain.";
      else if (!setup.contractAdded) nextAction = "Register a contract to start capturing its events.";
      else if (!setup.firstEventReceived) nextAction = "Trigger a transaction on your contract. No events have been captured yet.";
      else if (!setup.webhookConfigured) nextAction = "Add a webhook endpoint to receive these events.";
      else if (!setup.firstDeliverySucceeded) nextAction = "Send a test delivery to confirm your endpoint works.";
    }
    return {
      project: p,
      metrics: { eventsReceived: stats.events, delivered: stats.delivered, failed: stats.failed, retrying: stats.retrying, pending: stats.pending, activeWebhooks: stats.activeEndpoints },
      network: net,
      recentEvents: recent.items.map((e) => ({ ...eventView(e), delivery: statusByEvent[e.id] ?? null })),
      recentFailures: isOwner ? failures.map((f) => ({ deliveryId: f.delivery.id, eventId: f.event.id, eventName: f.event.eventName, contractAddress: f.event.contractAddress, endpointId: f.delivery.endpointId, lastError: f.delivery.lastError, lastResponseStatus: f.delivery.lastResponseStatus, updatedAt: f.delivery.updatedAt })) : [],
      setup: { ...setup, completed: Object.values(setup).filter(Boolean).length, total: Object.keys(setup).length },
      nextAction,
    };
  }, "optional");

  // -------------------------------------------------------------- contracts
  router.add("POST", "/api/v1/projects/:projectId/contracts", async (ctx) => {
    const p = await ownedProject(ctx, ctx.params.projectId);
    const body = parse(schemas.contract, ctx.body);
    if (JSON.stringify(body.abi ?? []).length > 262_144) throw new ApiError(422, "validation_failed", "ABI is too large (256 KiB max).");
    const c = await store.createContract({ projectId: p.id, address: body.address, name: body.name ?? null, abi: body.abi ?? null, startBlock: body.startBlock ?? null, deploymentTxHash: body.deploymentTxHash ?? null });
    if (!c) throw new ApiError(409, "contract_exists", "This contract is already registered in the project.");
    await store.audit("contract.add", ctx.userId, p.id, { address: c.address });
    await store.log("info", "config", `Contract ${c.address} registered`, undefined, p.id);
    return { __status: 201, data: contractView(c) };
  });

  /** One shape for every contract response: no ABI body, but whether there is one and which events it declares. */
  const contractView = (c: ContractRecord, eventCount = 0) => ({
    ...c, abi: undefined, hasAbi: c.abi !== null, eventCount,
    events: c.abi ? (c.abi as { type?: string; name?: string }[]).filter((x) => x.type === "event" && x.name).map((x) => x.name as string) : [],
  });
  const withCounts = async (projectId: string) => {
    const counts = await store.contractEventCounts(projectId);
    return (await store.listContracts(projectId)).map((c) => contractView(c, counts[c.address] ?? 0));
  };

  router.add("GET", "/api/v1/projects/:projectId/contracts", async (ctx) => await withCounts((await project(ctx, ctx.params.projectId, "read")).id), "optional");

  router.add("GET", "/api/v1/contracts/:contractId", async (ctx) => {
    const c = await store.getContract(ctx.params.contractId);
    if (!c) throw notFound();
    await project(ctx, c.projectId, "read");
    return contractView(c, (await store.contractEventCounts(c.projectId))[c.address] ?? 0);
  }, "optional");

  router.add("POST", "/api/v1/contracts/:contractId/test", async (ctx) => {
    const c = await store.getContract(ctx.params.contractId);
    if (!c) throw notFound();
    await ownedProject(ctx, c.projectId);
    const wait = actionLimiter.hit("ctest:" + ctx.userId);
    if (wait) throw new ApiError(429, "rate_limited", `Try again in ${wait}s.`);
    // Read-only: does bytecode exist at this address on the connected network? Nothing is signed or sent.
    const code = await network.getCode(c.address).catch((e: unknown) => { throw new ApiError(502, "rpc_unavailable", e instanceof Error ? e.message : "RPC unavailable"); });
    const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    return { address: c.address, codeFound: bytes > 0, runtimeCodeBytes: bytes, note: bytes > 0 ? "Bytecode exists at this address." : "No contract code at this address on the connected network." };
  });

  // ----------------------------------------------------------------- events
  router.add("GET", "/api/v1/projects/:projectId/events", async (ctx) => {
    const p = await project(ctx, ctx.params.projectId, "read");
    const q = parse(schemas.eventQuery, Object.fromEntries(ctx.url.searchParams));
    const r = await store.searchEvents({ projectId: p.id, search: q.q, contractAddress: q.contract, eventName: q.event, finalityStatus: q.finality, deliveryStatus: q.delivery, limit: q.limit, offset: q.offset });
    const status = await store.deliveryStatusByEvent(r.items.map((e) => e.id));
    return { items: r.items.map((e) => ({ ...eventView(e), delivery: status[e.id] ?? null })), total: r.total, limit: q.limit, offset: q.offset };
  }, "optional");

  router.add("GET", "/api/v1/events/:eventId", async (ctx) => {
    const e = await store.getEvent(ctx.params.eventId);
    if (!e) throw notFound();
    const p = await project(ctx, e.projectId, "read");
    const owner = ctx.userId === p.ownerId;
    const deliveries = owner ? await Promise.all((await store.listDeliveries({ eventId: e.id })).map(async (d) => ({ ...d, attempts: await store.listAttempts(d.id) }))) : [];
    return { ...eventView(e), deliveries };
  }, "optional");

  router.add("POST", "/api/v1/events/:eventId/replay", async (ctx) => {
    const e = await store.getEvent(ctx.params.eventId);
    if (!e) throw notFound();
    const p = await ownedProject(ctx, e.projectId);
    const wait = actionLimiter.hit("replay:" + ctx.userId);
    if (wait) throw new ApiError(429, "rate_limited", `Too many replays. Try again in ${wait}s.`);
    const body = parse(schemas.replay, ctx.body);
    const targets = body.endpointId ? [(await endpointFor(ctx, body.endpointId)).endpoint] : (await store.listEndpoints(p.id)).filter((x) => x.enabled);
    if (body.endpointId && targets[0].projectId !== p.id) throw notFound();
    if (!targets.length) throw new ApiError(409, "no_endpoints", "This project has no enabled webhook endpoints to replay to.");
    const ids = await Promise.all(targets.map((t) => replayEvent(store, e.id, t.id, now())));
    await store.audit("event.replay", ctx.userId, p.id, { eventId: e.id, deliveryIds: ids });
    return { __status: 202, data: { deliveryIds: ids, note: "Queued. The stored event payload will be re-delivered; the original transaction is not resubmitted." } };
  });

  router.add("GET", "/api/v1/projects/:projectId/deliveries", async (ctx) => {
    const p = await ownedProject(ctx, ctx.params.projectId);
    const q = parse(schemas.deliveryQuery, Object.fromEntries(ctx.url.searchParams));
    return (await store.listProjectDeliveries(p.id, q.status, q.limit)).map(({ delivery, event }) => ({ ...delivery, event: { id: event.id, eventName: event.eventName, contractAddress: event.contractAddress, transactionHash: event.transactionHash, blockNumber: event.blockNumber } }));
  });

  // --------------------------------------------------------------- webhooks
  router.add("POST", "/api/v1/projects/:projectId/webhooks", async (ctx) => {
    const p = await ownedProject(ctx, ctx.params.projectId);
    const body = parse(schemas.webhook, ctx.body);
    let url = body.url;
    let token: string | null = null;
    if (body.builtinReceiver) {
      if (!config.receiverBaseUrl) throw new ApiError(409, "receiver_unavailable", "The built-in test receiver is not configured on this server (PORTALOPS_API_PUBLIC_URL).");
      token = randomBytes(24).toString("base64url"); // 192 bits: the URL itself is the capability
      url = `${config.receiverBaseUrl.replace(/\/+$/, "")}/api/v1/hooks/${token}`;
    } else if (!url) {
      throw new ApiError(422, "validation_failed", "Request validation failed.", [{ path: "url", message: "Required unless builtinReceiver is true." }]);
    }
    try {
      await checkWebhookUrl(url);
    } catch (e) {
      if (body.builtinReceiver && e instanceof ApiError) throw new ApiError(422, "receiver_unreachable", `The built-in receiver URL is not deliverable from this server (${e.message}) Set PORTALOPS_API_PUBLIC_URL to a public https URL.`);
      throw e;
    }
    const secret = generateWebhookSecret();
    const ep = await store.createEndpoint(
      { projectId: p.id, url, description: body.description ?? null, enabled: body.enabled, eventFilter: body.eventFilter, retryPolicy: mergeRetryPolicy(DEFAULT_RETRY_POLICY, body.retryPolicy) },
      encryptSecret(secret, config.encryptionKey),
    );
    if (token) await store.createReceiver(ep.id, hashReceiverToken(token));
    await store.audit("webhook.create", ctx.userId, p.id, { endpointId: ep.id, url: body.builtinReceiver ? "[built-in receiver]" : ep.url });
    // The secret is returned exactly once, here. It cannot be read back later.
    return { __status: 201, data: { ...(await publicEndpoint(ep)), secret } };
  });

  router.add("GET", "/api/v1/projects/:projectId/webhooks", async (ctx) => Promise.all((await store.listEndpoints((await ownedProject(ctx, ctx.params.projectId)).id)).map(publicEndpoint)));

  router.add("PATCH", "/api/v1/webhooks/:webhookId", async (ctx) => {
    const { endpoint, project: p } = await endpointFor(ctx, ctx.params.webhookId);
    const body = parse(schemas.webhookPatch, ctx.body);
    if (body.url !== undefined) await checkWebhookUrl(body.url);
    await store.updateEndpoint(endpoint.id, {
      url: body.url, description: body.description, enabled: body.enabled, eventFilter: body.eventFilter,
      retryPolicy: body.retryPolicy ? mergeRetryPolicy(endpoint.retryPolicy, body.retryPolicy) : undefined,
    });
    await store.audit("webhook.update", ctx.userId, p.id, { endpointId: endpoint.id, fields: Object.keys(body) });
    return publicEndpoint((await store.getEndpoint(endpoint.id))!);
  });

  router.add("POST", "/api/v1/webhooks/:webhookId/rotate-secret", async (ctx) => {
    const { endpoint, project: p } = await endpointFor(ctx, ctx.params.webhookId);
    const secret = generateWebhookSecret();
    await store.updateEndpoint(endpoint.id, { encryptedSecret: encryptSecret(secret, config.encryptionKey) });
    await store.audit("webhook.rotate_secret", ctx.userId, p.id, { endpointId: endpoint.id });
    return { id: endpoint.id, secret };
  });

  router.add("DELETE", "/api/v1/webhooks/:webhookId", async (ctx) => {
    const { endpoint, project: p } = await endpointFor(ctx, ctx.params.webhookId);
    await store.deleteEndpoint(endpoint.id);
    await store.audit("webhook.delete", ctx.userId, p.id, { endpointId: endpoint.id, url: endpoint.url });
    return { ok: true };
  });

  router.add("POST", "/api/v1/webhooks/:webhookId/test", async (ctx) => {
    const { endpoint, project: p } = await endpointFor(ctx, ctx.params.webhookId);
    const wait = actionLimiter.hit("whtest:" + ctx.userId);
    if (wait) throw new ApiError(429, "rate_limited", `Try again in ${wait}s.`);
    const found = (await store.getEndpointWithSecret(endpoint.id))!;
    const secret = decryptSecret(found.encryptedSecret, config.encryptionKey);
    const body = JSON.stringify({ id: "evt_test_" + randomUUID().replaceAll("-", "").slice(0, 16), type: "webhook.test", network: config.networkId, data: { message: "PortalOps test delivery. This is not a blockchain event." } });
    const { timestamp, header } = signHeader(secret, body, now());
    const r = await sendWebhook(endpoint.url, body, { "portalops-signature": header, "portalops-timestamp": String(timestamp), "portalops-event-id": "test", "portalops-delivery-id": "test", "portalops-attempt": "1" }, { timeoutMs: endpoint.retryPolicy.timeoutMs, guard });
    await store.log(r.status !== null && r.status < 300 ? "info" : "warn", "webhook", `Test delivery to ${endpoint.id}: ${r.status ?? r.errorCode}`, { durationMs: r.durationMs }, p.id);
    return { ok: r.status !== null && r.status >= 200 && r.status < 300, status: r.status, errorCode: r.errorCode, durationMs: r.durationMs, response: r.sanitisedResponse };
  });

  router.add("GET", "/api/v1/webhooks/:webhookId/deliveries", async (ctx) => {
    const { endpoint } = await endpointFor(ctx, ctx.params.webhookId);
    const q = parse(schemas.deliveryQuery, Object.fromEntries(ctx.url.searchParams));
    return Promise.all((await store.listDeliveries({ endpointId: endpoint.id, status: q.status, limit: q.limit })).map(async (d) => ({ ...d, attempts: await store.listAttempts(d.id) })));
  });

  // ------------------------------------------------- built-in test receiver
  // Public, unauthenticated sink addressed by an unguessable token. It behaves like a correct consumer: it verifies the
  // signature over the RAW body with the endpoint's own secret, rejects stale timestamps, and de-duplicates on the event id.
  const receiverLimiter = new RateLimiter(120, 60_000);
  const hold = (ms: number, req: IncomingMessage) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref(); req.on("close", () => { clearTimeout(t); resolve(); }); });

  router.add("POST", "/api/v1/hooks/:token", async (ctx) => {
    const receiver = await store.getReceiverByTokenHash(hashReceiverToken(ctx.params.token));
    if (!receiver) throw notFound(); // same answer for malformed and unknown tokens
    const wait = receiverLimiter.hit("rcv:" + receiver.id);
    if (wait) throw new ApiError(429, "rate_limited", `Try again in ${wait}s.`);

    const found = await store.getEndpointWithSecret(receiver.endpointId);
    if (!found) throw notFound();
    const secret = decryptSecret(found.encryptedSecret, config.encryptionKey);
    const header = ctx.req.headers[SIGNATURE_HEADER] as string | undefined;
    const verdict = verifySignature(secret, ctx.rawBody, header, { now: now() });
    const eventId = (ctx.req.headers["portalops-event-id"] as string | undefined)?.slice(0, 80) ?? null;
    const deliveryId = (ctx.req.headers["portalops-delivery-id"] as string | undefined)?.slice(0, 80) ?? null;
    const attemptHeader = Number(ctx.req.headers["portalops-attempt"]);
    // Bodies are untrusted input from the internet: store a short, sanitised preview only, never the signature or secret.
    const bodyPreview = ctx.rawBody.slice(0, 1_500).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    const record = (outcome: string, httpStatus: number) =>
      store.recordReceiverRequest(receiver.id, { eventId, deliveryId, attempt: Number.isInteger(attemptHeader) ? attemptHeader : null, signatureOk: verdict.ok, signatureReason: verdict.ok ? null : verdict.reason, outcome, httpStatus, bodyPreview });

    if (!verdict.ok) {
      await record("rejected", 401);
      throw new ApiError(401, "invalid_signature", `Signature check failed (${verdict.reason}).`);
    }
    if (receiver.mode === "timeout") {
      await record("timeout", 504);
      await hold(config.receiverTimeoutHoldMs ?? 31_000, ctx.req);
      return { __status: 504, data: { error: "simulated timeout" } };
    }
    if (receiver.mode === "fail500") { await record("fail500", 500); return { __status: 500, data: { error: "simulated internal error" } }; }
    if (receiver.mode === "fail400") { await record("fail400", 400); return { __status: 400, data: { error: "simulated bad request" } }; }

    const duplicate = eventId !== null && await store.receiverEventProcessed(receiver.id, eventId);
    await record(duplicate ? "duplicate" : "ok", 200);
    return { received: true, duplicate };
  }, "none", { maxBytes: 256 * 1024 });

  const receiverFor = async (ctx: Ctx) => {
    const { endpoint } = await endpointFor(ctx, ctx.params.webhookId);
    const receiver = await store.getReceiverByEndpoint(endpoint.id);
    if (!receiver) throw new ApiError(404, "not_found", "This webhook does not use the built-in test receiver.");
    return { endpoint, receiver };
  };

  router.add("GET", "/api/v1/webhooks/:webhookId/receiver", async (ctx) => {
    const { receiver } = await receiverFor(ctx);
    return { mode: receiver.mode, requests: await store.listReceiverRequests(receiver.id, 50) };
  });

  router.add("PATCH", "/api/v1/webhooks/:webhookId/receiver", async (ctx) => {
    const { endpoint, receiver } = await receiverFor(ctx);
    const { mode } = parse(schemas.receiverPatch, ctx.body);
    await store.setReceiverMode(receiver.id, mode);
    await store.audit("receiver.set_mode", ctx.userId, endpoint.projectId, { endpointId: endpoint.id, mode });
    return { mode };
  });

  // ------------------------------------------------------------ logs, audit
  router.add("GET", "/api/v1/projects/:projectId/logs", async (ctx) => {
    const p = await ownedProject(ctx, ctx.params.projectId);
    return await store.listLogs(p.id, parse(schemas.limitQuery, Object.fromEntries(ctx.url.searchParams)).limit);
  });

  router.add("GET", "/api/v1/projects/:projectId/audit", async (ctx) => { sessionOnly(ctx); return await store.listAudit((await ownedProject(ctx, ctx.params.projectId)).id, 100); });

  // ----------------------------------------------------------------- API keys
  const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");
  const MAX_ACTIVE_KEYS = 10;

  router.add("POST", "/api/v1/projects/:projectId/api-keys", async (ctx) => {
    sessionOnly(ctx);
    const p = await ownedProject(ctx, ctx.params.projectId);
    const body = parse(schemas.apiKey, ctx.body);
    if (await store.countActiveApiKeys(p.id) >= MAX_ACTIVE_KEYS) throw new ApiError(409, "key_limit", `A project can have up to ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`);
    const key = "pops_" + randomBytes(32).toString("base64url"); // 256 bits of randomness, so a plain SHA-256 lookup hash is appropriate
    const rec = await store.createApiKey({ projectId: p.id, name: body.name, scope: body.scope, prefix: key.slice(0, 12), keyHash: hashApiKey(key), createdBy: ctx.userId });
    await store.audit("api_key.create", ctx.userId, p.id, { keyId: rec.id, scope: rec.scope, name: rec.name });
    // The key is returned exactly once, here.
    return { __status: 201, data: { ...rec, key } };
  });

  router.add("GET", "/api/v1/projects/:projectId/api-keys", async (ctx) => {
    sessionOnly(ctx);
    return await store.listApiKeys((await ownedProject(ctx, ctx.params.projectId)).id);
  });

  router.add("DELETE", "/api/v1/api-keys/:keyId", async (ctx) => {
    sessionOnly(ctx);
    const k = await store.getApiKey(ctx.params.keyId);
    if (!k) throw notFound();
    const p = await ownedProject(ctx, k.projectId);
    await store.revokeApiKey(k.id);
    await store.audit("api_key.revoke", ctx.userId, p.id, { keyId: k.id, name: k.name });
    return { ok: true };
  });

  // ------------------------------------------------------------ automations
  router.add("POST", "/api/v1/projects/:projectId/automations", async (ctx) => {
    const p = await ownedProject(ctx, ctx.params.projectId);
    const body = parse(schemas.automation, ctx.body);
    const ep = await store.getEndpoint(body.endpointId);
    if (!ep || ep.projectId !== p.id) throw new ApiError(422, "validation_failed", "endpointId must be a webhook in this project.");
    const a = await store.createAutomation({ projectId: p.id, ...body });
    await store.audit("automation.create", ctx.userId, p.id, { automationId: a.id });
    return { __status: 201, data: a };
  });

  router.add("GET", "/api/v1/projects/:projectId/automations", async (ctx) => await store.listAutomations((await ownedProject(ctx, ctx.params.projectId)).id));

  router.add("PATCH", "/api/v1/automations/:automationId", async (ctx) => {
    const a = await store.getAutomation(ctx.params.automationId);
    if (!a) throw notFound();
    await ownedProject(ctx, a.projectId);
    await store.setAutomationEnabled(a.id, parse(schemas.automationPatch, ctx.body).enabled);
    return await store.getAutomation(a.id);
  });

  router.add("DELETE", "/api/v1/automations/:automationId", async (ctx) => {
    const a = await store.getAutomation(ctx.params.automationId);
    if (!a) throw notFound();
    await ownedProject(ctx, a.projectId);
    await store.deleteAutomation(a.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ dispatcher
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients; browsers always send Origin on cross-site POST/PATCH/DELETE
    if (config.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  return async (req, res) => {
    const ip = clientIp(req, config.trustedProxyHops ?? 0);
    const reply = (status: number, payload: unknown, headers: Record<string, string | string[]> = {}) => sendJson(res, status, payload, headers);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (!url.pathname.startsWith("/api/")) return reply(404, { error: { code: "not_found", message: "Not found." } });

      const wait = globalLimiter.hit("ip:" + ip);
      if (wait) throw new ApiError(429, "rate_limited", `Too many requests. Try again in ${wait}s.`);

      const m = router.match(method, url.pathname);
      if (!m) throw notFound();
      if ("allowed" in m) return reply(405, { error: { code: "method_not_allowed", message: "Method not allowed." } }, { allow: m.allowed.join(", ") });

      const mutating = method !== "GET" && method !== "HEAD";
      if (mutating && !originAllowed(req)) throw new ApiError(403, "origin_not_allowed", "Cross-origin request blocked.");

      const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
      let userId = sessionToken ? await store.findSessionUser(hashToken(sessionToken), now()) : null;
      let apiKey: Ctx["apiKey"] = null;

      // API key auth: `Authorization: Bearer pops_…`. If the header is present it wins and must be valid; a bad key is never
      // silently downgraded to "anonymous" or to a cookie session. Public routes (e.g. the receiver hook) ignore it.
      const authz = req.headers.authorization;
      if (authz && m.route.auth !== "none") {
        const match = /^Bearer\s+(pops_[A-Za-z0-9_-]{20,128})$/.exec(authz);
        const found = match ? await store.findApiKeyByHash(hashApiKey(match[1])) : null;
        if (!found || found.revokedAt) throw new ApiError(401, "invalid_api_key", "Invalid or revoked API key.");
        const wait = keyLimiter.hit("key:" + found.id);
        if (wait) throw new ApiError(429, "rate_limited", `Too many requests for this key. Try again in ${wait}s.`);
        if (mutating && found.scope === "read") throw new ApiError(403, "insufficient_scope", "This API key is read-only.");
        userId = found.ownerId;
        apiKey = { id: found.id, projectId: found.projectId, scope: found.scope };
        await store.touchApiKey(found.id, now());
      }
      if (m.route.auth === "required" && !userId) throw new ApiError(401, "unauthenticated", "Sign in to continue.");

      let rawBody = "";
      let body: unknown;
      if (mutating) {
        rawBody = await readRaw(req, m.route.raw?.maxBytes ?? MAX_BODY_BYTES);
        if (!m.route.raw) body = parseJsonBody(rawBody, req.headers["content-type"]);
      }
      const result = await m.route.handler({ req, res, url, params: m.params, body, userId, ip, sessionToken, rawBody, apiKey });

      if (result && typeof result === "object" && "__headers" in result) {
        const r = result as { __status?: number; __headers: Record<string, string>; data: unknown };
        return reply(r.__status ?? 200, { data: r.data }, r.__headers);
      }
      if (result && typeof result === "object" && "__status" in result) {
        const r = result as { __status: number; data: unknown };
        return reply(r.__status, { data: r.data });
      }
      return reply(200, { data: result });
    } catch (e) {
      if (e instanceof ApiError) {
        return reply(e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, e.status === 429 ? { "retry-after": String(/\d+/.exec(e.message)?.[0] ?? 60) } : {});
      }
      console.error("Unhandled API error:", e instanceof Error ? e.stack : e);
      return reply(500, { error: { code: "internal_error", message: "Something went wrong." } });
    }
  };
}
