import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret } from "../../packages/database/secrets.ts";
import { enqueueEvent, runDueDeliveries } from "../../packages/webhook-engine/runner.ts";
import { DEFAULT_RETRY_POLICY } from "../../packages/shared-types/index.ts";
import { startApi } from "./test-harness.ts";
import http from "node:http";

/** A destination that always answers 500 with a message, so there is a real failed delivery to diagnose. */
async function failingDestination() {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(500, { "content-type": "text/plain" }); res.end("TypeError: Cannot read properties of undefined (reading 'winner')"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks/battle?token=SECRETQUERY`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

async function withFailedDelivery(overrides: Record<string, unknown> = {}) {
  const h = await startApi(undefined, overrides);
  const dest = await failingDestination();
  const key = await h.mkKey("write");
  const event = await h.seed(10);
  const ep = await h.store.createEndpoint({ projectId: h.project.id, url: dest.url, description: null, enabled: true, eventFilter: [], retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 } }, encryptSecret("whsec_diag", h.key));
  const [id] = await enqueueEvent(h.store, event, new Date());
  await runDueDeliveries({ store: h.store, encryptionKey: h.key, guard: { allowPrivate: true } });
  assert.equal((await h.store.getDelivery(id))!.status, "failed");
  void ep;
  return { h, dest, key, deliveryId: id, close: async () => { await dest.close(); await h.close(); } };
}

const get = (base: string, path: string, key?: string) => fetch(base + path, { headers: key ? { authorization: `Bearer ${key}` } : {} }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
const post = (base: string, path: string, key?: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: "{}" }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

test("diagnosis: a failed delivery is explained from what was recorded, with the evidence shown and no secrets in it", async (t) => {
  const x = await withFailedDelivery();
  t.after(x.close);
  const r = await get(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis`, x.key);
  assert.equal(r.status, 200);
  const d = r.json.data;
  assert.match(d.rules.cause, /receiving side|handler/i);
  assert.ok(d.rules.fixes.length > 0);
  assert.equal(d.ai.available, false, "no AI key is configured");
  assert.equal(d.evidence.attempts[0].status, 500);
  assert.match(d.evidence.attempts[0].response, /reading 'winner'/);
  const text = JSON.stringify(d);
  assert.ok(!text.includes("SECRETQUERY") && !text.includes("whsec_diag"), "no query string, no signing secret");
  assert.equal(d.evidence.endpoint.path, "/hooks/battle");
});

test("diagnosis: only the project's owner can read it, and unknown deliveries are 404", async (t) => {
  const x = await withFailedDelivery();
  t.after(x.close);
  assert.equal((await get(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis`)).status, 401, "anonymous");
  assert.equal((await get(x.h.base, `/api/v1/deliveries/dlv_nope/diagnosis`, x.key)).status, 404);
  const other = await startApi();
  t.after(() => other.close());
  const otherKey = await other.mkKey("read");
  assert.equal((await get(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis`, otherKey)).status, 401, "a key from another server is just invalid");
});

test("diagnosis: AI explanation is off without a key, and refuses a read-only API key", async (t) => {
  const x = await withFailedDelivery();
  t.after(x.close);
  const off = await post(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis/ai`, x.key);
  assert.equal(off.status, 503);
  assert.equal(off.json.error.code, "ai_unavailable");
});

test("diagnosis: with a key, the model gets only the evidence; its answer is returned beside the rule-based one; failures degrade", async (t) => {
  let calls = 0, sent = "";
  let mode: "ok" | "fail" = "ok";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++; sent = init.body as string;
    if (mode === "fail") return new Response("upstream exploded sk-ant-xyz", { status: 529 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ summary: "Your handler threw a TypeError.", likelyCause: "payload.winner is undefined.", suggestedFixes: ["Guard against undecoded events."], missingEvidence: [] }) }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const x = await withFailedDelivery({ ai: { apiKey: "sk-ant-xyz", model: "claude-haiku-5-5", fetchImpl } });
  t.after(x.close);
  const readKey = await x.h.mkKey("read");

  assert.equal((await get(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis`, x.key)).json.data.ai.available, true);
  assert.equal((await post(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis/ai`, readKey)).status, 403, "a read-only key cannot spend the model");
  assert.equal(calls, 0);

  const ok = await post(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis/ai`, x.key);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.source, "model");
  assert.equal(ok.json.data.explanation.summary, "Your handler threw a TypeError.");
  assert.ok(ok.json.data.rules.cause, "the rule-based diagnosis comes with it");
  assert.ok(!sent.includes("whsec_diag") && !sent.includes("SECRETQUERY") && !sent.includes("sk-ant-xyz"));

  mode = "fail";
  const bad = await post(x.h.base, `/api/v1/deliveries/${x.deliveryId}/diagnosis/ai`, x.key);
  assert.equal(bad.status, 502);
  assert.equal(bad.json.error.code, "ai_failed");
  assert.ok(!JSON.stringify(bad.json).includes("sk-ant-xyz") && !JSON.stringify(bad.json).includes("exploded"), "provider details are not forwarded");
  void randomBytes;
});
