import { createHash } from "node:crypto";
import { decodeEventLog, type Abi } from "viem";
import type { FinalityStatus, NormalizedEvent, RawEvmLog } from "../shared-types/index.ts";

/**
 * Stable identity for an EVM log within a project (PRD §10.3): project + chain id + block hash + tx hash + log index.
 * Timestamps are deliberately not part of it. Including the block hash means a log that reappears
 * in a different block after a reorg is a distinct event, while a re-read of the same log is a duplicate.
 * The project is part of the identity because two projects may watch the same contract: each needs its own
 * copy of the event (own deliveries, own history), and ids must stay globally unique so /events/:id is unambiguous.
 */
export function evmEventId(projectId: string, chainId: number, blockHash: string, transactionHash: string, logIndex: number): string {
  const material = `evm:${projectId}:${chainId}:${blockHash.toLowerCase()}:${transactionHash.toLowerCase()}:${logIndex}`;
  return "evt_" + createHash("sha256").update(material).digest("hex").slice(0, 32);
}

const jsonSafe = (v: unknown): unknown => {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
};

export interface NormalizeContext {
  projectId: string;
  chainId: number;
  /** ABIs keyed by lower-case contract address. Logs from unknown contracts are stored undecoded. */
  abis?: Map<string, Abi>;
  now?: () => Date;
  finalityStatus?: FinalityStatus;
}

export function normalizeEvmLog(log: RawEvmLog, ctx: NormalizeContext): NormalizedEvent {
  const address = log.address.toLowerCase();
  const abi = ctx.abis?.get(address);

  let eventName: string | null = null;
  let payload: Record<string, unknown> | null = null;
  if (abi) {
    try {
      const d = decodeEventLog({ abi, data: log.data as `0x${string}`, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      eventName = d.eventName ?? null;
      payload = (jsonSafe(d.args ?? {}) as Record<string, unknown>) ?? {};
    } catch {
      // ABI present but this log does not match it: keep the raw log, mark undecoded. Never invent a name.
    }
  }

  return {
    id: evmEventId(ctx.projectId, ctx.chainId, log.blockHash, log.transactionHash, log.logIndex),
    projectId: ctx.projectId,
    network: "portaldot-v3-testnet",
    source: "evm",
    chainId: ctx.chainId,
    contractAddress: address,
    eventName,
    decoded: eventName !== null,
    topics: log.topics.map((t) => t.toLowerCase()),
    data: log.data,
    payload,
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: log.transactionIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    eventIndex: log.logIndex,
    observedAt: (ctx.now ?? (() => new Date()))().toISOString(),
    processingStatus: "persisted",
    finalityStatus: ctx.finalityStatus ?? "included",
  };
}
