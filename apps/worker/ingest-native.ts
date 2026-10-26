import { createHash } from "node:crypto";
import type { Store } from "../../packages/database/store.ts";
import { asChainAdapter, type NativeChain, type RawInkEvent } from "../../packages/chain-adapters/native.ts";
import { BlockUnavailableError } from "../../packages/chain-adapters/errors.ts";
import { loadInkAbi, normalizeInkEvent, type InkAbi } from "../../packages/event-engine/ink.ts";
import type { BlockRef, FinalityStatus } from "../../packages/shared-types/index.ts";
import { enqueueEvent } from "../../packages/webhook-engine/runner.ts";
import { promoteFinalized } from "./finality.ts";

/** Cursor key for the native chain. Separate from the EVM cursor, so the two readers never share (or disturb) a position. */
export const NATIVE_NETWORK = "portaldot-v3-native";

/** The node keeps a block's events for roughly this many recent blocks; reads start inside that window. */
export const NATIVE_STATE_WINDOW = 240;

export interface NativeIngestOptions {
  projectId: string;
  chain: NativeChain;
  store: Store;
  /** The project's active ink! contracts: canonical SS58 address and the metadata that decodes its events. */
  contracts: { address: string; metadata: unknown; startBlock?: number | null }[];
  /** Stored on every event (the testnet's chain id), same as the EVM path. */
  evmChainId: number;
  /** Blocks read per pass. The rest are picked up on the next pass. */
  maxBlocksPerPass?: number;
  /** Blocks per database transaction. */
  batchSize?: number;
  /** Where to start when there is no cursor yet and no contract start block (this many blocks behind the head). */
  initialLookback?: number;
  confirmationDepth?: number;
  reorgWindow?: number;
  enqueueDeliveries?: boolean;
  onBatch?: (progress: { block: number; head: number }) => void;
  now?: () => Date;
}

export interface NativeIngestReport {
  from: number;
  to: number;
  head: number;
  eventsSeen: number;
  newEvents: number;
  duplicates: number;
  orphaned: number;
  reorgDetected: boolean;
  /** Blocks whose events the node had already discarded before they could be read (skipped, and logged). */
  skippedBlocks: number;
  lagBlocks: number;
  finalizedHeight: number | null;
  finalizedEvents: number;
}

const abiCache = new Map<string, InkAbi>();
/** Loading metadata builds a type registry, so each distinct metadata document is loaded once per process. */
async function abiFor(metadata: unknown): Promise<InkAbi> {
  const key = createHash("sha1").update(JSON.stringify(metadata)).digest("hex");
  let abi = abiCache.get(key);
  if (!abi) { abi = await loadInkAbi(metadata); abiCache.set(key, abi); }
  return abi;
}

/**
 * One native ingestion pass for a project: read recent blocks' ContractEmitted events for its ink! contracts, decode them with the
 * contracts' metadata, store them and queue their deliveries. Same guarantees as the EVM pass: the cursor moves only after a batch is
 * stored (and storing is idempotent), reorganisations are detected from the cursor block's hash, and `finalized` is only set from the
 * node's own finalized head.
 */
export async function ingestNativeOnce(o: NativeIngestOptions): Promise<NativeIngestReport> {
  const { store, chain } = o;
  const proj = o.projectId;
  const depth = o.confirmationDepth ?? 12;
  const reorgWindow = o.reorgWindow ?? 12;
  const batch = o.batchSize ?? 20;
  const maxBlocks = o.maxBlocksPerPass ?? 200;
  const now = o.now ?? (() => new Date());

  const head: BlockRef = await chain.getHead();
  const fin: BlockRef | null = await chain.getFinalized().catch(() => null);
  const abis = new Map<string, InkAbi>();
  for (const c of o.contracts) abis.set(c.address, await abiFor(c.metadata));
  const watched = new Set(abis.keys());
  const horizon = Math.max(1, head.number - NATIVE_STATE_WINDOW);

  let cursor = await store.getCursor(proj, NATIVE_NETWORK);
  let reorgDetected = false;
  let orphaned = 0;

  // Reorg check: the block we last processed must still have the hash we recorded.
  if (cursor && cursor.hash !== "") {
    const onChain = await chain.getBlock(cursor.block);
    if (!onChain || onChain.hash !== cursor.hash) {
      reorgDetected = true;
      const rewindTo = Math.max(1, cursor.block - reorgWindow);
      const canonical = new Map<number, string | null>();
      for (let n = rewindTo; n <= cursor.block; n++) canonical.set(n, (await chain.getBlock(n))?.hash ?? null);
      orphaned = await store.markOrphaned(proj, rewindTo, (n) => canonical.get(n) ?? null, "native");
      const prev = await chain.getBlock(rewindTo - 1);
      if (prev) await store.setCursor(proj, NATIVE_NETWORK, rewindTo - 1, prev.hash); else await store.deleteCursor(proj, NATIVE_NETWORK);
      await store.log(orphaned > 0 ? "warn" : "info", "ingest", `Native reorg at block ${cursor.block}; rewound to ${rewindTo - 1}, ${orphaned} event(s) marked orphaned`, undefined, proj);
      cursor = await store.getCursor(proj, NATIVE_NETWORK);
    }
  }

  const starts = o.contracts.map((c) => c.startBlock).filter((n): n is number => typeof n === "number");
  const firstFrom = starts.length ? Math.min(...starts) : head.number - (o.initialLookback ?? 100);
  let from = cursor ? cursor.block + 1 : Math.max(horizon, firstFrom, 1);
  let skipped = 0;
  if (from < horizon) { // the worker was away longer than the node keeps events for
    skipped = horizon - from;
    await store.log("warn", "ingest", `Native blocks ${from}..${horizon - 1} are older than the node keeps events for; skipping them`, undefined, proj);
    from = horizon;
  }
  const last = Math.min(head.number, from + maxBlocks - 1);
  let eventsSeen = 0, newEvents = 0, duplicates = 0;
  let lastBlock = from - 1;

  for (let start = from; start <= last; start += batch) {
    const end = Math.min(start + batch - 1, last);
    let raws: RawInkEvent[];
    try {
      raws = watched.size ? await chain.getContractEvents(start, end, watched) : [];
    } catch (e) {
      if (!(e instanceof BlockUnavailableError)) throw e;
      // Pruned between the check above and the read: skip to what the node still has and say so.
      await store.log("warn", "ingest", `Native block ${e.blockNumber} was discarded by the node before it could be read; skipping ahead`, undefined, proj);
      skipped += end - start + 1;
      raws = [];
    }
    const endBlock = await chain.getBlock(end);
    if (!endBlock) throw new Error(`Block ${end} has no hash yet; will retry next pass.`);
    await store.tx(async (s) => {
      for (const raw of raws) {
        eventsSeen++;
        const finality: FinalityStatus = fin && raw.blockNumber <= fin.number ? "finalized" : head.number - raw.blockNumber >= depth ? "confirmed" : "included";
        const ev = normalizeInkEvent(raw, { projectId: proj, chainId: o.evmChainId, genesisHash: chain.genesisHash, abis, now: o.now, finalityStatus: finality });
        if (await s.insertEvent(ev)) {
          newEvents++;
          if (o.enqueueDeliveries) await enqueueEvent(s, ev, now());
        } else duplicates++;
      }
      await s.setCursor(proj, NATIVE_NETWORK, end, endBlock.hash);
    });
    lastBlock = end;
    o.onBatch?.({ block: end, head: head.number });
  }

  await store.confirmUpTo(proj, head.number, depth, "native");
  let finalizedEvents = 0;
  if (fin) {
    try {
      finalizedEvents = (await promoteFinalized({ store, chain: asChainAdapter(chain, o.evmChainId), projectId: proj, finalized: fin, source: "native" })).finalized;
    } catch (e) {
      await store.log("warn", "ingest", `Native finality check failed: ${e instanceof Error ? e.message : String(e)}`, undefined, proj);
    }
  }
  if (newEvents > 0) await store.log("info", "ingest", `Stored ${newEvents} new native event(s) through block ${lastBlock} (head ${head.number})`, undefined, proj);

  return { from, to: lastBlock, head: head.number, eventsSeen, newEvents, duplicates, orphaned, reorgDetected, skippedBlocks: skipped, lagBlocks: head.number - lastBlock, finalizedHeight: fin ? fin.number : null, finalizedEvents };
}
