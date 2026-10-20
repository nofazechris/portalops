// End-to-end pipeline check against the PUBLIC testnet (read-only on-chain, local webhook receiver):
//
//   real eth_getLogs -> normalise -> persist -> queue delivery -> signed POST -> deliberate 500 -> retries -> replay -> 200
//
// The logs ingested here are REAL events emitted by OTHER participants' contracts on Portaldot V3.0 testnet.
// They are stored undecoded (no ABI) and are NOT our PortalQuest demo contract. This proves the pipeline works on live
// chain data; it does not replace deploying and invoking our own contract.
//
//   npm run pipeline:test
import { randomBytes } from "node:crypto";
import { EvmAdapter } from "../../packages/chain-adapters/evm.ts";
import { Store } from "../../packages/database/store.ts";
import { encryptSecret, generateWebhookSecret } from "../../packages/database/secrets.ts";
import { ingestOnce } from "../../apps/worker/ingest.ts";
import { replayEvent, runDueDeliveries, type RunnerContext } from "../../packages/webhook-engine/runner.ts";
import { startReceiver } from "../../examples/webhook-receiver/server.ts";
import { DEFAULT_RETRY_POLICY } from "../../packages/shared-types/index.ts";

const RPC = process.env.PORTALDOT_EVM_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev";
const CHAIN_ID = Number(process.env.PORTALDOT_EVM_CHAIN_ID || 420420777);
const LOOKBACK = Number(process.env.PIPELINE_LOOKBACK_BLOCKS || 20_000);
const NETWORK = "portaldot-v3-testnet";
const PROJECT = "pipeline-check";

const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);
const fail = (msg: string): never => { console.error(`\nFAILED: ${msg}`); process.exit(1); };

const chain = new EvmAdapter(RPC, CHAIN_ID);
await chain.assertChain();
const head = await chain.getHead();
console.log(`Connected to ${RPC} · chain ${CHAIN_ID} verified · head #${head.number} (${head.hash.slice(0, 14)}…)`);

const store = new Store();
await store.ensureProject(PROJECT, "Pipeline check", NETWORK);
const key = randomBytes(32);
const secret = generateWebhookSecret();
const receiver = await startReceiver(secret);

// Fake-able clock so the demo doesn't sit through real backoff delays.
let skew = 0;
const ctx: RunnerContext = { store, encryptionKey: key, guard: { allowPrivate: true }, now: () => new Date(Date.now() + skew) };

try {
  step(1, `Ingest real logs from the last ${LOOKBACK} blocks`);
  const ep = await store.createEndpoint(
    { projectId: PROJECT, url: receiver.url, description: "local test receiver", enabled: true, eventFilter: [], retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 2_000, timeoutMs: 3_000 } },
    encryptSecret(secret, key),
  );
  // Cap how many events we deliver so the demo stays short: ingest, then use only the first few.
  const report = await ingestOnce({ projectId: PROJECT, networkId: NETWORK, chain, store, startBlock: Math.max(1, head.number - LOOKBACK), batchSize: 5_000, enqueueDeliveries: true });
  console.log(`    logs seen ${report.logsSeen} · new events ${report.newEvents} · duplicates ${report.duplicates} · lag ${report.lagBlocks} blocks`);
  if (report.newEvents === 0) fail("No logs found in the window; widen PIPELINE_LOOKBACK_BLOCKS.");

  // Re-running ingestion over the same range must add nothing.
  await store.deleteCursor(PROJECT, NETWORK);
  const again = await ingestOnce({ projectId: PROJECT, networkId: NETWORK, chain, store, startBlock: Math.max(1, head.number - LOOKBACK), batchSize: 5_000, enqueueDeliveries: true });
  console.log(`    re-ingest of the same range: new ${again.newEvents} · duplicates ${again.duplicates}  (idempotent: ${again.newEvents === 0})`);
  if (again.newEvents !== 0) fail("Re-ingestion created duplicate events.");

  const events = await store.listEvents({ projectId: PROJECT, limit: 500 });
  const pending = await store.listDeliveries({ endpointId: ep.id, status: "pending", limit: 500 });
  console.log(`    stored ${events.length} events · ${pending.length} deliveries queued`);
  const sample = events.slice(0, 3);
  for (const e of sample) console.log(`      ${e.id}  block #${e.blockNumber}  tx ${e.transactionHash.slice(0, 14)}…  contract ${e.contractAddress.slice(0, 12)}…  ${e.finalityStatus}`);

  step(2, "Receiver is failing (HTTP 500): deliveries should be retried, not lost");
  receiver.setMode("fail500");
  await runDueDeliveries(ctx, 1_000);
  const retrying = await store.listDeliveries({ endpointId: ep.id, status: "retrying", limit: 500 });
  console.log(`    first attempts done: ${retrying.length} retrying, ${receiver.requests.length} requests all answered 500`);
  if (retrying.length !== events.length) fail("Expected every delivery to be in 'retrying' after a 500.");

  step(3, "Let the retry policy exhaust against the still-failing receiver");
  for (let i = 0; i < 4; i++) { skew += 10_000; await runDueDeliveries(ctx, 1_000); }
  const failed = await store.listDeliveries({ endpointId: ep.id, status: "failed", limit: 500 });
  console.log(`    ${failed.length} deliveries ended 'failed' after ${(await store.listAttempts(failed[0].id)).length} attempts each`);
  if (failed.length !== events.length) fail("Expected all deliveries to be 'failed' after retry exhaustion.");

  step(4, "Receiver recovers; replay every failed event (stored payload re-sent, chain untouched)");
  receiver.setMode("ok");
  for (const e of events) await replayEvent(store, e.id, ep.id, ctx.now!());
  await runDueDeliveries(ctx, 1_000);
  const delivered = await store.listDeliveries({ endpointId: ep.id, status: "delivered", limit: 500 });
  console.log(`    ${delivered.length} replay deliveries succeeded · receiver processed ${receiver.processed.size} distinct event ids`);
  if (delivered.length !== events.length) fail("Not every replay was delivered.");
  if (receiver.requests.some((r) => !r.signatureOk)) fail("Receiver saw an invalid signature.");

  step(5, "Evidence for one event");
  const ev = events[0];
  console.log(`    event       ${ev.id}`);
  console.log(`    tx hash     ${ev.transactionHash}`);
  console.log(`    block       #${ev.blockNumber}  ${ev.blockHash}`);
  for (const d of await store.listDeliveries({ eventId: ev.id })) {
    console.log(`    delivery ${d.id} [${d.kind}] -> ${d.status} after ${d.attemptCount} attempt(s)`);
    for (const a of await store.listAttempts(d.id)) console.log(`        attempt ${a.attemptNumber}: ${a.responseStatus ?? a.errorCode} in ${a.responseDurationMs}ms`);
  }
  console.log("\nPASS: real testnet logs -> persisted -> signed delivery -> failure -> retries -> replay -> success");
  console.log("Note: these are other participants' contract events, undecoded. Deploying and invoking our own contract is still pending a funded account.");
} finally {
  await receiver.close();
  await store.close();
}
