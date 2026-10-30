import { makeTestStore } from "../../packages/database/testing.ts";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildCsp, createStaticHandler } from "./static.ts";
import { createApp } from "./app.ts";
import { Store } from "../../packages/database/store.ts";
import { RateLimiter } from "./http.ts";

function site(hsts = false) {
  // dist/ lives inside a parent that also holds a secret: traversal must never reach it
  const parent = mkdtempSync(join(tmpdir(), "pops-static-"));
  const dist = join(parent, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log('app')");
  writeFileSync(join(dist, "assets", "app-abc123.css"), "body{}");
  writeFileSync(join(dist, ".env"), "SECRET=1");
  mkdirSync(join(dist, "docs"));
  writeFileSync(join(dist, "docs", "index.html"), "<!doctype html><title>docs dir</title>");
  writeFileSync(join(parent, "secret.txt"), "TOP SECRET");
  const handler = createStaticHandler({ root: dist, hsts });
  const server = http.createServer((req, res) => void handler(req, res));
  return new Promise<{ base: string; port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => { rmSync(parent, { recursive: true, force: true }); r(); }); }) });
    });
  });
}

/** Sends a request line byte-for-byte (fetch would normalise `..` away before it left the client). */
function raw(port: number, requestLine: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let data = "";
    s.on("data", (d) => (data += d));
    s.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]), body: data.split("\r\n\r\n").slice(1).join("") }));
    s.on("error", reject);
  });
}

test("static: serves the app, SPA routes fall back to index.html, missing files are real 404s", async (t) => {
  const s = await site(); t.after(() => s.close());
  const idx = await fetch(s.base + "/");
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /<title>app<\/title>/);
  assert.match(idx.headers.get("content-type")!, /text\/html/);
  assert.equal(idx.headers.get("cache-control"), "no-cache");

  for (const route of ["/docs/missing-page", "/auth", "/app", "/app/whatever/deep"]) {
    const r = await fetch(s.base + route);
    assert.equal(r.status, 200, route);
    assert.match(await r.text(), /<title>(app|docs dir)<\/title>/);
  }
  assert.match(await (await fetch(s.base + "/docs")).text(), /docs dir/, "a directory with its own index.html serves it");

  const js = await fetch(s.base + "/assets/app-abc123.js");
  assert.match(js.headers.get("content-type")!, /javascript/);
  assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(js.headers.get("content-length"), String("console.log('app')".length));
  assert.equal((await fetch(s.base + "/assets/app-abc123.css")).headers.get("content-type"), "text/css; charset=utf-8");

  const missing = await fetch(s.base + "/assets/nope.js");
  assert.equal(missing.status, 404);
  assert.ok(!(await missing.text()).includes("<title>"), "a missing script must not be answered with HTML");
});

test("static: path traversal, encoded traversal, NUL bytes, backslashes and dotfiles are all refused", async (t) => {
  const s = await site(); t.after(() => s.close());
  for (const line of [
    "GET /../secret.txt HTTP/1.1", "GET /assets/../../secret.txt HTTP/1.1", "GET /%2e%2e/secret.txt HTTP/1.1", "GET /%2e%2e%2fsecret.txt HTTP/1.1",
    "GET /assets/%2e%2e/%2e%2e/secret.txt HTTP/1.1", "GET /..%5csecret.txt HTTP/1.1", "GET /%00.html HTTP/1.1", "GET /.env HTTP/1.1",
    "GET /assets/../.env HTTP/1.1", "GET /%2eenv HTTP/1.1", "GET /%252e%252e/secret.txt HTTP/1.1",
  ]) {
    const r = await raw(s.port, line);
    assert.ok(r.status === 404 || r.status === 400, `${line} -> ${r.status}`);
    assert.ok(!/TOP SECRET|SECRET=1/.test(r.body), `${line} leaked a file`);
  }
});

test("static: only GET/HEAD; HEAD sends headers without a body; security headers on every response", async (t) => {
  const s = await site(true); t.after(() => s.close());
  const post = await fetch(s.base + "/", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");

  const head = await fetch(s.base + "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  for (const url of ["/", "/assets/app-abc123.js", "/nope.png", "/auth"]) {
    const r = await fetch(s.base + url);
    const csp = r.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/, "clickjacking protection that a <meta> CSP cannot provide");
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(csp));
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("strict-transport-security")!, /max-age=31536000/);
    await r.text();
  }
  const plain = await site(false); t.after(() => plain.close());
  assert.equal((await fetch(plain.base + "/")).headers.get("strict-transport-security"), null, "no HSTS unless actually served over https");
});

test("health and readiness: liveness is independent of the worker; readiness reflects the worker heartbeat", async (t) => {
  const store = await makeTestStore();
  let clock = Date.now();
  const handler = createApp({
    store,
    network: { check: async () => ({ chainIdVerified: true, reportedChainId: 420420777, headBlock: 1, latencyMs: 1, error: null }), getCode: async () => "0x" },
    config: { networkId: "portaldot-v3-testnet", networkLabel: "x", chainId: 420420777, encryptionKey: randomBytes(32), allowedOrigins: [], cookieSecure: false, sessionTtlMs: 1000, allowPrivateWebhookTargets: false, receiverBaseUrl: null, maxProjectsPerUser: 5, now: () => new Date(clock) },
    rateLimits: { auth: new RateLimiter(1000, 60_000), global: new RateLimiter(100_000, 60_000), actions: new RateLimiter(1000, 60_000) },
  });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, json: await r.json() as any }; };

  let h = await get("/api/v1/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.data.ok, true);
  assert.equal(h.json.data.worker.status, "never");
  let rd = await get("/api/v1/ready");
  assert.equal(rd.status, 503, "no worker has ever reported: not ready");
  assert.equal(rd.json.error.code, "worker_unavailable");

  await store.beat("worker", { head: 10 }, new Date(clock));
  assert.equal((await get("/api/v1/ready")).status, 200);
  assert.equal((await get("/api/v1/health")).json.data.worker.status, "ok");

  clock += 5 * 60_000; // the worker stops reporting
  rd = await get("/api/v1/ready");
  assert.equal(rd.status, 503);
  assert.equal(rd.json.error.details.status, "stale");
  h = await get("/api/v1/health");
  assert.equal(h.status, 200, "the API itself is still alive");
  assert.equal(h.json.data.worker.status, "stale");

  await store.beat("worker", undefined, new Date(clock));
  assert.equal((await get("/api/v1/ready")).status, 200, "recovers as soon as it reports again");
  assert.equal((await get("/api/v1/public/status")).json.data.worker, "ok");
});

test("CSP: the page may only call itself, plus the one chain RPC origin when one is given", () => {
  assert.match(buildCsp(), /connect-src 'self'(;|$)/);
  assert.ok(!/https:/.test(buildCsp().split("; ").find((d) => d.startsWith("connect-src"))!), "nothing else by default");
  const withRpc = buildCsp(["https://test-evm-rpc-v3.portaldot.dev"]);
  assert.match(withRpc, /connect-src 'self' https:\/\/test-evm-rpc-v3\.portaldot\.dev(;|$)/);
  assert.match(withRpc, /script-src 'self'(;|$)/, "scripts are still only our own");
  assert.match(withRpc, /frame-ancestors 'none'/);
});
