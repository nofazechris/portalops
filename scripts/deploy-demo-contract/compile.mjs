#!/usr/bin/env node
// Compiles contracts/evm/PortalQuest.sol with solc-js into contracts/evm/artifacts/PortalQuest.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ROOT, ARTIFACT_PATH, fail } from "./common.mjs";

const require = createRequire(import.meta.url);
const solc = require("solc");

const source = readFileSync(resolve(ROOT, "contracts/evm/PortalQuest.sol"), "utf8").replace(/\r\n/g, "\n"); // LF form: same bytecode on every platform
const input = {
  language: "Solidity",
  sources: { "PortalQuest.sol": { content: source } },
  settings: {
    // "paris" avoids PUSH0 and newer opcodes the testnet EVM may not support.
    evmVersion: "paris",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((e) => e.severity === "error");
for (const e of output.errors || []) console.error(e.formattedMessage);
if (errors.length) fail("Compilation failed.");

const c = output.contracts["PortalQuest.sol"].PortalQuest;
mkdirSync(resolve(ROOT, "contracts/evm/artifacts"), { recursive: true });
writeFileSync(
  ARTIFACT_PATH,
  JSON.stringify(
    {
      contractName: "PortalQuest",
      compiler: { name: "solc-js", version: solc.version(), evmVersion: "paris", optimizerRuns: 200 },
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,
      deployedBytecode: "0x" + c.evm.deployedBytecode.object,
    },
    null,
    2,
  ),
);
console.log(`Compiled PortalQuest with solc ${solc.version()}`);
console.log(`  bytecode: ${c.evm.bytecode.object.length / 2} bytes, events: ${c.abi.filter((x) => x.type === "event").map((x) => x.name).join(", ")}`);
console.log(`  artifact: ${ARTIFACT_PATH}`);
