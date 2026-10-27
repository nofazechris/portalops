import test from "node:test";
import assert from "node:assert/strict";
import { startApi } from "./test-harness.ts";
import type { PingSender } from "../../packages/chain-adapters/pinger.ts";
import { normalizeEvmLog } from "../../packages/event-engine/normalize.ts";

const PING = "0x6a8705e4621dd87a261b1c5f97b73871616537ec";
const HASH = "0x" + "ab".repeat(32);

function fakeSender(over: Partial<{ balance: bigint; fail: boolean }> = {}) {
  const sent: string[] = [];
  const sender: PingSender = {
    address: "0x" + "55".repeat(20),
    contract: PING,
    send: async (note) => { if (over.fail) throw new Error("boom\nsecret stack"); sent.push(note); return { hash: HASH }; },
    balanceWei: async () => over.balance ?? 20n * 10n ** 18n,
  };
  return { sender, sent };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const h = await startApi(undefined, { trustedProxyHops: 1, ...overrides });
  await h.store.createProject({ ownerId: null, name: "Playground", networkId: "portaldot-v3-testnet", kind: "playground" });
  const call = (method: string, path: string, body?: unknown, ip = "9.9.9.9") =>
    fetch(h.base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  return { h, call };
}

test("playground ping: off without a sponsor wallet, and says where to send one yourself", async (t) => {
  const { h, call } = await setup();
  t.after(() => h.close());
  const info = (await call("GET", "/api/v1/playground")).json.data;
  assert.equal(info.ping.sponsored, false);
  assert.equal(info.ping.contract, PING, "the wallet path still knows which contract to call");
  const r = await call("POST", "/api/v1/playground/ping", { note: "hi" });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "ping_unavailable");
});

test("playground ping: sends one cleaned ping through the sponsor wallet and never anything else", async (t) => {
  const { sender, sent } = fakeSender();
  const { h, call } = await setup({ pinger: sender });
  t.after(() => h.close());
  const info = (await call("GET", "/api/v1/playground")).json.data;
  assert.equal(info.ping.sponsored, true);
  assert.equal(info.ping.sponsor, sender.address);
  assert.ok(info.contracts.some((c: any) => c.address === PING), "PortalPing is being watched, so the event will be captured");

  const r = await call("POST", "/api/v1/playground/ping", { note: "  hello\njudge  " }, "1.1.1.1");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.transactionHash, HASH);
  assert.equal(r.json.data.contract, PING);
  assert.deepEqual(sent, ["hello judge"], "the note was cleaned");
  assert.equal((await call("POST", "/api/v1/playground/ping", {}, "2.2.2.2")).status, 200);
  assert.equal(sent[1], "hello from the PortalOps playground", "an empty note gets a friendly default");
});

test("playground ping: limited per visitor, per day, and when the wallet is empty; failures reveal nothing", async (t) => {
  const { sender } = fakeSender();
  const { h, call } = await setup({ pinger: sender, demoPingsPerDay: 2 });
  t.after(() => h.close());
  assert.equal((await call("POST", "/api/v1/playground/ping", {}, "1.1.1.1")).status, 200);
  const again = await call("POST", "/api/v1/playground/ping", {}, "1.1.1.1");
  assert.equal(again.status, 429);
  assert.match(again.json.error.message, /every 5 minutes/);
  assert.equal((await call("POST", "/api/v1/playground/ping", {}, "2.2.2.2")).status, 200);
  const capped = await call("POST", "/api/v1/playground/ping", {}, "3.3.3.3");
  assert.equal(capped.status, 429);
  assert.equal(capped.json.error.code, "daily_limit");

  const poor = await setup({ pinger: fakeSender({ balance: 10n ** 18n }).sender });
  t.after(() => poor.h.close());
  const empty = await poor.call("POST", "/api/v1/playground/ping", {});
  assert.equal(empty.status, 503);
  assert.equal(empty.json.error.code, "demo_wallet_empty");

  const broken = await setup({ pinger: fakeSender({ fail: true }).sender });
  t.after(() => broken.h.close());
  const bad = await broken.call("POST", "/api/v1/playground/ping", {});
  assert.equal(bad.status, 502);
  assert.equal(bad.json.error.code, "ping_failed");
  assert.ok(!JSON.stringify(bad.json).includes("secret stack"), "provider details are not forwarded");
});

test("playground tx: the event a transaction caused, decoded, with its finality and delivery", async (t) => {
  const { h, call } = await setup();
  t.after(() => h.close());
  const pg = await h.store.getPlaygroundProject();
  const e = normalizeEvmLog({ address: PING, topics: ["0xaa"], data: "0x", blockNumber: 152200, blockHash: "0xb1", transactionHash: HASH, transactionIndex: 0, logIndex: 4, removed: false }, { projectId: pg!.id, chainId: 420420777 });
  await h.store.insertEvent(e);
  const r = await call("GET", `/api/v1/playground/tx/${HASH}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.events.length, 1);
  assert.equal(r.json.data.events[0].blockNumber, 152200);
  assert.equal(r.json.data.events[0].finalityStatus, "included");
  assert.equal((await call("GET", `/api/v1/playground/tx/0x${"cd".repeat(32)}`)).json.data.events.length, 0, "not captured yet");
  assert.equal((await call("GET", "/api/v1/playground/tx/0x123")).status, 422);
});
