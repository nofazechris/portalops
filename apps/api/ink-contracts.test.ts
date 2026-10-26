import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startApi } from "./test-harness.ts";

const METADATA = JSON.parse(readFileSync(new URL("../../packages/examples/ink/portal_ping_ink.metadata.json", import.meta.url), "utf8"));
const { encodeAddress } = await import("@polkadot/util-crypto");
const ADDR = encodeAddress(Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255)), 42);

/** A signed-in client of the test API (cookie session), with one project. */
async function setup() {
  const h = await startApi();
  const base = h.base;
  let cookie = "";
  const call = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(base + p, { method: m, headers: { ...(b ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const s = r.headers.get("set-cookie"); if (s) cookie = s.split(";")[0];
    const json = await r.json() as { data?: any; error?: any };
    return { status: r.status, data: json.data, error: json.error };
  };
  await call("POST", "/api/v1/auth/signup", { email: `ink${Date.now()}${Math.random()}@example.com`, password: "ink-test-password-123" });
  const project = (await call("POST", "/api/v1/projects", { name: "Ink" })).data;
  return { h, call, project };
}

test("ink contracts: registered with an SS58 address and their metadata, listed with the events they declare", async (t) => {
  const { h, call, project } = await setup();
  t.after(() => h.close());
  const ok = await call("POST", `/api/v1/projects/${project.id}/contracts`, { type: "ink", address: ADDR, name: "Ping (ink!)", abi: METADATA });
  assert.equal(ok.status, 201, JSON.stringify(ok.error));
  assert.equal(ok.data.runtimeType, "ink");
  assert.equal(ok.data.address, ADDR, "an SS58 address keeps its case");
  assert.equal(ok.data.hasAbi, true);
  assert.deepEqual([...ok.data.events].sort(), ["Ping", "Rewarded"]);
  assert.equal(ok.data.abi, undefined, "the metadata body is not echoed back");

  const list = await call("GET", `/api/v1/projects/${project.id}/contracts`);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].runtimeType, "ink");
  assert.equal((await call("POST", `/api/v1/projects/${project.id}/contracts`, { type: "ink", address: ADDR, abi: METADATA })).status, 409, "the same contract twice");

  // stored as given, so the worker can read it back
  const stored = await h.store.listContracts(project.id);
  assert.equal(stored[0].runtimeType, "ink");
  assert.equal((stored[0].abi as { spec: unknown }).spec !== undefined, true);
});

test("ink contracts: the wrong kind of address or metadata is refused with a clear message", async (t) => {
  const { h, call, project } = await setup();
  t.after(() => h.close());
  const add = (body: unknown) => call("POST", `/api/v1/projects/${project.id}/contracts`, body);
  const evmAddr = "0x" + "11".repeat(20);

  const badAddr = await add({ type: "ink", address: evmAddr, abi: METADATA });
  assert.equal(badAddr.status, 422);
  assert.match(JSON.stringify(badAddr.error), /SS58/);
  assert.equal((await add({ type: "ink", address: "5notanaddress", abi: METADATA })).status, 422);

  const noMeta = await add({ type: "ink", address: ADDR });
  assert.equal(noMeta.status, 422);
  assert.match(JSON.stringify(noMeta.error), /metadata/i);
  assert.equal((await add({ type: "ink", address: ADDR, abi: [{ type: "event", name: "X" }] })).status, 422, "a Solidity ABI is not ink! metadata");
  assert.equal((await add({ type: "ink", address: ADDR, abi: { spec: {}, types: [], source: {} } })).status, 422, "metadata that does not load");

  // and an EVM contract still needs an EVM address and an array ABI
  assert.equal((await add({ address: ADDR })).status, 422);
  assert.equal((await add({ address: evmAddr, abi: METADATA })).status, 422, "ink! metadata is not a Solidity ABI");
  assert.equal((await add({ address: evmAddr, abi: [{ type: "event", name: "Transfer", inputs: [] }] })).status, 201);
});

test("ink contracts: events can be filtered by an SS58 contract address", async (t) => {
  const { h, call, project } = await setup();
  t.after(() => h.close());
  assert.equal((await call("GET", `/api/v1/projects/${project.id}/events?contract=${ADDR}`)).status, 200);
  assert.equal((await call("GET", `/api/v1/projects/${project.id}/events?contract=not-an-address`)).status, 422);
});
