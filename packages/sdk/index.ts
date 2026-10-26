import type {
  AddContractInput, Automation, Contract, ContractTestResult, CreateAutomationInput, CreateWebhookInput, CreatedWebhook, DeliveryAiExplanation, DeliveryDiagnosis, DeliveryStatus,
  DeliveryWithAttempts, EventDetail, ExampleDetail, ExampleSummary, EventListItem, EventListParams, NetworkStatus, Overview, Page, Project, ProjectDelivery,
  ReceiverMode, ReplayResult, UpdateWebhookInput, Webhook, WebhookTestResult,
} from "./types.ts";

export * from "./types.ts";
export { verifyWebhookSignature, constructEvent, SignatureVerificationError, SIGNATURE_HEADER, DEFAULT_TOLERANCE_SECONDS } from "./verify.ts";
export type { VerifyResult, VerifyOptions } from "./verify.ts";

/** Every failure surfaces as this error, whether it came from the API, the network or a timeout. */
export class PortalOpsError extends Error {
  /** HTTP status, or 0 when no response was received (network failure, timeout). */
  readonly status: number;
  /** Machine-readable code, e.g. `invalid_api_key`, `not_found`, `validation_failed`, `rate_limited`, `timeout`, `network_error`. */
  readonly code: string;
  /** Field-level problems for `validation_failed`. */
  readonly details?: { path: string; message: string }[];
  /** Seconds to wait before retrying, when the API said so (HTTP 429). */
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, extra: { details?: { path: string; message: string }[]; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "PortalOpsError";
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

export interface PortalOpsOptions {
  /** A project API key (`pops_…`). Create one in the dashboard under Settings → API keys. Never ship it to a browser. */
  apiKey: string;
  /** Where PortalOps is hosted, e.g. `https://portalops.example.com`. Falls back to the PORTALOPS_API_URL environment variable. */
  baseUrl?: string;
  /** The project to act on. Optional: a key belongs to exactly one project, which is discovered on first use. */
  projectId?: string;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Retries for idempotent reads on network errors, 429 and 5xx. Default 2. Writes are never retried automatically. */
  maxRetries?: number;
  /** Custom fetch implementation (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined | null>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Client for the PortalOps REST API.
 *
 * ```ts
 * const portal = new PortalOps({ apiKey: process.env.PORTALOPS_API_KEY!, baseUrl: "https://portalops.example.com" });
 * const { items } = await portal.events.list({ finality: "finalized", limit: 20 });
 * await portal.events.replay(items[0].id);
 * ```
 */
export class PortalOps {
  readonly events: EventsApi;
  readonly webhooks: WebhooksApi;
  readonly contracts: ContractsApi;
  readonly deliveries: DeliveriesApi;
  readonly automations: AutomationsApi;
  readonly project: ProjectApi;
  readonly examples: ExamplesApi;

  private readonly apiKey: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private projectIdCache: string | undefined;

  constructor(options: PortalOpsOptions) {
    if (!options || typeof options.apiKey !== "string" || !/^pops_[A-Za-z0-9_-]{20,}$/.test(options.apiKey)) {
      throw new TypeError("PortalOps: `apiKey` must be a project API key starting with \"pops_\".");
    }
    const baseUrl = options.baseUrl ?? (typeof process !== "undefined" ? process.env.PORTALOPS_API_URL : undefined);
    if (!baseUrl) throw new TypeError("PortalOps: `baseUrl` is required (or set PORTALOPS_API_URL).");
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new TypeError(`PortalOps: \`baseUrl\` is not a valid URL: ${baseUrl}`); }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
      throw new TypeError("PortalOps: `baseUrl` must use https (plain http is only allowed for localhost), otherwise the API key is sent in the clear.");
    }
    this.apiKey = options.apiKey;
    this.base = url.origin + url.pathname.replace(/\/+$/, "") + "/api/v1";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
    this.projectIdCache = options.projectId;

    this.events = new EventsApi(this);
    this.webhooks = new WebhooksApi(this);
    this.contracts = new ContractsApi(this);
    this.deliveries = new DeliveriesApi(this);
    this.automations = new AutomationsApi(this);
    this.project = new ProjectApi(this);
    this.examples = new ExamplesApi(this);
  }

  /** The project this key acts on. Resolved once and cached. */
  async projectId(): Promise<string> {
    if (this.projectIdCache) return this.projectIdCache;
    const projects = await this.request<Project[]>("GET", "/projects");
    if (!projects[0]) throw new PortalOpsError(404, "not_found", "This API key's project could not be found.");
    this.projectIdCache = projects[0].id;
    return this.projectIdCache;
  }

  /** @internal */
  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const url = this.base + path + (qs.size ? "?" + qs : "");
    const idempotent = method === "GET";
    const attempts = idempotent ? this.maxRetries + 1 : 1;

    let lastError: PortalOpsError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once<T>(method, url, opts.body);
      } catch (e) {
        if (!(e instanceof PortalOpsError)) throw e;
        lastError = e;
        const retryable = e.status === 0 || e.status === 429 || e.status >= 500;
        if (!retryable || attempt === attempts) throw e;
        await sleep(Math.min(5_000, e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : 250 * 2 ** (attempt - 1)));
      }
    }
    throw lastError ?? new PortalOpsError(0, "network_error", "Request failed.");
  }

  private async once<T>(method: string, url: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error", // never forward the Authorization header to another host
      });
    } catch (e) {
      const err = e as { name?: string; cause?: { code?: string } };
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new PortalOpsError(0, "timeout", `Request timed out after ${this.timeoutMs}ms.`);
      throw new PortalOpsError(0, "network_error", `Could not reach PortalOps: ${err.cause?.code ?? (e instanceof Error ? e.message : String(e))}`);
    }
    let json: { data?: T; error?: { code?: string; message?: string; details?: { path: string; message: string }[] } } | null = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new PortalOpsError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? `Request failed with HTTP ${res.status}.`, {
        details: json?.error?.details,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      });
    }
    return json?.data as T;
  }
}

class Resource {
  protected readonly c: PortalOps;
  constructor(client: PortalOps) { this.c = client; }
}

class ExamplesApi extends Resource {
  /** The public catalog of example contracts (source, ABI, deploy command and a webhook receiver for each). */
  list(): Promise<ExampleSummary[]> { return this.c.request("GET", "/examples"); }
  get(id: string): Promise<ExampleDetail> { return this.c.request("GET", `/examples/${enc(id)}`); }
}

class ProjectApi extends Resource {
  async get(): Promise<Project> { return this.c.request("GET", `/projects/${await this.c.projectId()}`); }
  async overview(): Promise<Overview> { return this.c.request("GET", `/projects/${await this.c.projectId()}/overview`); }
  async networkStatus(): Promise<NetworkStatus> { return this.c.request("GET", `/projects/${await this.c.projectId()}/network/status`); }
}

class EventsApi extends Resource {
  async list(params: EventListParams = {}): Promise<Page<EventListItem>> {
    return this.c.request("GET", `/projects/${await this.c.projectId()}/events`, { query: { ...params } });
  }
  /** One event with its full delivery history (every attempt, status and response). */
  get(id: string): Promise<EventDetail> { return this.c.request("GET", `/events/${enc(id)}`); }
  /**
   * Re-delivers the STORED event to one endpoint (or all enabled endpoints). The on-chain transaction is never resubmitted and
   * the event is unchanged; consumers should de-duplicate on the event id.
   */
  replay(id: string, opts: { endpointId?: string } = {}): Promise<ReplayResult> {
    return this.c.request("POST", `/events/${enc(id)}/replay`, { body: opts.endpointId ? { endpointId: opts.endpointId } : {} });
  }
  /** Async iterator over every matching event, newest first, fetching pages as needed. */
  async *iterate(params: Omit<EventListParams, "offset"> = {}): AsyncGenerator<EventListItem, void, void> {
    const limit = params.limit ?? 100;
    for (let offset = 0; ; offset += limit) {
      const page = await this.list({ ...params, limit, offset });
      yield* page.items;
      if (offset + limit >= page.total || page.items.length === 0) return;
    }
  }
}

class WebhooksApi extends Resource {
  async list(): Promise<Webhook[]> { return this.c.request("GET", `/projects/${await this.c.projectId()}/webhooks`); }
  /** The returned `secret` is shown ONCE. Store it now; it cannot be read back (use `rotateSecret` to replace it). */
  async create(input: CreateWebhookInput): Promise<CreatedWebhook> { return this.c.request("POST", `/projects/${await this.c.projectId()}/webhooks`, { body: input }); }
  update(id: string, patch: UpdateWebhookInput): Promise<Webhook> { return this.c.request("PATCH", `/webhooks/${enc(id)}`, { body: patch }); }
  async delete(id: string): Promise<void> { await this.c.request("DELETE", `/webhooks/${enc(id)}`); }
  /** Sends a signed test delivery and returns the receiver's response. Not stored as an event. */
  test(id: string): Promise<WebhookTestResult> { return this.c.request("POST", `/webhooks/${enc(id)}/test`, { body: {} }); }
  /** Replaces the signing secret. The old one stops working immediately. The new one is returned once. */
  rotateSecret(id: string): Promise<{ id: string; secret: string }> { return this.c.request("POST", `/webhooks/${enc(id)}/rotate-secret`, { body: {} }); }
  deliveries(id: string, params: { status?: DeliveryStatus; limit?: number } = {}): Promise<DeliveryWithAttempts[]> {
    return this.c.request("GET", `/webhooks/${enc(id)}/deliveries`, { query: params });
  }
  /** Built-in test receiver only: choose how the hosted receiver answers, to rehearse retries and replay. */
  setReceiverMode(id: string, mode: ReceiverMode): Promise<{ mode: ReceiverMode }> { return this.c.request("PATCH", `/webhooks/${enc(id)}/receiver`, { body: { mode } }); }
}

class ContractsApi extends Resource {
  async list(): Promise<Contract[]> { return this.c.request("GET", `/projects/${await this.c.projectId()}/contracts`); }
  async add(input: AddContractInput): Promise<Contract> { return this.c.request("POST", `/projects/${await this.c.projectId()}/contracts`, { body: input }); }
  /** Read-only: checks whether bytecode exists at the address on the connected network. */
  test(id: string): Promise<ContractTestResult> { return this.c.request("POST", `/contracts/${enc(id)}/test`, { body: {} }); }
}

class DeliveriesApi extends Resource {
  /** Why a delivery failed, from the attempts PortalOps recorded. Free and deterministic; includes the evidence an AI explanation would see. */
  diagnosis(deliveryId: string): Promise<DeliveryDiagnosis> { return this.c.request("GET", `/deliveries/${enc(deliveryId)}/diagnosis`); }
  /** A written explanation from a Claude model (needs a write key; `ai_unavailable` if the server has no model configured). */
  explain(deliveryId: string): Promise<DeliveryAiExplanation> { return this.c.request("POST", `/deliveries/${enc(deliveryId)}/diagnosis/ai`, { body: {} }); }
  /** Deliveries across the whole project, e.g. `{ status: "failed" }` for everything awaiting replay. */
  async list(params: { status?: DeliveryStatus; limit?: number } = {}): Promise<ProjectDelivery[]> {
    return this.c.request("GET", `/projects/${await this.c.projectId()}/deliveries`, { query: params });
  }
}

class AutomationsApi extends Resource {
  async list(): Promise<Automation[]> { return this.c.request("GET", `/projects/${await this.c.projectId()}/automations`); }
  async create(input: CreateAutomationInput): Promise<Automation> { return this.c.request("POST", `/projects/${await this.c.projectId()}/automations`, { body: input }); }
  setEnabled(id: string, enabled: boolean): Promise<Automation> { return this.c.request("PATCH", `/automations/${enc(id)}`, { body: { enabled } }); }
  async delete(id: string): Promise<void> { await this.c.request("DELETE", `/automations/${enc(id)}`); }
}

const enc = encodeURIComponent;
