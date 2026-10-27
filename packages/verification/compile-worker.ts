import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";

// Runs inside a worker thread: solc-js is synchronous and can take seconds, and a hostile or huge input must never freeze the API or outlive
// its time limit (the parent terminates this thread when the clock runs out). No import callback is given, so the compiler can read no files.

const solc = createRequire(import.meta.url)("solc");

export interface CompileRequest { name: string; source: string; evmVersion: string; optimizerRuns: number | null }
export interface CompiledContract { name: string; abi: unknown[]; runtimeHex: string; immutables: [number, number][] }
export interface CompileResult { ok: boolean; version: string; contracts: CompiledContract[]; errors: string[] }

function compile(req: CompileRequest): CompileResult {
  const input = {
    language: "Solidity",
    sources: { [req.name]: { content: req.source } },
    settings: {
      evmVersion: req.evmVersion,
      optimizer: req.optimizerRuns === null ? { enabled: false } : { enabled: true, runs: req.optimizerRuns },
      outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors: string[] = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error").map((e: { formattedMessage: string }) => String(e.formattedMessage).trim().slice(0, 600));
  const contracts: CompiledContract[] = [];
  for (const [name, c] of Object.entries<any>(out.contracts?.[req.name] ?? {})) {
    const runtime = c.evm?.deployedBytecode?.object ?? "";
    if (!runtime) continue; // interfaces and abstract contracts have no code
    const refs = Object.values<any[]>(c.evm.deployedBytecode.immutableReferences ?? {}).flat().map((r) => [r.start, r.length] as [number, number]);
    contracts.push({ name, abi: c.abi, runtimeHex: "0x" + runtime, immutables: refs });
  }
  return { ok: errors.length === 0, version: solc.version(), contracts, errors };
}

parentPort!.on("message", (req: CompileRequest) => {
  try { parentPort!.postMessage(compile(req)); }
  catch (e) { parentPort!.postMessage({ ok: false, version: solc.version(), contracts: [], errors: [e instanceof Error ? e.message.slice(0, 300) : "The compiler failed."] } satisfies CompileResult); }
});
