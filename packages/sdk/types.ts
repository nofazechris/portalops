// Response shapes of the PortalOps REST API (v1). Hand-written to match apps/api; the SDK tests run against the real API so
// drift shows up as a failing test.

export type FinalityStatus = "included" | "confirmed" | "finalized" | "orphaned";
export type DeliveryStatus = "pending" | "retrying" | "delivered" | "failed";
export type ReceiverMode = "ok" | "fail500" | "fail400" | "timeout";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  kind: "user" | "public_demo" | "playground";
  networkId: string;
  createdAt: string;
}

export interface PortalEvent {
  id: string;
  projectId: string;
  network: string;
  source: "evm" | "native";
  contractAddress: string;
  /** null when no ABI was registered for the contract (the log is stored undecoded). */
  eventName: string | null;
  decoded: boolean;
  /** Decoded arguments, JSON-safe (bigint values are strings). null when undecoded. */
  payload: Record<string, unknown> | null;
  topics: string[];
  data: string;
  transactionHash: string;
  transactionIndex: number;
  blockNumber: number;
  blockHash: string;
  eventIndex: number;
  observedAt: string;
  processingStatus: "persisted";
  finalityStatus: FinalityStatus;
}

export interface EventListItem extends PortalEvent {
  /** Most recent delivery state for this event, or null if no delivery was ever created. */
  delivery: { status: DeliveryStatus; count: number } | null;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string;
  responseStatus: number | null;
  responseDurationMs: number;
  sanitisedResponse: string | null;
  errorCode: string | null;
}

export interface Delivery {
  id: string;
  eventId: string;
  endpointId: string;
  kind: "initial" | "replay";
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastResponseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryWithAttempts extends Delivery {
  attempts: DeliveryAttempt[];
}

export interface EventDetail extends PortalEvent {
  deliveries: DeliveryWithAttempts[];
}

/** A ready-made example contract from the public catalog. */
export interface ExampleSummary {
  id: string;
  title: string;
  tagline: string;
  category: string;
  contractName: string;
  events: { name: string; meaning: string }[];
}

export interface ExampleDetail extends ExampleSummary {
  description: string;
  eventDetails: { name: string; meaning: string; samplePayload: Record<string, string>; idea: string }[];
  source: string;
  abi: Record<string, unknown>[];
  /** Creation bytecode, for deploying with any EVM tool. */
  bytecode: string;
  /** Repo command that deploys it (needs your own funded testnet key in .env). */
  deployCommand: string;
  /** A Node.js receiver that verifies signatures and handles every event of this contract. */
  handler: string;
  compiler: { name: string; version: string; evmVersion: string; optimizerRuns: number };
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventListParams {
  /** Search transaction hash, contract address, event name or event id. */
  q?: string;
  contract?: string;
  event?: string;
  finality?: FinalityStatus;
  delivery?: DeliveryStatus;
  limit?: number;
  offset?: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAgeMs: number;
  timeoutMs: number;
}

export interface Webhook {
  id: string;
  projectId: string;
  url: string;
  description: string | null;
  enabled: boolean;
  eventFilter: string[];
  retryPolicy: RetryPolicy;
  createdAt: string;
  /** True when the endpoint is the PortalOps-hosted test receiver. */
  builtinReceiver: boolean;
}

/** Returned once, on creation. The signing secret cannot be retrieved afterwards; use `rotateSecret`. */
export interface CreatedWebhook extends Webhook {
  secret: string;
}

export interface CreateWebhookInput {
  /** Required unless `builtinReceiver` is true. */
  url?: string;
  builtinReceiver?: boolean;
  description?: string;
  /** Event names to receive. Empty or omitted = every event. */
  eventFilter?: string[];
  retryPolicy?: Partial<RetryPolicy>;
  enabled?: boolean;
}

export interface UpdateWebhookInput {
  url?: string;
  description?: string | null;
  enabled?: boolean;
  eventFilter?: string[];
  retryPolicy?: Partial<RetryPolicy>;
}

export interface WebhookTestResult {
  ok: boolean;
  status: number | null;
  errorCode: string | null;
  durationMs: number;
  response: string | null;
}

export interface Contract {
  id: string;
  projectId: string;
  address: string;
  name: string | null;
  runtimeType: string;
  startBlock: number | null;
  deploymentTxHash: string | null;
  status: string;
  createdAt: string;
  hasAbi: boolean;
  eventCount: number;
  /** Event names found in the ABI. */
  events: string[];
}

export interface AddContractInput {
  address: string;
  name?: string;
  /** The contract ABI (array), used to decode logs. Without it, logs are stored undecoded. */
  abi?: Record<string, unknown>[];
  startBlock?: number;
  deploymentTxHash?: string;
}

export interface ContractTestResult {
  address: string;
  codeFound: boolean;
  runtimeCodeBytes: number;
  note: string;
}

export interface Overview {
  project: Project;
  metrics: { eventsReceived: number; delivered: number; failed: number; retrying: number; pending: number; activeWebhooks: number };
  network: NetworkStatus;
  recentEvents: EventListItem[];
  setup: { networkConnected: boolean; contractAdded: boolean; webhookConfigured: boolean; firstEventReceived: boolean; firstDeliverySucceeded: boolean; completed: number; total: number };
  nextAction: string | null;
}

export interface NetworkStatus {
  network: string;
  chainId: number;
  connection: "connected" | "disconnected" | "wrong_chain";
  headBlock: number | null;
  rpcLatencyMs: number;
  rpcError: string | null;
  ingestion: "never_run" | "healthy" | "stalled" | "unknown";
  cursorBlock: number | null;
  lagBlocks: number | null;
  lastIngestionAt: string | null;
  lastEventObservedAt: string | null;
}

export interface ProjectDelivery extends Delivery {
  event: { id: string; eventName: string | null; contractAddress: string; transactionHash: string; blockNumber: number };
}

export interface Automation {
  id: string;
  projectId: string;
  name: string;
  triggerEventName: string | null;
  triggerContract: string | null;
  endpointId: string;
  enabled: boolean;
  createdAt: string;
}

export interface CreateAutomationInput {
  name: string;
  triggerEventName?: string | null;
  triggerContract?: string | null;
  endpointId: string;
}

export interface ReplayResult {
  deliveryIds: string[];
  note: string;
}

/** The JSON body PortalOps POSTs to a webhook endpoint. */
export interface WebhookPayload {
  id: string;
  type: "event.received";
  network: string;
  data: {
    eventName: string | null;
    decoded: boolean;
    contractAddress: string;
    payload: Record<string, unknown> | null;
    topics: string[];
    data: string;
    transactionHash: string;
    blockNumber: number;
    blockHash: string;
    eventIndex: number;
    observedAt: string;
    finalityStatus: FinalityStatus;
  };
}
