#!/usr/bin/env node
// Compiles every example contract with solc-js and writes packages/examples/generated.json
// (source + ABI + creation bytecode). The generated file is committed, so servers never need the compiler.
//
//   npm run examples:build
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const solc = require("solc");

const FILES = [
  { id: "quest", file: "contracts/evm/PortalQuest.sol", name: "PortalQuest" },
  { id: "token", file: "contracts/examples/PortalToken.sol", name: "PortalToken" },
  { id: "bounty", file: "contracts/examples/PortalBounty.sol", name: "PortalBounty" },
  { id: "arena", file: "contracts/examples/PortalArena.sol", name: "PortalArena" },
];

const out = { compiler: { name: "solc-js", version: solc.version(), evmVersion: "paris", optimizerRuns: 200 }, contracts: {} };
let failed = false;

for (const f of FILES) {
  // Always compile (and store) the LF form, so the artifacts are identical whichever platform built them.
  const source = readFileSync(resolve(ROOT, f.file), "utf8").replace(/\r\n/g, "\n");
  const input = {
    language: "Solidity",
    sources: { [`${f.name}.sol`]: { content: source } },
    // "paris" avoids PUSH0 and newer opcodes the testnet EVM may not support.
    settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const res = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const e of res.errors || []) { console.error(e.formattedMessage); if (e.severity === "error") failed = true; }
  const c = res.contracts?.[`${f.name}.sol`]?.[f.name];
  if (!c) { failed = true; continue; }
  out.contracts[f.id] = { name: f.name, source, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  const events = c.abi.filter((x) => x.type === "event").map((x) => x.name);
  console.log(`${f.name.padEnd(13)} ${String(c.evm.bytecode.object.length / 2).padStart(5)} bytes  events: ${events.join(", ")}`);
}
if (failed) { console.error("Compilation failed."); process.exit(1); }
mkdirSync(resolve(ROOT, "packages/examples"), { recursive: true });
writeFileSync(resolve(ROOT, "packages/examples/generated.json"), JSON.stringify(out, null, 1) + "\n");
console.log("wrote packages/examples/generated.json");
