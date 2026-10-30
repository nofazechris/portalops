import test from "node:test";
import assert from "node:assert/strict";
import { compareToReceipt, parseReceipt, verifyEventAgainstChain, type CheckableEvent } from "./chain-check.ts";

const TX = "0x" + "ab".repeat(32);
const BLOCK = "0x" + "b1".repeat(32);
const CONTRACT = "0x6a8705e4621dd87a261b1c5f97b73871616537ec";
const TOPICS = ["0x" + "11".repeat(32), "0x" + "22".repeat(32)];

const stored = (over: Partial<CheckableEvent> = {}): CheckableEvent => ({ source: "evm", contractAddress: CONTRACT, topics: TOPICS, data: "0x1234", transactionHash: TX, blockNumber: 152200, blockHash: BLOCK, eventIndex: 4, ...over });

// a receipt exactly as JSON-RPC returns it: hex quantities, mixed case
const rawReceipt = (over: Record<string, unknown> = {}, logOver: Record<string, unknown> = {}) => ({
  status: "0x1", blockNumber: "0x252c8", blockHash: BLOCK.toUpperCase().replace("0X", "0x"), transactionHash: TX,
  logs: [
    { address: "0x" + "99".repeat(20), topics: ["0xaa"], data: "0x", blockNumber: "0x252c8", blockHash: BLOCK, transactionHash: TX, logIndex: "0x3" },
    { address: CONTRACT.toUpperCase().replace("0X", "0x"), topics: TOPICS, data: "0x1234", blockNumber: "0x252c8", blockHash: BLOCK, transactionHash: TX, logIndex: "0x4", ...logOver },
  ],
  ...over,
});

test("parseReceipt: hex quantities become numbers, case is normalised, null stays null", () => {
  const r = parseReceipt(rawReceipt())!;
  assert.equal(r.blockNumber, 152264);
  assert.equal(r.status, true);
  assert.equal(r.logs[1].logIndex, 4);
  assert.equal(r.logs[1].address, CONTRACT);
  assert.equal(parseReceipt(null), null);
  assert.equal(parseReceipt("nope"), null);
});

test("compareToReceipt: a matching log is verified, and reports confirmations", () => {
  const r = compareToReceipt(stored({ blockNumber: 152264 }), parseReceipt(rawReceipt()), 152274);
  assert.equal(r.verdict, "verified", JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.confirmations, 10);
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(r.chainLog?.logIndex, 4);
});

test("compareToReceipt: every kind of difference is caught and named", () => {
  const good = () => parseReceipt(rawReceipt())!;
  const base = stored({ blockNumber: 152264 });
  const bad = (event: CheckableEvent, receipt = good()) => compareToReceipt(event, receipt);
  const failed = (r: ReturnType<typeof bad>) => r.checks.filter((c) => !c.ok).map((c) => c.id);

  const data = bad({ ...base, data: "0xdead" });
  assert.equal(data.verdict, "mismatch"); assert.deepEqual(failed(data), ["data"]);
  assert.deepEqual(failed(bad({ ...base, topics: [TOPICS[0], "0x" + "33".repeat(32)] })), ["topics"]);
  assert.deepEqual(failed(bad({ ...base, topics: [TOPICS[0]] })), ["topics"]);
  assert.deepEqual(failed(bad({ ...base, contractAddress: "0x" + "77".repeat(20) })), ["address"]);
  assert.deepEqual(failed(bad({ ...base, blockHash: "0x" + "cc".repeat(32) })), ["block_hash"]);
  assert.deepEqual(failed(bad({ ...base, blockNumber: 1 })), ["block_number"]);
  assert.deepEqual(failed(bad({ ...base, eventIndex: 9 })), ["log"], "no log at that index: the address, topics and data are not compared against some other log");
  assert.deepEqual(failed(bad(base, parseReceipt(rawReceipt({ status: "0x0" }))!)), ["status"]);
  assert.deepEqual(failed(bad({ ...base, transactionHash: "0x" + "dd".repeat(32) })), ["tx"]);
});

test("compareToReceipt: an unknown transaction is not_found, an ink! event is not_applicable", () => {
  const nf = compareToReceipt(stored(), null);
  assert.equal(nf.verdict, "not_found");
  assert.match(nf.summary, /reorganised/);
  assert.equal(compareToReceipt(stored({ source: "native" }), null).verdict, "not_applicable");
});

test("verifyEventAgainstChain: asks the RPC for the receipt and the head, and verifies", async () => {
  const calls: string[] = [];
  const fetchImpl = async (_u: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    calls.push(method);
    return { ok: true, status: 200, json: async () => ({ result: method === "eth_blockNumber" ? "0x252d2" : rawReceipt() }) };
  };
  const r = await verifyEventAgainstChain(stored({ blockNumber: 152264 }), { rpcUrl: "http://rpc.test", fetchImpl });
  assert.equal(r.verdict, "verified");
  assert.equal(r.confirmations, 10);
  assert.deepEqual(calls.sort(), ["eth_blockNumber", "eth_getTransactionReceipt"]);
});

test("verifyEventAgainstChain: a transaction the chain has never heard of is not_found", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result: null }) });
  assert.equal((await verifyEventAgainstChain(stored(), { rpcUrl: "http://rpc.test", fetchImpl })).verdict, "not_found");
});

test("verifyEventAgainstChain: an unreachable or failing RPC is unavailable, never a pass or a fail, and never throws", async () => {
  const down = async () => { throw new Error("socket hang up"); };
  const r = await verifyEventAgainstChain(stored(), { rpcUrl: "http://rpc.test", fetchImpl: down as any });
  assert.equal(r.verdict, "unavailable");
  assert.match(r.summary, /Could not reach the chain/);
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal((await verifyEventAgainstChain(stored(), { rpcUrl: "x", fetchImpl: http500 })).verdict, "unavailable");
  const rpcErr = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "boom" } }) });
  assert.equal((await verifyEventAgainstChain(stored(), { rpcUrl: "x", fetchImpl: rpcErr })).verdict, "unavailable");
});

test("verifyEventAgainstChain: a head that cannot be read does not fail the check", async () => {
  const fetchImpl = async (_u: string, init: { body: string }) => {
    if (JSON.parse(init.body).method === "eth_blockNumber") throw new Error("nope");
    return { ok: true, status: 200, json: async () => ({ result: rawReceipt() }) };
  };
  const r = await verifyEventAgainstChain(stored({ blockNumber: 152264 }), { rpcUrl: "x", fetchImpl: fetchImpl as any });
  assert.equal(r.verdict, "verified");
  assert.equal(r.confirmations, null);
});
