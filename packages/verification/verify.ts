import { Worker } from "node:worker_threads";
import type { CompileRequest, CompileResult, CompiledContract } from "./compile-worker.ts";

// Contract verification for Portaldot: given a Solidity source and the address of a deployed contract, compile the source and compare the result
// with the code that is really on chain. A match proves the source is what is running, so its ABI can be trusted and its events decoded by name.
// Single-file sources only (no imports), compiled with the compiler PortalOps ships, on a worker thread with a time limit.

export const MAX_SOURCE_BYTES = 100_000;
export const COMPILE_TIMEOUT_MS = 40_000;

/** Settings tried, in order, when the caller does not name any. The first is what PortalOps' own contracts use. */
export const DEFAULT_ATTEMPTS: { evmVersion: string; optimizerRuns: number | null }[] = [
  { evmVersion: "paris", optimizerRuns: 200 },
  { evmVersion: "paris", optimizerRuns: null },
  { evmVersion: "shanghai", optimizerRuns: 200 },
  { evmVersion: "cancun", optimizerRuns: 200 },
];
const EVM_VERSIONS = new Set(["istanbul", "berlin", "london", "paris", "shanghai", "cancun"]);

export type MatchKind = "full" | "partial";

/** How the on-chain runtime code relates to freshly compiled code. Both are 0x-hex. */
export function compareRuntime(onChain: string, compiled: string, immutables: [number, number][] = []): MatchKind | null {
  const a = onChain.toLowerCase().replace(/^0x/, ""), b = compiled.toLowerCase().replace(/^0x/, "");
  if (!a || !b) return null;
  if (a === b) return "full";
  // immutables are filled in at deployment, so the compiled code has zeros where the chain has values: blank those bytes out of both
  const blank = (hex: string) => { let s = hex; for (const [start, len] of immutables) s = s.slice(0, start * 2) + "0".repeat(len * 2) + s.slice((start + len) * 2); return s; };
  const ai = blank(a), bi = blank(b);
  if (ai === bi) return "full";
  // the CBOR metadata the compiler appends (source hash, compiler version) is its last (length + 2) bytes: code that differs only there is a partial match
  const strip = (hex: string) => { const len = parseInt(hex.slice(-4), 16); return Number.isFinite(len) && len * 2 + 4 < hex.length ? hex.slice(0, hex.length - len * 2 - 4) : hex; };
  return strip(ai) === strip(bi) && strip(ai).length > 0 ? "partial" : null;
}

/** One compile on a worker thread, killed after the time limit. */
export function compileInWorker(req: CompileRequest, timeoutMs = COMPILE_TIMEOUT_MS): Promise<CompileResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./compile-worker.ts", import.meta.url));
    const finish = (r: CompileResult) => { clearTimeout(timer); void worker.terminate(); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, version: "", contracts: [], errors: [`The compiler did not finish within ${timeoutMs / 1000} seconds.`] }), timeoutMs);
    worker.once("message", (m: CompileResult) => finish(m));
    worker.once("error", (e: Error) => finish({ ok: false, version: "", contracts: [], errors: [e.message.slice(0, 300)] }));
    worker.postMessage(req);
  });
}

// One verification at a time: the compiler is heavy, and a queue is kinder than parallel memory spikes. The queue is short on purpose.
export const MAX_QUEUE = 4;
let tail: Promise<unknown> = Promise.resolve();
let queued = 0;
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  queued++;
  const run = tail.then(fn, fn).finally(() => { queued--; });
  tail = run.catch(() => undefined);
  return run;
};

export interface VerifyRequest {
  source: string;
  /** Which contract in the file to check; otherwise the one whose code matches. */
  contractName?: string;
  evmVersion?: string;
  /** null = optimizer off; a number = runs. Omit to try the usual settings. */
  optimizerRuns?: number | null;
  /** The runtime code at the address (eth_getCode). */
  onChainCode: string;
}

export type VerifyOutcome =
  | { ok: true; match: MatchKind; name: string; abi: unknown[]; settings: { evmVersion: string; optimizerRuns: number | null }; compiler: string; runtimeBytes: number }
  | { ok: false; reason: "no_code" | "too_large" | "imports" | "compile_error" | "mismatch" | "bad_settings" | "busy"; message: string; details?: string[] };

export function verifySource(req: VerifyRequest, compile: typeof compileInWorker = compileInWorker): Promise<VerifyOutcome> {
  if (queued >= MAX_QUEUE) return Promise.resolve({ ok: false, reason: "busy", message: "The verifier is busy with other contracts. Try again in a minute." });
  return exclusive(async () => {
    const onChain = req.onChainCode.toLowerCase();
    if (!onChain || onChain === "0x") return { ok: false, reason: "no_code", message: "There is no contract code at that address on the Portaldot testnet." };
    if (Buffer.byteLength(req.source) > MAX_SOURCE_BYTES) return { ok: false, reason: "too_large", message: `The source is larger than ${MAX_SOURCE_BYTES / 1000} KB.` };
    if (/^\s*import\s/m.test(req.source)) return { ok: false, reason: "imports", message: "Imports are not supported yet. Flatten your contract into one file (for example with `forge flatten`) and submit that." };

    let attempts = DEFAULT_ATTEMPTS;
    if (req.evmVersion !== undefined || req.optimizerRuns !== undefined) {
      const evm = req.evmVersion ?? "paris";
      if (!EVM_VERSIONS.has(evm)) return { ok: false, reason: "bad_settings", message: `Unknown EVM version "${evm}". Use one of: ${[...EVM_VERSIONS].join(", ")}.` };
      const runs = req.optimizerRuns === undefined ? 200 : req.optimizerRuns;
      if (runs !== null && (!Number.isInteger(runs) || runs < 0 || runs > 1_000_000)) return { ok: false, reason: "bad_settings", message: "Optimizer runs must be a whole number from 0 to 1,000,000, or off." };
      attempts = [{ evmVersion: evm, optimizerRuns: runs }];
    }

    const tried: string[] = [];
    let lastErrors: string[] = [];
    for (const a of attempts) {
      const r = await compile({ name: "Contract.sol", source: req.source, evmVersion: a.evmVersion, optimizerRuns: a.optimizerRuns });
      if (!r.ok) { lastErrors = r.errors; if (attempts.length === 1 || attempts === DEFAULT_ATTEMPTS) break; continue; }
      const candidates: CompiledContract[] = req.contractName ? r.contracts.filter((c) => c.name === req.contractName) : r.contracts;
      for (const c of candidates) {
        const match = compareRuntime(onChain, c.runtimeHex, c.immutables);
        if (match) return { ok: true, match, name: c.name, abi: c.abi, settings: a, compiler: r.version, runtimeBytes: (onChain.length - 2) / 2 };
      }
      tried.push(`${a.evmVersion}, optimizer ${a.optimizerRuns === null ? "off" : a.optimizerRuns + " runs"}: ${candidates.map((c) => `${c.name} ${(c.runtimeHex.length - 2) / 2} bytes`).join(", ") || "no contract with code"}`);
    }
    if (lastErrors.length) return { ok: false, reason: "compile_error", message: "The source did not compile.", details: lastErrors.slice(0, 3) };
    return {
      ok: false, reason: "mismatch",
      message: `The code on chain (${(onChain.length - 2) / 2} bytes) is not what this source compiles to with the settings tried. The usual causes: a different compiler version or settings, a different source (a changed line changes the code), or a different address.`,
      details: tried,
    };
  });
}
