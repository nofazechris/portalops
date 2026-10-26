import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeTestStore } from "../../packages/database/testing.ts";
import type { BlockRef } from "../../packages/shared-types/index.ts";
import type { NativeChain, RawInkEvent } from "../../packages/chain-adapters/native.ts";
import { BlockUnavailableError } from "../../packages/chain-adapters/errors.ts";
import { canonicalSs58 } from "../../packages/chain-adapters/native.ts";
import { inkEventNames, loadInkAbi, looksLikeInkMetadata } from "../../packages/event-engine/ink.ts";
import { ingestNativeOnce } from "./ingest-native.ts";

// Real ink! metadata, produced from contracts/ink/portal_ping_ink (cargo-contract's metadata generator, ink! 5.1.1).
const METADATA = JSON.parse(readFileSync(new URL("../../packages/examples/ink/portal_ping_ink.metadata.json", import.meta.url), "utf8"));
const topicOf = (label: string): string => METADATA.spec.events.find((e: { label: string }) => e.label === label).signature_topic;

const hex = (b: Uint8Array | number[]) => "0x" + Buffer.from(b).toString("hex");
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return [...b]; };
const u128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xffffffffffffffffn); b.writeBigUInt64LE(n >> 64n, 8); return [...b]; };
const text = (s: string) => { if (Buffer.byteLength(s) >= 64) throw new Error("short strings only"); return [Buffer.byteLength(s) << 2, ...Buffer.from(s)]; }; // SCALE compact length + bytes
const account = (seed: number) => Array.from({ length: 32 }, (_, i) => (seed + i) & 255);
/** SCALE bytes of the Ping { from, seq, note } event. */
const pingBytes = (seed: number, seq: number, note: string) => hex([...account(seed), ...u64(seq), ...text(note)]);
/** SCALE bytes of the Rewarded { to, amount } event. */
const rewardBytes = (seed: number, amount: bigint) => hex([...account(seed), ...u128(amount)]);

const { encodeAddress } = await import("@polkadot/util-crypto");
const ss58 = (seed: number) => encodeAddress(Uint8Array.from(account(seed)), 42);
const contractAddr = ss58(200);

class FakeNative implements NativeChain {
  genesisHash = "0x" + "ab".repeat(32);
  hashes: Record<number, string> = {};
  events: RawInkEvent[] = [];
  head = 0;
  finalizedNumber: number | null = null;
  reads: [number, number][] = [];
  mine(upTo: number, tag = "a") { for (let n = this.head + 1; n <= upTo; n++) this.hashes[n] = `0x${tag}${n}`; this.head = Math.max(this.head, upTo); }
  emit(block: number, data: string, topics: string[], eventIndex = 3, contract = contractAddr) {
    this.events.push({ contract, data, topics, blockNumber: block, blockHash: this.hashes[block], eventIndex, extrinsicIndex: 1, extrinsicHash: `0xex${block}` });
  }
  async getHead(): Promise<BlockRef> { return { number: this.head, hash: this.hashes[this.head] }; }
  async getBlock(n: number): Promise<BlockRef | null> { return this.hashes[n] ? { number: n, hash: this.hashes[n] } : null; }
  async getFinalized(): Promise<BlockRef | null> { return this.finalizedNumber === null ? null : { number: this.finalizedNumber, hash: this.hashes[this.finalizedNumber] }; }
  async getContractEvents(from: number, to: number, contracts?: Set<string>): Promise<RawInkEvent[]> {
    this.reads.push([from, to]);
    return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to && (!contracts || contracts.has(e.contract)) && this.hashes[e.blockNumber] === e.blockHash);
  }
  async contractExists(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}
void BlockUnavailableError;

type TestStore = Awaited<ReturnType<typeof makeTestStore>>;
const run = (chain: FakeNative, store: TestStore, extra = {}) =>
  ingestNativeOnce({ projectId: "p1", chain, store, contracts: [{ address: contractAddr, metadata: METADATA }], evmChainId: 420420777, batchSize: 10, confirmationDepth: 3, reorgWindow: 5, initialLookback: 1000, ...extra });

test("ink metadata: recognised, its events listed, and an address canonicalised", async () => {
  assert.equal(looksLikeInkMetadata(METADATA), true);
  assert.equal(looksLikeInkMetadata([{ type: "event", name: "Transfer" }]), false);
  assert.deepEqual(inkEventNames(METADATA).sort(), ["Ping", "Rewarded"]);
  assert.equal(await canonicalSs58(contractAddr), contractAddr);
  assert.equal(await canonicalSs58("not an address"), null);
  await loadInkAbi(METADATA); // valid
  await assert.rejects(loadInkAbi({ nonsense: true }));
});

test("native ingest: reads, decodes with the contract metadata, stores, and advances the cursor", async () => {
  const chain = new FakeNative(); chain.mine(30);
  chain.emit(8, pingBytes(5, 7, "hello"), [topicOf("Ping"), "0x" + "11".repeat(32)], 2);
  chain.emit(8, rewardBytes(9, 12345678901234567890123n), [topicOf("Rewarded"), "0x" + "22".repeat(32)], 4);
  chain.emit(8, "0x00", ["0x" + "99".repeat(32)], 5, ss58(77)); // another contract: ignored
  const store = await makeTestStore();
  const r = await run(chain, store);
  assert.equal(r.newEvents, 2);
  const evs = (await store.listEvents({ projectId: "p1" })).sort((a, b) => a.eventIndex - b.eventIndex);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].eventName, "Ping");
  assert.equal(evs[0].source, "native");
  assert.equal(evs[0].decoded, true);
  assert.equal(evs[0].contractAddress, contractAddr);
  assert.equal(evs[0].transactionHash, "0xex8");
  assert.deepEqual(evs[0].payload, { from: ss58(5), seq: "7", note: "hello" });
  assert.equal(evs[1].eventName, "Rewarded");
  assert.deepEqual(evs[1].payload, { to: ss58(9), amount: "12345678901234567890123" });
  assert.deepEqual(await store.getCursor("p1", "portaldot-v3-native"), { block: 30, hash: "0xa30" });
  assert.equal(evs[0].finalityStatus, "confirmed", "22 blocks deep");

  // a second pass is a no-op and does not duplicate
  assert.equal((await run(chain, store)).newEvents, 0);
  assert.equal((await store.listEvents({ projectId: "p1" })).length, 2);
});

test("native ingest: an event the metadata cannot decode is kept raw, never named", async () => {
  const chain = new FakeNative(); chain.mine(10);
  chain.emit(5, "0xdeadbeef", ["0x" + "77".repeat(32)]);
  const store = await makeTestStore();
  await run(chain, store);
  const [e] = await store.listEvents({ projectId: "p1" });
  assert.equal(e.eventName, null);
  assert.equal(e.decoded, false);
  assert.equal(e.data, "0xdeadbeef");
});

test("native ingest: finalized only from the node finalized head, promoted later; EVM events are left alone", async () => {
  const chain = new FakeNative(); chain.mine(20); chain.finalizedNumber = 10;
  chain.emit(6, pingBytes(1, 1, "a"), [topicOf("Ping")], 0);
  chain.emit(15, pingBytes(1, 2, "b"), [topicOf("Ping")], 0);
  const store = await makeTestStore();
  // an EVM event of the same project at a block number the native chain also has
  await store.insertEvent({ id: "evt_evm", projectId: "p1", network: "portaldot-v3-testnet", source: "evm", chainId: 420420777, contractAddress: "0x1", eventName: null, decoded: false, topics: [], data: "0x", payload: null, transactionHash: "0xt", transactionIndex: 0, blockNumber: 12, blockHash: "0xother", eventIndex: 0, observedAt: new Date().toISOString(), processingStatus: "persisted", finalityStatus: "included" });
  await run(chain, store);
  const native = async () => Object.fromEntries((await store.listEvents({ projectId: "p1" })).filter((e) => e.source === "native").map((e) => [e.blockNumber, e.finalityStatus]));
  const first = await native();
  assert.equal(first[6], "finalized");
  assert.equal(first[15], "confirmed", "above the finalized head: depth only");
  chain.mine(30); chain.finalizedNumber = 28; await run(chain, store);
  assert.equal((await native())[15], "finalized", "promoted once the finalized head passed it");
  const evm = (await store.listEvents({ projectId: "p1" })).find((e) => e.source === "evm")!;
  assert.equal(evm.finalityStatus, "included", "the native pass never touches EVM events");
});

test("native ingest: a reorganisation orphans the events of the replaced blocks", async () => {
  const chain = new FakeNative(); chain.mine(20);
  chain.emit(19, pingBytes(1, 1, "x"), [topicOf("Ping")], 0);
  const store = await makeTestStore();
  await run(chain, store);
  assert.equal((await store.listEvents({ projectId: "p1" }))[0].finalityStatus, "included");
  // blocks 18..20 are replaced by a different fork
  for (const n of [18, 19, 20]) chain.hashes[n] = `0xb${n}`;
  const r = await run(chain, store);
  assert.equal(r.reorgDetected, true);
  assert.equal(r.orphaned, 1);
  assert.equal((await store.listEvents({ projectId: "p1" }))[0].finalityStatus, "orphaned");
});

test("native ingest: a contract start block is honoured on a node that keeps old state (the default lookback is generous)", async () => {
  const chain = new FakeNative(); chain.mine(5000);
  chain.emit(1200, pingBytes(1, 1, "old"), [topicOf("Ping")], 0);
  const store = await makeTestStore();
  const r = await run(chain, store, { contracts: [{ address: contractAddr, metadata: METADATA, startBlock: 1100 }], maxBlocksPerPass: 200 });
  assert.equal(r.from, 1100, "starts at the contract's own start block, far behind the head");
  assert.equal(r.newEvents, 1, "and backfills what happened there");
});

test("native ingest: reads are bounded per pass, start near the head, and skip blocks beyond the lookback limit", async () => {
  const chain = new FakeNative(); chain.mine(1000);
  const store = await makeTestStore();
  const first = await run(chain, store, { maxBlocksPerPass: 50, initialLookback: 5000, maxLookback: 240 });
  assert.equal(first.from, 1000 - 240, "never starts earlier than the lookback limit");
  assert.equal(first.to, first.from + 49);
  assert.ok(first.lagBlocks > 0, "the rest comes on the next pass");
  const second = await run(chain, store, { maxBlocksPerPass: 50, maxLookback: 240 });
  assert.equal(second.from, first.to + 1);

  // a worker that was away for longer than the node window: the gap is skipped and reported, not retried forever
  chain.mine(2000);
  const third = await run(chain, store, { maxBlocksPerPass: 50, maxLookback: 240 });
  assert.equal(third.from, 2000 - 240);
  assert.ok(third.skippedBlocks > 0);
});

test("native ingest: a project with no contracts reads nothing", async () => {
  const chain = new FakeNative(); chain.mine(30);
  const store = await makeTestStore();
  const r = await run(chain, store, { contracts: [] });
  assert.equal(r.newEvents, 0);
  assert.equal(chain.reads.length, 0, "no block reads without watched contracts");
});
