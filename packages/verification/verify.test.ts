import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRuntime, compileInWorker, verifySource } from "./verify.ts";
import { getExample } from "../examples/catalog.ts";

const ping = getExample("ping")!;
const pingSource = ping.source;

test("compareRuntime: identical code is a full match", () => {
  assert.equal(compareRuntime("0xAABBCC", "0xaabbcc"), "full");
});

test("compareRuntime: code that differs is no match", () => {
  assert.equal(compareRuntime("0xaabbcc", "0xaabbcd"), null);
  assert.equal(compareRuntime("0x", "0xaa"), null);
});

test("compareRuntime: immutable slots are ignored", () => {
  // bytes 1..2 are an immutable (filled in at deployment): different values there still match fully
  assert.equal(compareRuntime("0xaa1122bb", "0xaa0000bb", [[1, 2]]), "full");
  assert.equal(compareRuntime("0xaa1122bb", "0xaa0000bc", [[1, 2]]), null);
});

test("compareRuntime: code that differs only in the compiler metadata tail is a partial match", () => {
  // code, then 3 bytes of "metadata", then its length (0003)
  const a = "0x6001600155" + "111111" + "0003";
  const b = "0x6001600155" + "222222" + "0003";
  assert.equal(compareRuntime(a, b), "partial");
});

test("verifySource: the real PortalPing source verifies against the code it compiles to", { timeout: 90_000 }, async () => {
  const c = await compileInWorker({ name: "Contract.sol", source: pingSource, evmVersion: "paris", optimizerRuns: 200 });
  assert.equal(c.ok, true, c.errors.join("\n"));
  const code = c.contracts.find((x) => x.name === "PortalPing")!.runtimeHex;
  assert.equal(((code.length - 2) / 2) > 100, true);

  const ok = await verifySource({ source: pingSource, onChainCode: code });
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.name, "PortalPing"); assert.equal(ok.match, "full"); assert.equal(ok.settings.evmVersion, "paris"); assert.ok(ok.abi.length > 0); }

  // naming the contract or the settings narrows the search, and the wrong settings do not match
  const named = await verifySource({ source: pingSource, onChainCode: code, contractName: "PortalPing", evmVersion: "paris", optimizerRuns: 200 });
  assert.equal(named.ok, true);
  const wrong = await verifySource({ source: pingSource, onChainCode: code, evmVersion: "paris", optimizerRuns: null });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "mismatch");
});

test("verifySource: a changed source does not match", { timeout: 90_000 }, async () => {
  const c = await compileInWorker({ name: "Contract.sol", source: pingSource, evmVersion: "paris", optimizerRuns: 200 });
  const code = c.contracts.find((x) => x.name === "PortalPing")!.runtimeHex;
  const changed = pingSource.replace("emit Ping(msg.sender, seq, note);", "emit Ping(msg.sender, seq + 1, note);");
  assert.notEqual(changed, pingSource);
  const r = await verifySource({ source: changed, onChainCode: code });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "mismatch");
});

test("verifySource: rejects missing code, imports, oversized source, bad settings and sources that do not compile", { timeout: 90_000 }, async () => {
  const none = await verifySource({ source: pingSource, onChainCode: "0x" });
  assert.equal(none.ok === false && none.reason, "no_code");
  const imp = await verifySource({ source: 'import "./x.sol";\ncontract A {}', onChainCode: "0xaa" });
  assert.equal(imp.ok === false && imp.reason, "imports");
  const big = await verifySource({ source: "a".repeat(100_001), onChainCode: "0xaa" });
  assert.equal(big.ok === false && big.reason, "too_large");
  const evm = await verifySource({ source: pingSource, onChainCode: "0xaa", evmVersion: "frontier" });
  assert.equal(evm.ok === false && evm.reason, "bad_settings");
  const runs = await verifySource({ source: pingSource, onChainCode: "0xaa", optimizerRuns: -1 });
  assert.equal(runs.ok === false && runs.reason, "bad_settings");
  const bad = await verifySource({ source: "contract Broken { this is not solidity }", onChainCode: "0xaa" });
  assert.equal(bad.ok === false && bad.reason, "compile_error");
});

test("compileInWorker: a compile that outlives its time limit is stopped", async () => {
  const r = await compileInWorker({ name: "Contract.sol", source: pingSource, evmVersion: "paris", optimizerRuns: 200 }, 1);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /did not finish/);
});


