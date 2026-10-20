import type { BlockRef, ChainAdapter } from "../../packages/shared-types/index.ts";
import type { Store } from "../../packages/database/store.ts";
import { BlockUnavailableError } from "../../packages/chain-adapters/errors.ts";

export interface FinalityReport {
  /** Height of the node's finalized block used for this pass. */
  finalizedHeight: number;
  /** Distinct block heights examined this pass. */
  heightsChecked: number;
  /** Events promoted to `finalized`. */
  finalized: number;
  /** Events whose block turned out not to be the canonical one at its (finalized) height. */
  orphaned: number;
  /** Events we could not verify this pass (no positive evidence either way); retried next pass. */
  unverified: number;
}

/**
 * Promotes events at or below the node's finalized height to `finalized`, but only after checking that the block each event
 * was observed in is the canonical block at that height. Below a finalized head the canonical chain can no longer change, so a
 * verified match is permanent; a verified mismatch means the event was seen on a fork and is marked `orphaned`.
 *
 * Verification, per distinct height:
 *   1. `getBlock(height)` and compare hashes (the node serves roughly the latest 256 blocks by number).
 *   2. If the node has pruned that block, fall back to `getLogs(height, height)`: every log at a height comes from the canonical
 *      block, so our event's block hash appearing there confirms it, and a different hash there refutes it.
 *   3. No block / no logs returned is NOT evidence (RPC hiccup, or pruning): the event is left untouched and retried later.
 *      We never orphan or finalize on absence of data.
 *
 * Work per pass is bounded so a long backlog cannot monopolise the RPC; it is cleared over successive passes.
 */
export async function promoteFinalized(o: {
  store: Store;
  chain: ChainAdapter;
  projectId: string;
  finalized: BlockRef;
  maxHeightsPerPass?: number;
}): Promise<FinalityReport> {
  const { store, chain, projectId, finalized } = o;
  const maxHeights = o.maxHeightsPerPass ?? 50;

  const candidates = await store.listUnfinalized(projectId, finalized.number, maxHeights * 40);
  const byHeight = new Map<number, typeof candidates>();
  for (const c of candidates) {
    const list = byHeight.get(c.blockNumber) ?? [];
    list.push(c);
    byHeight.set(c.blockNumber, list);
  }

  const toFinalize: string[] = [];
  const toOrphan: string[] = [];
  let unverified = 0;
  let heights = 0;

  for (const [height, events] of byHeight) {
    if (heights >= maxHeights) break;
    heights++;

    // 1. canonical hash by number
    let canonical: string | null = null;
    if (height === finalized.number) {
      canonical = finalized.hash;
    } else {
      try {
        canonical = (await chain.getBlock(height))?.hash ?? null;
      } catch (e) {
        if (!(e instanceof BlockUnavailableError)) throw e;
      }
    }
    if (canonical !== null) {
      for (const ev of events) (ev.blockHash === canonical ? toFinalize : toOrphan).push(ev.id);
      continue;
    }

    // 2. pruned: use the logs at that height as positive evidence
    const logs = await chain.getLogs(height, height);
    if (logs.length === 0) { unverified += events.length; continue; } // absence of data proves nothing
    const hashesAtHeight = new Set(logs.map((l) => l.blockHash.toLowerCase()));
    for (const ev of events) (hashesAtHeight.has(ev.blockHash.toLowerCase()) ? toFinalize : toOrphan).push(ev.id);
  }

  const finalizedCount = await store.setFinality(toFinalize, "finalized");
  const orphanedCount = await store.setFinality(toOrphan, "orphaned");
  if (finalizedCount > 0) await store.log("info", "ingest", `Finalized ${finalizedCount} event(s) at or below block ${finalized.number}`, undefined, projectId);
  if (orphanedCount > 0) await store.log("warn", "ingest", `${orphanedCount} event(s) at or below finalized block ${finalized.number} were on a non-canonical block and are now orphaned`, undefined, projectId);

  return { finalizedHeight: finalized.number, heightsChecked: heights, finalized: finalizedCount, orphaned: orphanedCount, unverified };
}
