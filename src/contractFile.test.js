import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectContractFile } from "./contractFile.js";

const INK = JSON.parse(readFileSync(new URL("../packages/examples/ink/portal_ping_ink.metadata.json", import.meta.url), "utf8"));
const ABI = [{ type: "event", name: "Transfer", inputs: [] }, { type: "function", name: "transfer", inputs: [] }, { type: "event", name: "Approval", inputs: [] }];

test("contract file: a bare ABI array is Solidity, with its events listed", () => {
  const r = detectContractFile(JSON.stringify(ABI));
  assert.equal(r.kind, "evm");
  assert.deepEqual(r.events, ["Transfer", "Approval"]);
  assert.deepEqual(r.abi, ABI);
});

test("contract file: a compiler artifact is unwrapped (Hardhat / Foundry / Remix, and solc output)", () => {
  assert.deepEqual(detectContractFile(JSON.stringify({ contractName: "T", abi: ABI, bytecode: "0x" })).abi, ABI);
  assert.deepEqual(detectContractFile(JSON.stringify({ output: { abi: ABI } })).abi, ABI);
});

test("contract file: ink! metadata is recognised, its events listed, and the bundled contract code is dropped", () => {
  const bundled = { ...INK, source: { ...INK.source, wasm: "0x" + "00".repeat(5000) } }; // what a .contract file holds
  const r = detectContractFile(JSON.stringify(bundled));
  assert.equal(r.kind, "ink");
  assert.deepEqual([...r.events].sort(), ["Ping", "Rewarded"]);
  assert.equal(r.abi.source.wasm, undefined, "the code is not uploaded");
  assert.deepEqual(r.abi.spec, INK.spec, "everything needed to decode events is kept");
  assert.match(r.note, /portal_ping_ink/);
  assert.ok(JSON.stringify(r.abi).length < JSON.stringify(bundled).length);
});

test("contract file: anything else is refused with a message that says what to do", () => {
  assert.throws(() => detectContractFile(""), /empty/);
  assert.throws(() => detectContractFile("not json"), /valid JSON/);
  assert.throws(() => detectContractFile("[]"), /not a Solidity ABI/);
  assert.throws(() => detectContractFile("[1, 2]"), /not a Solidity ABI/);
  assert.throws(() => detectContractFile('{"hello": "world"}'), /ink! metadata/);
  assert.throws(() => detectContractFile('"just a string"'), /could not tell/);
});
