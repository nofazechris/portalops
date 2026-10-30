// "Verify against the chain": does the event PortalOps stored match what the chain itself says?
//
// This file has no imports on purpose. The same code runs on the server (for the API, the SDK and the Claude tools) and in the visitor's own
// browser, where it asks the public RPC directly, so a visitor can check an event without trusting PortalOps at all.

/** The fields of a stored event that the chain can confirm. */
export interface CheckableEvent {
  source: string;
  contractAddress: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  eventIndex: number;
}

export interface ChainLog { address: string; topics: string[]; data: string; blockNumber: number; blockHash: string; transactionHash: string; logIndex: number }
export interface ChainReceipt { status: boolean; blockNumber: number; blockHash: string; transactionHash: string; logs: ChainLog[] }

export type Verdict = "verified" | "mismatch" | "not_found" | "unavailable" | "not_applicable";
export interface Check { id: string; label: string; ok: boolean; detail?: string }
export interface ChainCheckResult {
  verdict: Verdict;
  /** One sentence a person can read. */
  summary: string;
  checks: Check[];
  /** Blocks on top of the event's block at the time of the check, when known. */
  confirmations: number | null;
  /** The log exactly as the chain returned it (what the stored event was compared with). */
  chainLog: ChainLog | null;
}

const lower = (s: unknown) => String(s ?? "").toLowerCase();
const num = (v: unknown): number => (typeof v === "string" && v.startsWith("0x") ? parseInt(v, 16) : Number(v));

/** Turns a raw eth_getTransactionReceipt result (hex quantities) into plain numbers. Null stays null. */
export function parseReceipt(raw: any): ChainReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const logs: ChainLog[] = Array.isArray(raw.logs)
    ? raw.logs.map((l: any) => ({ address: lower(l.address), topics: (l.topics ?? []).map(lower), data: lower(l.data), blockNumber: num(l.blockNumber), blockHash: lower(l.blockHash), transactionHash: lower(l.transactionHash), logIndex: num(l.logIndex) }))
    : [];
  return { status: num(raw.status) === 1, blockNumber: num(raw.blockNumber), blockHash: lower(raw.blockHash), transactionHash: lower(raw.transactionHash), logs };
}

const short = (h: string) => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);

/**
 * Compares a stored event with the receipt the chain returned for its transaction.
 * `receipt` null means the chain does not know that transaction right now.
 */
export function compareToReceipt(event: CheckableEvent, receipt: ChainReceipt | null, headBlock: number | null = null): ChainCheckResult {
  if (event.source !== "evm") {
    return { verdict: "not_applicable", summary: "Checking Rust (ink!) events against the native node is not available yet. EVM events can be checked.", checks: [], confirmations: null, chainLog: null };
  }
  if (!receipt) {
    return {
      verdict: "not_found",
      summary: "The chain does not know this transaction right now. If the event is old, the block it was in may have been reorganised away.",
      checks: [{ id: "tx", label: "Transaction exists on the chain", ok: false, detail: short(event.transactionHash) }],
      confirmations: null, chainLog: null,
    };
  }

  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });

  add("tx", "Transaction exists on the chain", receipt.transactionHash === lower(event.transactionHash), short(receipt.transactionHash));
  add("status", "Transaction succeeded (a reverted transaction emits no events)", receipt.status);
  add("block_hash", "In the same block (hash matches)", receipt.blockHash === lower(event.blockHash), `chain: ${short(receipt.blockHash)} · stored: ${short(lower(event.blockHash))}`);
  add("block_number", "Same block number", receipt.blockNumber === event.blockNumber, `chain: ${receipt.blockNumber} · stored: ${event.blockNumber}`);

  const log = receipt.logs.find((l) => l.logIndex === event.eventIndex) ?? null;
  add("log", `The chain has a log at index ${event.eventIndex}`, log !== null);
  if (log) {
    add("address", "Emitted by the same contract", log.address === lower(event.contractAddress), short(log.address));
    const topicsOk = log.topics.length === event.topics.length && log.topics.every((t, i) => t === lower(event.topics[i]));
    add("topics", "Same topics (event signature and indexed values)", topicsOk, topicsOk ? `${log.topics.length} topics` : `chain has ${log.topics.length}, stored has ${event.topics.length}`);
    add("data", "Same data", log.data === lower(event.data), `${(log.data.length - 2) / 2} bytes`);
  }

  const ok = checks.every((c) => c.ok);
  const confirmations = headBlock !== null && headBlock >= receipt.blockNumber ? headBlock - receipt.blockNumber : null;
  return {
    verdict: ok ? "verified" : "mismatch",
    summary: ok
      ? "The chain confirms it: this exact log was emitted by this contract in this block."
      : `The stored event does not match the chain: ${checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join("; ")}.`,
    checks, confirmations, chainLog: log,
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

async function rpc(rpcUrl: string, method: string, params: unknown[], fetchImpl: FetchLike, timeoutMs: number): Promise<any> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl?.signal });
    if (!res.ok) throw new Error(`The RPC answered HTTP ${res.status}.`);
    const j = await res.json();
    if (j.error) throw new Error(`The RPC returned an error: ${String(j.error.message ?? "unknown").slice(0, 120)}`);
    return j.result;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Asks the RPC about the event's transaction and compares. Never throws: an unreachable RPC is reported as "unavailable", which is neither a pass nor a fail.
 * Works the same on the server and in a browser (pass `fetch`).
 */
export async function verifyEventAgainstChain(event: CheckableEvent, opts: { rpcUrl: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<ChainCheckResult> {
  if (event.source !== "evm") return compareToReceipt(event, null);
  const f: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const t = opts.timeoutMs ?? 10_000;
  try {
    const [raw, head] = await Promise.all([
      rpc(opts.rpcUrl, "eth_getTransactionReceipt", [event.transactionHash], f, t),
      rpc(opts.rpcUrl, "eth_blockNumber", [], f, t).catch(() => null),
    ]);
    return compareToReceipt(event, parseReceipt(raw), head ? num(head) : null);
  } catch (e) {
    return { verdict: "unavailable", summary: `Could not reach the chain to check: ${e instanceof Error ? e.message : "unknown error"} Try again in a moment.`, checks: [], confirmations: null, chainLog: null };
  }
}
