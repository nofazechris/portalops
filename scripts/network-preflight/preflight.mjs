#!/usr/bin/env node
// Portaldot V3.0 testnet compatibility preflight (PRD §3, Phase 0).
//
// READ-ONLY. It never signs or submits a transaction and never needs a key.
// Checks that need a funded account (transaction submission, receipts, deploy,
// invoke, event logs from our own contract) are reported as NOT RUN, not as passed.
//
//   node scripts/network-preflight/preflight.mjs
//   PORTALDOT_EVM_RPC_URL=... PORTALDOT_NATIVE_RPC_URL=... node scripts/network-preflight/preflight.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVM_URL = process.env.PORTALDOT_EVM_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev";
const NATIVE_URL = process.env.PORTALDOT_NATIVE_RPC_URL || "wss://test-node-v3.portaldot.dev";
const EXPECTED_CHAIN_ID = BigInt(process.env.PORTALDOT_EVM_CHAIN_ID || "420420777");
const TIMEOUT_MS = 15_000;

const results = [];
const record = (group, name, status, detail, data) => {
  results.push({ group, name, status, detail, ...(data !== undefined ? { data } : {}) });
  const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" }[status];
  console.log(`  [${icon}] ${name}${detail ? " — " + detail : ""}`);
};

const hex = (v) => (typeof v === "string" && v.startsWith("0x") ? BigInt(v) : null);
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);

// ---------------------------------------------------------------- EVM (HTTP)
let rpcId = 0;
async function evm(method, params = []) {
  const res = await withTimeout(
    fetch(EVM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
    TIMEOUT_MS,
    method,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) {
    const e = new Error(body.error.message || "rpc error");
    e.code = body.error.code;
    throw e;
  }
  return body.result;
}

async function evmCheck(name, method, params, judge) {
  try {
    const result = await evm(method, params);
    const verdict = judge ? judge(result) : { status: "pass", detail: JSON.stringify(result).slice(0, 120) };
    record("evm", name, verdict.status, verdict.detail, verdict.data);
    return result;
  } catch (e) {
    record("evm", name, "fail", `${method}: ${e.message}${e.code !== undefined ? ` (code ${e.code})` : ""}`);
    return undefined;
  }
}

async function runEvm() {
  console.log(`\nEVM JSON-RPC  ${EVM_URL}`);

  await evmCheck("client version", "web3_clientVersion", [], (r) => ({ status: "pass", detail: String(r) }));

  const chainId = await evmCheck("chain id", "eth_chainId", [], (r) => {
    const id = hex(r);
    return id === EXPECTED_CHAIN_ID
      ? { status: "pass", detail: `${id} (matches expected)` }
      : { status: "fail", detail: `got ${id}, expected ${EXPECTED_CHAIN_ID}` };
  });
  void chainId;

  await evmCheck("net_version", "net_version", [], (r) => ({ status: "pass", detail: String(r) }));
  await evmCheck("syncing", "eth_syncing", [], (r) => ({
    status: r === false ? "pass" : "warn",
    detail: r === false ? "node reports fully synced" : "node reports it is still syncing",
  }));

  const head = await evmCheck("latest block number", "eth_blockNumber", [], (r) => ({
    status: "pass",
    detail: `#${hex(r)}`,
  }));

  let headNum = head ? hex(head) : null;
  if (headNum !== null) {
    const block = await evmCheck("latest block (with hash/timestamp)", "eth_getBlockByNumber", [head, false], (b) =>
      b && b.hash
        ? { status: "pass", detail: `hash ${b.hash.slice(0, 14)}… ts ${hex(b.timestamp)} txs ${b.transactions?.length ?? "?"}`, data: { hash: b.hash } }
        : { status: "fail", detail: "no block returned" },
    );
    void block;
  }

  await evmCheck("account balance", "eth_getBalance", ["0x0000000000000000000000000000000000000000", "latest"], (r) => ({
    status: "pass",
    detail: `zero-address balance ${hex(r)} wei`,
  }));
  await evmCheck("code lookup", "eth_getCode", ["0x0000000000000000000000000000000000000000", "latest"], (r) => ({
    status: "pass",
    detail: `returns ${r}`,
  }));
  await evmCheck("gas price", "eth_gasPrice", [], (r) => ({ status: "pass", detail: `${hex(r)} wei` }));
  await evmCheck("priority fee (EIP-1559)", "eth_maxPriorityFeePerGas", [], (r) => ({ status: "pass", detail: `${hex(r)} wei` }));
  await evmCheck("fee history", "eth_feeHistory", ["0x1", "latest", []], (r) => ({
    status: r && r.baseFeePerGas ? "pass" : "warn",
    detail: r && r.baseFeePerGas ? `baseFee ${hex(r.baseFeePerGas[0])}` : "no baseFeePerGas",
  }));
  await evmCheck(
    "gas estimation (plain transfer)",
    "eth_estimateGas",
    [{ from: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000002", value: "0x0" }],
    (r) => ({ status: "pass", detail: `${hex(r)} gas` }),
  );
  await evmCheck("transaction count", "eth_getTransactionCount", ["0x0000000000000000000000000000000000000001", "latest"], (r) => ({
    status: "pass",
    detail: `nonce ${hex(r)}`,
  }));

  // Event log retrieval + historical range limits. Needed by the ingestion worker (PRD §10).
  if (headNum !== null) {
    for (const span of [1n, 100n, 1000n, 10000n]) {
      const from = headNum > span ? headNum - span : 0n;
      try {
        const logs = await evm("eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + headNum.toString(16) }]);
        record("evm", `eth_getLogs over last ${span} block(s)`, "pass", `${logs.length} log(s) across all contracts`);
      } catch (e) {
        record("evm", `eth_getLogs over last ${span} block(s)`, span === 1n ? "fail" : "warn", `${e.message}${e.code !== undefined ? ` (code ${e.code})` : ""} — range limit?`);
        break;
      }
    }
    // Historical depth: can we read an old block?
    for (const back of [100_000n, 1_000_000n]) {
      if (headNum <= back) continue;
      try {
        const b = await evm("eth_getBlockByNumber", ["0x" + (headNum - back).toString(16), false]);
        record("evm", `historical block ${back} back`, b ? "pass" : "warn", b ? "available" : "pruned / not returned");
      } catch (e) {
        record("evm", `historical block ${back} back`, "warn", e.message);
      }
    }
  }

  // Subscriptions are not available over plain HTTP.
  record("evm", "eth_subscribe (logs/newHeads)", "skip", "no EVM WebSocket URL was provided in the announcement; ingestion must poll unless one is found");
}

// ------------------------------------------------------- Native (WebSocket)
function nativeSession() {
  if (typeof WebSocket === "undefined") throw new Error("global WebSocket unavailable (need Node 22+)");
  const ws = new WebSocket(NATIVE_URL);
  const pending = new Map();
  const subs = new Map();
  let id = 0;
  const ready = new Promise((resolveReady, rejectReady) => {
    ws.addEventListener("open", () => resolveReady());
    ws.addEventListener("error", () => rejectReady(new Error("websocket error")));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : resolve(msg.result);
    } else if (msg.params?.subscription !== undefined) {
      subs.get(msg.params.subscription)?.(msg.params.result);
    }
  });
  const call = (method, params = []) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
      }),
      TIMEOUT_MS,
      method,
    );
  return { ready, call, subs, close: () => ws.close() };
}

async function runNative() {
  console.log(`\nNative Substrate RPC  ${NATIVE_URL}`);
  let s;
  try {
    s = nativeSession();
    await withTimeout(s.ready, TIMEOUT_MS, "websocket connect");
    record("native", "websocket connect", "pass", "connected");
  } catch (e) {
    record("native", "websocket connect", "fail", e.message);
    return;
  }

  const check = async (name, method, params, judge) => {
    try {
      const r = await s.call(method, params);
      const v = judge ? judge(r) : { status: "pass", detail: JSON.stringify(r).slice(0, 120) };
      record("native", name, v.status, v.detail, v.data);
      return r;
    } catch (e) {
      record("native", name, "fail", `${method}: ${e.message}`);
      return undefined;
    }
  };

  await check("chain name", "system_chain", [], (r) => ({ status: "pass", detail: String(r) }));
  await check("node name/version", "system_name", [], (r) => ({ status: "pass", detail: String(r) }));
  await check("node version", "system_version", [], (r) => ({ status: "pass", detail: String(r) }));
  await check("health", "system_health", [], (r) => ({
    status: r && r.isSyncing === false ? "pass" : "warn",
    detail: JSON.stringify(r),
  }));
  await check("properties (ss58 / token)", "system_properties", [], (r) => ({ status: "pass", detail: JSON.stringify(r) }));

  const header = await check("latest header", "chain_getHeader", [], (h) => ({
    status: h && h.number ? "pass" : "fail",
    detail: h && h.number ? `#${BigInt(h.number)}` : "no header",
  }));
  await check("finalized head", "chain_getFinalizedHead", [], (r) => ({ status: "pass", detail: String(r).slice(0, 18) + "…" }));
  if (header?.number) {
    await check("historical block hash (#1)", "chain_getBlockHash", [1], (r) => ({
      status: r ? "pass" : "warn",
      detail: r ? String(r).slice(0, 18) + "…" : "genesis+1 not available",
    }));
  }

  await check("runtime version", "state_getRuntimeVersion", [], (r) => ({
    status: "pass",
    detail: `${r.specName} spec ${r.specVersion} / impl ${r.implVersion}`,
    data: { specName: r.specName, specVersion: r.specVersion },
  }));

  const methods = await check("rpc_methods", "rpc_methods", [], (r) => ({
    status: "pass",
    detail: `${r.methods.length} methods`,
    data: { methods: r.methods },
  }));

  // Which contract runtime is installed? Scan metadata for pallet names (ink! => Contracts/Revive; EVM => EVM/Ethereum).
  const metadata = await check("metadata fetch", "state_getMetadata", [], (r) => ({ status: "pass", detail: `${((r.length - 2) / 2 / 1024).toFixed(0)} KiB` }));
  if (typeof metadata === "string") {
    const bytes = Buffer.from(metadata.slice(2), "hex").toString("latin1");
    const pallets = ["Contracts", "Revive", "EVM", "Ethereum", "BaseFee", "DynamicFee", "Assets", "Balances"];
    const found = pallets.filter((p) => bytes.includes(p));
    record("native", "contract-capable pallets in runtime metadata", found.length ? "pass" : "warn", found.join(", ") || "none of the expected pallet names found", { found });
  }

  // Live head subscription — proves we can follow the chain over WS.
  if (methods?.methods?.includes("chain_subscribeNewHeads")) {
    try {
      const got = new Promise((resolve) => {
        s.call("chain_subscribeNewHeads", []).then((subId) => s.subs.set(subId, resolve));
      });
      const h = await withTimeout(got, 30_000, "newHeads notification");
      record("native", "subscribe new heads", "pass", `received #${BigInt(h.number)}`);
    } catch (e) {
      record("native", "subscribe new heads", "warn", e.message);
    }
  } else {
    record("native", "subscribe new heads", "warn", "chain_subscribeNewHeads not advertised");
  }
  s.close();
}

// ---------------------------------------------------- Steps that need a key
function notRun() {
  console.log("\nChecks that need a funded testnet account (NOT RUN — no key supplied)");
  for (const name of [
    "transaction submission",
    "transaction receipt retrieval",
    "contract deployment",
    "contract invocation",
    "event log retrieval for a deployed contract",
    "native event retrieval for a deployed contract",
    "fee behaviour on a real transaction",
  ]) {
    record("needs-funded-account", name, "skip", "requires a funded test account; PortalOps never asks for seed phrases — use a throwaway testnet key via local env var");
  }
}

// ------------------------------------------------------------------- main
console.log("Portaldot V3.0 testnet preflight (read-only)");
console.log(new Date().toISOString());
await runEvm().catch((e) => record("evm", "unexpected error", "fail", e.message));
await runNative().catch((e) => record("native", "unexpected error", "fail", e.message));
notRun();

const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\nSummary: ${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} not run`);

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../docs/architecture/preflight-report.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ ranAt: new Date().toISOString(), evmUrl: EVM_URL, nativeUrl: NATIVE_URL, expectedChainId: String(EXPECTED_CHAIN_ID), results }, null, 2),
);
console.log(`Report written to ${out}`);
process.exit(count("fail") > 0 ? 1 : 0);
