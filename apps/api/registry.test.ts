import test from "node:test";
import assert from "node:assert/strict";
import { startApi } from "./test-harness.ts";
import type { verifySource } from "../../packages/verification/verify.ts";
import { seedVerifiedContracts } from "../../packages/verification/seed.ts";

const A = "0x" + "ab".repeat(19) + "a1"; // the harness reports code for addresses ending in 1
const ABI = [{ type: "event", name: "Ping", inputs: [] }, { type: "function", name: "ping", inputs: [], outputs: [] }];
const SRC = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract P { event Ping(); function ping() external { emit Ping(); } }";

type Verify = typeof verifySource;
const accepting: Verify = async () => ({ ok: true, match: "full", name: "P", abi: ABI, settings: { evmVersion: "paris", optimizerRuns: 200 }, compiler: "0.8.28+fake", runtimeBytes: 2 });
const rejecting: Verify = async () => ({ ok: false, reason: "mismatch", message: "The code on chain is not what this source compiles to.", details: ["paris, optimizer 200 runs: P 100 bytes"] });

async function setup(verify: Verify) {
  const h = await startApi(undefined, { verify, trustedProxyHops: 1 });
  const call = (method: string, path: string, body?: unknown, ip = "7.7.7.7") =>
    fetch(h.base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  return { h, call };
}

test("registry: a matching source is stored, shown publicly and not stored again", async (t) => {
  const { h, call } = await setup(accepting);
  t.after(() => h.close());
  const r = await call("POST", "/api/v1/registry/verify", { address: A, source: SRC });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.data.verified, true);
  assert.equal(r.json.data.name, "P");
  assert.deepEqual(r.json.data.events, ["Ping"]);

  const list = (await call("GET", "/api/v1/public/registry")).json.data;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].address, A.toLowerCase());
  assert.equal(list.items[0].source, undefined, "the list carries no source");

  const one = (await call("GET", `/api/v1/public/registry/${A}`)).json.data;
  assert.equal(one.source, SRC);
  assert.deepEqual(one.abi, ABI);
  assert.equal(one.activity.events, 0);

  const again = await call("POST", "/api/v1/registry/verify", { address: A, source: SRC }, "8.8.8.8");
  assert.equal(again.status, 200);
  assert.equal(again.json.data.alreadyVerified, true);
});

test("registry: a source that does not match is refused with the reason, and nothing is stored", async (t) => {
  const { h, call } = await setup(rejecting);
  t.after(() => h.close());
  const r = await call("POST", "/api/v1/registry/verify", { address: A, source: SRC });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, "verification_failed");
  assert.match(r.json.error.message, /not what this source compiles to/);
  assert.equal((await call("GET", "/api/v1/public/registry")).json.data.total, 0);
  assert.equal((await call("GET", `/api/v1/public/registry/${A}`)).status, 404);
});

test("registry: bad input is refused and verification is rate limited per visitor", async (t) => {
  const { h, call } = await setup(accepting);
  t.after(() => h.close());
  assert.equal((await call("POST", "/api/v1/registry/verify", { address: "nope", source: SRC }, "2.2.2.2")).status, 422);
  assert.equal((await call("POST", "/api/v1/registry/verify", { address: A, source: "x" }, "2.2.2.2")).status, 422);
  assert.equal((await call("POST", "/api/v1/registry/verify", { address: A, source: SRC, contractName: "bad name" }, "2.2.2.2")).status, 422);
  assert.equal((await call("GET", "/api/v1/public/registry/nope")).status, 422);
  const b = (ip: string) => call("POST", "/api/v1/registry/verify", { address: A, source: SRC }, ip);
  assert.equal((await b("5.5.5.5")).status, 201);
  assert.equal((await b("5.5.5.5")).status, 200);
  assert.equal((await b("5.5.5.5")).status, 200);
  assert.equal((await b("5.5.5.5")).status, 429);
  assert.equal((await b("6.6.6.6")).status, 200, "another visitor is not affected");
});

test("registry: a busy verifier is passed on honestly", async (t) => {
  const busy: Verify = async () => ({ ok: false, reason: "busy", message: "The verifier is busy with other contracts. Try again in a minute." });
  const { h, call } = await setup(busy);
  t.after(() => h.close());
  const r = await call("POST", "/api/v1/registry/verify", { address: A, source: SRC });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "busy");
});

test("registry: a contract added without an ABI gets the verified one", async (t) => {
  const { h, call } = await setup(accepting);
  t.after(() => h.close());
  await call("POST", "/api/v1/registry/verify", { address: A, source: SRC });
  const key = await h.mkKey("write");
  const r = await fetch(h.base + `/api/v1/projects/${h.project.id}/contracts`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ address: A }) });
  const added = (await r.json()) as any;
  assert.equal(r.status, 201, JSON.stringify(added));
  assert.equal(added.data.hasAbi, true);
  assert.equal(added.data.name, "P");
  assert.deepEqual(added.data.events, ["Ping"]);
});

test("registry seed: verifies the contracts we deployed, skips what is done, and a chain failure is not an error", async (t) => {
  const { h } = await setup(accepting);
  t.after(() => h.close());
  const r1 = await seedVerifiedContracts(h.store, async () => "0x6080", accepting);
  assert.ok(r1.verified.length >= 2, "both of our deployed contracts");
  assert.equal(r1.failed.length, 0);
  const r2 = await seedVerifiedContracts(h.store, async () => { throw new Error("down"); }, accepting);
  assert.equal(r2.verified.length, 0, "already verified: nothing to do, and the dead chain is never asked");
  const other = await setup(rejecting);
  t.after(() => other.h.close());
  const r3 = await seedVerifiedContracts(other.h.store, async () => { throw new Error("down"); }, rejecting);
  assert.equal(r3.verified.length, 0);
  assert.ok(r3.failed.length >= 2);
});
