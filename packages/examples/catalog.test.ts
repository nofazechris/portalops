import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, type Abi } from "viem";
import { getExample, listExamples } from "./catalog.ts";
import { normalizeEvmLog } from "../event-engine/normalize.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_FILES: Record<string, string> = {
  quest: "contracts/evm/PortalQuest.sol",
  token: "contracts/examples/PortalToken.sol",
  bounty: "contracts/examples/PortalBounty.sol",
};

test("examples: the committed artifacts are not stale (they were built from the Solidity on disk)", () => {
  for (const ex of listExamples()) {
    const d = getExample(ex.id)!;
    assert.equal(d.source, readFileSync(resolve(ROOT, SOURCE_FILES[ex.id]), "utf8"), `${ex.id}: run npm run examples:build`);
    assert.match(d.bytecode, /^0x[0-9a-f]{200,}$/);
    assert.equal(d.compiler.evmVersion, "paris");
  }
});

test("examples: every ABI event is documented, and nothing is documented that the ABI does not have", () => {
  for (const ex of listExamples()) {
    const d = getExample(ex.id)!;
    const abiEvents = (d.abi as { type: string; name: string }[]).filter((x) => x.type === "event").map((x) => x.name).sort();
    assert.deepEqual(d.eventDetails.map((e) => e.name).sort(), abiEvents, ex.id);
  }
});

test("examples: sample payloads use exactly the ABI argument names, and real logs decode to them", () => {
  const ctx = { projectId: "p", chainId: 420420777 };
  const addr = "0x1111111111111111111111111111111111111111";
  const who = "0x2222222222222222222222222222222222222222";
  const sample = (type: string, name: string) => (type === "address" ? who : type === "string" ? "hello" : type === "bool" ? true : BigInt(name.length + 1));

  for (const ex of listExamples()) {
    const d = getExample(ex.id)!;
    const abi = d.abi as Abi;
    for (const meta of d.eventDetails) {
      const ev = (abi as any[]).find((x) => x.type === "event" && x.name === meta.name);
      assert.deepEqual(Object.keys(meta.samplePayload), ev.inputs.map((i: any) => i.name), `${ex.id}.${meta.name} sample keys`);

      const args = Object.fromEntries(ev.inputs.map((i: any) => [i.name, sample(i.type, i.name)]));
      const indexed = ev.inputs.filter((i: any) => i.indexed);
      const topics = encodeEventTopics({ abi, eventName: meta.name, args: Object.fromEntries(indexed.map((i: any) => [i.name, args[i.name]])) } as never);
      const plain = ev.inputs.filter((i: any) => !i.indexed);
      const data = plain.length ? encodeAbiParameters(plain, plain.map((i: any) => args[i.name])) : "0x";
      const e = normalizeEvmLog(
        { address: addr, topics: topics.filter((t): t is `0x${string}` => typeof t === "string"), data, blockNumber: 1, blockHash: "0xb", transactionHash: "0xt", transactionIndex: 0, logIndex: 0, removed: false },
        { ...ctx, abis: new Map([[addr, abi]]) },
      );
      assert.equal(e.eventName, meta.name, `${ex.id}.${meta.name} decodes`);
      assert.equal(e.decoded, true);
      assert.deepEqual(Object.keys(e.payload!), ev.inputs.map((i: any) => i.name));
    }
  }
});

test("examples: each handler verifies the signature first, de-duplicates, and handles every event of its contract", () => {
  for (const ex of listExamples()) {
    const d = getExample(ex.id)!;
    assert.ok(d.handler.indexOf("constructEvent") < d.handler.indexOf("seen.has"), "verify before doing anything else");
    assert.match(d.handler, /express\.raw/, "raw body, not parsed JSON");
    for (const e of d.eventDetails) assert.ok(d.handler.includes(`case "${e.name}"`), `${ex.id} handles ${e.name}`);
    assert.ok(!/whsec_[0-9a-f]{8}/.test(d.handler), "no secret baked in");
    assert.equal(d.deployCommand, `npm run contract:deploy -- --example ${ex.id} --send`);
  }
});

test("examples: unknown ids give null (prototype keys included)", () => {
  assert.equal(getExample("nope"), null);
  assert.equal(getExample("__proto__"), null);
  assert.equal(getExample("constructor"), null);
});
