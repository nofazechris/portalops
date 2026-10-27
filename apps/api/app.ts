import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import type { Store, ProjectRecord, ContractRecord, UserRecord, VerifiedContractRecord } from "../../packages/database/store.ts";
import { decryptSecret, encryptSecret, generateWebhookSecret } from "../../packages/database/secrets.ts";
import { DEFAULT_RETRY_POLICY, type NormalizedEvent, type RetryPolicy, type WebhookEndpoint } from "../../packages/shared-types/index.ts";
import { getExample, listExamples, listFeatured } from "../../packages/examples/catalog.ts";
import { replayEvent } from "../../packages/webhook-engine/runner.ts";
import { sendWebhook } from "../../packages/webhook-engine/send.ts";
import { signHeader, SIGNATURE_HEADER, verifySignature } from "../../packages/webhook-engine/sign.ts";
import { BlockedTargetError, validateWebhookUrl, type GuardOptions } from "../../packages/webhook-engine/url-guard.ts";
import { clearedSessionCookie, dummyHash, hashPassword, hashToken, newSessionToken, SESSION_COOKIE, sessionCookie, verifyPassword } from "./auth.ts";
import { resetPasswordMessage, verifyEmailMessage } from "../../packages/email/templates.ts";
import type { EmailSender } from "../../packages/email/index.ts";
import { ApiError, clientIp, parseCookies, parseJsonBody, RateLimiter, readRaw, Router, sendJson, MAX_BODY_BYTES, type Ctx, type Limiter } from "./http.ts";
import { SharedRateLimiter } from "./shared-limiter.ts";
import { buildEvidence, diagnoseRules, explainWithModel } from "../../packages/diagnostics/diagnose.ts";
import { cleanNote, type PingSender } from "../../packages/chain-adapters/pinger.ts";
import { canonicalSs58 } from "../../packages/chain-adapters/native.ts";
import { verifySource } from "../../packages/verification/verify.ts";
import { inkEventNames, loadInkAbi, looksLikeInkMetadata } from "../../packages/event-engine/ink.ts";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "./totp.ts";

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
  /** Whether an ink! contract is deployed at this SS58 address on the native runtime. Absent when the server has no native connection. */
  inkContractExists?(address: string): Promise<boolean>;
}

/** Optional model-written explanations of failed deliveries. Off unless the operator sets an Anthropic API key. */
export interface AiConfig { apiKey: string; model: string; /** Injected in tests. */ fetchImpl?: typeof fetch }

export interface AppConfig {
  /** AI explanations for failed deliveries; null/absent = off (the rule-based diagnosis is always available). */
  ai?: AiConfig | null;
  /** Lets the public playground send a real ping on a visitor's behalf (one contract, one function). Null/absent = visitors use their own wallet. */
  pinger?: PingSender | null;
  /** How many sponsored pings the playground sends per UTC day, across all visitors. Default 30. */
  demoPingsPerDay?: number;
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
  /** Browser-facing origin; used to build the links in emails and the GitHub callback. */
  publicUrl?: string;
  /** Sends account emails. Without one, emails are not delivered (the flows still respond normally). */
  email?: EmailSender;
  /** GitHub OAuth App credentials. Null/absent hides "Continue with GitHub". */
  github?: { clientId: string; clientSecret: string } | null;
  /** fetch used for outbound calls to GitHub (injectable for tests). */
  fetch?: typeof fetch;
}

/** Marker stored instead of a password hash for accounts created through GitHub: it can never verify as a password. */
const NO_PASSWORD = "!oauth";
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const OAUTH_COOKIE = "portalops_oauth";

export interface AppDeps {
  store: Store;
  config: AppConfig;
  network: NetworkProbe;
  rateLimits?: { auth?: Limiter; global?: Limiter; actions?: Limiter; keys?: Limiter };
  /** Keep rate-limit counters in the database so several API instances share them (default: in this process). */
  sharedRateLimits?: boolean;
  /** The source verifier. Injected in tests so they need no compiler; defaults to the real one. */
  verify?: typeof verifySource;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Either kind of contract address: a 0x EVM address, or an SS58 address (ink! contracts on the native runtime; starts with 5). */
const ANY_ADDRESS = /^(0x[0-9a-fA-F]{40}|5[1-9A-HJ-NP-Za-km-z]{46,47})$/;
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
  mfaCode: z.object({ code: z.string().trim().min(6).max(24) }),
  mfaLogin: z.object({ challenge: z.string().min(20).max(100), code: z.string().trim().min(6).max(24) }),
  mfaDisable: z.object({ code: z.string().trim().min(6).max(24), password: z.string().max(200).optional() }),
  forgot: z.object({ email: z.string().trim().toLowerCase().email().max(254) }),
  token: z.object({ token: z.string().min(20).max(200) }),
  reset: z.object({ token: z.string().min(20).max(200), password: z.string().min(12, "At least 12 characters.").max(200) }),
  project: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    networkId: z.literal("portaldot-v3-testnet").default("portaldot-v3-testnet"),
  }),
  projectPatch: z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).nullable().optional() }),
  contract: z.object({
    /** "evm" (Solidity, 0x address, ABI array) or "ink" (Rust ink!, SS58 address, contract metadata object). */
    type: z.enum(["evm", "ink"]).default("evm"),
    address: z.string().trim().min(1).max(80),
    name: z.string().trim().max(80).optional(),
    abi: z.union([z.array(z.record(z.string(), z.unknown())).max(500), z.record(z.string(), z.unknown())]).optional(),
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
    triggerContract: z.string().regex(ANY_ADDRESS).nullable().default(null),
    endpointId: z.string().min(1).max(64),
  }),
  automationPatch: z.object({ enabled: z.boolean() }),
  apiKey: z.object({
    name: z.string().trim().min(1).max(60),
    scope: z.enum(["read", "write"]).default("read"),
    /** Days until the key stops working. Omitted = 90; null = never expires. */
    expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  }),
  receiverPatch: z.object({ mode: z.enum(["ok", "fail500", "fail400", "timeout"]) }),
  eventQuery: z.object({
    q: z.string().trim().max(200).optional(),
    contract: z.string().regex(ANY_ADDRESS).optional(),
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
  const makeLimiter = (name: string, limit: number, windowMs: number): Limiter => deps.sharedRateLimits ? new SharedRateLimiter(store, name, limit, windowMs) : new RateLimiter(limit, windowMs);
  const authLimiter = deps.rateLimits?.auth ?? makeLimiter("auth", 10, 60_000);
  const globalLimiter = deps.rateLimits?.global ?? makeLimiter("global", 600, 60_000);
  const actionLimiter = deps.rateLimits?.actions ?? makeLimiter("actions", 60, 60_000);
  const keyLimiter = deps.rateLimits?.keys ?? makeLimiter("keys", 600, 60_000);
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
  // Registered BEFORE /examples/:id so "featured" is not read as an example id.
  router.add("GET", "/api/v1/examples/featured", async () => listFeatured(), "none");
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

  // ------------------------------------------------ verified contract registry (public, no signup)
  // Anyone can submit Solidity source for a contract on the testnet. It is compiled here and the result is compared byte for byte with the
  // code on chain; only a match is stored. A verified contract has a trustworthy ABI, so PortalOps decodes its events by name for everyone.
  const verifyLimiter = makeLimiter("verify", 3, 10 * 60_000); // compiling is heavy: three submissions per IP per ten minutes
  const verifySchema = z.object({
    address: z.string().trim().regex(ADDRESS, "An address is 0x followed by 40 hex characters."),
    source: z.string().min(10, "Paste the Solidity source.").max(100_000, "The source is larger than 100 KB."),
    contractName: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, "Not a valid contract name.").optional(),
    evmVersion: z.string().trim().max(20).optional(),
    optimizerRuns: z.number().int().nullable().optional(),
  });
  const verifier = deps.verify ?? verifySource;
  const registryItem = (v: VerifiedContractRecord) => ({
    address: v.address, name: v.name, matchType: v.matchType, compiler: v.compiler, evmVersion: v.evmVersion, optimizerRuns: v.optimizerRuns, runtimeBytes: v.runtimeBytes, verifiedAt: v.verifiedAt,
    events: (v.abi as { type?: string; name?: string }[]).filter((x) => x.type === "event" && x.name).map((x) => x.name as string),
    functions: (v.abi as { type?: string; name?: string }[]).filter((x) => x.type === "function" && x.name).length,
  });

  router.add("POST", "/api/v1/registry/verify", async (ctx) => {
    const wait = await verifyLimiter.hit("verify:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Verification is limited to three submissions per ten minutes. Try again in ${wait}s.`);
    const body = parse(verifySchema, ctx.body);
    const address = body.address.toLowerCase();
    const existing = await store.getVerifiedContract(address);
    if (existing?.matchType === "full") return { verified: true, alreadyVerified: true, ...registryItem(existing) };
    const code = await network.getCode(address).catch(() => { throw new ApiError(502, "rpc_unavailable", "The Portaldot testnet could not be reached just now. Try again in a moment."); });
    const r = await verifier({ source: body.source, contractName: body.contractName, evmVersion: body.evmVersion, optimizerRuns: body.optimizerRuns, onChainCode: code });
    if (!r.ok) {
      const status = r.reason === "busy" ? 503 : r.reason === "no_code" ? 404 : 422;
      throw new ApiError(status, r.reason === "mismatch" || r.reason === "compile_error" ? "verification_failed" : r.reason, r.message, r.details?.map((d) => ({ path: r.reason, message: d })));
    }
    await store.saveVerifiedContract({ address, name: r.name, abi: r.abi, source: body.source, matchType: r.match, evmVersion: r.settings.evmVersion, optimizerRuns: r.settings.optimizerRuns, compiler: r.compiler, runtimeBytes: r.runtimeBytes });
    await store.log("info", "registry", `Verified ${address} as ${r.name} (${r.match} match)`);
    const saved = (await store.getVerifiedContract(address))!;
    return { __status: 201, data: { verified: true, alreadyVerified: false, ...registryItem(saved) } };
  }, "none");

  router.add("GET", "/api/v1/public/registry", async (ctx) => {
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(ctx.url.searchParams.get("offset") ?? 0) || 0, 0);
    const { items, total } = await store.listVerifiedContracts(limit, offset);
    const withActivity = await Promise.all(items.map(async (v) => ({ ...registryItem(v), activity: await store.contractActivity(v.address).then((a) => ({ events: a.events, lastEventAt: a.lastEventAt })) })));
    return { total, items: withActivity };
  }, "none");

  router.add("GET", "/api/v1/public/registry/:address", async (ctx) => {
    if (!ADDRESS.test(ctx.params.address)) throw new ApiError(422, "validation_failed", "An address is 0x followed by 40 hex characters.");
    const v = await store.getVerifiedContract(ctx.params.address);
    if (!v) throw new ApiError(404, "not_found", "No verified contract at that address.");
    return { ...registryItem(v), abi: v.abi, source: v.source, activity: await store.contractActivity(v.address) };
  }, "none");

  // ---------------------------------------------------- public playground (no signup)
  // A shared sandbox: anyone can watch a contract and fire a SIGNED test delivery to the built-in receiver,
  // with no account. Hardened for public write: rate-limited per IP, hard-capped, built-in receiver only
  // (no arbitrary URLs, so the SSRF surface is nil), and no secrets are ever returned.
  const PLAYGROUND_MAX_CONTRACTS = 20; // visitor-added, on top of the pinned examples
  const playgroundLimiter = makeLimiter("playground", 12, 60_000); // write actions per IP per minute
  const pgWatchSchema = z.object({
    address: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "An address is 0x followed by 40 hex characters."),
    example: z.string().trim().optional(),
  });
  const pinnedAddresses = () => new Set(listFeatured().map((f) => f.address.toLowerCase()));
  let playgroundReady: { project: ProjectRecord; endpoint: WebhookEndpoint } | null = null;
  async function ensurePlayground() {
    if (playgroundReady) return playgroundReady;
    const project = await store.getPlaygroundProject();
    if (!project) throw new ApiError(503, "unavailable", "The playground is not available right now.");
    // One built-in-receiver webhook for the whole playground.
    let endpoint = (await store.listEndpoints(project.id))[0] ?? null;
    if (!endpoint) {
      if (!config.receiverBaseUrl) throw new ApiError(503, "unavailable", "The playground receiver is not configured on this server.");
      const token = randomBytes(24).toString("base64url");
      const url = `${config.receiverBaseUrl.replace(/\/+$/, "")}/api/v1/hooks/${token}`;
      await checkWebhookUrl(url);
      endpoint = await store.createEndpoint(
        { projectId: project.id, url, description: "Playground built-in receiver", enabled: true, eventFilter: [], retryPolicy: DEFAULT_RETRY_POLICY },
        encryptSecret(generateWebhookSecret(), config.encryptionKey),
      );
      await store.createReceiver(endpoint.id, hashReceiverToken(token));
    }
    // Pin the featured example contracts so there is always something live to watch.
    const have = new Set((await store.listContracts(project.id)).map((c) => c.address.toLowerCase()));
    for (const f of listFeatured()) {
      if (have.has(f.address.toLowerCase())) continue;
      const ex = f.example ? getExample(f.example) : null;
      await store.createContract({ projectId: project.id, address: f.address, name: f.title, abi: ex?.abi ?? null, startBlock: f.startBlock ?? null });
    }
    playgroundReady = { project, endpoint };
    return playgroundReady;
  }

  router.add("GET", "/api/v1/playground", async () => {
    const { project, endpoint } = await ensurePlayground();
    const [contracts, recent, receiver] = await Promise.all([
      withCounts(project.id),
      store.searchEvents({ projectId: project.id, limit: 12 }),
      store.getReceiverByEndpoint(endpoint.id),
    ]);
    const requests = receiver ? await store.listReceiverRequests(receiver.id, 8) : [];
    return {
      projectId: project.id,
      network: config.networkLabel,
      pinned: [...pinnedAddresses()],
      ping: { sponsored: !!config.pinger, contract: config.pinger?.contract ?? listFeatured().find((f) => f.example === "ping")?.address ?? null, sponsor: config.pinger?.address ?? null, perDay: config.demoPingsPerDay ?? 30 },
      maxContracts: PLAYGROUND_MAX_CONTRACTS,
      contracts,
      events: recent.items.map(eventView),
      receiver: requests.map((r) => ({ outcome: r.outcome, httpStatus: r.httpStatus, signatureOk: r.signatureOk, eventId: r.eventId, receivedAt: r.receivedAt })),
    };
  }, "none");

  router.add("POST", "/api/v1/playground/watch", async (ctx) => {
    const { project } = await ensurePlayground();
    const wait = await playgroundLimiter.hit("pgwatch:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Easy there — try again in ${wait}s.`);
    const body = parse(pgWatchSchema, ctx.body);
    const existing = await store.listContracts(project.id);
    const match = existing.find((c) => c.address.toLowerCase() === body.address.toLowerCase());
    if (match) return contractView(match, (await store.contractEventCounts(project.id))[match.address] ?? 0);
    const pinned = pinnedAddresses();
    if (existing.filter((c) => !pinned.has(c.address.toLowerCase())).length >= PLAYGROUND_MAX_CONTRACTS) {
      throw new ApiError(409, "playground_full", "The playground is watching its maximum number of contracts right now. Try again later, or sign up for your own project.");
    }
    const ex = body.example ? getExample(body.example) : null;
    if (body.example && !ex) throw new ApiError(422, "validation_failed", `Unknown example "${body.example}".`);
    const verified = ex ? null : await store.getVerifiedContract(body.address);
    const c = await store.createContract({ projectId: project.id, address: body.address, name: verified?.name ?? null, abi: ex?.abi ?? verified?.abi ?? null, startBlock: null });
    if (!c) throw new ApiError(409, "contract_exists", "That contract is already being watched.");
    await store.log("info", "config", `Playground watch ${c.address}`, undefined, project.id);
    return { __status: 201, data: contractView(c) };
  }, "none");

  // ---- "make an event happen": send a REAL ping to the testnet from the page, then watch PortalOps capture it
  const pgPingLimiter = makeLimiter("pgping", 1, 5 * 60_000); // one sponsored ping per visitor per 5 minutes
  const pgPingSchema = z.object({ note: z.string().max(200).optional() });
  const MIN_SPONSOR_BALANCE = 5n * 10n ** 18n; // below this the demo wallet is "out of funds" and visitors are sent to their own wallet
  let sponsorBalance: { at: number; wei: bigint } | null = null;

  router.add("POST", "/api/v1/playground/ping", async (ctx) => {
    const pinger = config.pinger;
    if (!pinger) throw new ApiError(503, "ping_unavailable", "This server does not send pings for visitors. Use your own wallet below, or call the contract yourself.");
    await ensurePlayground(); // makes sure the contract is being watched before the event exists
    const wait = await pgPingLimiter.hit("pgping:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `One free ping per visitor every 5 minutes. Try again in ${Math.max(1, Math.ceil(wait / 60))} min, or use your own wallet.`);
    const cap = config.demoPingsPerDay ?? 30;
    const today = await store.hitRateLimit("demoping:" + now().toISOString().slice(0, 10), 86_400_000, now().getTime());
    if (today.hits > cap) throw new ApiError(429, "daily_limit", `The demo wallet has sent its ${cap} free pings for today. Use your own wallet, or come back tomorrow.`);
    if (!sponsorBalance || now().getTime() - sponsorBalance.at > 60_000) {
      sponsorBalance = { at: now().getTime(), wei: await pinger.balanceWei().catch(() => 0n) };
    }
    if (sponsorBalance.wei < MIN_SPONSOR_BALANCE) throw new ApiError(503, "demo_wallet_empty", "The demo wallet is out of testnet funds right now. Use your own wallet below.");
    const body = parse(pgPingSchema, ctx.body);
    const note = cleanNote(body.note) || "hello from the PortalOps playground";
    try {
      const { hash } = await pinger.send(note);
      await store.log("info", "playground", `Sponsored ping sent: ${hash}`);
      return { transactionHash: hash, from: pinger.address, contract: pinger.contract, note };
    } catch (e) {
      await store.log("warn", "playground", `Sponsored ping failed: ${e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : "unknown"}`);
      throw new ApiError(502, "ping_failed", "The testnet did not accept the transaction right now. Try again in a moment, or use your own wallet.");
    }
  }, "none");

  /** What PortalOps has stored for one transaction hash: the decoded event(s), their finality and whether they were delivered. */
  router.add("GET", "/api/v1/playground/tx/:hash", async (ctx) => {
    const { project } = await ensurePlayground();
    if (!/^0x[0-9a-fA-F]{64}$/.test(ctx.params.hash)) throw new ApiError(422, "validation_failed", "A transaction hash is 0x followed by 64 hex characters.");
    const hash = ctx.params.hash.toLowerCase();
    const found = (await store.searchEvents({ projectId: project.id, search: hash, limit: 10 })).items.filter((e) => e.transactionHash === hash);
    const status = await store.deliveryStatusByEvent(found.map((e) => e.id));
    return { transactionHash: hash, events: found.map((e) => ({ ...eventView(e), delivery: status[e.id] ?? null })) };
  }, "none");

  router.add("POST", "/api/v1/playground/test-delivery", async (ctx) => {
    const { endpoint } = await ensurePlayground();
    const wait = await playgroundLimiter.hit("pgtest:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Easy there — try again in ${wait}s.`);
    const found = await store.getEndpointWithSecret(endpoint.id);
    if (!found) throw new ApiError(503, "unavailable", "The playground receiver is not ready.");
    const secret = decryptSecret(found.encryptedSecret, config.encryptionKey);
    const payload = JSON.stringify({ id: "evt_test_" + randomUUID().replaceAll("-", "").slice(0, 16), type: "webhook.test", network: config.networkId, data: { message: "PortalOps playground test delivery. Not a blockchain event." } });
    const { timestamp, header } = signHeader(secret, payload, now());
    const r = await sendWebhook(endpoint.url, payload, { "portalops-signature": header, "portalops-timestamp": String(timestamp), "portalops-event-id": "test", "portalops-delivery-id": "test", "portalops-attempt": "1" }, { timeoutMs: endpoint.retryPolicy.timeoutMs, guard });
    return { ok: r.status !== null && r.status >= 200 && r.status < 300, status: r.status, errorCode: r.errorCode, durationMs: r.durationMs };
  }, "none");

  // ------------------------------------------------------------------- auth
  const publicUrl = (config.publicUrl ?? "http://localhost:5173").replace(/\/+$/, "");
  const outbound = config.fetch ?? fetch;
  const resendLimiter = makeLimiter("resend", 1, 60_000); // one verification email per user per minute
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref(); });

  /** What the browser is told about an account: never the hash. */
  const userView = (u: UserRecord) => ({ id: u.id, email: u.email, mfaEnabled: u.totpEnabledAt !== null, emailVerified: u.emailVerifiedAt !== null, githubLinked: u.githubId !== null, githubLogin: u.githubLogin, hasPassword: u.passwordHash !== NO_PASSWORD });
  const newToken = () => randomBytes(32).toString("base64url");

  /** Creates a single-use link token and emails it. Returns whether the provider accepted the message. */
  async function sendAccountEmail(kind: "verify_email" | "reset_password", user: { id: string; email: string }): Promise<boolean> {
    if (!config.email) return false;
    const token = newToken();
    const ttl = kind === "verify_email" ? VERIFY_TTL_MS : RESET_TTL_MS;
    await store.createAuthToken(user.id, kind, hashToken(token), new Date(now().getTime() + ttl), now());
    // The token travels in the URL FRAGMENT: it is never sent to a server, logged by a proxy, or leaked in a Referer header.
    const link = `${publicUrl}/auth#${kind === "verify_email" ? "verify" : "reset"}=${token}`;
    const msg = kind === "verify_email" ? verifyEmailMessage(user.email, link, VERIFY_TTL_MS / 3_600_000) : resetPasswordMessage(user.email, link, RESET_TTL_MS / 60_000);
    const r = await config.email.send(msg);
    if (!r.ok) console.warn(`account email (${kind}) not sent: ${r.error}`);
    return r.ok;
  }

  router.add("POST", "/api/v1/auth/signup", async (ctx) => {
    const wait = await authLimiter.hit("signup:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    const body = parse(schemas.signup, ctx.body);
    const user = await store.createUser(body.email, await hashPassword(body.password));
    if (!user) throw new ApiError(409, "email_taken", "An account with this email already exists.");
    await store.audit("auth.signup", user.id, null);
    // Best effort and capped: a slow or failing email provider must never block or fail sign-up.
    await Promise.race([sendAccountEmail("verify_email", user).catch(() => false), sleep(3_000)]);
    const full = (await store.getUser(user.id))!;
    return await startSession(ctx, user.id, userView(full), 201);
  }, "none");

  router.add("POST", "/api/v1/auth/login", async (ctx) => {
    const body = parse(schemas.login, ctx.body);
    const wait = Math.max(await authLimiter.hit("login:" + ctx.ip), await authLimiter.hit("login-email:" + body.email));
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    const user = await store.getUserByEmail(body.email);
    // Accounts without a password (GitHub-only) are checked against the dummy hash, so they cost the same time as any wrong password.
    const hasPassword = !!user && user.passwordHash !== NO_PASSWORD;
    const ok = (await verifyPassword(body.password, hasPassword ? user!.passwordHash : await dummyHash())) && hasPassword;
    if (!user || !ok) {
      await store.audit("auth.login_failed", user?.id ?? null, null);
      throw new ApiError(401, "invalid_credentials", "Incorrect email or password."); // same message for both cases
    }
    if (user.totpEnabledAt) {
      // Right password, but this account needs a second factor: no session yet, just a short-lived challenge to answer with a code.
      const challenge = newToken();
      await store.createAuthToken(user.id, "mfa_login", hashToken(challenge), new Date(now().getTime() + MFA_CHALLENGE_TTL_MS), now());
      await store.audit("auth.login_mfa_required", user.id, null);
      return { mfaRequired: true, challenge };
    }
    await store.audit("auth.login", user.id, null);
    return await startSession(ctx, user.id, userView(user), 200);
  }, "none");

  // ---- two-factor sign-in (TOTP). GitHub sign-in is not asked for a code: GitHub enforces its own two-factor on the account.
  const MFA_CHALLENGE_TTL_MS = 5 * 60_000;

  /** Accepts a current authenticator code or an unused recovery code for a user who has two-factor on. Each is single-use. */
  async function checkSecondFactor(userId: string, code: string): Promise<"totp" | "recovery" | null> {
    const t = await store.getTotp(userId);
    if (!t?.enabledAt || !t.secretEnc) return null;
    const v = verifyTotp(decryptSecret(t.secretEnc, config.encryptionKey), code, now().getTime(), t.lastStep);
    if (v.ok) return (await store.claimTotpStep(userId, v.step)) ? "totp" : null;
    if (/^[a-z0-9]{5}[\s-]?[a-z0-9]{5}$/i.test(code.trim()) && await store.useRecoveryCode(userId, hashRecoveryCode(code))) return "recovery";
    return null;
  }
  const mfaThrottle = async (ctx: Ctx, userId: string) => {
    const wait = Math.max(await authLimiter.hit("mfa:" + ctx.ip), await authLimiter.hit("mfa-user:" + userId));
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
  };
  const badCode = () => new ApiError(401, "invalid_code", "That code is not right, or it was already used. Codes change every 30 seconds.");

  router.add("POST", "/api/v1/auth/login/mfa", async (ctx) => {
    const body = parse(schemas.mfaLogin, ctx.body);
    const userId = await store.peekAuthToken("mfa_login", hashToken(body.challenge), now());
    if (!userId) throw new ApiError(401, "challenge_expired", "That sign-in expired. Enter your password again.");
    await mfaThrottle(ctx, userId);
    const how = await checkSecondFactor(userId, body.code);
    if (!how) { await store.audit("auth.mfa_failed", userId, null); throw badCode(); }
    if (!await store.consumeAuthToken("mfa_login", hashToken(body.challenge), now())) throw new ApiError(401, "challenge_expired", "That sign-in expired. Enter your password again.");
    await store.audit("auth.login", userId, null, { second: how });
    return await startSession(ctx, userId, userView((await store.getUser(userId))!), 200);
  }, "none");

  router.add("GET", "/api/v1/auth/mfa", async (ctx) => {
    sessionOnly(ctx);
    const t = await store.getTotp(requireUser(ctx));
    return { enabled: !!t?.enabledAt, recoveryCodesLeft: t?.enabledAt ? t.recoveryLeft : 0 };
  });

  router.add("POST", "/api/v1/auth/mfa/setup", async (ctx) => {
    sessionOnly(ctx);
    const userId = requireUser(ctx);
    const user = (await store.getUser(userId))!;
    const secret = newTotpSecret();
    if (!await store.setTotpSecret(userId, encryptSecret(secret, config.encryptionKey))) throw new ApiError(409, "mfa_already_enabled", "Two-factor sign-in is already on. Turn it off first to set it up again.");
    return { secret, otpauthUri: otpauthUri(user.email, secret) }; // shown once, to be added to an authenticator app
  });

  router.add("POST", "/api/v1/auth/mfa/enable", async (ctx) => {
    sessionOnly(ctx);
    const userId = requireUser(ctx);
    await mfaThrottle(ctx, userId);
    const body = parse(schemas.mfaCode, ctx.body);
    const t = await store.getTotp(userId);
    if (!t?.secretEnc || t.enabledAt) throw new ApiError(409, "mfa_not_pending", "Start setup first.");
    const v = verifyTotp(decryptSecret(t.secretEnc, config.encryptionKey), body.code, now().getTime(), null);
    if (!v.ok) throw badCode();
    const recoveryCodes = newRecoveryCodes();
    if (!await store.enableTotp(userId, now(), v.step, recoveryCodes.map(hashRecoveryCode))) throw new ApiError(409, "mfa_not_pending", "Start setup first.");
    await store.audit("auth.mfa_enabled", userId, null);
    return { enabled: true, recoveryCodes }; // the only time they are shown
  });

  router.add("POST", "/api/v1/auth/mfa/recovery-codes", async (ctx) => {
    sessionOnly(ctx);
    const userId = requireUser(ctx);
    await mfaThrottle(ctx, userId);
    const body = parse(schemas.mfaCode, ctx.body);
    if (!await checkSecondFactor(userId, body.code)) throw badCode();
    const recoveryCodes = newRecoveryCodes();
    await store.setRecoveryCodes(userId, recoveryCodes.map(hashRecoveryCode));
    await store.audit("auth.mfa_recovery_regenerated", userId, null);
    return { recoveryCodes };
  });

  router.add("POST", "/api/v1/auth/mfa/disable", async (ctx) => {
    sessionOnly(ctx);
    const userId = requireUser(ctx);
    await mfaThrottle(ctx, userId);
    const body = parse(schemas.mfaDisable, ctx.body);
    const user = (await store.getUser(userId))!;
    if (user.passwordHash !== NO_PASSWORD && !(body.password && await verifyPassword(body.password, user.passwordHash))) throw new ApiError(401, "invalid_credentials", "Enter your current password to turn two-factor off.");
    if (!await checkSecondFactor(userId, body.code)) throw badCode();
    await store.disableTotp(userId);
    await store.audit("auth.mfa_disabled", userId, null);
    return { enabled: false };
  });

  async function startSession(ctx: Ctx, userId: string, user: ReturnType<typeof userView>, status: number) {
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
    return { user: userView(user) };
  });

  // ---- sign-in options, email verification, password reset
  router.add("GET", "/api/v1/auth/providers", async () => ({ github: !!config.github, email: !!config.email && config.email.kind !== "console" }), "none");

  const invalidToken = () => new ApiError(400, "invalid_token", "This link is invalid or has expired. Request a new one.");

  router.add("POST", "/api/v1/auth/verify-email", async (ctx) => {
    const wait = await authLimiter.hit("verify:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    const { token } = parse(schemas.token, ctx.body);
    const userId = await store.consumeAuthToken("verify_email", hashToken(token), now());
    if (!userId) throw invalidToken();
    await store.markEmailVerified(userId, now());
    await store.audit("auth.email_verified", userId, null);
    return { verified: true };
  }, "none");

  router.add("POST", "/api/v1/auth/resend-verification", async (ctx) => {
    sessionOnly(ctx);
    const userId = requireUser(ctx);
    const user = await store.getUser(userId);
    if (!user) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true };
    const wait = await resendLimiter.hit("resend:" + userId);
    if (wait) throw new ApiError(429, "rate_limited", `Please wait ${wait}s before asking for another email.`);
    const ok = await sendAccountEmail("verify_email", user);
    if (!ok) throw new ApiError(503, "email_unavailable", "We couldn't send the email right now. Try again in a few minutes.");
    return { sent: true };
  });

  router.add("POST", "/api/v1/auth/forgot-password", async (ctx) => {
    const body = parse(schemas.forgot, ctx.body);
    const wait = Math.max(await authLimiter.hit("forgot:" + ctx.ip), await authLimiter.hit("forgot-email:" + body.email));
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    // The same answer, in the same time, whether or not the account exists: the email (if any) is sent in the background.
    void (async () => {
      const user = await store.getUserByEmail(body.email);
      if (user) await sendAccountEmail("reset_password", user);
    })().catch((e) => console.warn("forgot-password work failed:", e instanceof Error ? e.message : e));
    return { sent: true, message: "If an account exists for that address, a reset link is on its way." };
  }, "none");

  router.add("POST", "/api/v1/auth/reset-password", async (ctx) => {
    const wait = await authLimiter.hit("reset:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    const body = parse(schemas.reset, ctx.body);
    const userId = await store.consumeAuthToken("reset_password", hashToken(body.token), now());
    if (!userId) throw invalidToken();
    await store.setPassword(userId, await hashPassword(body.password));
    await store.markEmailVerified(userId, now()); // they just proved they control the inbox
    await store.revokeAllSessions(userId);       // anyone who had the old password is signed out everywhere
    await store.audit("auth.password_reset", userId, null);
    return { reset: true };
  }, "none");

  // ---- GitHub sign-in (OAuth authorization-code flow)
  const oauthCookie = (value: string, maxAge: number) =>
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/api/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? "; Secure" : ""}`;
  const authError = (code: string) => ({ __redirect: `${publicUrl}/auth#error=${code}`, __headers: { "set-cookie": oauthCookie("", 0) } });
  const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

  router.add("GET", "/api/v1/auth/github/start", async (ctx) => {
    if (!config.github) throw new ApiError(404, "github_unavailable", "GitHub sign-in is not configured on this server.");
    const wait = await authLimiter.hit("gh-start:" + ctx.ip);
    if (wait) throw new ApiError(429, "rate_limited", `Too many attempts. Try again in ${wait}s.`);
    const state = randomBytes(24).toString("base64url");
    const q = new URLSearchParams({ client_id: config.github.clientId, redirect_uri: `${publicUrl}/api/v1/auth/github/callback`, scope: "read:user user:email", state, allow_signup: "true" });
    return { __redirect: `https://github.com/login/oauth/authorize?${q}`, __headers: { "set-cookie": oauthCookie(state, 600) } };
  }, "none");

  router.add("GET", "/api/v1/auth/github/callback", async (ctx) => {
    if (!config.github) return authError("github_unavailable");
    const wait = await authLimiter.hit("gh-cb:" + ctx.ip);
    if (wait) return authError("rate_limited");
    const q = ctx.url.searchParams;
    const expected = parseCookies(ctx.req.headers.cookie)[OAUTH_COOKIE] ?? "";
    const state = q.get("state") ?? "";
    if (!expected || !state || !safeEqual(expected, state)) return authError("state_mismatch");   // forged or replayed callback
    if (q.get("error")) return authError("access_denied");
    const code = q.get("code");
    if (!code || code.length > 200) return authError("github_failed");

    const gh = async <T>(url: string, init: RequestInit): Promise<T | null> => {
      try {
        const r = await outbound(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
        return r.ok ? ((await r.json()) as T) : null;
      } catch { return null; }
    };
    const tok = await gh<{ access_token?: string }>("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: `${publicUrl}/api/v1/auth/github/callback` }),
    });
    if (!tok?.access_token) return authError("github_failed");
    const headers = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "PortalOps" };
    const profile = await gh<{ id?: number; login?: string }>("https://api.github.com/user", { headers });
    const emails = await gh<{ email: string; primary: boolean; verified: boolean }[]>("https://api.github.com/user/emails", { headers });
    if (!profile?.id || !profile.login || !Array.isArray(emails)) return authError("github_failed");
    // Only an address GitHub itself has verified may identify an account here.
    const verified = emails.filter((e) => e.verified);
    const chosen = (verified.find((e) => e.primary) ?? verified[0])?.email?.toLowerCase();
    if (!chosen) return authError("github_no_verified_email");

    const githubId = String(profile.id);
    let user = await store.getUserByGithubId(githubId);
    if (!user) {
      const existing = await store.getUserByEmail(chosen);
      if (existing) {
        if (existing.githubId && existing.githubId !== githubId) return authError("github_account_mismatch");
        if (!existing.emailVerifiedAt) {
          // Someone registered this address with a password but never proved they own it. GitHub just did, so the real owner takes
          // the account over: the unproven password stops working and every session of it is revoked.
          await store.setPassword(existing.id, NO_PASSWORD);
          await store.revokeAllSessions(existing.id);
          await store.markEmailVerified(existing.id, now());
          await store.audit("auth.github_reclaim", existing.id, null);
        }
        await store.linkGithub(existing.id, githubId, profile.login);
        user = (await store.getUser(existing.id))!;
      } else {
        const created = await store.createUser(chosen, NO_PASSWORD, { verified: true, githubId, githubLogin: profile.login });
        if (!created) return authError("github_failed");
        user = (await store.getUser(created.id))!;
        await store.audit("auth.signup", user.id, null, { via: "github" });
      }
    }
    await store.audit("auth.login", user.id, null, { via: "github" });
    const { token, hash } = newSessionToken();
    await store.createSession(hash, user.id, new Date(now().getTime() + config.sessionTtlMs));
    return { __redirect: `${publicUrl}/app`, __headers: { "set-cookie": [sessionCookie(token, Math.floor(config.sessionTtlMs / 1000), config.cookieSecure), oauthCookie("", 0)] } };
  }, "none");


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
    const wait = await actionLimiter.hit("nettest:" + ctx.userId);
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
    if (JSON.stringify(body.abi ?? []).length > 524_288) throw new ApiError(422, "validation_failed", "The ABI or metadata is too large (512 KiB max).");
    const invalid = (path: string, message: string) => new ApiError(422, "validation_failed", "The request is not valid.", [{ path, message }]);
    let address = body.address;
    if (body.type === "ink") {
      // An ink! (Rust) contract on the native runtime: an SS58 address and the contract metadata file that cargo-contract writes.
      const ss58 = await canonicalSs58(body.address);
      if (!ss58 || !ANY_ADDRESS.test(ss58)) throw invalid("address", "Must be a valid SS58 address (it starts with 5).");
      address = ss58;
      if (!body.abi || Array.isArray(body.abi) || !looksLikeInkMetadata(body.abi)) throw invalid("abi", "Upload the contract metadata file (the .contract or metadata.json from cargo contract build).");
      try { await loadInkAbi(body.abi); } catch { throw invalid("abi", "That is not valid ink! contract metadata."); }
    } else {
      if (!ADDRESS.test(body.address)) throw invalid("address", "Must be a 0x-prefixed 20-byte address.");
      if (body.abi && !Array.isArray(body.abi)) throw invalid("abi", "A Solidity ABI is a JSON array. For an ink! contract, choose the ink! type.");
    }
    // No ABI given for an EVM contract that is verified in the registry: use the verified one, so its events are decoded without any setup.
    const verified = body.type !== "ink" && !body.abi ? await store.getVerifiedContract(address) : null;
    const c = await store.createContract({ projectId: p.id, address, name: body.name ?? verified?.name ?? null, abi: body.abi ?? verified?.abi ?? null, startBlock: body.startBlock ?? null, deploymentTxHash: body.deploymentTxHash ?? null, runtimeType: body.type });
    if (!c) throw new ApiError(409, "contract_exists", "This contract is already registered in the project.");
    await store.audit("contract.add", ctx.userId, p.id, { address: c.address });
    await store.log("info", "config", `Contract ${c.address} registered`, undefined, p.id);
    return { __status: 201, data: contractView(c) };
  });

  /** One shape for every contract response: no ABI body, but whether there is one and which events it declares. */
  const contractView = (c: ContractRecord, eventCount = 0) => ({
    ...c, abi: undefined, hasAbi: c.abi !== null, eventCount,
    events: !c.abi ? [] : c.runtimeType === "ink" ? inkEventNames(c.abi) : (c.abi as { type?: string; name?: string }[]).filter((x) => x.type === "event" && x.name).map((x) => x.name as string),
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
    const wait = await actionLimiter.hit("ctest:" + ctx.userId);
    if (wait) throw new ApiError(429, "rate_limited", `Try again in ${wait}s.`);
    if (c.runtimeType === "ink") {
      if (!network.inkContractExists) throw new ApiError(503, "unavailable", "This server has no connection to the native Portaldot runtime.");
      const found = await network.inkContractExists(c.address).catch((e: unknown) => { throw new ApiError(502, "rpc_unavailable", e instanceof Error ? e.message : "Native RPC unavailable"); });
      return { address: c.address, codeFound: found, runtimeCodeBytes: 0, note: found ? "An ink! contract is deployed at this address." : "No ink! contract at this address on the native runtime." };
    }
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
    const wait = await actionLimiter.hit("replay:" + ctx.userId);
    if (wait) throw new ApiError(429, "rate_limited", `Too many replays. Try again in ${wait}s.`);
    const body = parse(schemas.replay, ctx.body);
    const targets = body.endpointId ? [(await endpointFor(ctx, body.endpointId)).endpoint] : (await store.listEndpoints(p.id)).filter((x) => x.enabled);
    if (body.endpointId && targets[0].projectId !== p.id) throw notFound();
    if (!targets.length) throw new ApiError(409, "no_endpoints", "This project has no enabled webhook endpoints to replay to.");
    const ids = await Promise.all(targets.map((t) => replayEvent(store, e.id, t.id, now())));
    await store.audit("event.replay", ctx.userId, p.id, { eventId: e.id, deliveryIds: ids });
    return { __status: 202, data: { deliveryIds: ids, note: "Queued. The stored event payload will be re-delivered; the original transaction is not resubmitted." } };
  });

  // ------------------------------------------------------------ delivery diagnostics
  const aiLimiter = makeLimiter("ai", 10, 60_000);
  /** The recorded evidence for one delivery, after checking the caller owns its project (404 otherwise, like everything else). */
  async function deliveryEvidence(ctx: Ctx) {
    const d = await store.getDelivery(ctx.params.deliveryId);
    const event = d ? await store.getEvent(d.eventId) : null;
    if (!d || !event) throw notFound();
    const p = await ownedProject(ctx, event.projectId);
    const [attempts, endpoint] = [await store.listAttempts(d.id), await store.getEndpoint(d.endpointId)];
    return { project: p, delivery: d, evidence: buildEvidence({ event, delivery: d, attempts, endpoint }) };
  }

  router.add("GET", "/api/v1/deliveries/:deliveryId/diagnosis", async (ctx) => {
    const { evidence } = await deliveryEvidence(ctx);
    // `evidence` is exactly what an AI explanation would be given, so the user can read it before asking for one.
    return { rules: diagnoseRules(evidence), evidence, ai: { available: !!config.ai, model: config.ai?.model ?? null } };
  });

  router.add("POST", "/api/v1/deliveries/:deliveryId/diagnosis/ai", async (ctx) => {
    if (!config.ai) throw new ApiError(503, "ai_unavailable", "AI explanations are not turned on for this server. The rule-based diagnosis is available.");
    const { project: p, delivery, evidence } = await deliveryEvidence(ctx);
    const wait = await aiLimiter.hit("ai:" + ctx.userId);
    if (wait) throw new ApiError(429, "rate_limited", `Try again in ${wait}s.`);
    const rules = diagnoseRules(evidence);
    try {
      const explanation = await explainWithModel(evidence, rules, config.ai);
      await store.audit("diagnosis.ai", ctx.userId, p.id, { deliveryId: delivery.id, model: config.ai.model });
      return { explanation, source: "model", model: config.ai.model, rules, evidence };
    } catch (e) {
      await store.log("warn", "diagnostics", `AI explanation for ${delivery.id} failed: ${e instanceof Error ? e.message : "unknown error"}`, undefined, p.id);
      throw new ApiError(502, "ai_failed", "The AI service could not explain this right now. The rule-based diagnosis is still available.");
    }
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
    const wait = await actionLimiter.hit("whtest:" + ctx.userId);
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
  const receiverLimiter = makeLimiter("receiver", 120, 60_000);
  const hold = (ms: number, req: IncomingMessage) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref(); req.on("close", () => { clearTimeout(t); resolve(); }); });

  router.add("POST", "/api/v1/hooks/:token", async (ctx) => {
    const receiver = await store.getReceiverByTokenHash(hashReceiverToken(ctx.params.token));
    if (!receiver) throw notFound(); // same answer for malformed and unknown tokens
    const wait = await receiverLimiter.hit("rcv:" + receiver.id);
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
  const DEFAULT_KEY_DAYS = 90; // secure by default: a key that is forgotten eventually stops working

  router.add("POST", "/api/v1/projects/:projectId/api-keys", async (ctx) => {
    sessionOnly(ctx);
    const p = await ownedProject(ctx, ctx.params.projectId);
    const body = parse(schemas.apiKey, ctx.body);
    if (await store.countActiveApiKeys(p.id) >= MAX_ACTIVE_KEYS) throw new ApiError(409, "key_limit", `A project can have up to ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`);
    const key = "pops_" + randomBytes(32).toString("base64url"); // 256 bits of randomness, so a plain SHA-256 lookup hash is appropriate
    const days = body.expiresInDays === undefined ? DEFAULT_KEY_DAYS : body.expiresInDays;
    const expiresAt = days === null ? null : new Date(now().getTime() + days * 86_400_000).toISOString();
    const rec = await store.createApiKey({ projectId: p.id, name: body.name, scope: body.scope, prefix: key.slice(0, 12), keyHash: hashApiKey(key), createdBy: ctx.userId, expiresAt });
    await store.audit("api_key.create", ctx.userId, p.id, { keyId: rec.id, scope: rec.scope, name: rec.name, expiresAt });
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

      const wait = await globalLimiter.hit("ip:" + ip);
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
        if (found.expiresAt && now().getTime() >= new Date(found.expiresAt).getTime()) throw new ApiError(401, "api_key_expired", "This API key has expired. Create a new one in Settings → API keys.");
        const wait = await keyLimiter.hit("key:" + found.id);
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

      if (result && typeof result === "object" && "__redirect" in result) {
        const r = result as { __redirect: string; __headers?: Record<string, string | string[]> };
        res.writeHead(302, { location: r.__redirect, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", ...(r.__headers ?? {}) });
        res.end();
        return;
      }
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
