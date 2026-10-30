import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, type Abi } from "viem";
import { startApi } from "./test-harness.ts";
import { normalizeEvmLog } from "../../packages/event-engine/normalize.ts";

const ADDR = "0x" + "11".repeat(20);
const TX = "0x" + "ab".repeat(32);
const BLOCK = "0x" + "b1".repeat(32);
const ABI = [{ type: "event", name: "Ping", inputs: [] }] as const satisfies Abi;
const TOPICS = encodeEventTopics({ abi: ABI, eventName: "Ping" }) as string[];

const hex = (n: number) => "0x" + n.toString(16);
const receiptFor = (over: { data?: string; status?: string } = {}) => ({
  status: over.status ?? "0x1", blockNumber: hex(300), blockHash: BLOCK, transactionHash: TX,
  logs: [{ address: ADDR, topics: [...TOPICS], data: over.data ?? "0x", blockNumber: hex(300), blockHash: BLOCK, transactionHash: TX, logIndex: "0x2" }],
});

function fakeRpc(receipt: unknown, opts: { down?: boolean } = {}) {
  const asked: string[] = [];
  const chainFetch = async (_url: string, init: { body: string }) => {
    if (opts.down) throw new Error("connect ECONNREFUSED");
    const { method, params } = JSON.parse(init.body);
    asked.push(method + ":" + (params[0] ?? ""));
    return { ok: true, status: 200, json: async () => ({ result: method === "eth_blockNumber" ? hex(310) : receipt }) };
  };
  return { chainFetch, asked };
}

async function setup(rpc: ReturnType<typeof fakeRpc> | null, withAbi = true) {
  const h = await startApi(undefined, rpc ? { rpcUrl: "https://rpc.example", chainFetch: rpc.chainFetch } : {});
  const key = await h.mkKey("read");
  const writeKey = await h.mkKey("write");
  if (withAbi) await fetch(h.base + `/api/v1/projects/${h.project.id}/contracts`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${writeKey}` }, body: JSON.stringify({ address: ADDR, abi: ABI }) });
  const e = normalizeEvmLog({ address: ADDR, topics: [...TOPICS], data: "0x", blockNumber: 300, blockHash: BLOCK, transactionHash: TX, transactionIndex: 0, logIndex: 2, removed: false }, { projectId: h.project.id, chainId: 420420777, abis: withAbi ? new Map([[ADDR, ABI as unknown as Abi]]) : undefined });
  await h.store.insertEvent(e);
  const get = async (id = e.id) => { const r = await fetch(h.base + `/api/v1/events/${id}/verify`, { headers: { authorization: `Bearer ${key}` } }); return { status: r.status, json: (await r.json()) as any }; };
  return { h, e, get };
}

test("verify against the chain: an event the chain confirms, including that its decoded fields are what the chain data says", async (t) => {
  const rpc = fakeRpc(receiptFor());
  const { h, e, get } = await setup(rpc);
  t.after(() => h.close());
  assert.equal(e.eventName, "Ping");
  const r = await get();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.verdict, "verified");
  assert.equal(r.json.data.confirmations, 10);
  assert.ok(r.json.data.checks.some((c: any) => c.id === "decode" && c.ok), "the decode check ran and passed");
  assert.match(r.json.data.checkYourself, /eth_getTransactionReceipt/);
  assert.ok(r.json.data.checkYourself.includes(TX));
  assert.equal(r.json.data.rpcUrl, "https://rpc.example");
  assert.ok(rpc.asked.includes("eth_getTransactionReceipt:" + TX));
});

test("verify against the chain: data that differs on chain is a mismatch", async (t) => {
  const { h, get } = await setup(fakeRpc(receiptFor({ data: "0xdead" })));
  t.after(() => h.close());
  const r = (await get()).json.data;
  assert.equal(r.verdict, "mismatch");
  assert.deepEqual(r.checks.filter((c: any) => !c.ok).map((c: any) => c.id), ["data"]);
});

test("verify against the chain: a transaction the chain does not know, a failed transaction and an unreachable chain", async (t) => {
  const none = await setup(fakeRpc(null));
  t.after(() => none.h.close());
  assert.equal((await none.get()).json.data.verdict, "not_found");

  const reverted = await setup(fakeRpc(receiptFor({ status: "0x0" })));
  t.after(() => reverted.h.close());
  const rv = (await reverted.get()).json.data;
  assert.equal(rv.verdict, "mismatch");
  assert.ok(rv.checks.some((c: any) => c.id === "status" && !c.ok));

  const down = await setup(fakeRpc(null, { down: true }));
  t.after(() => down.h.close());
  const d = (await down.get()).json.data;
  assert.equal(d.verdict, "unavailable", "an unreachable chain is neither a pass nor a fail");
});

test("verify against the chain: unknown event, no RPC configured, and the public network list shows the RPC", async (t) => {
  const { h, get } = await setup(fakeRpc(receiptFor()));
  t.after(() => h.close());
  assert.equal((await get("evt_nope")).status, 404);
  const nets = (await (await fetch(h.base + "/api/v1/networks")).json()) as any;
  assert.equal(nets.data[0].rpcUrl, "https://rpc.example");

  const off = await setup(null);
  t.after(() => off.h.close());
  const r = await off.get();
  assert.equal(r.status, 503);
  const nets2 = (await (await fetch(off.h.base + "/api/v1/networks")).json()) as any;
  assert.equal(nets2.data[0].rpcUrl, undefined);
});
