import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { decodeFunctionData, parseAbi, parseTransaction, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cleanNote, createPingSender, encodePing, MAX_NOTE_CHARS } from "./pinger.ts";

const KEY = "0x" + "ab".repeat(32);
const PING = "0x6a8705e4621dd87a261b1c5f97b73871616537ec";
const ABI = parseAbi(["function ping(string note) returns (uint256 seq)"]);

test("pinger: notes are cleaned to one short printable line", () => {
  assert.equal(cleanNote("  hello\n\tworld  "), "hello world");
  assert.equal(cleanNote("a\u0000b‮c"), "a b c");
  assert.equal(cleanNote("x".repeat(500)).length, MAX_NOTE_CHARS);
  assert.equal(cleanNote(undefined), "");
  assert.equal(cleanNote(42), "");
  assert.equal(Array.from(cleanNote("🙂".repeat(100))).length, MAX_NOTE_CHARS, "counted in characters, never cutting one in half");
});

test("pinger: the calldata is ping(string) and nothing else", () => {
  const data = encodePing("hello");
  const d = decodeFunctionData({ abi: ABI, data });
  assert.equal(d.functionName, "ping");
  assert.deepEqual(d.args, ["hello"]);
  assert.equal(data.slice(0, 10), toFunctionSelector("ping(string)"), "the selector is ping(string)");
});

/** A tiny JSON-RPC node: enough for viem to estimate, price, sign and submit one transaction. */
async function fakeNode() {
  const seen: { method: string; params: any[] }[] = [];
  const raw: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      seen.push({ method, params });
      const answer: Record<string, unknown> = {
        eth_chainId: "0x190f1ca9", eth_estimateGas: "0x" + (1_000_000_000_000_000n).toString(16), eth_gasPrice: "0x" + (30_000n).toString(16),
        eth_getTransactionCount: "0x7", eth_getBalance: "0x" + (12n * 10n ** 18n).toString(16),
        eth_sendRawTransaction: "0x" + "cd".repeat(32),
        eth_getBlockByNumber: { number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), timestamp: "0x65000000", gasLimit: "0x" + (10n ** 18n).toString(16), gasUsed: "0x0", baseFeePerGas: "0x7530", miner: "0x" + "00".repeat(20), transactions: [], uncles: [], difficulty: "0x0", totalDifficulty: "0x0", nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), extraData: "0x", size: "0x1" },
      };
      if (method === "eth_sendRawTransaction") raw.push(params[0]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(method in answer ? { jsonrpc: "2.0", id, result: answer[method] } : { jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported " + method } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, raw, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("pinger: signs one call to the one contract, with the node's gas estimate padded, and reports the balance", async (t) => {
  const node = await fakeNode();
  t.after(node.close);
  const sender = createPingSender({ privateKey: KEY, rpcUrl: node.url, chainId: 420420777, contract: PING });
  assert.equal(sender.address, privateKeyToAccount(KEY as `0x${string}`).address);
  assert.equal(await sender.balanceWei(), 12n * 10n ** 18n);

  const { hash } = await sender.send("hello from a judge\n<script>");
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(node.raw.length, 1);
  const tx = parseTransaction(node.raw[0] as `0x${string}`);
  assert.equal(tx.to?.toLowerCase(), PING, "it can only call the ping contract");
  assert.equal(tx.chainId, 420420777);
  assert.equal(tx.value ?? 0n, 0n, "no value is ever sent");
  assert.equal(tx.gas, (1_000_000_000_000_000n * 13n) / 10n, "the node's estimate plus 30%");
  const call = decodeFunctionData({ abi: ABI, data: tx.data! });
  assert.deepEqual(call.args, ["hello from a judge <script>"], "the note was cleaned before it was encoded");
});

test("pinger: refuses a malformed key or contract, and overlapping sends go out one at a time", async (t) => {
  assert.throws(() => createPingSender({ privateKey: "nope", rpcUrl: "http://x", chainId: 1, contract: PING }), /32-byte/);
  assert.throws(() => createPingSender({ privateKey: KEY, rpcUrl: "http://x", chainId: 1, contract: "0x123" }), /0x address/);
  const node = await fakeNode();
  t.after(node.close);
  const sender = createPingSender({ privateKey: KEY, rpcUrl: node.url, chainId: 420420777, contract: PING });
  await Promise.all([sender.send("a"), sender.send("b"), sender.send("c")]);
  assert.equal(node.raw.length, 3);
  const order = node.seen.filter((s) => s.method === "eth_sendRawTransaction" || s.method === "eth_estimateGas").map((s) => s.method);
  assert.deepEqual(order, ["eth_estimateGas", "eth_sendRawTransaction", "eth_estimateGas", "eth_sendRawTransaction", "eth_estimateGas", "eth_sendRawTransaction"], "each send finishes before the next starts");
});
