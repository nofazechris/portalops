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

const isPruned = (e: unknown): boolean => /discarded|pruned|unknown block|not found|State already|header not found/i.test(e instanceof Error ? e.message : String(e));

// polkadot-js is loaded on first use, so processes that never touch ink! contracts do not pay for it. This adapter talks to the node
// with the plain JSON-RPC provider and decodes events with a type registry built from the node's own metadata. It deliberately avoids
// ApiPromise: that opens background subscriptions and asks for every block's state, and this node answers a burst of requests by dropping
// the connection (and polkadot-js then throws from inside the socket handler, which would take the whole worker down).

const CALL_TIMEOUT_MS = 20_000;
const hexNum = (h: string): number => Number.parseInt(h, 16);

export class PolkadotNativeChain implements NativeChain {
  genesisHash = "";
  private provider: any;
  private registry: any;
  private lib!: { xxhashAsU8a: (d: Uint8Array | string, bits?: 64 | 128 | 192 | 256 | 320 | 384 | 448 | 512) => Uint8Array; blake2AsHex: (d: Uint8Array, bits?: 64 | 128 | 256 | 384 | 512) => string; decodeAddress: (a: string) => Uint8Array; hexToU8a: (h: string) => Uint8Array; u8aConcat: (...a: Uint8Array[]) => Uint8Array; u8aToHex: (a: Uint8Array) => string };
  private eventsKey = "";
  private constructor() {}

  static async connect(wsUrl: string, timeoutMs = 20_000): Promise<PolkadotNativeChain> {
    const [{ WsProvider }, { TypeRegistry, Metadata }, crypto, util] = await Promise.all([import("@polkadot/rpc-provider"), import("@polkadot/types"), import("@polkadot/util-crypto"), import("@polkadot/util")]);
    const c = new PolkadotNativeChain();
    c.lib = { xxhashAsU8a: crypto.xxhashAsU8a, blake2AsHex: crypto.blake2AsHex, decodeAddress: crypto.decodeAddress, hexToU8a: util.hexToU8a, u8aConcat: util.u8aConcat, u8aToHex: util.u8aToHex };
    const provider = new WsProvider(wsUrl, 2_500, {}, timeoutMs);
    provider.on("error", () => { /* surfaced through the request that was waiting; reconnecting is automatic */ });
    c.provider = provider;
    try {
      await Promise.race([
        new Promise<void>((resolve) => provider.on("connected", () => resolve())),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Native RPC ${wsUrl} did not answer within ${timeoutMs / 1000}s`)), timeoutMs).unref()),
      ]);
      c.genesisHash = (await c.call<string>("chain_getBlockHash", [0])) ?? "";
      await c.loadMetadata(Metadata, TypeRegistry);
    } catch (e) {
      await provider.disconnect().catch(() => {});
      throw e;
    }
    // System.Events: twox128("System") ++ twox128("Events")
    c.eventsKey = util.u8aToHex(util.u8aConcat(crypto.xxhashAsU8a("System", 128), crypto.xxhashAsU8a("Events", 128)));
    return c;
  }

  /** A JSON-RPC call with a timeout; a closed connection is an error (the caller reconnects), never a hang. */
  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.provider.isConnected) throw new Error("Native RPC is not connected");
    return await Promise.race([
      this.provider.send(method, params) as Promise<T>,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Native RPC ${method} timed out`)), CALL_TIMEOUT_MS).unref()),
    ]);
  }

  private async loadMetadata(Metadata?: any, TypeRegistry?: any): Promise<void> {
    if (!Metadata) ({ Metadata, TypeRegistry } = await import("@polkadot/types"));
    const registry = new TypeRegistry();
    registry.setMetadata(new Metadata(registry, await this.call<string>("state_getMetadata")));
    const props = await this.call<Record<string, unknown>>("system_properties").catch(() => null);
    if (props) registry.setChainProperties(registry.createType("ChainProperties", props));
    this.registry = registry;
  }

  private async header(hash?: string): Promise<{ number: number; hash: string }> {
    const h = hash ?? (await this.call<string>("chain_getBlockHash", []));
    const head = await this.call<{ number: string } | null>("chain_getHeader", [h]);
    if (!head) throw new Error(`Block ${h} has no header`);
    return { number: hexNum(head.number), hash: h };
  }

  async getHead(): Promise<BlockRef> { return await this.header(); }

  async getBlock(number: number): Promise<BlockRef | null> {
    const hash = await this.call<string | null>("chain_getBlockHash", [number]);
    return hash ? { number, hash } : null;
  }

  async getFinalized(): Promise<BlockRef | null> {
    try { return await this.header(await this.call<string>("chain_getFinalizedHead")); } catch { return null; }
  }

  /** Event records in a stored System.Events value. If the runtime was upgraded since the metadata was read, it is read again once. */
  private async decodeRecords(valueHex: string | null): Promise<any[]> {
    if (!valueHex) return [];
    const bytes = this.lib.hexToU8a(valueHex);
    try {
      return [...this.registry.createType("Vec<FrameSystemEventRecord>", bytes)];
    } catch {
      await this.loadMetadata();
      return [...this.registry.createType("Vec<FrameSystemEventRecord>", bytes)];
    }
  }

  /**
   * ContractEmitted events in [from, to]. Instead of asking for every block's events (hundreds of requests), it asks ONCE which blocks changed
   * the System.Events storage between the two ends. A block that is not listed has exactly the events of the last listed block before it,
   * so every block's events can be reconstructed from the listed ones, and only blocks whose events contain a ContractEmitted cost any
   * further requests.
   */
  async getContractEvents(from: number, to: number, contracts?: Set<string>): Promise<RawInkEvent[]> {
    const hashAt = async (n: number) => {
      const h = await this.call<string | null>("chain_getBlockHash", [n]);
      if (!h) throw new Error(`Block ${n} has no hash yet`);
      return h;
    };
    const hFrom = await hashAt(from);
    const hTo = to === from ? hFrom : await hashAt(to);

    let changes: { block: string; changes: [string, string | null][] }[];
    let atFrom: string | null;
    try {
      [changes, atFrom] = await Promise.all([
        this.call<typeof changes>("state_queryStorage", [[this.eventsKey], hFrom, hTo]),
        this.call<string | null>("state_getStorage", [this.eventsKey, hFrom]),
      ]);
    } catch (e) {
      if (isPruned(e)) throw new BlockUnavailableError(from, "the node has discarded that block's state");
      throw e;
    }

    // The value of System.Events at each block where it changed, in block order, starting at `from`.
    const numbered: { number: number; value: string | null }[] = [];
    for (let i = 0; i < changes.length; i += 8) {
      const slice = changes.slice(i, i + 8);
      const heads = await Promise.all(slice.map((c) => this.header(c.block)));
      slice.forEach((c, j) => numbered.push({ number: heads[j].number, value: c.changes[0]?.[1] ?? null }));
    }
    numbered.sort((a, b) => a.number - b.number);
    if (!numbered.length || numbered[0].number > from) numbered.unshift({ number: from, value: atFrom }); // make sure the start is covered
    const sets: { number: number; records: any[] }[] = [];
    for (const n of numbered) sets.push({ number: n.number, records: await this.decodeRecords(n.value) });

    const out: RawInkEvent[] = [];
    for (let i = 0; i < sets.length; i++) {
      const found: { idx: number; r: any }[] = [];
      sets[i].records.forEach((r: any, idx: number) => { if (r.event.section === "contracts" && r.event.method === "ContractEmitted") found.push({ idx, r }); });
      const wanted = found.filter(({ r }) => !contracts || contracts.has(r.event.data[0].toString()));
      if (!wanted.length) continue;
      const last = Math.min(to, i + 1 < sets.length ? sets[i + 1].number - 1 : to);
      for (let n = Math.max(from, sets[i].number); n <= last; n++) { // every block up to the next change has these same events
        const hash = n === from ? hFrom : n === to ? hTo : await hashAt(n);
        const body = await this.call<{ block: { extrinsics: string[] } }>("chain_getBlock", [hash]);
        for (const { idx, r } of wanted) {
          const exIdx = r.phase.isApplyExtrinsic ? (r.phase.asApplyExtrinsic.toNumber() as number) : null;
          const ex = exIdx !== null ? body.block.extrinsics[exIdx] : undefined;
          out.push({
            contract: r.event.data[0].toString() as string, // SS58 in the chain's own prefix (42)
            data: r.event.data[1].toHex(),
            topics: [...r.topics].map((t: any) => t.toHex() as string),
            blockNumber: n,
            blockHash: hash,
            eventIndex: idx,
            extrinsicIndex: exIdx,
            extrinsicHash: ex ? this.lib.blake2AsHex(this.lib.hexToU8a(ex), 256) : null,
          });
        }
      }
    }
    return out.sort((a, b) => a.blockNumber - b.blockNumber || a.eventIndex - b.eventIndex);
  }

  /** Contracts.ContractInfoOf(account): twox128("Contracts") ++ twox128("ContractInfoOf") ++ twox64(account) ++ account. */
  async contractExists(address: string): Promise<boolean> {
    const l = this.lib;
    const account = l.decodeAddress(address);
    const key = l.u8aToHex(l.u8aConcat(l.xxhashAsU8a("Contracts", 128), l.xxhashAsU8a("ContractInfoOf", 128), l.xxhashAsU8a(account, 64), account));
    return (await this.call<string | null>("state_getStorage", [key])) !== null;
  }

  async close(): Promise<void> { try { await this.provider.disconnect(); } catch { /* already closed */ } }
}
