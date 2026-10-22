#!/usr/bin/env node
// Deploy and drive the tiny PortalPing demo contract, so you can watch PortalOps capture live events.
//
//   node scripts/deploy-demo-contract/ping.mjs deploy            dry run: compiles, checks balance + gas, sends nothing
//   node scripts/deploy-demo-contract/ping.mjs deploy --send     broadcasts the deployment
//   node scripts/deploy-demo-contract/ping.mjs ping "a note"     calls ping("a note")   (needs a deployment)
//   node scripts/deploy-demo-contract/ping.mjs milestone 100     calls milestone(100)
//
// Reads PORTALDOT_DEPLOYER_PRIVATE_KEY from .env (git-ignored). The key is never printed or written anywhere.
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEventLogs } from "viem";
import { ROOT, accountFromEnv, assertChain, config, fail, fmt, hasFlag, publicClient, walletFor } from "./common.mjs";

const require = createRequire(import.meta.url);
const solc = require("solc");
const DEPLOYMENT = resolve(ROOT, "docs/architecture/deployment-ping.json");
const SAFETY = 12n; // gas estimates on pallet-revive run ~10% under actual; pad by 30%

function compile() {
  const source = readFileSync(resolve(ROOT, "contracts/examples/PortalPing.sol"), "utf8");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "PortalPing.sol": { content: source } },
    settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  for (const e of out.errors || []) console.error(e.formattedMessage);
  if (errs.length) fail("Compilation failed.");
  const c = out.contracts["PortalPing.sol"].PortalPing;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, version: solc.version() };
}

const cmd = process.argv[2];
const send = hasFlag("--send");
const account = accountFromEnv("PORTALDOT_DEPLOYER_PRIVATE_KEY");
const { abi, bytecode, version } = compile();

console.log(`Portaldot V3.0 testnet · chain ${await assertChain()} (verified) · solc ${version}`);
console.log(`deployer ${account.address}`);
const [balance, gasPrice] = await Promise.all([publicClient.getBalance({ address: account.address }), publicClient.getGasPrice()]);
console.log(`balance  ${fmt(balance)} · gas price ${gasPrice} wei`);

const pad = (g) => config.gasLimit ?? (g * SAFETY) / 10n;

if (cmd === "deploy") {
  console.log(`bytecode ${(bytecode.length - 2) / 2} bytes · events ${abi.filter((x) => x.type === "event").map((x) => x.name).join(", ")}`);
  let est;
  try { est = await publicClient.estimateGas({ account, data: bytecode }); } catch (e) { fail(`Gas estimation failed: ${e.shortMessage || e.message}`); }
  const gas = pad(est);
  const maxCost = gas * gasPrice;
  console.log(`gas est  ${est} · gas limit ${gas} · max cost ${fmt(maxCost)}`);
  if (balance < maxCost) fail("Balance is lower than the maximum deployment cost. Fund the account, or lower PORTALDOT_GAS_LIMIT.");
  if (!send) { console.log("\nDry run only. Nothing was sent. Re-run with --send to deploy."); process.exit(0); }
  const hash = await walletFor(account).deployContract({ abi, bytecode, gas, gasPrice, type: "legacy" });
  console.log(`\ndeploy tx ${hash}\nwaiting for inclusion…`);
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
  if (r.status !== "success" || !r.contractAddress) fail(`Deployment failed (status ${r.status}).`);
  console.log(`\n✅ PortalPing deployed at ${r.contractAddress}\n   block #${r.blockNumber} · gasUsed ${r.gasUsed} · tx ${hash}`);
  writeFileSync(DEPLOYMENT, JSON.stringify({ contractName: "PortalPing", contractAddress: r.contractAddress, deployTransactionHash: hash, deployBlock: Number(r.blockNumber), gasUsed: String(r.gasUsed), compiler: version, abi, deployedAt: new Date().toISOString() }, null, 2));
  console.log(`   saved ${DEPLOYMENT}`);
  console.log(`\nABI (paste this in the dashboard, or see the saved file):\n${JSON.stringify(abi)}`);
  process.exit(0);
}

if (cmd === "ping" || cmd === "milestone") {
  if (!existsSync(DEPLOYMENT)) fail("No PortalPing deployment yet. Run: node scripts/deploy-demo-contract/ping.mjs deploy --send");
  const { contractAddress } = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const fn = cmd === "ping" ? "ping" : "milestone";
  const arg = cmd === "ping" ? (process.argv[3] ?? "hello from PortalOps") : BigInt(process.argv[3] ?? "100");
  const base = { address: contractAddress, abi, functionName: fn, args: [arg], account };
  let est;
  try { est = await publicClient.estimateContractGas(base); } catch (e) { fail(`${fn}: gas estimation failed (would revert): ${e.shortMessage || e.message}`); }
  const gas = pad(est);
  console.log(`${fn}(${JSON.stringify(arg, (_, v) => (typeof v === "bigint" ? v.toString() : v))}) on ${contractAddress}\n  gas est ${est} · gas limit ${gas} · max cost ${fmt(gas * gasPrice)}`);
  if (!send) { console.log("\nDry run only. Re-run with --send to broadcast."); process.exit(0); }
  const hash = await walletFor(account).writeContract({ ...base, gas, gasPrice, type: "legacy" });
  console.log(`  submitted ${hash}\n  waiting…`);
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
  if (r.status !== "success") fail(`${fn}: reverted.`);
  const decoded = parseEventLogs({ abi, logs: r.logs });
  console.log(`  included block #${r.blockNumber} · gasUsed ${r.gasUsed}`);
  for (const ev of decoded) console.log(`  event ${ev.eventName} ${JSON.stringify(ev.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  process.exit(0);
}

fail("Usage: ping.mjs deploy [--send] | ping \"note\" --send | milestone <score> --send");
