#!/usr/bin/env node
// Independent check of every on-chain claim PortalOps makes. READ-ONLY: it never signs or sends anything and needs no key.
//
//   npm run verify:evidence                       # the chain: deployments, transactions, events
//   npm run verify:evidence -- --live https://portalops.onrender.com     # ...and that the live service captured them
//
// For each recorded deployment and transaction it asks the public Portaldot V3.0 testnet RPC (not our server) whether the receipt exists and
// succeeded, whether code is deployed at the address, and whether the event in the receipt is the one we say it is. Exit code 1 if anything fails.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { keccak256, toBytes } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));
const RPC = process.env.PORTALDOT_EVM_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev";
const CHAIN_ID = 420420777n;
const liveIdx = process.argv.indexOf("--live");
const LIVE = liveIdx > 0 ? process.argv[liveIdx + 1]?.replace(/\/$/, "") : null;

let id = 0;
/** One JSON-RPC call, retried a few times: a public testnet endpoint blinks now and then, and a reviewer should not see that as a failure. */
async function rpc(method, params = []) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { final: true });
      return body.result;
    } catch (e) {
      last = e;
      if (e.final) throw e;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error(`${method}: the RPC did not answer (${last?.cause?.code ?? last?.message})`);
}

let failures = 0, checks = 0;
const ok = (name, detail = "") => { checks++; console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`); };
const bad = (name, detail = "") => { checks++; failures++; console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`); };
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));
const sig = (s) => keccak256(toBytes(s));

// ---- what we claim -----------------------------------------------------------------------------------------------------------------
const quest = read("docs/architecture/deployment.json");
const pingDeploy = read("docs/architecture/deployment-ping.json");
const questTxs = read("docs/architecture/evidence.json").transactions;
const pingTxs = read("docs/architecture/evidence-ping.json");

const contracts = [
  { name: "PortalQuest", file: "contracts/evm/PortalQuest.sol", address: quest.contractAddress, deployTx: quest.deployTransactionHash, deployBlock: quest.blockNumber },
  { name: "PortalPing", file: "contracts/examples/PortalPing.sol", address: pingDeploy.contractAddress, deployTx: pingDeploy.deployTransactionHash, deployBlock: pingDeploy.deployBlock },
];

/** The runtime bytecode this repository's Solidity compiles to (the settings the contracts were deployed with: solc, paris, optimizer 200). */
function compileRuntime(name, file) {
  const solc = createRequire(import.meta.url)("solc");
  const source = readFileSync(resolve(ROOT, file), "utf8").replace(/\r\n/g, "\n"); // line endings are not part of the contract
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources: { [name + ".sol"]: { content: source } },
    settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } } },
  })));
  return "0x" + out.contracts[name + ".sol"][name].evm.deployedBytecode.object;
}
const calls = [
  ...questTxs.map((t) => ({ contract: "PortalQuest", address: quest.contractAddress, label: t.label.replace(/^\d+\.\s*/, ""), hash: t.transactionHash, block: t.blockNumber, event: t.events[0].name, signature: { QuestCreated: "QuestCreated(uint256,address,string)", QuestCompleted: "QuestCompleted(uint256,address)", RewardIssued: "RewardIssued(uint256,address,uint256)" }[t.events[0].name] })),
  ...pingTxs.transactions.map((t) => ({ contract: "PortalPing", address: pingDeploy.contractAddress, label: "ping", hash: t.hash, block: t.block, event: "Ping", signature: "Ping(address,uint256,string)" })),
];

console.log(`Portaldot V3.0 testnet evidence check  ·  ${RPC}\n`);
try {
  const chain = BigInt(await rpc("eth_chainId"));
  check(chain === CHAIN_ID, "RPC is the Portaldot V3.0 testnet", `chain id ${chain}`);
  const head = BigInt(await rpc("eth_blockNumber"));
  ok("RPC is live", `head block ${head}`);

  console.log("\nDeployments");
  for (const c of contracts) {
    try {
      const r = await rpc("eth_getTransactionReceipt", [c.deployTx]);
      if (!r) { bad(`${c.name} deployment receipt`, `${c.deployTx} not found`); continue; }
      check(r.status === "0x1", `${c.name} deployment succeeded`, `tx ${c.deployTx.slice(0, 18)}…`);
      check(Number(BigInt(r.blockNumber)) === c.deployBlock, `${c.name} deployed in block ${c.deployBlock}`, `receipt says ${BigInt(r.blockNumber)}`);
      if (r.contractAddress) check(r.contractAddress.toLowerCase() === c.address.toLowerCase(), `${c.name} receipt's contract address is ${c.address}`);
      const code = await rpc("eth_getCode", [c.address, "latest"]);
      const bytes = code === "0x" ? 0 : (code.length - 2) / 2;
      check(bytes > 0, `${c.name} has code at ${c.address}`, `${bytes.toLocaleString("en-US")} bytes of runtime code`);
      // source to chain: the code on chain is exactly what the Solidity in this repository compiles to
      try { check(compileRuntime(c.name, c.file).toLowerCase() === code.toLowerCase(), `${c.name}: code on chain equals what ${c.file} compiles to`, "byte for byte"); }
      catch (e) { bad(`${c.name}: compile ${c.file}`, e.message); }
    } catch (e) { bad(`${c.name} deployment`, e.message); }
  }

  console.log("\nTransactions and the events they emitted");
  for (const t of calls) {
    try {
      const r = await rpc("eth_getTransactionReceipt", [t.hash]);
      if (!r) { bad(`${t.contract}.${t.label}`, `${t.hash} not found`); continue; }
      const name = `${t.contract}.${t.label} → ${t.event} (block ${t.block})`;
      const mine = (r.logs ?? []).filter((l) => l.address.toLowerCase() === t.address.toLowerCase() && l.topics[0] === sig(t.signature));
      check(r.status === "0x1" && Number(BigInt(r.blockNumber)) === t.block && mine.length >= 1, name, `tx ${t.hash.slice(0, 14)}…`);
      // the same log through eth_getLogs: the query PortalOps itself uses to capture events
      const logs = await rpc("eth_getLogs", [{ address: t.address, fromBlock: "0x" + t.block.toString(16), toBlock: "0x" + t.block.toString(16), topics: [sig(t.signature)] }]);
      check(logs.some((l) => l.transactionHash === t.hash), `   the same event is returned by eth_getLogs`, "");
    } catch (e) { bad(`${t.contract}.${t.label}`, e.message); }
  }

  if (LIVE) {
    console.log(`\nLive service  ·  ${LIVE}`);
    const get = async (p) => { const r = await fetch(LIVE + p, { signal: AbortSignal.timeout(60_000) }); return { status: r.status, json: await r.json().catch(() => null) }; };
    const st = await get("/api/v1/public/status");
    check(st.status === 200 && st.json?.data?.connection === "connected", "PortalOps reports it is connected to the testnet", `head #${st.json?.data?.headBlock}`);
    const demo = st.json?.data?.demo;
    if (demo?.projectId) {
      for (const c of contracts) {
        const ev = await get(`/api/v1/projects/${demo.projectId}/events?contract=${c.address.toLowerCase()}&limit=50`);
        const n = ev.json?.data?.total ?? 0;
        check(n > 0, `PortalOps captured events from ${c.name}`, `${n} stored`);
      }
    } else bad("PortalOps public explorer is available");
  }
} catch (e) {
  bad("could not complete the check", e.message);
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}.`);
process.exit(failures ? 1 : 0);
