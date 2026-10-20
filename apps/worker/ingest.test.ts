import { makeTestStore } from "../../packages/database/testing.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { BlockRef, ChainAdapter, RawEvmLog } from "../../packages/shared-types/index.ts";
import { Store } from "../../packages/database/store.ts";
import { ingestOnce } from "./ingest.ts";
import { BlockUnavailableError } from "../../packages/chain-adapters/errors.ts";

/** In-memory chain. `hashes[n]` is the canonical hash at height n; logs carry the block hash they were emitted in. */
class FakeChain implements ChainAdapter {
  readonly chainId = 420420777;
  readonly source = "evm" as const;
  hashes: Record<number, string> = {};
  logs: RawEvmLog[] = [];
  head = 0;
  getLogsCalls: [number, number][] = [];
  failNextGetLogs = false;
  /** Mirrors the real testnet: blocks older than head-horizon cannot be fetched by number (logs still can). */
  horizon: number | null = null;

  mine(upTo: number, tag = "a") {
    for (let n = this.head + 1; n <= upTo; n++) this.hashes[n] = `0x${tag}${n}`;
    this.head = Math.max(this.head, upTo);
  }
  emit(block: number, logIndex = 0, address = "0xc0ffee0000000000000000000000000000000001") {
    this.logs.push({ address, topics: ["0xdead"], data: "0x", blockNumber: block, blockHash: this.hashes[block], transactionHash: `0xtx${block}_${logIndex}`, transactionIndex: 0, logIndex, removed: false });
  }
  /** The node's finalized height; null = the node has no finality signal. */
  finalizedNumber: number | null = null;
  async getFinalized(): Promise<BlockRef | null> {
    return this.finalizedNumber === null ? null : { number: this.finalizedNumber, hash: this.hashes[this.finalizedNumber] };
  }
  async getHead(): Promise<BlockRef> { return { number: this.head, hash: this.hashes[this.head] }; }
  async getBlock(n: number): Promise<BlockRef | null> {
    if (this.horizon !== null && n < this.head - this.horizon) throw new BlockUnavailableError(n, "state discarded");
    return this.hashes[n] ? { number: n, hash: this.hashes[n] } : null;
  }
  async getLogs(from: number, to: number, addresses?: string[]): Promise<RawEvmLog[]> {
    this.getLogsCalls.push([from, to]);
    if (this.failNextGetLogs) { this.failNextGetLogs = false; throw new Error("rpc down"); }
    return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && (!addresses || addresses.includes(l.address)) && this.hashes[l.blockNumber] === l.blockHash);
  }
}

const opts = (chain: FakeChain, store: Store, extra = {}) => ({ projectId: "p1", networkId: "portaldot-v3-testnet", chain, store, startBlock: 1, batchSize: 10, confirmationDepth: 3, reorgWindow: 5, ...extra });

test("ingest: stores logs, advances cursor, marks depth-confirmed events", async () => {
  const chain = new FakeChain(); chain.mine(20); chain.emit(5); chain.emit(5, 1); chain.emit(19);
  const store = await makeTestStore();
  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.newEvents, 3);
  assert.equal(r.lagBlocks, 0);
  assert.deepEqual(await store.getCursor("p1", "portaldot-v3-testnet"), { block: 20, hash: "0xa20" });
  const evs = await store.listEvents({ projectId: "p1" });
  assert.equal(evs.find((e) => e.blockNumber === 5)!.finalityStatus, "confirmed"); // 15 deep
  assert.equal(evs.find((e) => e.blockNumber === 19)!.finalityStatus, "included"); // 1 deep
});

test("ingest: batches the range, and a second pass is a no-op", async () => {
  const chain = new FakeChain(); chain.mine(25); chain.emit(12);
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store));
  assert.deepEqual(chain.getLogsCalls, [[1, 10], [11, 20], [21, 25]]);
  chain.getLogsCalls = [];
  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.newEvents, 0);
  assert.deepEqual(chain.getLogsCalls, []);
});

test("ingest: restart resumes from the cursor and never loses or duplicates events", async () => {
  const chain = new FakeChain(); chain.mine(10); chain.emit(4);
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store));
  chain.mine(20); chain.emit(15);
  const r = await ingestOnce(opts(chain, store)); // "restarted worker": new call, state only in the store
  assert.equal(r.from, 11);
  assert.equal(r.newEvents, 1);
  assert.equal(await store.countEvents("p1"), 2);
});

test("ingest: a failed RPC call leaves the cursor untouched, so nothing is skipped", async () => {
  const chain = new FakeChain(); chain.mine(30); chain.emit(3); chain.emit(15); chain.emit(25);
  const store = await makeTestStore();
  // fail on the 2nd batch
  let calls = 0;
  const orig = chain.getLogs.bind(chain);
  chain.getLogs = async (...a) => { if (++calls === 2) throw new Error("rpc down"); return orig(...a); };
  await assert.rejects(ingestOnce(opts(chain, store)), /rpc down/);
  assert.deepEqual((await store.getCursor("p1", "portaldot-v3-testnet"))?.block, 10); // only batch 1 committed
  assert.equal(await store.countEvents("p1"), 1);
  chain.getLogs = orig;
  await ingestOnce(opts(chain, store));
  assert.equal(await store.countEvents("p1"), 3); // all recovered
});

test("ingest: duplicates from overlapping reads are ignored", async () => {
  const chain = new FakeChain(); chain.mine(10); chain.emit(4);
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store));
  await store.deleteCursor("p1", "portaldot-v3-testnet"); // force a full re-read
  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.newEvents, 0);
  assert.equal(r.duplicates, 1);
  assert.equal(await store.countEvents("p1"), 1);
});

test("ingest: reorg orphans replaced events and ingests the new canonical ones", async () => {
  const chain = new FakeChain(); chain.mine(20); chain.emit(18); chain.emit(20);
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store));
  assert.equal(await store.countEvents("p1"), 2);

  // blocks 18..20 are replaced by a competing fork; the log at 18 is re-emitted on the new fork, the one at 20 is dropped
  for (let n = 18; n <= 20; n++) chain.hashes[n] = `0xb${n}`;
  chain.head = 21; chain.hashes[21] = "0xb21";
  chain.logs = chain.logs.filter((l) => l.blockNumber !== 18 && l.blockNumber !== 20);
  chain.emit(18);

  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.reorgDetected, true);
  assert.equal(r.orphaned, 2);
  const evs = await store.listEvents({ projectId: "p1" });
  assert.equal(evs.length, 3);
  assert.equal(evs.filter((e) => e.finalityStatus === "orphaned").length, 2);
  const live = evs.filter((e) => e.finalityStatus !== "orphaned");
  assert.equal(live.length, 1);
  assert.equal(live[0].blockHash, "0xb18");
  assert.equal((await store.getCursor("p1", "portaldot-v3-testnet"))?.block, 21);
});

test("ingest: address filter is passed to the chain", async () => {
  const chain = new FakeChain(); chain.mine(10); chain.emit(2, 0, "0xaaaa"); chain.emit(3, 0, "0xbbbb");
  const store = await makeTestStore();
  const r = await ingestOnce(opts(chain, store, { addresses: ["0xaaaa"] }));
  assert.equal(r.newEvents, 1);
});

test("ingest: deep backfill works when old blocks are pruned (real testnet behaviour); cursor is marked unverifiable", async () => {
  const chain = new FakeChain(); chain.mine(1000); chain.emit(10); chain.emit(500); chain.emit(995);
  chain.horizon = 256;
  const store = await makeTestStore();
  const r = await ingestOnce(opts(chain, store, { startBlock: 1, batchSize: 400 }));
  assert.equal(r.newEvents, 3);
  assert.equal(await store.countEvents("p1"), 3);
  assert.equal((await store.getCursor("p1", "portaldot-v3-testnet"))?.block, 1000);
});

test("ingest: worker restarting after long downtime (cursor block pruned) resumes instead of crashing or flagging a reorg", async () => {
  const chain = new FakeChain(); chain.mine(100); chain.emit(50);
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store));
  chain.mine(2000); chain.emit(1500); // node moved far past the lookup horizon while we were down
  chain.horizon = 256;
  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.reorgDetected, false);
  assert.equal(r.newEvents, 1);
  assert.equal((await store.getCursor("p1", "portaldot-v3-testnet"))?.block, 2000);
});

// ------------------------------------------------------------------ finality (node's `finalized` tag)
const statusOf = async (store: Store) => Object.fromEntries((await store.listEvents({ projectId: "p1", limit: 100 })).map((e) => [e.blockNumber, e.finalityStatus]));

test("finality: with no finality signal from the node, nothing is ever called finalized (no guessing from depth)", async () => {
  const chain = new FakeChain(); chain.mine(100); chain.emit(5); chain.emit(99); // finalizedNumber stays null
  const store = await makeTestStore();
  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.finalizedHeight, null);
  assert.equal(r.finalizedEvents, 0);
  assert.deepEqual(await statusOf(store), { 5: "confirmed", 99: "included" });
});

test("finality: events ingested at or below the finalized height are finalized immediately; newer ones keep depth-based status", async () => {
  const chain = new FakeChain(); chain.mine(100); chain.emit(5); chain.emit(60); chain.emit(80); chain.emit(99);
  chain.finalizedNumber = 70;
  const store = await makeTestStore();
  const r = await ingestOnce(opts(chain, store, { batchSize: 100 })); // one batch straddling the finalized height
  assert.equal(r.finalizedHeight, 70);
  assert.deepEqual(await statusOf(store), { 5: "finalized", 60: "finalized", 80: "confirmed", 99: "included" });
  assert.equal(r.finalizedEvents, 2, "the straddling batch is promoted by the verification pass");
});

test("finality: when the finalized head advances, earlier events are promoted after their block hash is verified", async () => {
  const chain = new FakeChain(); chain.mine(100); chain.emit(80); chain.emit(95);
  chain.finalizedNumber = 50;
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store));
  assert.deepEqual(await statusOf(store), { 80: "confirmed", 95: "confirmed" }); // depth heuristic only (confirmation depth is 3 here)

  chain.finalizedNumber = 90;
  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.finalizedEvents, 1);
  assert.deepEqual(await statusOf(store), { 80: "finalized", 95: "confirmed" }, "95 is above the finalized head so it must not be promoted");

  chain.mine(120); chain.finalizedNumber = 110;
  await ingestOnce(opts(chain, store));
  assert.deepEqual(await statusOf(store), { 80: "finalized", 95: "finalized" });
});

test("finality: an event seen on a fork is orphaned, not finalized, once the finalized head passes its height", async () => {
  const chain = new FakeChain(); chain.mine(100); chain.emit(80);
  chain.finalizedNumber = 50;
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store)); // stored with block hash 0xa80

  // history below the (future) finalized head is settled differently: height 80 is now a different block
  chain.hashes[80] = "0xb80"; chain.logs = chain.logs.filter((l) => l.blockNumber !== 80); chain.emit(80);
  chain.finalizedNumber = 90;
  const r = await ingestOnce(opts(chain, store));
  assert.equal(r.finalityOrphaned, 1);
  const evs = await store.listEvents({ projectId: "p1" });
  assert.equal(evs.find((e) => e.blockHash === "0xa80")!.finalityStatus, "orphaned");
});

test("finality: a finalized event is terminal (never downgraded by depth confirmation or reorg handling)", async () => {
  const chain = new FakeChain(); chain.mine(100); chain.emit(10); chain.finalizedNumber = 90;
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store));
  const id = (await store.listEvents({ projectId: "p1" }))[0].id;
  assert.equal((await store.getEvent(id))!.finalityStatus, "finalized");
  await store.confirmUpTo("p1", 100, 3);
  assert.equal((await store.getEvent(id))!.finalityStatus, "finalized");
  assert.equal(await store.markOrphaned("p1", 0, () => "0xsomething-else"), 0);
  assert.equal((await store.getEvent(id))!.finalityStatus, "finalized");
  assert.equal(await store.setFinality([id], "orphaned"), 0, "even an explicit orphan request cannot override finality");
});

test("finality: pruned blocks are verified through eth_getLogs; absence of data is not evidence", async () => {
  const chain = new FakeChain(); chain.mine(1000); chain.emit(10); chain.emit(20); chain.emit(30);
  chain.finalizedNumber = 100; // old events ingested while the head is far ahead
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store, { batchSize: 50 }));
  // simulate: they were stored earlier as confirmed, finality signal was unavailable then
  await store.rawRun("UPDATE events SET finality_status = 'confirmed'");
  chain.horizon = 256; // blocks below ~744 can no longer be fetched by number

  // 10: logs at that height contain our hash -> finalized. 20: a different canonical block -> orphaned. 30: no logs returned -> unverified.
  chain.hashes[20] = "0xfork20"; chain.logs = chain.logs.filter((l) => l.blockNumber !== 20); chain.emit(20);
  const realLogs = chain.logs.filter((l) => l.blockNumber === 30);
  chain.logs = chain.logs.filter((l) => l.blockNumber !== 30); // RPC "hiccup": returns nothing for height 30
  chain.finalizedNumber = 500;
  let r = await ingestOnce(opts(chain, store));
  assert.deepEqual(await statusOf(store), { 10: "finalized", 20: "orphaned", 30: "confirmed" });
  assert.equal(r.finalizedEvents, 1);
  assert.equal(r.finalityOrphaned, 1);

  chain.logs.push(...realLogs); // data returns: now there is positive evidence
  r = await ingestOnce(opts(chain, store));
  assert.deepEqual(await statusOf(store), { 10: "finalized", 20: "orphaned", 30: "finalized" });
});

test("finality: verification work per pass is bounded and the backlog clears over successive passes", async () => {
  const chain = new FakeChain(); chain.mine(100);
  for (const h of [10, 20, 30, 40, 50]) chain.emit(h);
  const store = await makeTestStore();
  await ingestOnce(opts(chain, store)); // no finality signal yet
  chain.finalizedNumber = 90;
  const counts: number[] = [];
  for (let i = 0; i < 4; i++) counts.push((await ingestOnce(opts(chain, store, { finalityHeightsPerPass: 2 }))).finalizedEvents);
  assert.deepEqual(counts, [2, 2, 1, 0]);
  assert.ok(Object.values(await statusOf(store)).every((s) => s === "finalized"));
});

test("finality: a failing finality signal or verification never breaks ingestion", async () => {
  const chain = new FakeChain(); chain.mine(100); chain.emit(5);
  chain.getFinalized = async () => { throw new Error("method not supported"); };
  const store = await makeTestStore();
  let r = await ingestOnce(opts(chain, store));
  assert.equal(r.newEvents, 1);
  assert.equal(r.finalizedHeight, null);

  // verification itself blows up (RPC error while checking logs of a pruned block)
  const chain2 = new FakeChain(); chain2.mine(1000); chain2.emit(10);
  const store2 = await makeTestStore();
  await ingestOnce(opts(chain2, store2, { batchSize: 100 }));
  chain2.horizon = 256; chain2.finalizedNumber = 500;
  const orig = chain2.getLogs.bind(chain2);
  chain2.getLogs = async () => { throw new Error("rpc down"); };
  r = await ingestOnce(opts(chain2, store2));
  assert.equal(r.finalizedEvents, 0);
  assert.ok((await store2.listLogs("p1")).some((l) => /Finality check failed: rpc down/.test(l.message)));
  chain2.getLogs = orig;
  r = await ingestOnce(opts(chain2, store2));
  assert.equal(r.finalizedEvents, 1, "recovers on the next pass");
});

test("ingest: reports progress after every committed batch (so a long backfill can heartbeat)", async () => {
  const chain = new FakeChain(); chain.mine(25); chain.emit(3);
  const store = await makeTestStore();
  const seen: { block: number; head: number }[] = [];
  await ingestOnce(opts(chain, store, { onBatch: (p: { block: number; head: number }) => seen.push(p) }));
  assert.deepEqual(seen, [{ block: 10, head: 25 }, { block: 20, head: 25 }, { block: 25, head: 25 }]);
  assert.equal((await store.getCursor("p1", "portaldot-v3-testnet"))?.block, 25, "the cursor had been advanced before each callback");
});
