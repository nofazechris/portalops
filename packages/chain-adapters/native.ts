import type { BlockRef, ChainAdapter, RawEvmLog } from "../shared-types/index.ts";
import { BlockUnavailableError } from "./errors.ts";

/**
 * Native Portaldot (Substrate) reader for ink! contracts. Portaldot's runtime has the Contracts pallet next to pallet-revive, so a
 * contract written in Rust with ink! emits `Contracts.ContractEmitted { contract, data }` runtime events. This reads them block by block
 * (read-only: it never signs or submits anything) and hands them to the same decode / store / deliver pipeline the EVM path uses.
 *
 * Differences from the EVM reader that matter to callers:
 *  - Events are read from each block's `System.Events` STORAGE, which the node only keeps for recent blocks (about the last 256 by
 *    default). Unlike `eth_getLogs`, a native read cannot reach arbitrarily far back, so a first read starts near the head.
 *  - Contract addresses are SS58 strings (prefix 42), compared in their canonical form.
 */

/** One `ContractEmitted` event as read from a block. `data` is the SCALE-encoded ink! event (decoded later with the contract's metadata). */
export interface RawInkEvent {
  /** SS58 address of the contract, canonical form (prefix 42). */
  contract: string;
  /** 0x-prefixed event bytes. */
  data: string;
  /** The event record's topics (hex). ink! 5 puts the event's signature in the first one, which is how its metadata identifies it. */
  topics: string[];
  blockNumber: number;
  blockHash: string;
  /** Position of the event within the block's event list. */
  eventIndex: number;
  /** The extrinsic that caused it, or null if it was emitted outside any extrinsic. */
  extrinsicIndex: number | null;
  extrinsicHash: string | null;
}

/** What the native ingestion needs from a chain. Implemented by PolkadotNativeChain and by test fakes. */
export interface NativeChain {
  /** Identifies the chain (genesis hash), part of every native event id. */
  readonly genesisHash: string;
  getHead(): Promise<BlockRef>;
  getBlock(number: number): Promise<BlockRef | null>;
  /** The node's finalized head. Null if unavailable; never guessed. */
  getFinalized(): Promise<BlockRef | null>;
  /** `ContractEmitted` events in [from, to] from the given contracts (all contracts when `contracts` is omitted). */
  getContractEvents(from: number, to: number, contracts?: Set<string>): Promise<RawInkEvent[]>;
  /** Whether a contract is deployed at this SS58 address. */
  contractExists(address: string): Promise<boolean>;
  close(): Promise<void>;
}

/** The same address in the chain's canonical SS58 form, or null if it is not a valid address. */
export async function canonicalSs58(address: string, prefix = 42): Promise<string | null> {
  try {
    const { decodeAddress, encodeAddress } = await import("@polkadot/util-crypto");
    return encodeAddress(decodeAddress(address.trim()), prefix);
  } catch {
    return null;
  }
}

/** Lets the shared finality code (which speaks ChainAdapter) check native blocks. Logs do not exist natively, so getLogs is empty. */
export function asChainAdapter(chain: NativeChain, chainId: number): ChainAdapter {
  return {
    chainId,
    source: "native",
    getHead: () => chain.getHead(),
    getBlock: (n) => chain.getBlock(n),
    getFinalized: () => chain.getFinalized(),
    getLogs: async (): Promise<RawEvmLog[]> => [],
  };
}

const isPruned = (e: unknown): boolean => /discarded|pruned|unknown block|not found|State already/i.test(e instanceof Error ? e.message : String(e));

/** Real implementation over @polkadot/api (loaded on first use, so processes that never touch ink! contracts do not pay for it). */
export class PolkadotNativeChain implements NativeChain {
  genesisHash = "";
  // The polkadot-js types are large; this adapter is the only place that sees them.
  private api: any;
  private constructor(api: unknown) { this.api = api; }

  static async connect(wsUrl: string, timeoutMs = 20_000): Promise<PolkadotNativeChain> {
    const { ApiPromise, WsProvider } = await import("@polkadot/api");
    const provider = new WsProvider(wsUrl, 2_500, {}, timeoutMs);
    const api = await Promise.race([
      ApiPromise.create({ provider, noInitWarn: true }),
      new Promise<never>((_, rej) => setTimeout(() => { provider.disconnect().catch(() => {}); rej(new Error(`Native RPC ${wsUrl} did not answer within ${timeoutMs / 1000}s`)); }, timeoutMs).unref()),
    ]);
    const c = new PolkadotNativeChain(api);
    c.genesisHash = api.genesisHash.toHex();
    return c;
  }

  private ref(header: { number: { toNumber(): number }; hash: { toHex(): string } }): BlockRef {
    return { number: header.number.toNumber(), hash: header.hash.toHex() };
  }

  async getHead(): Promise<BlockRef> { return this.ref(await this.api.rpc.chain.getHeader()); }

  async getBlock(number: number): Promise<BlockRef | null> {
    const hash = await this.api.rpc.chain.getBlockHash(number);
    if (!hash || hash.isEmpty) return null;
    return { number, hash: hash.toHex() };
  }

  async getFinalized(): Promise<BlockRef | null> {
    try {
      const hash = await this.api.rpc.chain.getFinalizedHead();
      return this.ref(await this.api.rpc.chain.getHeader(hash));
    } catch { return null; }
  }

  async getContractEvents(from: number, to: number, contracts?: Set<string>): Promise<RawInkEvent[]> {
    const out: RawInkEvent[] = [];
    for (let n = from; n <= to; n++) {
      const hash = await this.api.rpc.chain.getBlockHash(n);
      if (!hash || hash.isEmpty) throw new Error(`Block ${n} has no hash yet`);
      let records: any[];
      try {
        const at = await this.api.at(hash);
        records = [...(await at.query.system.events())];
      } catch (e) {
        if (isPruned(e)) throw new BlockUnavailableError(n, "the node has discarded that block's state");
        throw e;
      }
      const found: { idx: number; r: any }[] = [];
      for (let i = 0; i < records.length; i++) {
        const ev = records[i].event;
        if (ev.section === "contracts" && ev.method === "ContractEmitted") found.push({ idx: i, r: records[i] });
      }
      if (!found.length) continue;
      let extrinsics: any[] | null = null;
      for (const { idx, r } of found) {
        const contract = r.event.data[0].toString() as string; // SS58 in the chain's own prefix (42)
        if (contracts && !contracts.has(contract)) continue;
        if (!extrinsics) extrinsics = [...(await this.api.rpc.chain.getBlock(hash)).block.extrinsics];
        const exIdx = r.phase.isApplyExtrinsic ? (r.phase.asApplyExtrinsic.toNumber() as number) : null;
        out.push({
          contract,
          data: r.event.data[1].toHex(),
          topics: [...r.topics].map((t: any) => t.toHex() as string),
          blockNumber: n,
          blockHash: hash.toHex(),
          eventIndex: idx,
          extrinsicIndex: exIdx,
          extrinsicHash: exIdx !== null && extrinsics[exIdx] ? (extrinsics[exIdx].hash.toHex() as string) : null,
        });
      }
    }
    return out;
  }

  async contractExists(address: string): Promise<boolean> {
    const info = await this.api.query.contracts.contractInfoOf(address);
    return info.isSome;
  }

  async close(): Promise<void> { try { await this.api.disconnect(); } catch { /* already closed */ } }
}
