import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EvmAdapter } from "./evm.ts";
import { BlockUnavailableError } from "./errors.ts";

/** Minimal JSON-RPC stub. `handler` returns a result, or throws {code, message} to produce a JSON-RPC error. */
async function stub(handler: (method: string, params: unknown[]) => unknown) {
  const calls: { method: string; params: unknown[] }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw);
      calls.push({ method, params });
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: handler(method, params) }));
      } catch (e) {
        const err = e as { code?: number; message?: string };
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.message ?? "error" } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("getFinalized: asks for the standard `finalized` tag and parses the block", async (t) => {
  const s = await stub((m, p) => (m === "eth_getBlockByNumber" && p[0] === "finalized" ? { number: "0x18a2c", hash: "0xABCDEF0000000000000000000000000000000000000000000000000000000001" } : null));
  t.after(() => s.close());
  const f = await new EvmAdapter(s.url, 1).getFinalized();
  assert.deepEqual(f, { number: 100908, hash: "0xabcdef0000000000000000000000000000000000000000000000000000000001" }); // hash lower-cased
  assert.deepEqual(s.calls[0], { method: "eth_getBlockByNumber", params: ["finalized", false] });
});

test("getFinalized: returns null (never a guess) when the node rejects the tag, returns nothing, or is unreachable", async (t) => {
  const rejecting = await stub(() => { throw { code: -32602, message: "unknown block tag: finalized" }; });
  const empty = await stub(() => null);
  t.after(async () => { await rejecting.close(); await empty.close(); });
  assert.equal(await new EvmAdapter(rejecting.url, 1).getFinalized(), null);
  assert.equal(await new EvmAdapter(empty.url, 1).getFinalized(), null);
  assert.equal(await new EvmAdapter("http://127.0.0.1:1", 1, 500).getFinalized(), null);
});

test("getBlock: distinguishes a pruned block (BlockUnavailableError) from other RPC failures", async (t) => {
  const s = await stub((m, p) => {
    if (p[0] === "0x1") throw { code: -32000, message: "UnknownBlock: State already discarded for 0xabc" };
    if (p[0] === "0x2") throw { code: -32603, message: "internal error" };
    return { number: "0x3", hash: "0xAA" };
  });
  t.after(() => s.close());
  const a = new EvmAdapter(s.url, 1);
  await assert.rejects(a.getBlock(1), (e) => e instanceof BlockUnavailableError);
  await assert.rejects(a.getBlock(2), (e) => !(e instanceof BlockUnavailableError) && /internal error/.test((e as Error).message));
  assert.deepEqual(await a.getBlock(3), { number: 3, hash: "0xaa" });
});
