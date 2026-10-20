import type { BlockRef, ChainAdapter, RawEvmLog } from "../shared-types/index.ts";
import { BlockUnavailableError } from "./errors.ts";

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
}

/** Minimal JSON-RPC EVM adapter over HTTP. Polling only: no EVM WebSocket URL was announced. */
export class EvmAdapter implements ChainAdapter {
  readonly source = "evm" as const;
  private nextId = 0;

  readonly chainId: number;
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;

  constructor(rpcUrl: string, chainId: number, timeoutMs = 30_000) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.timeoutMs = timeoutMs;
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.nextId, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message} (code ${body.error.code})`);
    return body.result as T;
  }

  /** Throws if the endpoint is on a different chain than configured. Call once at startup. */
  async assertChain(): Promise<void> {
    const id = Number(BigInt(await this.rpc<string>("eth_chainId")));
    if (id !== this.chainId) throw new Error(`RPC reports chain ID ${id}, expected ${this.chainId}`);
  }

  async getHead(): Promise<BlockRef> {
    const b = await this.rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["latest", false]);
    return { number: Number(BigInt(b.number)), hash: b.hash.toLowerCase() };
  }

  /** Uses the standard "finalized" block tag. Returns null if the node rejects it, so callers fall back to depth heuristics. */
  async getFinalized(): Promise<BlockRef | null> {
    try {
      const b = await this.rpc<{ number: string; hash: string } | null>("eth_getBlockByNumber", ["finalized", false]);
      return b ? { number: Number(BigInt(b.number)), hash: b.hash.toLowerCase() } : null;
    } catch {
      return null;
    }
  }

  async getBlock(number: number): Promise<BlockRef | null> {
    try {
      const b = await this.rpc<{ number: string; hash: string } | null>("eth_getBlockByNumber", ["0x" + number.toString(16), false]);
      return b ? { number: Number(BigInt(b.number)), hash: b.hash.toLowerCase() } : null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/State already discarded|UnknownBlock|pruned/i.test(msg)) throw new BlockUnavailableError(number, "state discarded");
      throw e;
    }
  }

  async getCode(address: string): Promise<string> {
    return this.rpc<string>("eth_getCode", [address, "latest"]);
  }

  async getLogs(fromBlock: number, toBlock: number, addresses?: string[]): Promise<RawEvmLog[]> {
    const filter: Record<string, unknown> = { fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16) };
    if (addresses?.length) filter.address = addresses;
    const logs = await this.rpc<RpcLog[]>("eth_getLogs", [filter]);
    return logs.map((l) => ({
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
      blockNumber: Number(BigInt(l.blockNumber)),
      blockHash: l.blockHash.toLowerCase(),
      transactionHash: l.transactionHash.toLowerCase(),
      transactionIndex: Number(BigInt(l.transactionIndex)),
      logIndex: Number(BigInt(l.logIndex)),
      removed: l.removed === true,
    }));
  }
}
