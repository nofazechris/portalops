// Long-running worker: ingest new blocks for every project, then deliver anything due.
// Independent of the web UI and the API (PRD §9.1).   npm run worker
//
// Which logs each project ingests:
//   - public demo project: every log on the chain, undecoded (read-only exploration before signup)
//   - user projects: only their registered contracts, decoded when an ABI was supplied; no contracts => nothing
//
// Limitation: a contract registered AFTER a project's cursor was created is captured from the cursor forward.
// Back-filling its earlier history is not implemented yet.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";
import { EvmAdapter } from "../../packages/chain-adapters/evm.ts";
import { describeDatabase, openStore, type ProjectRecord } from "../../packages/database/store.ts";
import { parseKey } from "../../packages/database/secrets.ts";
import { runDueDeliveries } from "../../packages/webhook-engine/runner.ts";
import { ingestOnce } from "./ingest.ts";
import { ingestNativeOnce } from "./ingest-native.ts";
import type { NativeChain } from "../../packages/chain-adapters/native.ts";
import { loadServiceEnv } from "../../packages/config/env.ts";
import { installProcessDiagnostics } from "../../packages/config/diagnostics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadServiceEnv(ROOT); // also drops the deploy-script private keys: this process never needs them
// The worker never sends account email or talks to GitHub: do not hold those credentials in this process.
delete process.env.RESEND_API_KEY;
delete process.env.GITHUB_CLIENT_SECRET;
delete process.env.ANTHROPIC_API_KEY; // only the API process explains failures
delete process.env.PORTALOPS_DEMO_SIGNER_PRIVATE_KEY; // ...and only the API process holds the playground's sponsor wallet

const RPC = process.env.PORTALDOT_EVM_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev";
const CHAIN_ID = Number(process.env.PORTALDOT_EVM_CHAIN_ID || 420420777);
const DB = process.env.PORTALOPS_DB_PATH || resolve(ROOT, "data/portalops.sqlite");
const NETWORK = "portaldot-v3-testnet";
const POLL_MS = Number(process.env.PORTALOPS_POLL_MS || 6_000);
const ALLOW_PRIVATE = process.env.PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS === "1";
const MAX_PARALLEL = Number(process.env.PORTALOPS_MAX_PARALLEL_DELIVERIES || 8); // deliveries attempted at once
const MAX_PER_ENDPOINT = Number(process.env.PORTALOPS_MAX_DELIVERIES_PER_ENDPOINT || 2); // ... and at most this many to one endpoint
const NATIVE_RPC = process.env.PORTALDOT_NATIVE_RPC_URL || "wss://test-node-v3.portaldot.dev";
const NATIVE_MAX_LOOKBACK = Number(process.env.PORTALOPS_NATIVE_MAX_LOOKBACK_BLOCKS || 100_000);
const DEMO_LOOKBACK = Number(process.env.PORTALOPS_DEMO_LOOKBACK_BLOCKS || 120_000); // covers the whole testnet so far
const DEFAULT_LOOKBACK = 1_000;

const DATABASE = process.env.DATABASE_URL || DB;
if (!/^postgres(ql)?:\/\//i.test(DATABASE)) mkdirSync(dirname(DB), { recursive: true });
const store = await openStore(DATABASE);
const encryptionKey = parseKey(process.env.WEBHOOK_ENCRYPTION_KEY);
const chain = new EvmAdapter(RPC, CHAIN_ID);
await chain.assertChain();

console.log(`PortalOps worker · ${RPC} · chain ${CHAIN_ID} · db ${describeDatabase(DATABASE)}`);

let stopping = false;
let markStopped: () => void = () => {};
const stopped = new Promise<void>((r) => { markStopped = r; });
// On a stop signal: finish the current pass, close the database, then exit (but never hang more than 15s).
installProcessDiagnostics("worker", () => { stopping = true; return Promise.race([stopped, new Promise<void>((r) => setTimeout(r, 15_000).unref())]); });

/** Liveness signal. Also emitted per batch during ingestion, so a long first backfill is not mistaken for a dead worker. */
const beat = async (detail: Record<string, unknown>) => { try { await store.beat("worker", detail); } catch { /* a missed heartbeat must never stop ingestion */ } };

async function ingestProject(p: ProjectRecord, headNumber: number): Promise<number> {
  const contracts = (await store.listContracts(p.id)).filter((c) => c.status === "active" && c.runtimeType !== "ink"); // ink! contracts are read by ingestNativeProject
  if (p.kind !== "public_demo" && contracts.length === 0) return 0;

  const abis = new Map<string, Abi>();
  for (const c of contracts) if (c.abi) abis.set(c.address, c.abi as Abi);
  const starts = contracts.map((c) => c.startBlock).filter((n): n is number => n !== null);
  const lookback = p.kind === "public_demo" ? DEMO_LOOKBACK : DEFAULT_LOOKBACK;
  const startBlock = Math.max(1, starts.length ? Math.min(...starts) : headNumber - lookback);

  const r = await ingestOnce({
    projectId: p.id, networkId: NETWORK, chain, store, startBlock, abis,
    addresses: p.kind === "public_demo" ? undefined : contracts.map((c) => c.address),
    enqueueDeliveries: true,
    onBatch: ({ block, head }) => beat({ phase: "ingesting", project: p.id, block, head }),
  });
  if (r.newEvents || r.reorgDetected) console.log(`${new Date().toISOString()} ${p.id} head #${r.head} +${r.newEvents} events${r.reorgDetected ? ", REORG handled" : ""}`);
  return r.newEvents;
}

// ink! (Rust) contracts live on the native runtime. Connect only when some project has one, and reconnect after any failure.
let nativeChain: NativeChain | null = null;
async function ingestNativeProject(p: ProjectRecord): Promise<number> {
  const ink = (await store.listContracts(p.id)).filter((c) => c.status === "active" && c.runtimeType === "ink" && c.abi);
  if (ink.length === 0) return 0;
  try {
    if (!nativeChain) {
      const { PolkadotNativeChain } = await import("../../packages/chain-adapters/native.ts");
      nativeChain = await PolkadotNativeChain.connect(NATIVE_RPC);
      console.log(`PortalOps worker · native ${NATIVE_RPC} · genesis ${nativeChain.genesisHash.slice(0, 12)}…`);
    }
    const r = await ingestNativeOnce({
      projectId: p.id, chain: nativeChain, store, evmChainId: CHAIN_ID, enqueueDeliveries: true, maxLookback: NATIVE_MAX_LOOKBACK,
      contracts: ink.map((c) => ({ address: c.address, metadata: c.abi, startBlock: c.startBlock })),
      onBatch: ({ block, head }) => beat({ phase: "ingesting-native", project: p.id, block, head }),
    });
    if (r.newEvents || r.reorgDetected) console.log(`${new Date().toISOString()} ${p.id} native head #${r.head} +${r.newEvents} events${r.reorgDetected ? ", REORG handled" : ""}`);
    return r.newEvents;
  } catch (e) {
    const dead = nativeChain as NativeChain | null; nativeChain = null; // reconnect on the next pass
    await dead?.close();
    throw e;
  }
}

let failures = 0;
while (!stopping) {
  try {
    const head = await chain.getHead();
    await beat({ phase: "pass", head: head.number });
    for (const p of await store.listAllProjects()) {
      try {
        await ingestProject(p, head.number);
        await ingestNativeProject(p).catch(async (e) => {
          // A native outage must not stall the EVM side of the same project.
          const msg = e instanceof Error ? e.message : String(e);
          await store.log("error", "ingest", `Native ingestion failed: ${msg}`, undefined, p.id);
          console.error(`${new Date().toISOString()} ${p.id} native ingestion failed: ${msg}`);
        });
      } catch (e) {
        // One project's failure must not stall the others.
        const msg = e instanceof Error ? e.message : String(e);
        await store.log("error", "ingest", `Ingestion failed: ${msg}`, undefined, p.id);
        console.error(`${new Date().toISOString()} ${p.id} ingestion failed: ${msg}`);
      }
    }
    await beat({ phase: "delivering", head: head.number });
    const attempts = await runDueDeliveries({ store, encryptionKey, guard: { allowPrivate: ALLOW_PRIVATE }, maxParallel: MAX_PARALLEL, maxPerEndpoint: MAX_PER_ENDPOINT }, 50);
    if (attempts) console.log(`${new Date().toISOString()} ${attempts} delivery attempt(s)`);
    failures = 0;
  } catch (e) {
    failures++;
    console.error(`${new Date().toISOString()} pass failed (${failures}): ${e instanceof Error ? e.message : e}`);
  }
  // Adaptive backoff on repeated RPC failures, capped at 60s.
  const wait = Math.min(60_000, POLL_MS * 2 ** Math.min(failures, 4));
  for (let waited = 0; waited < wait && !stopping; waited += 250) await new Promise((r) => setTimeout(r, 250));
}
await (nativeChain as NativeChain | null)?.close();
await store.close();
console.log("Worker stopped.");
markStopped();
