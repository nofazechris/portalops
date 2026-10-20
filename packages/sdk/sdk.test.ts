import { makeTestStore } from "../database/testing.ts";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { PortalOps, PortalOpsError, verifyWebhookSignature, constructEvent, SignatureVerificationError } from "./index.ts";
import { Store } from "../database/store.ts";
import { normalizeEvmLog } from "../event-engine/normalize.ts";
import { signHeader, computeSignature } from "../webhook-engine/sign.ts";
import { enqueueEvent, runDueDeliveries } from "../webhook-engine/runner.ts";
import { startApi } from "../../apps/api/test-harness.ts";
import { RateLimiter } from "../../apps/api/http.ts";

// ----------------------------------------------------------------------------------------------------------------
// The SDK is tested against the REAL API (createApp over a real HTTP server and an in-memory store), so a change to
// the API that breaks the SDK fails here instead of in a customer's integration.

test("sdk: events.list / get / iterate with filters, pagination and the project discovered from the key", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const portal = new PortalOps({ apiKey: await api.mkKey("write"), baseUrl: api.base });
  for (let i = 1; i <= 7; i++) await api.seed(i, i % 2 ? "0x" + "11".repeat(20) : "0x" + "22".repeat(20));

  const page = await portal.events.list({ limit: 3 });
  assert.equal(page.total, 7);
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0].blockNumber, 7, "newest first");
  assert.equal(page.items[0].finalityStatus, "included");
  assert.equal(page.items[0].delivery, null);

  assert.equal((await portal.events.list({ contract: "0x" + "22".repeat(20) })).total, 3);
  assert.equal((await portal.events.list({ q: "0xtx5" })).total, 1);

  const all: number[] = [];
  for await (const e of portal.events.iterate({ limit: 3 })) all.push(e.blockNumber);
  assert.deepEqual(all, [7, 6, 5, 4, 3, 2, 1]);

  const one = await portal.events.get(page.items[0].id);
  assert.equal(one.id, page.items[0].id);
  assert.deepEqual(one.deliveries, []);
  assert.equal((await portal.project.get()).name, "SDK");
  assert.equal((await portal.project.overview()).metrics.eventsReceived, 7);
  assert.equal((await portal.project.networkStatus()).connection, "connected");
});

test("sdk: webhooks lifecycle, test delivery, receiver failure -> replay -> delivered", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const portal = new PortalOps({ apiKey: await api.mkKey("write"), baseUrl: api.base });
  const ev = await api.seed(1);

  const wh = await portal.webhooks.create({ builtinReceiver: true, description: "sdk", retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000, timeoutMs: 2000 } });
  assert.match(wh.secret, /^whsec_/);
  assert.equal(wh.builtinReceiver, true);
  assert.equal((await portal.webhooks.list()).length, 1);
  assert.ok(!JSON.stringify(await portal.webhooks.list()).includes(wh.secret), "secret is not retrievable afterwards");

  assert.equal((await portal.webhooks.test(wh.id)).ok, true);
  assert.equal((await portal.webhooks.update(wh.id, { description: "renamed", eventFilter: ["Anything"] })).description, "renamed");
  await portal.webhooks.update(wh.id, { eventFilter: [] });

  // deliver, break the receiver, fail, recover, replay through the SDK
  let skew = 0;
  const ctx = { store: api.store, encryptionKey: api.key, guard: { allowPrivate: true }, now: () => new Date(Date.now() + skew), random: () => 0.5 };
  await portal.webhooks.setReceiverMode(wh.id, "fail500");
  await enqueueEvent(api.store, ev, ctx.now());
  await runDueDeliveries(ctx); skew += 5_000; await runDueDeliveries(ctx);
  const failed = await portal.deliveries.list({ status: "failed" });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].lastResponseStatus, 500);
  assert.equal(failed[0].event.id, ev.id);

  await portal.webhooks.setReceiverMode(wh.id, "ok");
  const rep = await portal.events.replay(ev.id, { endpointId: wh.id });
  assert.equal(rep.deliveryIds.length, 1);
  await runDueDeliveries(ctx);
  const detail = await portal.events.get(ev.id);
  assert.deepEqual(detail.deliveries.map((d) => `${d.kind}:${d.status}:${d.attempts.length}`).sort(), ["initial:failed:2", "replay:delivered:1"]);
  assert.equal((await portal.webhooks.deliveries(wh.id)).length, 2);
  assert.equal((await portal.events.list({ delivery: "delivered" })).total, 1);

  const rotated = await portal.webhooks.rotateSecret(wh.id);
  assert.notEqual(rotated.secret, wh.secret);
  await portal.webhooks.delete(wh.id);
  assert.equal((await portal.webhooks.list()).length, 0);
});

test("sdk: contracts and automations", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const portal = new PortalOps({ apiKey: await api.mkKey("write"), baseUrl: api.base });
  const c = await portal.contracts.add({ address: "0x" + "00".repeat(19) + "01", name: "Q", abi: [{ type: "event", name: "QuestCreated", inputs: [] }] });
  assert.deepEqual(c.events, ["QuestCreated"]);
  assert.equal((await portal.contracts.test(c.id)).codeFound, true);
  assert.equal((await portal.contracts.list()).length, 1);
  const wh = await portal.webhooks.create({ builtinReceiver: true });
  const a = await portal.automations.create({ name: "rule", triggerEventName: "QuestCreated", endpointId: wh.id });
  assert.equal((await portal.automations.setEnabled(a.id, false)).enabled, false);
  assert.equal((await portal.automations.list()).length, 1);
  await portal.automations.delete(a.id);
  assert.equal((await portal.automations.list()).length, 0);
});

test("sdk: errors are typed — auth, not found, validation, scope, session-only, rate limit", async (t) => {
  const api = await startApi({ keys: new RateLimiter(6, 60_000) }); t.after(() => api.close());
  const ro = new PortalOps({ apiKey: await api.mkKey("read"), baseUrl: api.base, maxRetries: 0 });
  const bad = new PortalOps({ apiKey: "pops_" + "x".repeat(43), baseUrl: api.base, maxRetries: 0 });

  await assert.rejects(bad.events.list(), (e: PortalOpsError) => e instanceof PortalOpsError && e.status === 401 && e.code === "invalid_api_key");
  await assert.rejects(ro.events.get("evt_missing"), (e: PortalOpsError) => e.status === 404 && e.code === "not_found");
  await assert.rejects(ro.webhooks.create({ builtinReceiver: true }), (e: PortalOpsError) => e.status === 403 && e.code === "insufficient_scope");

  const rw = new PortalOps({ apiKey: await api.mkKey("write"), baseUrl: api.base, maxRetries: 0 });
  await assert.rejects(rw.webhooks.create({}), (e: PortalOpsError) => e.status === 422 && e.code === "validation_failed" && e.details![0].path === "url");
  await assert.rejects(rw.contracts.add({ address: "0x123" }), (e: PortalOpsError) => e.status === 422 && e.details![0].path === "address");

  // per-key rate limit (6/min): the typed error carries Retry-After
  let limited: PortalOpsError | undefined;
  for (let i = 0; i < 10 && !limited; i++) { try { await ro.events.list(); } catch (e) { limited = e as PortalOpsError; } }
  assert.equal(limited?.status, 429);
  assert.equal(limited?.code, "rate_limited");
  assert.ok((limited?.retryAfterSeconds ?? 0) > 0);
});

test("sdk: reads are retried on 5xx/429 with Retry-After; writes are never retried; timeouts and network errors are typed", async (t) => {
  let getCalls = 0, postCalls = 0;
  const stub = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/v1/projects/prj_x/events")) {
      getCalls++;
      if (getCalls <= 2) { res.writeHead(getCalls === 1 ? 503 : 429, { "content-type": "application/json", "retry-after": "1" }); res.end(JSON.stringify({ error: { code: "unavailable", message: "try later" } })); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { items: [], total: 0, limit: 50, offset: 0 } })); return;
    }
    if (req.url === "/api/v1/projects/prj_x/webhooks" && req.method === "POST") { postCalls++; res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "unavailable", message: "down" } })); return; }
    if (req.url?.includes("/hang")) return; // never answer
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  const base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const key = "pops_" + "k".repeat(43);

  const portal = new PortalOps({ apiKey: key, baseUrl: base, projectId: "prj_x", maxRetries: 2 });
  const t0 = Date.now();
  assert.deepEqual((await portal.events.list()).items, []);
  assert.equal(getCalls, 3, "two failures then success");
  assert.ok(Date.now() - t0 >= 1_000, "Retry-After was honoured");

  await assert.rejects(portal.webhooks.create({ url: "https://x.example/h" }), (e: PortalOpsError) => e.status === 503);
  assert.equal(postCalls, 1, "a write is sent exactly once");

  const slow = new PortalOps({ apiKey: key, baseUrl: base, projectId: "prj_x", timeoutMs: 200, maxRetries: 0 });
  await assert.rejects(slow.events.get("hang"), (e: PortalOpsError) => e.status === 0 && e.code === "timeout");
  const down = new PortalOps({ apiKey: key, baseUrl: "http://127.0.0.1:1", projectId: "prj_x", maxRetries: 0 });
  await assert.rejects(down.events.list(), (e: PortalOpsError) => e.status === 0 && e.code === "network_error");
});

test("sdk: construction rules protect the API key", async () => {
  const key = "pops_" + "a".repeat(43);
  assert.throws(() => new PortalOps({ apiKey: "nope", baseUrl: "https://x.example" }), /apiKey/);
  assert.throws(() => new PortalOps({ apiKey: "", baseUrl: "https://x.example" }), /apiKey/);
  assert.throws(() => new PortalOps({ apiKey: key } as never), /baseUrl/, "baseUrl is required");
  assert.throws(() => new PortalOps({ apiKey: key, baseUrl: "not a url" }), /valid URL/);
  assert.throws(() => new PortalOps({ apiKey: key, baseUrl: "http://portalops.example.com" }), /https/, "the key is never sent over plain http to a remote host");
  assert.doesNotThrow(() => new PortalOps({ apiKey: key, baseUrl: "https://portalops.example.com/" }));
  assert.doesNotThrow(() => new PortalOps({ apiKey: key, baseUrl: "http://localhost:8787" }));
  assert.doesNotThrow(() => new PortalOps({ apiKey: key, baseUrl: "http://127.0.0.1:8787" }));
});

test("sdk: the Authorization header goes only to the configured host (redirects are refused)", async (t) => {
  const seen: string[] = [];
  const target = http.createServer((req, res) => { seen.push(String(req.headers.authorization ?? "")); res.end("{}"); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const redirector = http.createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${(target.address() as { port: number }).port}/steal` }); res.end(); });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  t.after(() => { target.closeAllConnections(); target.close(); redirector.closeAllConnections(); redirector.close(); });

  const portal = new PortalOps({ apiKey: "pops_" + "s".repeat(43), baseUrl: `http://127.0.0.1:${(redirector.address() as { port: number }).port}`, projectId: "p", maxRetries: 0 });
  await assert.rejects(portal.events.list(), (e: PortalOpsError) => e instanceof PortalOpsError);
  assert.deepEqual(seen, [], "the redirect target never received the key");
});

test("sdk: webhook signature verification matches the server, rejects tampering and staleness, and constructEvent never parses unverified bodies", async () => {
  const secret = "whsec_sdk_verify";
  const body = JSON.stringify({ id: "evt_1", type: "event.received", network: "portaldot-v3-testnet", data: { eventName: "QuestCreated" } });

  // independent known-answer vector (computed with: printf '%s' '1700000000.{}' | openssl dgst -sha256 -hmac k)
  assert.equal(computeSignature("k", 1700000000, "{}"), "c6ef4734033cee2367414a0939385eca0397754aa7a59716da7463a9298b5146");
  assert.deepEqual(verifyWebhookSignature("k", "{}", "t=1700000000,v1=c6ef4734033cee2367414a0939385eca0397754aa7a59716da7463a9298b5146", { now: new Date(1700000000_000) }), { ok: true });

  // whatever the server signs, the SDK verifies
  const now = new Date();
  const { header } = signHeader(secret, body, now);
  assert.deepEqual(verifyWebhookSignature(secret, body, header, { now }), { ok: true });
  assert.deepEqual(verifyWebhookSignature(secret, new TextEncoder().encode(body), header, { now }), { ok: true }, "raw bytes work too");
  assert.equal(constructEvent(secret, body, header, { now }).data.eventName, "QuestCreated");

  assert.deepEqual(verifyWebhookSignature(secret, body + " ", header, { now }), { ok: false, reason: "mismatch" });
  assert.deepEqual(verifyWebhookSignature("whsec_other", body, header, { now }), { ok: false, reason: "mismatch" });
  assert.deepEqual(verifyWebhookSignature(secret, body, "garbage", { now }), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyWebhookSignature(secret, body, undefined, { now }), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyWebhookSignature(secret, body, header, { now: new Date(now.getTime() + 10 * 60_000) }), { ok: false, reason: "expired" });
  assert.deepEqual(verifyWebhookSignature(secret, body, header, { now: new Date(now.getTime() + 10 * 60_000), toleranceSeconds: 3600 }), { ok: true });

  assert.throws(() => constructEvent(secret, "{ not json but also not signed", header, { now }), (e: SignatureVerificationError) => e instanceof SignatureVerificationError && e.reason === "mismatch");
  assert.throws(() => constructEvent(secret, body, undefined), (e: SignatureVerificationError) => e.reason === "malformed");
});
