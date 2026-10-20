// Shared domain types. Kept free of runtime code so every package can import them.

export type NetworkId = "portaldot-v3-testnet";

/**
 * Honest chain-status vocabulary (PRD principle 7). "finalized" is only ever set from the network's own finality signal.
 * - included:  observed in a block, fewer than `confirmationDepth` blocks deep
 * - confirmed: at least `confirmationDepth` blocks deep (a depth heuristic, NOT protocol finality)
 * - finalized: at or below the node's `finalized` block AND its block hash was verified to be the canonical one at that height.
 *              Terminal: a finalized event is never downgraded and cannot be reorganised away.
 * - orphaned:  the block it was observed in is not on the canonical chain
 */
export type FinalityStatus = "included" | "confirmed" | "finalized" | "orphaned";

export interface NormalizedEvent {
  /** Deterministic id: hash of chain id + block hash + tx hash + log index. */
  id: string;
  projectId: string;
  network: NetworkId;
  source: "evm" | "native";
  chainId: number;
  contractAddress: string;
  /** Null when no ABI was available to decode the log. */
  eventName: string | null;
  decoded: boolean;
  topics: string[];
  data: string;
  /** Decoded arguments, JSON-safe (bigint → string). Null when undecoded. */
  payload: Record<string, unknown> | null;
  transactionHash: string;
  transactionIndex: number;
  blockNumber: number;
  blockHash: string;
  /** Log index within the block. */
  eventIndex: number;
  observedAt: string;
  processingStatus: "persisted";
  finalityStatus: FinalityStatus;
}

/** A raw EVM log as returned by eth_getLogs, with hex quantities already parsed. */
export interface RawEvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
}

export interface BlockRef {
  number: number;
  hash: string;
}

/** What the ingestion worker needs from a chain. Implemented by the EVM adapter and by test fakes. */
export interface ChainAdapter {
  readonly chainId: number;
  readonly source: "evm" | "native";
  getHead(): Promise<BlockRef>;
  getBlock(number: number): Promise<BlockRef | null>;
  /** The network's finalized head, or null if the node does not expose a finality signal. Never guessed from depth. */
  getFinalized(): Promise<BlockRef | null>;
  getLogs(fromBlock: number, toBlock: number, addresses?: string[]): Promise<RawEvmLog[]>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Stop retrying once the delivery is older than this. */
  maxAgeMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 5_000,
  maxDelayMs: 60 * 60 * 1000,
  maxAgeMs: 24 * 60 * 60 * 1000,
  timeoutMs: 10_000,
};

export type DeliveryStatus = "pending" | "retrying" | "delivered" | "failed";

export interface WebhookEndpoint {
  id: string;
  projectId: string;
  url: string;
  description: string | null;
  enabled: boolean;
  /** Event names this endpoint receives; empty = all. */
  eventFilter: string[];
  retryPolicy: RetryPolicy;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  /** "initial" for the first delivery of an event, "replay"/"retry" when a user asked for it. */
  kind: "initial" | "replay";
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastResponseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookAttempt {
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
