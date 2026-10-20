import type { Abi } from "viem";
import type { BlockRef, ChainAdapter } from "../../packages/shared-types/index.ts";
import { normalizeEvmLog } from "../../packages/event-engine/normalize.ts";
import type { Store } from "../../packages/database/store.ts";
import { enqueueEvent } from "../../packages/webhook-engine/runner.ts";
import { BlockUnavailableError } from "../../packages/chain-adapters/errors.ts";
import { promoteFinalized } from "./finality.ts";

export interface IngestOptions {
  projectId: string;
  networkId: string;
  chain: ChainAdapter;
  store: Store;
  /** Limit to these contract addresses; omit to ingest every log (useful for exploring the public testnet). */
  addresses?: string[];
  abis?: Map<string, Abi>;
  /** First block to read when no cursor exists yet. */
  startBlock: number;
  /** Blocks per eth_getLogs request. */
  batchSize?: number;
  /** Blocks of depth before an event counts as "confirmed". A depth heuristic, not protocol finality. */
  confirmationDepth?: number;
  /** How far back to re-check for reorganisations each pass. */
  reorgWindow?: number;
  /** Max distinct block heights verified for finality per pass (bounds RPC work on a large backlog). */
  finalityHeightsPerPass?: number;
  /** Called after every committed batch: lets the caller prove liveness during a long backfill. */
  onBatch?: (progress: { block: number; head: number }) => void;
  /** Create webhook deliveries for each newly stored event. */
  enqueueDeliveries?: boolean;
  now?: () => Date;
}

export interface IngestReport {
  from: number;
  to: number;
  head: number;
  logsSeen: number;
  newEvents: number;
  duplicates: number;
  orphaned: number;
  reorgDetected: boolean;
  lagBlocks: number;
  /** Node's finalized height, or null if the node exposes no finality signal. */
  finalizedHeight: number | null;
  /** Events promoted to `finalized` this pass. */
  finalizedEvents: number;
  /** Events found on a non-canonical block at or below the finalized height. */
  finalityOrphaned: number;
}

/**
 * One ingestion pass. Durable and restart-safe: the cursor only advances after a batch has been persisted,
 * and persistence is idempotent, so a crash mid-pass re-reads blocks instead of losing them.
 */
export async function ingestOnce(o: IngestOptions): Promise<IngestReport> {
  const { store, chain } = o;
  const batch = o.batchSize ?? 2_000;
  const depth = o.confirmationDepth ?? 12;
  const reorgWindow = o.reorgWindow ?? 12;
  const proj = o.projectId;

  const head: BlockRef = await chain.getHead();
  // The network's own finality signal. Null means "not available": we then say nothing about finality instead of guessing.
  const fin: BlockRef | null = await chain.getFinalized().catch(() => null);
  let cursor = await store.getCursor(proj, o.networkId);
  let reorgDetected = false;
  let orphaned = 0;

  // Reorg check: the block we last processed must still have the hash we recorded.
  if (cursor && cursor.hash !== "") {
    let onChain: BlockRef | null | undefined;
    try {
      onChain = await chain.getBlock(cursor.block);
    } catch (e) {
      // Pruned block (e.g. worker was down longer than the node's lookup horizon): cannot verify, so continue forward.
      if (!(e instanceof BlockUnavailableError)) throw e;
      await store.log("warn", "ingest", `Cursor block ${cursor.block} is no longer served by the node; reorg check skipped`, undefined, proj);
    }
    if (onChain !== undefined && (!onChain || onChain.hash !== cursor.hash)) {
      reorgDetected = true;
      const rewindTo = Math.max(o.startBlock, cursor.block - reorgWindow);
      const canonical = new Map<number, string | null>();
      for (let n = rewindTo; n <= cursor.block; n++) canonical.set(n, (await chain.getBlock(n))?.hash ?? null);
      orphaned = await store.markOrphaned(proj, rewindTo, (n) => canonical.get(n) ?? null);
      const prev = rewindTo > 0 ? await chain.getBlock(rewindTo - 1) : null;
      if (prev) await store.setCursor(proj, o.networkId, rewindTo - 1, prev.hash);
      else await store.deleteCursor(proj, o.networkId);
      // The testnet reorganises its latest block or two routinely (observed: the hash at head-1 changing within a minute).
      // That is only worth a warning when it actually invalidated events we had already stored.
      await store.log(orphaned > 0 ? "warn" : "info", "ingest", `Reorg at block ${cursor.block}; rewound to ${rewindTo - 1}, ${orphaned} event(s) marked orphaned`, undefined, proj);
      cursor = await store.getCursor(proj, o.networkId);
    }
  }

  const from = cursor ? cursor.block + 1 : o.startBlock;
  let logsSeen = 0, newEvents = 0, duplicates = 0;
  let lastBlock = cursor?.block ?? from - 1;

  for (let start = from; start <= head.number; start += batch) {
    const end = Math.min(start + batch - 1, head.number);
    const logs = await chain.getLogs(start, end, o.addresses);
    // Logs just fetched come from the canonical chain, so a batch that ends at or below the finalized height is final already.
    const finality = fin && end <= fin.number ? "finalized" : head.number - end >= depth ? "confirmed" : "included";

    // Persist the whole batch, THEN move the cursor.
    // The cursor stores the end block's hash for later reorg checks. For deep backfill the node may no longer serve
    // that block by number; the batch is still valid (every log carries its own block hash), so record "unverifiable".
    let endHash = "";
    try {
      const endBlock = await chain.getBlock(end);
      if (!endBlock) throw new Error(`Block ${end} disappeared during ingestion; will retry next pass.`);
      endHash = endBlock.hash;
    } catch (e) {
      if (!(e instanceof BlockUnavailableError)) throw e;
    }
    // One atomic transaction per batch: events, their deliveries and the cursor move together or not at all.
    await store.tx(async (s) => {
      for (const log of logs) {
        if (log.removed) continue;
        logsSeen++;
        const ev = normalizeEvmLog(log, { projectId: proj, chainId: chain.chainId, abis: o.abis, now: o.now, finalityStatus: finality });
        if (await s.insertEvent(ev)) {
          newEvents++;
          if (o.enqueueDeliveries) await enqueueEvent(s, ev, (o.now ?? (() => new Date()))());
        } else {
          duplicates++;
        }
      }
      await s.setCursor(proj, o.networkId, end, endHash);
    });
    lastBlock = end;
    o.onBatch?.({ block: end, head: head.number });
  }

  await store.confirmUpTo(proj, head.number, depth);

  // Promote older events (observed above the finalized height at the time) once the finalized head has moved past them.
  let finalizedEvents = 0, finalityOrphaned = 0;
  if (fin) {
    try {
      const f = await promoteFinalized({ store, chain, projectId: proj, finalized: fin, maxHeightsPerPass: o.finalityHeightsPerPass });
      finalizedEvents = f.finalized;
      finalityOrphaned = f.orphaned;
    } catch (e) {
      // Finality bookkeeping must never fail ingestion itself; it is retried on the next pass.
      await store.log("warn", "ingest", `Finality check failed: ${e instanceof Error ? e.message : String(e)}`, undefined, proj);
    }
  }
  if (newEvents > 0) await store.log("info", "ingest", `Stored ${newEvents} new event(s) through block ${lastBlock} (head ${head.number})`, undefined, proj);

  return { from, to: lastBlock, head: head.number, logsSeen, newEvents, duplicates, orphaned, reorgDetected, lagBlocks: head.number - lastBlock, finalizedHeight: fin ? fin.number : null, finalizedEvents, finalityOrphaned };
}
