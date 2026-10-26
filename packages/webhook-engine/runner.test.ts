import { makeTestStore } from "../database/testing.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Store } from "../database/store.ts";
import { encryptSecret } from "../database/secrets.ts";
import { normalizeEvmLog } from "../event-engine/normalize.ts";
import { startReceiver } from "../../examples/webhook-receiver/server.ts";
import { attemptDelivery, enqueueEvent, replayEvent, runDueDeliveries, type RunnerContext } from "./runner.ts";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../shared-types/index.ts";

const SECRET = "whsec_runner_test";
const FAST: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 4_000, maxAgeMs: 3_600_000, timeoutMs: 1_000 };

async function setup(policy: RetryPolicy = FAST, url?: string) {
  const receiver = await startReceiver(SECRET);
  const store = await makeTestStore();
  const key = randomBytes(32);
  // Start the fake clock at real time: the receiver verifies timestamp freshness against the real clock.
  let clock = Date.now();
  const ctx: RunnerContext = { store, encryptionKey: key, guard: { allowPrivate: true }, now: () => new Date(clock), random: () => 0.5 };
  const advance = (ms: number) => { clock += ms; };
  const event = normalizeEvmLog(
    { address: "0x" + "11".repeat(20), topics: ["0xaa"], data: "0x", blockNumber: 7, blockHash: "0xb7", transactionHash: "0xtx7", transactionIndex: 0, logIndex: 0, removed: false },
    { projectId: "p1", chainId: 420420777, now: ctx.now },
  );
  await store.insertEvent(event);
  const ep = await store.createEndpoint({ projectId: "p1", url: url ?? receiver.url, description: null, enabled: true, eventFilter: [], retryPolicy: policy }, encryptSecret(SECRET, key));
  return { receiver, store, ctx, advance, event, ep };
}

test("delivery: success on first attempt, signed, attempt recorded", async (t) => {
  const { receiver, store, ctx, event, ep } = await setup();
  t.after(() => receiver.close());
  const [id] = await enqueueEvent(store, event, ctx.now!());
  assert.equal(await runDueDeliveries(ctx), 1);
  const d = (await store.getDelivery(id))!;
  assert.equal(d.status, "delivered");
  assert.equal(d.attemptCount, 1);
  assert.equal(d.lastResponseStatus, 200);
  assert.equal(receiver.requests[0].signatureOk, true);
  assert.equal(receiver.requests[0].eventId, event.id);
  const [a] = await store.listAttempts(id);
  assert.equal(a.responseStatus, 200);
  assert.equal(a.attemptNumber, 1);
  void ep;
});

test("PRD scenario: deliberate failure -> retries recorded -> replay succeeds, without touching the event", async (t) => {
  const { receiver, store, ctx, advance, event, ep } = await setup();
  t.after(() => receiver.close());
  receiver.setMode("fail500");
  const [id] = await enqueueEvent(store, event, ctx.now!());

  await runDueDeliveries(ctx);
  let d = (await store.getDelivery(id))!;
  assert.equal(d.status, "retrying");
  assert.equal(d.lastResponseStatus, 500);
  assert.ok(d.nextAttemptAt);
  assert.equal(await runDueDeliveries(ctx), 0, "not due yet: retry must wait for its scheduled time");

  advance(60_000); await runDueDeliveries(ctx);
  advance(60_000); await runDueDeliveries(ctx);
  d = (await store.getDelivery(id))!;
  assert.equal(d.status, "failed"); // maxAttempts = 3
  assert.equal(d.attemptCount, 3);
  assert.equal((await store.listAttempts(id)).length, 3);
  assert.equal(await runDueDeliveries(ctx), 0, "no further attempts after exhaustion");

  // consumer recovers; user replays
  receiver.setMode("ok");
  const eventBefore = JSON.stringify(await store.getEvent(event.id));
  const replayId = await replayEvent(store, event.id, ep.id, ctx.now!());
  await runDueDeliveries(ctx);
  const r = (await store.getDelivery(replayId))!;
  assert.equal(r.status, "delivered");
  assert.equal(r.kind, "replay");
  assert.equal(JSON.stringify(await store.getEvent(event.id)), eventBefore, "replay must not alter the stored event");
  assert.ok(receiver.processed.has(event.id));
  // original failed delivery history is preserved
  assert.equal((await store.getDelivery(id))!.status, "failed");
  assert.equal((await store.listAttempts(id)).length, 3);
});

test("idempotency: replaying an already-processed event sends the same event id; receiver ignores the duplicate", async (t) => {
  const { receiver, store, ctx, event, ep } = await setup();
  t.after(() => receiver.close());
  await enqueueEvent(store, event, ctx.now!());
  await runDueDeliveries(ctx);
  await replayEvent(store, event.id, ep.id, ctx.now!());
  await runDueDeliveries(ctx);
  assert.deepEqual(receiver.requests.map((r) => r.outcome), ["ok", "ok:duplicate-ignored"]);
  assert.equal(new Set(receiver.requests.map((r) => r.eventId)).size, 1);
  assert.equal(new Set(receiver.requests.map((r) => r.deliveryId)).size, 2);
});

test("client errors (400) are not retried", async (t) => {
  const { receiver, store, ctx, event } = await setup();
  t.after(() => receiver.close());
  receiver.setMode("fail400");
  const [id] = await enqueueEvent(store, event, ctx.now!());
  await runDueDeliveries(ctx);
  const d = (await store.getDelivery(id))!;
  assert.equal(d.status, "failed");
  assert.equal(d.attemptCount, 1);
  assert.equal(d.nextAttemptAt, null);
});

test("timeouts are recorded and retried", async (t) => {
  const { receiver, store, ctx, event } = await setup({ ...FAST, timeoutMs: 150 });
  t.after(() => receiver.close());
  receiver.setMode("timeout");
  const [id] = await enqueueEvent(store, event, ctx.now!());
  await runDueDeliveries(ctx);
  const d = (await store.getDelivery(id))!;
  assert.equal(d.status, "retrying");
  assert.equal(d.lastError, "timeout");
  assert.equal((await store.listAttempts(id))[0].errorCode, "timeout");
});

test("a wrong signing secret is rejected by the receiver (401) and not retried", async (t) => {
  const { receiver, store, ctx, event, ep } = await setup();
  t.after(() => receiver.close());
  await store.rawRun("UPDATE webhook_endpoints SET encrypted_secret = ? WHERE id = ?", [encryptSecret("whsec_wrong", ctx.encryptionKey), ep.id]);
  const [id] = await enqueueEvent(store, event, ctx.now!());
  await runDueDeliveries(ctx);
  assert.equal((await store.getDelivery(id))!.status, "failed");
  assert.equal(receiver.requests[0].outcome, "rejected:mismatch");
});

test("ssrf: private targets are blocked at send time unless explicitly allowed; blocked targets are not retried", async (t) => {
  const { receiver, store, ctx, event, ep } = await setup(FAST, "http://169.254.169.254/latest/meta-data");
  t.after(() => receiver.close());
  const strict: RunnerContext = { ...ctx, guard: {} };
  const [id] = await enqueueEvent(store, event, ctx.now!());
  await attemptDelivery(strict, id);
  const d = (await store.getDelivery(id))!;
  assert.equal(d.status, "failed");
  assert.equal(d.lastError, "invalid_url"); // plain http is refused before any address check
  assert.equal(receiver.requests.length, 0);
  void ep;

  const s2 = await setup(FAST, "https://169.254.169.254/");
  t.after(() => s2.receiver.close());
  const [id2] = await enqueueEvent(s2.store, s2.event, s2.ctx.now!());
  await attemptDelivery({ ...s2.ctx, guard: {} }, id2);
  assert.equal((await s2.store.getDelivery(id2))!.lastError, "blocked_target");
  assert.equal((await s2.store.getDelivery(id2))!.status, "failed");
});

test("event filter: endpoints only receive matching events; disabled endpoints receive none", async (t) => {
  const { receiver, store, ctx, event, ep } = await setup();
  t.after(() => receiver.close());
  await store.setEndpointEnabled(ep.id, false);
  assert.deepEqual(await enqueueEvent(store, event, ctx.now!()), []);
  await store.setEndpointEnabled(ep.id, true);
  await store.rawRun("UPDATE webhook_endpoints SET event_filter = ? WHERE id = ?", [JSON.stringify(["QuestCompleted"]), ep.id]);
  assert.deepEqual(await enqueueEvent(store, event, ctx.now!()), [], "undecoded event must not match a named filter");
});

test("enqueue is idempotent: re-ingesting an event does not create a second initial delivery", async (t) => {
  const { receiver, store, ctx, event } = await setup();
  t.after(() => receiver.close());
  assert.equal((await enqueueEvent(store, event, ctx.now!())).length, 1);
  assert.equal((await enqueueEvent(store, event, ctx.now!())).length, 0);
  void DEFAULT_RETRY_POLICY;
});

test("delivery: attempts run in parallel but are bounded overall and per endpoint, and a failing batch member does not stop the rest", async (t) => {
  const http = await import("node:http");
  let active = 0, maxActive = 0;
  const perPath = new Map<string, { now: number; max: number }>();
  const server = http.createServer((req, res) => {
    const p = perPath.get(req.url!) ?? { now: 0, max: 0 };
    perPath.set(req.url!, p);
    active++; p.now++; maxActive = Math.max(maxActive, active); p.max = Math.max(p.max, p.now);
    req.resume();
    setTimeout(() => { active--; p.now--; res.writeHead(200); res.end("ok"); }, 80);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const store = await makeTestStore();
  const key = randomBytes(32);
  const ctx: RunnerContext = { store, encryptionKey: key, guard: { allowPrivate: true }, now: () => new Date(), random: () => 0.5 };
  for (let i = 0; i < 4; i++) await store.createEndpoint({ projectId: "p1", url: `${base}/e${i}`, description: null, enabled: true, eventFilter: [], retryPolicy: FAST }, encryptSecret(SECRET, key));
  let total = 0;
  for (let n = 1; n <= 6; n++) {
    const e = normalizeEvmLog({ address: "0x" + "11".repeat(20), topics: ["0xaa"], data: "0x", blockNumber: n, blockHash: "0xb" + n, transactionHash: "0xtx" + n, transactionIndex: 0, logIndex: 0, removed: false }, { projectId: "p1", chainId: 420420777 });
    await store.insertEvent(e);
    total += (await enqueueEvent(store, e, new Date())).length;
  }
  assert.equal(total, 24);

  const done = await runDueDeliveries(ctx, 50);
  assert.equal(done, 24, "everything due was attempted");
  assert.ok(maxActive > 2, "attempts overlapped (not one at a time): " + maxActive);
  assert.ok(maxActive <= 8, "never more than 8 at once: " + maxActive);
  for (const [path, v] of perPath) assert.ok(v.max <= 2, `${path} never had more than 2 in flight: ${v.max}`);

  // tighter limits are honoured
  perPath.clear(); maxActive = 0;
  for (let n = 7; n <= 9; n++) {
    const e = normalizeEvmLog({ address: "0x" + "11".repeat(20), topics: ["0xaa"], data: "0x", blockNumber: n, blockHash: "0xb" + n, transactionHash: "0xtx" + n, transactionIndex: 0, logIndex: 0, removed: false }, { projectId: "p1", chainId: 420420777 });
    await store.insertEvent(e);
    await enqueueEvent(store, e, new Date());
  }
  await runDueDeliveries({ ...ctx, maxParallel: 2, maxPerEndpoint: 1 }, 50);
  assert.ok(maxActive <= 2, "maxParallel is honoured: " + maxActive);
  for (const v of perPath.values()) assert.equal(v.max, 1);
});
