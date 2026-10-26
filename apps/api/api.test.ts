import { makeTestStore } from "../../packages/database/testing.ts";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Store } from "../../packages/database/store.ts";
import { decryptSecret } from "../../packages/database/secrets.ts";
import { normalizeEvmLog } from "../../packages/event-engine/normalize.ts";
import { enqueueEvent, runDueDeliveries } from "../../packages/webhook-engine/runner.ts";
import { startReceiver } from "../../examples/webhook-receiver/server.ts";
import { createApp, type AppConfig, type NetworkProbe } from "./app.ts";
import { RateLimiter } from "./http.ts";

const PASSWORD = "correct horse battery staple";

interface Harness {
  base: string;
  store: Store;
  key: Buffer;
  probe: { ok: boolean };
  close(): Promise<void>;
}

async function start(over: Partial<AppConfig> = {}, limiters?: ConstructorParameters<typeof Object>[0]): Promise<Harness> {
  const store = await makeTestStore();
  const key = randomBytes(32);
  const probe = { ok: true };
  const network: NetworkProbe = {
    check: async () => (probe.ok ? { chainIdVerified: true, reportedChainId: 420420777, headBlock: 5000, latencyMs: 3, error: null } : { chainIdVerified: false, reportedChainId: null, headBlock: null, latencyMs: 0, error: "connect ECONNREFUSED" }),
    getCode: async (a) => (a.endsWith("1") ? "0x6080604052" : "0x"),
  };
  const config: AppConfig = { networkId: "portaldot-v3-testnet", networkLabel: "Portaldot V3.0 Testnet", chainId: 420420777, encryptionKey: key, allowedOrigins: ["http://localhost:5173"], cookieSecure: false, sessionTtlMs: 3_600_000, allowPrivateWebhookTargets: true, maxProjectsPerUser: 3, receiverBaseUrl: null, receiverTimeoutHoldMs: 300, ...over };
  const handler = createApp({
    store, network,
    config,
    rateLimits: (limiters as never) ?? { auth: new RateLimiter(1000, 60_000), global: new RateLimiter(100_000, 60_000), actions: new RateLimiter(1000, 60_000) },
  });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  if (config.receiverBaseUrl === null && over.receiverBaseUrl === undefined) config.receiverBaseUrl = `http://127.0.0.1:${port}`; // the receiver is hosted by this very server
  return { base: `http://127.0.0.1:${port}`, store, key, probe, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Tiny cookie-jar client. */
class Client {
  cookie = "";
  readonly base: string;
  constructor(base: string) { this.base = base; }
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, data: json?.data, error: json?.error, headers: res.headers, text };
  }
  async signup(email: string) {
    const r = await this.call("POST", "/api/v1/auth/signup", { email, password: PASSWORD });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r;
  }
}

const logFor = (n: number, projectId: string, name = "0x" + "11".repeat(20)) =>
  normalizeEvmLog({ address: name, topics: ["0xaa"], data: "0x", blockNumber: n, blockHash: "0xb" + n, transactionHash: "0xtx" + n, transactionIndex: 0, logIndex: 0, removed: false }, { projectId, chainId: 420420777 });

test("health, networks and public status are public; status is honest when the RPC is down", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base);
  assert.equal((await c.call("GET", "/api/v1/health")).data.ok, true);
  assert.equal((await c.call("GET", "/api/v1/networks")).data[0].evmChainId, 420420777);
  const up = (await c.call("GET", "/api/v1/public/status")).data;
  assert.equal(up.connection, "connected");
  assert.equal(up.headBlock, 5000);
  h.probe.ok = false;
  await new Promise((r) => setTimeout(r, 5_100)); // status cache is 5s
  const down = (await c.call("GET", "/api/v1/public/status")).data;
  assert.equal(down.connection, "disconnected");
  assert.equal(down.headBlock, null); // never a made-up head block
});

test("auth: validation, duplicate email, uniform login failure, cookie flags, logout revokes the session", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base);

  const weak = await c.call("POST", "/api/v1/auth/signup", { email: "a@example.com", password: "short" });
  assert.equal(weak.status, 422);
  assert.equal((await c.call("POST", "/api/v1/auth/signup", { email: "not-an-email", password: PASSWORD })).status, 422);

  const ok = await c.signup("Ada@Example.com");
  const cookie = ok.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(ok.data.user.email, "ada@example.com"); // normalised
  assert.ok(!JSON.stringify(ok.json).includes("password"));

  assert.equal((await c.call("POST", "/api/v1/auth/signup", { email: "ada@example.com", password: PASSWORD })).status, 409);
  assert.equal((await c.call("GET", "/api/v1/auth/me")).data.user.email, "ada@example.com");

  // the password is stored as a scrypt hash, and the session token is stored hashed
  const row = (await h.store.rawAll("SELECT password_hash FROM users"))[0] as { password_hash: string };
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
  const rawToken = decodeURIComponent(c.cookie.split("=")[1]);
  assert.equal(Number(((await h.store.rawAll("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?", [rawToken]))[0] as { n: number }).n), 0);

  const other = new Client(h.base);
  const wrongPw = await other.call("POST", "/api/v1/auth/login", { email: "ada@example.com", password: "wrong password here" });
  const noUser = await other.call("POST", "/api/v1/auth/login", { email: "nobody@example.com", password: "wrong password here" });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPw.error.message, noUser.error.message, "must not reveal whether the account exists");

  assert.equal((await c.call("POST", "/api/v1/auth/logout", {})).status, 200);
  assert.equal(c.cookie, "");
  const stolen = new Client(h.base); stolen.cookie = `portalops_session=${rawToken}`;
  assert.equal((await stolen.call("GET", "/api/v1/auth/me")).status, 401, "a revoked session token must stop working");
});

test("expired sessions are rejected", async (t) => {
  let clock = Date.now();
  const h = await start({ now: () => new Date(clock), sessionTtlMs: 1_000 });
  t.after(() => h.close());
  const c = new Client(h.base);
  await c.signup("e@example.com");
  assert.equal((await c.call("GET", "/api/v1/auth/me")).status, 200);
  clock += 5_000;
  assert.equal((await c.call("GET", "/api/v1/auth/me")).status, 401);
});

test("project routes require authentication", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base);
  for (const [m, p] of [["GET", "/api/v1/projects"], ["POST", "/api/v1/projects"], ["GET", "/api/v1/auth/me"]] as const) {
    assert.equal((await c.call(m, p, m === "POST" ? {} : undefined)).status, 401, `${m} ${p}`);
  }
});

test("ownership: another user can neither see nor touch a project's data (404, never 403)", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const a = new Client(h.base), b = new Client(h.base);
  await a.signup("a@example.com"); await b.signup("b@example.com");

  const proj = (await a.call("POST", "/api/v1/projects", { name: "A's project" })).data;
  const contract = (await a.call("POST", `/api/v1/projects/${proj.id}/contracts`, { address: "0x" + "11".repeat(20) })).data;
  const wh = (await a.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { url: "http://127.0.0.1:9/x" })).data;
  const ev = logFor(1, proj.id); await h.store.insertEvent(ev);

  const probes: [string, string, unknown?][] = [
    ["GET", `/api/v1/projects/${proj.id}`], ["PATCH", `/api/v1/projects/${proj.id}`, { name: "pwned" }],
    ["GET", `/api/v1/projects/${proj.id}/events`], ["GET", `/api/v1/projects/${proj.id}/overview`],
    ["GET", `/api/v1/projects/${proj.id}/logs`], ["GET", `/api/v1/projects/${proj.id}/webhooks`],
    ["GET", `/api/v1/projects/${proj.id}/contracts`], ["GET", `/api/v1/projects/${proj.id}/deliveries`],
    ["GET", `/api/v1/projects/${proj.id}/network/status`], ["POST", `/api/v1/projects/${proj.id}/network/test`, {}],
    ["POST", `/api/v1/projects/${proj.id}/webhooks`, { url: "http://127.0.0.1:9/x" }],
    ["POST", `/api/v1/projects/${proj.id}/contracts`, { address: "0x" + "22".repeat(20) }],
    ["GET", `/api/v1/events/${ev.id}`], ["POST", `/api/v1/events/${ev.id}/replay`, {}],
    ["GET", `/api/v1/contracts/${contract.id}`], ["POST", `/api/v1/contracts/${contract.id}/test`, {}],
    ["PATCH", `/api/v1/webhooks/${wh.id}`, { enabled: false }], ["DELETE", `/api/v1/webhooks/${wh.id}`],
    ["POST", `/api/v1/webhooks/${wh.id}/test`, {}], ["POST", `/api/v1/webhooks/${wh.id}/rotate-secret`, {}],
    ["GET", `/api/v1/webhooks/${wh.id}/deliveries`],
  ];
  for (const [m, p, body] of probes) {
    const r = await b.call(m, p, body);
    assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`);
  }
  assert.deepEqual((await b.call("GET", "/api/v1/projects")).data, []);
  // and nothing changed
  assert.equal((await a.call("GET", `/api/v1/projects/${proj.id}`)).data.name, "A's project");
  assert.equal((await a.call("GET", `/api/v1/projects/${proj.id}/webhooks`)).data.length, 1);
});

test("public demo project: anyone can read events and overview, nothing sensitive, nothing writable", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const demo = await h.store.createProject({ ownerId: null, name: "Public explorer", networkId: "portaldot-v3-testnet", kind: "public_demo" });
  await h.store.insertEvent(logFor(1, demo.id));
  const anon = new Client(h.base);

  assert.equal((await anon.call("GET", `/api/v1/projects/${demo.id}/events`)).data.total, 1);
  assert.equal((await anon.call("GET", `/api/v1/projects/${demo.id}/overview`)).data.metrics.eventsReceived, 1);
  assert.equal((await anon.call("GET", `/api/v1/projects/${demo.id}/network/status`)).data.connection, "connected");

  const user = new Client(h.base); await user.signup("u@example.com");
  for (const c of [anon, user]) {
    for (const [m, p, body] of [
      ["GET", `/api/v1/projects/${demo.id}/logs`], ["GET", `/api/v1/projects/${demo.id}/webhooks`], ["GET", `/api/v1/projects/${demo.id}/deliveries`],
      ["POST", `/api/v1/projects/${demo.id}/webhooks`, { url: "https://x.example/h" }], ["PATCH", `/api/v1/projects/${demo.id}`, { name: "x" }],
      ["POST", `/api/v1/projects/${demo.id}/contracts`, { address: "0x" + "33".repeat(20) }],
    ] as [string, string, unknown?][]) {
      const r = await c.call(m, p, body);
      assert.ok(r.status === 401 || r.status === 404, `${m} ${p} -> ${r.status}`);
    }
  }
  const ev = (await h.store.listEvents({ projectId: demo.id }))[0];
  assert.deepEqual((await anon.call("GET", `/api/v1/events/${ev.id}`)).data.deliveries, [], "delivery history is not public");
  assert.equal((await anon.call("POST", `/api/v1/events/${ev.id}/replay`, {})).status, 401);
});

test("webhooks: secret shown once, never readable, encrypted at rest; rotation; SSRF policy", async (t) => {
  const h = await start();
  const strict = await start({ allowPrivateWebhookTargets: false });
  t.after(async () => { await h.close(); await strict.close(); });
  const c = new Client(h.base); await c.signup("w@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "P" })).data;

  const created = await c.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { url: "http://127.0.0.1:9/hook", eventFilter: ["QuestCompleted"] });
  assert.equal(created.status, 201);
  assert.match(created.data.secret, /^whsec_/);

  for (const r of [await c.call("GET", `/api/v1/projects/${proj.id}/webhooks`), await c.call("PATCH", `/api/v1/webhooks/${created.data.id}`, { description: "d" })]) {
    assert.ok(!r.text.includes(created.data.secret), "secret must never be returned again");
    assert.ok(!/encrypted|secret/i.test(r.text.replace(/"description"/g, "")) || !r.text.includes("whsec_"));
  }
  const stored = (await h.store.getEndpointWithSecret(created.data.id))!;
  assert.ok(!stored.encryptedSecret.includes(created.data.secret));
  assert.equal(decryptSecret(stored.encryptedSecret, h.key), created.data.secret);

  const rotated = await c.call("POST", `/api/v1/webhooks/${created.data.id}/rotate-secret`, {});
  assert.notEqual(rotated.data.secret, created.data.secret);
  assert.equal(decryptSecret((await h.store.getEndpointWithSecret(created.data.id))!.encryptedSecret, h.key), rotated.data.secret);

  // production-style policy: private/loopback/metadata and plain http are rejected at configuration time
  const s = new Client(strict.base); await s.signup("s@example.com");
  const sp = (await s.call("POST", "/api/v1/projects", { name: "S" })).data;
  for (const url of ["http://127.0.0.1:9/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/", "ftp://example.com/x", "https://user:pw@example.com/", "javascript:alert(1)"]) {
    const r = await s.call("POST", `/api/v1/projects/${sp.id}/webhooks`, { url });
    assert.equal(r.status, 422, url);
  }

  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { url: "not a url" })).status, 422);
  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { url: "http://127.0.0.1:9/x", retryPolicy: { maxAttempts: 99 } })).status, 422);
  assert.equal((await c.call("DELETE", `/api/v1/webhooks/${created.data.id}`)).status, 200);
  assert.equal((await c.call("GET", `/api/v1/projects/${proj.id}/webhooks`)).data.length, 0);
});

test("end to end through the API: events -> delivery fails -> replay via API -> delivered, metrics and history reflect it", async (t) => {
  const h = await start();
  const receiver = await startReceiver("placeholder");
  t.after(async () => { await h.close(); await receiver.close(); });
  const c = new Client(h.base); await c.signup("e2e@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "E2E" })).data;
  const addr = "0x" + "11".repeat(20);
  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/contracts`, { address: addr, name: "Quest" })).status, 201);
  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/contracts`, { address: addr })).status, 409);

  const wh = (await c.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { url: receiver.url, retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000, timeoutMs: 2000 } })).data;
  // make the receiver verify with the secret the API issued
  await receiver.close();
  const rcv = await startReceiver(wh.secret);
  await h.store.updateEndpoint(wh.id, { url: rcv.url });
  t.after(() => rcv.close());

  const ev = logFor(10, proj.id, addr);
  await h.store.insertEvent(ev);
  let clock = Date.now();
  const ctx = { store: h.store, encryptionKey: h.key, guard: { allowPrivate: true }, now: () => new Date(clock), random: () => 0.5 };
  await enqueueEvent(h.store, ev, ctx.now());

  rcv.setMode("fail500");
  await runDueDeliveries(ctx);
  clock += 5_000; await runDueDeliveries(ctx);

  let ov = (await c.call("GET", `/api/v1/projects/${proj.id}/overview`)).data;
  assert.equal(ov.metrics.eventsReceived, 1);
  assert.equal(ov.metrics.failed, 1);
  assert.equal(ov.metrics.delivered, 0);
  assert.equal(ov.recentFailures.length, 1);
  assert.equal(ov.recentFailures[0].lastResponseStatus, 500);
  assert.equal(ov.setup.firstDeliverySucceeded, false);
  assert.match(ov.nextAction, /test delivery/i);

  const failedList = (await c.call("GET", `/api/v1/projects/${proj.id}/deliveries?status=failed`)).data;
  assert.equal(failedList.length, 1);

  rcv.setMode("ok");
  const rep = await c.call("POST", `/api/v1/events/${ev.id}/replay`, { endpointId: wh.id });
  assert.equal(rep.status, 202);
  assert.equal(rep.data.deliveryIds.length, 1);
  await runDueDeliveries(ctx);

  const detail = (await c.call("GET", `/api/v1/events/${ev.id}`)).data;
  assert.equal(detail.deliveries.length, 2);
  const kinds = detail.deliveries.map((d: any) => `${d.kind}:${d.status}:${d.attempts.length}`).sort();
  assert.deepEqual(kinds, ["initial:failed:2", "replay:delivered:1"]);

  ov = (await c.call("GET", `/api/v1/projects/${proj.id}/overview`)).data;
  assert.equal(ov.metrics.delivered, 1);
  assert.equal(ov.setup.firstDeliverySucceeded, true);

  const list = (await c.call("GET", `/api/v1/projects/${proj.id}/events`)).data;
  assert.equal(list.items[0].delivery.status, "delivered");
  assert.equal((await c.call("GET", `/api/v1/projects/${proj.id}/logs`)).data.some((l: any) => l.area === "replay"), true);
  assert.equal((await c.call("GET", `/api/v1/projects/${proj.id}/audit`)).data.some((a: any) => a.action === "event.replay"), true);
  assert.equal((await c.call("POST", `/api/v1/webhooks/${wh.id}/test`, {})).data.ok, true);
});

test("events: search, filters, pagination; replay with no endpoints is a clear 409", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("s@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "S" })).data;
  for (let i = 1; i <= 5; i++) await h.store.insertEvent(logFor(i, proj.id, i % 2 ? "0x" + "11".repeat(20) : "0x" + "22".repeat(20)));
  const base = `/api/v1/projects/${proj.id}/events`;
  assert.equal((await c.call("GET", base)).data.total, 5);
  assert.equal((await c.call("GET", `${base}?limit=2&offset=0`)).data.items.length, 2);
  assert.equal((await c.call("GET", `${base}?limit=2&offset=4`)).data.items.length, 1);
  assert.equal((await c.call("GET", `${base}?contract=0x${"22".repeat(20)}`)).data.total, 2);
  assert.equal((await c.call("GET", `${base}?q=0xtx3`)).data.total, 1);
  assert.equal((await c.call("GET", `${base}?q=%25`)).data.total, 0, "LIKE wildcards in input are escaped");
  assert.equal((await c.call("GET", `${base}?finality=orphaned`)).data.total, 0);
  assert.equal((await c.call("GET", `${base}?limit=9999`)).status, 422);
  assert.equal((await c.call("GET", `${base}?finality=bogus`)).status, 422);
  const ev = (await c.call("GET", base)).data.items[0];
  assert.equal((await c.call("POST", `/api/v1/events/${ev.id}/replay`, {})).status, 409);
  assert.equal((await c.call("GET", "/api/v1/events/evt_doesnotexist")).status, 404);
});

test("contracts: address validation and a read-only test that reports what the chain says", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("c@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "C" })).data;
  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/contracts`, { address: "0x123" })).status, 422);
  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/contracts`, { address: "0x" + "zz".repeat(20) })).status, 422);
  const abi = [{ type: "event", name: "QuestCreated", inputs: [] }];
  const withCode = (await c.call("POST", `/api/v1/projects/${proj.id}/contracts`, { address: "0x" + "00".repeat(19) + "01", abi })).data;
  const noCode = (await c.call("POST", `/api/v1/projects/${proj.id}/contracts`, { address: "0x" + "00".repeat(19) + "02" })).data;
  assert.equal((await c.call("POST", `/api/v1/contracts/${withCode.id}/test`, {})).data.codeFound, true);
  assert.equal((await c.call("POST", `/api/v1/contracts/${noCode.id}/test`, {})).data.codeFound, false);
  const list = (await c.call("GET", `/api/v1/projects/${proj.id}/contracts`)).data;
  assert.deepEqual(list.find((x: any) => x.id === withCode.id).events, ["QuestCreated"]);
  assert.equal(list[0].abi, undefined, "ABI body is not dumped into list responses");
});

test("automations: rules queue deliveries for matching events only; endpoint must belong to the project", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("au@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "A" })).data;
  const wh = (await c.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { url: "http://127.0.0.1:9/x", eventFilter: ["NeverMatches"] })).data;
  const other = new Client(h.base); await other.signup("au2@example.com");
  const oproj = (await other.call("POST", "/api/v1/projects", { name: "O" })).data;
  const owh = (await other.call("POST", `/api/v1/projects/${oproj.id}/webhooks`, { url: "http://127.0.0.1:9/y" })).data;

  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/automations`, { name: "x", endpointId: owh.id })).status, 422, "cannot target another project's endpoint");
  const rule = (await c.call("POST", `/api/v1/projects/${proj.id}/automations`, { name: "contract rule", triggerContract: "0x" + "11".repeat(20), endpointId: wh.id })).data;

  const hit = logFor(1, proj.id, "0x" + "11".repeat(20)); const miss = logFor(2, proj.id, "0x" + "22".repeat(20));
  await h.store.insertEvent(hit); await h.store.insertEvent(miss);
  assert.equal((await enqueueEvent(h.store, hit)).length, 1);
  assert.equal((await enqueueEvent(h.store, miss)).length, 0);

  await c.call("PATCH", `/api/v1/automations/${rule.id}`, { enabled: false });
  const hit2 = logFor(3, proj.id, "0x" + "11".repeat(20)); await h.store.insertEvent(hit2);
  assert.equal((await enqueueEvent(h.store, hit2)).length, 0, "disabled rules do nothing");
  assert.equal((await other.call("PATCH", `/api/v1/automations/${rule.id}`, { enabled: true })).status, 404);
});

test("limits per user: project cap", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("l@example.com");
  for (let i = 0; i < 3; i++) assert.equal((await c.call("POST", "/api/v1/projects", { name: "p" + i })).status, 201);
  assert.equal((await c.call("POST", "/api/v1/projects", { name: "p4" })).status, 409);
});

test("rate limiting: brute-force logins are throttled; Retry-After is set", async (t) => {
  const h = await start({}, { auth: new RateLimiter(3, 60_000), global: new RateLimiter(100_000, 60_000), actions: new RateLimiter(1000, 60_000) });
  t.after(() => h.close());
  const c = new Client(h.base);
  const statuses: number[] = [];
  let last;
  for (let i = 0; i < 6; i++) { last = await c.call("POST", "/api/v1/auth/login", { email: "x@example.com", password: "whatever password" }); statuses.push(last.status); }
  assert.ok(statuses.includes(429), statuses.join(","));
  assert.ok(Number(last!.headers.get("retry-after")) > 0);
});

test("CSRF/origin: cross-origin state-changing requests are blocked; same-origin and allowed origins pass", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("o@example.com");
  const evil = await c.call("POST", "/api/v1/projects", { name: "x" }, { origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal((await c.call("POST", "/api/v1/projects", { name: "ok" }, { origin: "http://localhost:5173" })).status, 201);
  assert.equal((await c.call("POST", "/api/v1/projects", { name: "ok2" }, { origin: h.base })).status, 201);
  assert.equal((await c.call("GET", "/api/v1/projects", undefined, { origin: "https://evil.example" })).status, 200, "reads carry no side effects");
});

test("hardening: malformed JSON, wrong content-type, oversize body, unknown route, wrong method", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("h@example.com");
  const raw = await fetch(h.base + "/api/v1/projects", { method: "POST", headers: { "content-type": "application/json", cookie: c.cookie }, body: "{not json" });
  assert.equal(raw.status, 400);
  const wrongType = await fetch(h.base + "/api/v1/projects", { method: "POST", headers: { "content-type": "text/plain", cookie: c.cookie }, body: JSON.stringify({ name: "x" }) });
  assert.equal(wrongType.status, 415);
  const big = await fetch(h.base + "/api/v1/projects", { method: "POST", headers: { "content-type": "application/json", cookie: c.cookie }, body: JSON.stringify({ name: "x", description: "y".repeat(2_000_000) }) });
  assert.equal(big.status, 413);
  assert.equal((await c.call("GET", "/api/v1/nope")).status, 404);
  assert.equal((await c.call("DELETE", "/api/v1/projects")).status, 405);
  const r = await c.call("GET", "/api/v1/projects");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  // error bodies never leak internals
  assert.ok(!JSON.stringify((await c.call("GET", "/api/v1/projects/prj_missing")).json).includes("at "));
});

// ------------------------------------------------------------------ built-in test receiver
import { signHeader } from "../../packages/webhook-engine/sign.ts";

async function builtin(h: Harness, c: Client, projectId: string, body: object = {}) {
  const r = await c.call("POST", `/api/v1/projects/${projectId}/webhooks`, { builtinReceiver: true, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  void h;
  return r.data as { id: string; url: string; secret: string; builtinReceiver: boolean };
}
const runCtx = (h: Harness, clock = () => new Date()) => ({ store: h.store, encryptionKey: h.key, guard: { allowPrivate: true }, now: clock, random: () => 0.5 });

test("receiver: creation returns a hosted URL and the one-time secret; nobody else can see or control it", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const a = new Client(h.base), b = new Client(h.base);
  await a.signup("ra@example.com"); await b.signup("rb@example.com");
  const proj = (await a.call("POST", "/api/v1/projects", { name: "R" })).data;
  const wh = await builtin(h, a, proj.id);

  assert.equal(wh.builtinReceiver, true);
  assert.match(wh.url, /\/api\/v1\/hooks\/[A-Za-z0-9_-]{32}$/); // 24 random bytes => 32 base64url chars
  assert.match(wh.secret, /^whsec_/);

  const list = await a.call("GET", `/api/v1/projects/${proj.id}/webhooks`);
  assert.equal(list.data[0].builtinReceiver, true);
  assert.ok(!list.text.includes(wh.secret));

  // the token is stored hashed for lookup
  const token = wh.url.split("/").pop()!;
  const rows = (await h.store.rawAll("SELECT token_hash FROM test_receivers")) as { token_hash: string }[];
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].token_hash.includes(token));

  assert.equal((await b.call("GET", `/api/v1/webhooks/${wh.id}/receiver`)).status, 404);
  assert.equal((await b.call("PATCH", `/api/v1/webhooks/${wh.id}/receiver`, { mode: "fail500" })).status, 404);
  assert.equal((await new Client(h.base).call("GET", `/api/v1/webhooks/${wh.id}/receiver`)).status, 401);

  const plain = (await a.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { url: "http://127.0.0.1:9/x" })).data;
  assert.equal((await a.call("GET", `/api/v1/webhooks/${plain.id}/receiver`)).status, 404, "only built-in webhooks have a receiver");
  assert.equal((await a.call("PATCH", `/api/v1/webhooks/${wh.id}/receiver`, { mode: "explode" })).status, 422);
  assert.equal((await a.call("POST", `/api/v1/projects/${proj.id}/webhooks`, {})).status, 422, "url is required unless builtinReceiver is set");
});

test("receiver: the real delivery engine -> hosted receiver round trip, failure injection, replay, idempotency", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("rr@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "RR" })).data;
  const wh = await builtin(h, c, proj.id, { retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000, timeoutMs: 2000 } });
  const ev = logFor(5, proj.id); await h.store.insertEvent(ev);
  let skew = 0; // the API stamps replays with the real clock, so the worker clock must follow real time plus a skew
  const ctx = runCtx(h, () => new Date(Date.now() + skew));

  // healthy -> delivered, signature verified by the receiver
  await enqueueEvent(h.store, ev, ctx.now());
  await runDueDeliveries(ctx);
  let rec = (await c.call("GET", `/api/v1/webhooks/${wh.id}/receiver`)).data;
  assert.equal(rec.mode, "ok");
  assert.equal(rec.requests.length, 1);
  assert.equal(rec.requests[0].signatureOk, true);
  assert.equal(rec.requests[0].outcome, "ok");
  assert.equal(rec.requests[0].eventId, ev.id);
  assert.ok(!JSON.stringify(rec).includes(wh.secret), "secret never appears in receiver history");
  assert.ok(!JSON.stringify(rec).toLowerCase().includes("portalops-signature"), "signature header is not stored");

  // inject failure, replay -> retries and fails; the failures are visible in the receiver history
  assert.equal((await c.call("PATCH", `/api/v1/webhooks/${wh.id}/receiver`, { mode: "fail500" })).data.mode, "fail500");
  assert.equal((await c.call("POST", `/api/v1/events/${ev.id}/replay`, { endpointId: wh.id })).status, 202);
  await runDueDeliveries(ctx); skew += 5_000; await runDueDeliveries(ctx);
  const failed = (await c.call("GET", `/api/v1/projects/${proj.id}/deliveries?status=failed`)).data;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].lastResponseStatus, 500);

  // recover and replay again -> the receiver acknowledges but flags the duplicate event id
  await c.call("PATCH", `/api/v1/webhooks/${wh.id}/receiver`, { mode: "ok" });
  await c.call("POST", `/api/v1/events/${ev.id}/replay`, { endpointId: wh.id });
  await runDueDeliveries(ctx);
  rec = (await c.call("GET", `/api/v1/webhooks/${wh.id}/receiver`)).data;
  assert.deepEqual(rec.requests.map((r: any) => r.outcome).reverse(), ["ok", "fail500", "fail500", "duplicate"]);
  assert.equal((await c.call("GET", `/api/v1/projects/${proj.id}/overview`)).data.metrics.delivered, 2);
});

test("receiver: security of the public hook endpoint", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("rs@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "RS" })).data;
  const wh = await builtin(h, c, proj.id);
  const body = JSON.stringify({ id: "evt_x", type: "event.received" });
  const post = (url: string, headers: Record<string, string>, payload = body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });

  // unknown / malformed tokens: uniform 404
  assert.equal((await post(h.base + "/api/v1/hooks/" + "x".repeat(32), {})).status, 404);
  assert.equal((await post(h.base + "/api/v1/hooks/short", {})).status, 404);

  // missing, wrong-secret, tampered and stale signatures are all rejected and recorded as such
  assert.equal((await post(wh.url, {})).status, 401);
  assert.equal((await post(wh.url, { "portalops-signature": signHeader("whsec_wrong", body).header })).status, 401);
  assert.equal((await post(wh.url, { "portalops-signature": signHeader(wh.secret, body).header }, body + " ")).status, 401);
  assert.equal((await post(wh.url, { "portalops-signature": signHeader(wh.secret, body, new Date(Date.now() - 3_600_000)).header })).status, 401);
  const rec = (await c.call("GET", `/api/v1/webhooks/${wh.id}/receiver`)).data;
  assert.equal(rec.requests.length, 4);
  assert.ok(rec.requests.every((r: any) => r.outcome === "rejected" && r.signatureOk === false));
  assert.deepEqual(rec.requests.map((r: any) => r.signatureReason).reverse(), ["malformed", "mismatch", "mismatch", "expired"]);

  // a correctly signed request is accepted
  assert.equal((await post(wh.url, { "portalops-signature": signHeader(wh.secret, body).header, "portalops-event-id": "evt_x" })).status, 200);

  // oversized bodies are cut off before any work is done
  const big = "y".repeat(300 * 1024);
  assert.equal((await post(wh.url, { "portalops-signature": signHeader(wh.secret, big).header }, big)).status, 413);

  // the history is bounded so an anonymous caller cannot grow the database without limit
  const rid = (await h.store.getReceiverByEndpoint(wh.id))!.id;
  for (let i = 0; i < 110; i++) await h.store.recordReceiverRequest(rid, { eventId: null, deliveryId: null, attempt: null, signatureOk: false, signatureReason: "malformed", outcome: "rejected", httpStatus: 401, bodyPreview: null });
  assert.equal(Number(((await h.store.rawAll("SELECT COUNT(*) AS n FROM receiver_requests"))[0] as { n: number }).n), 100);

  // hostile content in the body is stored as an inert, truncated string
  const evil = "<script>alert(1)</script>\u0000" + "z".repeat(5000);
  await post(wh.url, { "portalops-signature": signHeader(wh.secret, evil).header }, evil);
  const latest = (await h.store.listReceiverRequests(rid, 1))[0];
  assert.ok(latest.bodyPreview!.length <= 1500);
  assert.ok(!latest.bodyPreview!.includes("\u0000"));
});

test("receiver: timeout mode answers 504 after holding the connection; rate limit protects the sink", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("rt@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "RT" })).data;
  const wh = await builtin(h, c, proj.id);
  await c.call("PATCH", `/api/v1/webhooks/${wh.id}/receiver`, { mode: "timeout" });
  const body = "{}";
  const t0 = Date.now();
  const r = await fetch(wh.url, { method: "POST", headers: { "content-type": "application/json", "portalops-signature": signHeader(wh.secret, body).header }, body });
  assert.equal(r.status, 504);
  assert.ok(Date.now() - t0 >= 250, "connection was held for the configured time");

  // a flood of requests against one token is throttled (120/min)
  let limited = 0;
  for (let i = 0; i < 130; i++) { const x = await fetch(wh.url, { method: "POST", headers: { "content-type": "application/json" }, body }); if (x.status === 429) limited++; }
  assert.ok(limited > 0, "expected some requests to be rate limited");
});

test("receiver: availability rules (not configured, or not deliverable under the strict SSRF policy)", async (t) => {
  const off = await start({ receiverBaseUrl: null });
  const strict = await start({ allowPrivateWebhookTargets: false });
  t.after(async () => { await off.close(); await strict.close(); });

  const a = new Client(off.base); await a.signup("o1@example.com");
  const pa = (await a.call("POST", "/api/v1/projects", { name: "A" })).data;
  const r1 = await a.call("POST", `/api/v1/projects/${pa.id}/webhooks`, { builtinReceiver: true });
  assert.equal(r1.status, 409);
  assert.equal(r1.error.code, "receiver_unavailable");

  const b = new Client(strict.base); await b.signup("o2@example.com");
  const pb = (await b.call("POST", "/api/v1/projects", { name: "B" })).data;
  const r2 = await b.call("POST", `/api/v1/projects/${pb.id}/webhooks`, { builtinReceiver: true });
  assert.equal(r2.status, 422);
  assert.equal(r2.error.code, "receiver_unreachable");
  assert.match(r2.error.message, /PORTALOPS_API_PUBLIC_URL/);
  assert.equal(Number(((await strict.store.rawAll("SELECT COUNT(*) AS n FROM webhook_endpoints"))[0] as { n: number }).n), 0, "no half-created endpoint is left behind");
});

test("receiver: the 'Send test delivery' button works against the hosted receiver", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("rb2@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "TB" })).data;
  const wh = await builtin(h, c, proj.id);
  const r = await c.call("POST", `/api/v1/webhooks/${wh.id}/test`, {});
  assert.equal(r.data.ok, true);
  const rec = (await c.call("GET", `/api/v1/webhooks/${wh.id}/receiver`)).data;
  assert.equal(rec.requests[0].signatureOk, true);
  assert.match(rec.requests[0].bodyPreview, /webhook\.test/);
});

test("events: `finalized` is a first-class, filterable status and unknown statuses are rejected", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("fin@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "F" })).data;
  const a = logFor(1, proj.id), b = logFor(2, proj.id), d = logFor(3, proj.id);
  for (const e of [a, b, d]) await h.store.insertEvent(e);
  await h.store.setFinality([a.id], "finalized");
  await h.store.confirmUpTo(proj.id, 100, 3);

  const base = `/api/v1/projects/${proj.id}/events`;
  const fin = (await c.call("GET", `${base}?finality=finalized`)).data;
  assert.equal(fin.total, 1);
  assert.equal(fin.items[0].id, a.id);
  assert.equal(fin.items[0].finalityStatus, "finalized");
  assert.equal((await c.call("GET", `${base}?finality=confirmed`)).data.total, 2);
  assert.equal((await c.call("GET", `${base}?finality=final`)).status, 422);
  assert.equal((await c.call("GET", `/api/v1/events/${a.id}`)).data.finalityStatus, "finalized");
  // finalized events still count as received events in the overview
  assert.equal((await c.call("GET", `/api/v1/projects/${proj.id}/overview`)).data.metrics.eventsReceived, 3);
});

// ------------------------------------------------------------------ API keys
async function mkKey(c: Client, projectId: string, scope: "read" | "write" = "write", name = "ci") {
  const r = await c.call("POST", `/api/v1/projects/${projectId}/api-keys`, { name, scope });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.data as { id: string; key: string; prefix: string; scope: string };
}
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

test("api keys: created once, stored only as a hash, never listed in the clear", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("k1@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "K" })).data;
  const k = await mkKey(c, proj.id);
  assert.match(k.key, /^pops_[A-Za-z0-9_-]{43}$/);
  assert.equal(k.prefix, k.key.slice(0, 12));

  const list = await c.call("GET", `/api/v1/projects/${proj.id}/api-keys`);
  assert.equal(list.data.length, 1);
  assert.ok(!list.text.includes(k.key), "the key is never returned again");
  assert.equal(list.data[0].lastUsedAt, null);

  const row = (await h.store.rawAll("SELECT key_hash, prefix FROM api_keys"))[0] as { key_hash: string; prefix: string };
  assert.match(row.key_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes(k.key.slice(12)), "only the 12-char prefix is stored, never the secret part");

  // logs and audit never contain it
  const audit = (await c.call("GET", `/api/v1/projects/${proj.id}/audit`)).text;
  assert.ok(!audit.includes(k.key));
  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/api-keys`, { name: "", scope: "write" })).status, 422);
  assert.equal((await c.call("POST", `/api/v1/projects/${proj.id}/api-keys`, { name: "x", scope: "admin" })).status, 422);
});

test("api keys: bearer auth reads and writes inside its own project only", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("k2@example.com");
  const mine = (await c.call("POST", "/api/v1/projects", { name: "mine" })).data;
  const other = (await c.call("POST", "/api/v1/projects", { name: "other" })).data; // same owner, different project
  await h.store.insertEvent(logFor(1, mine.id)); await h.store.insertEvent(logFor(2, other.id));
  const { key } = await mkKey(c, mine.id, "write");
  const anon = new Client(h.base); // no cookie: only the key identifies the caller

  const ev = await anon.call("GET", `/api/v1/projects/${mine.id}/events`, undefined, bearer(key));
  assert.equal(ev.status, 200);
  assert.equal(ev.data.total, 1);
  assert.equal((await anon.call("GET", `/api/v1/projects/${mine.id}/overview`, undefined, bearer(key))).status, 200);

  // the same owner's OTHER project is invisible to this key
  assert.equal((await anon.call("GET", `/api/v1/projects/${other.id}/events`, undefined, bearer(key))).status, 404);
  assert.equal((await anon.call("GET", `/api/v1/projects/${other.id}`, undefined, bearer(key))).status, 404);
  const otherEv = (await h.store.listEvents({ projectId: other.id }))[0];
  assert.equal((await anon.call("GET", `/api/v1/events/${otherEv.id}`, undefined, bearer(key))).status, 404);
  assert.deepEqual((await anon.call("GET", "/api/v1/projects", undefined, bearer(key))).data.map((p: any) => p.id), [mine.id]);

  // write scope: manage webhooks programmatically
  const wh = await anon.call("POST", `/api/v1/projects/${mine.id}/webhooks`, { builtinReceiver: true }, bearer(key));
  assert.equal(wh.status, 201);
  assert.equal((await anon.call("POST", `/api/v1/webhooks/${wh.data.id}/test`, {}, bearer(key))).data.ok, true);
  assert.equal((await anon.call("POST", `/api/v1/projects/${other.id}/webhooks`, { builtinReceiver: true }, bearer(key))).status, 404);

  // usage is recorded
  assert.ok((await c.call("GET", `/api/v1/projects/${mine.id}/api-keys`)).data[0].lastUsedAt);
});

test("api keys: read-only keys cannot change anything; account-level actions need a session", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("k3@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "P" })).data;
  const ro = await mkKey(c, proj.id, "read"), rw = await mkKey(c, proj.id, "write");
  const anon = new Client(h.base);

  assert.equal((await anon.call("GET", `/api/v1/projects/${proj.id}/webhooks`, undefined, bearer(ro.key))).status, 200);
  const w = await anon.call("POST", `/api/v1/projects/${proj.id}/webhooks`, { builtinReceiver: true }, bearer(ro.key));
  assert.equal(w.status, 403);
  assert.equal(w.error.code, "insufficient_scope");
  assert.equal((await h.store.listEndpoints(proj.id)).length, 0, "nothing was created");

  for (const key of [ro.key, rw.key]) {
    for (const [m, p, b] of [
      ["POST", "/api/v1/projects", { name: "new" }], ["PATCH", `/api/v1/projects/${proj.id}`, { name: "x" }],
      ["POST", `/api/v1/projects/${proj.id}/api-keys`, { name: "escalate", scope: "write" }], ["GET", `/api/v1/projects/${proj.id}/api-keys`],
      ["DELETE", `/api/v1/api-keys/${ro.id}`], ["GET", `/api/v1/projects/${proj.id}/audit`], ["GET", "/api/v1/auth/me"],
    ] as [string, string, unknown?][]) {
      const r = await anon.call(m, p, b, bearer(key));
      assert.ok(r.status === 403, `${m} ${p} with ${key === ro.key ? "read" : "write"} key -> ${r.status}`);
    }
  }
  assert.equal((await h.store.listApiKeys(proj.id)).length, 2, "a key could not mint or revoke keys");
});

test("api keys: revocation, bad keys, and header precedence", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); await c.signup("k4@example.com");
  const proj = (await c.call("POST", "/api/v1/projects", { name: "P" })).data;
  const k = await mkKey(c, proj.id, "write");
  const anon = new Client(h.base);
  const url = `/api/v1/projects/${proj.id}/events`;

  assert.equal((await anon.call("GET", url, undefined, bearer(k.key))).status, 200);
  assert.equal((await c.call("DELETE", `/api/v1/api-keys/${k.id}`)).status, 200);
  const revoked = await anon.call("GET", url, undefined, bearer(k.key));
  assert.equal(revoked.status, 401);
  assert.equal(revoked.error.code, "invalid_api_key");

  for (const bad of ["pops_" + "x".repeat(43), "pops_short", "Bearer", "notabearertoken"]) {
    assert.equal((await anon.call("GET", url, undefined, { authorization: bad.startsWith("Bearer") ? bad : `Bearer ${bad}` })).status, 401, bad);
  }
  assert.equal((await anon.call("GET", url, undefined, { authorization: "Basic dXNlcjpwYXNz" })).status, 401);

  // a bad key is never silently downgraded to the cookie session that is also present
  assert.equal((await c.call("GET", url, undefined, bearer("pops_" + "y".repeat(43)))).status, 401);
  assert.equal((await c.call("GET", url)).status, 200, "the session alone still works");

  // public routes ignore the header entirely
  assert.equal((await anon.call("GET", "/api/v1/health", undefined, bearer("pops_" + "z".repeat(43)))).status, 200);
});

test("api keys: other users cannot create, list or revoke them; per-project cap; per-key rate limit", async (t) => {
  const h = await start({}, { auth: new RateLimiter(1000, 60_000), global: new RateLimiter(100_000, 60_000), actions: new RateLimiter(1000, 60_000), keys: new RateLimiter(5, 60_000) } as never);
  t.after(() => h.close());
  const a = new Client(h.base), b = new Client(h.base); await a.signup("k5@example.com"); await b.signup("k6@example.com");
  const proj = (await a.call("POST", "/api/v1/projects", { name: "P" })).data;
  const k = await mkKey(a, proj.id, "read");

  assert.equal((await b.call("POST", `/api/v1/projects/${proj.id}/api-keys`, { name: "steal", scope: "write" })).status, 404);
  assert.equal((await b.call("GET", `/api/v1/projects/${proj.id}/api-keys`)).status, 404);
  assert.equal((await b.call("DELETE", `/api/v1/api-keys/${k.id}`)).status, 404);
  assert.equal((await new Client(h.base).call("POST", `/api/v1/projects/${proj.id}/api-keys`, { name: "x", scope: "read" })).status, 401);

  const anon = new Client(h.base);
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await anon.call("GET", `/api/v1/projects/${proj.id}/events`, undefined, bearer(k.key))).status);
  assert.ok(statuses.includes(429), statuses.join(","));
  assert.equal(statuses.filter((s) => s === 200).length, 5);

  const h2 = await start();
  t.after(() => h2.close());
  const c = new Client(h2.base); await c.signup("k7@example.com");
  const p2 = (await c.call("POST", "/api/v1/projects", { name: "P2" })).data;
  for (let i = 0; i < 10; i++) await mkKey(c, p2.id, "read", "k" + i);
  const over = await c.call("POST", `/api/v1/projects/${p2.id}/api-keys`, { name: "eleven", scope: "read" });
  assert.equal(over.status, 409);
  assert.equal(over.error.code, "key_limit");
});

test("examples: public catalog and detail; no auth needed, unknown ids are 404, nothing sensitive is exposed", async (t) => {
  const h = await start();
  t.after(() => h.close());
  const c = new Client(h.base); // not signed in
  const list = await c.call("GET", "/api/v1/examples");
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((e: any) => e.id).sort(), ["arena", "bounty", "quest", "token"]);
  assert.ok(list.data.every((e: any) => e.events.length > 0 && !("abi" in e) && !("bytecode" in e)), "the list is light");

  const d = await c.call("GET", "/api/v1/examples/token");
  assert.equal(d.status, 200);
  assert.equal(d.data.contractName, "PortalToken");
  assert.ok(Array.isArray(d.data.abi) && d.data.abi.some((x: any) => x.name === "Transfer"));
  assert.match(d.data.source, /contract PortalToken/);
  assert.match(d.data.handler, /constructEvent/);
  assert.match(d.data.deployCommand, /--example token/);

  const feat = await c.call("GET", "/api/v1/examples/featured");
  assert.equal(feat.status, 200);
  assert.ok(feat.data.length >= 2 && feat.data.every((x: any) => /^0x[0-9a-fA-F]{40}$/.test(x.address) && x.events.length > 0), "featured is not mistaken for an example id");
  assert.equal((await c.call("GET", "/api/v1/examples/nope")).status, 404);
  assert.equal((await c.call("GET", "/api/v1/examples/__proto__")).status, 404);
  assert.ok([404, 405].includes((await c.call("POST", "/api/v1/examples", {})).status), "read-only");
});
