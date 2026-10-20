import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PortalOps } from "../sdk/index.ts";
import { startApi } from "../../apps/api/test-harness.ts";
import { createPortalOpsMcpServer } from "./server.ts";
import { resolveSecretFile } from "./secrets.ts";

// The MCP server is driven through a real MCP client (in-process transport) against the REAL API.

async function connect(opts: { portal: PortalOps | null; cwd: string }) {
  const server = createPortalOpsMcpServer({ portal: opts.portal, cwd: opts.cwd, dashboardUrl: "https://portalops.example" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const t = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    let json: any = null;
    try { json = JSON.parse(t); } catch { /* plain text */ }
    return { isError: !!r.isError, text: t, json };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

const tmp = () => mkdtempSync(join(tmpdir(), "pops-mcp-"));
const DEPLOYED = "0x" + "ab".repeat(19) + "a1"; // the test API reports code for addresses ending in "1"

test("mcp: exposes the expected tools, and read-only tools are marked read-only", async (t) => {
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = await connect({ portal: null, cwd: dir }); t.after(() => m.close());
  const tools = (await m.client.listTools()).tools;
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    "portalops_create_webhook", "portalops_failed_deliveries", "portalops_get_event", "portalops_get_example", "portalops_list_events",
    "portalops_list_examples", "portalops_register_contract", "portalops_replay_event", "portalops_send_test_delivery", "portalops_setup_status",
  ]);
  const ro = (n: string) => tools.find((x) => x.name === n)!.annotations?.readOnlyHint;
  for (const n of ["portalops_list_examples", "portalops_get_example", "portalops_setup_status", "portalops_list_events", "portalops_get_event", "portalops_failed_deliveries"]) assert.equal(ro(n), true, n);
  for (const n of ["portalops_register_contract", "portalops_create_webhook", "portalops_send_test_delivery", "portalops_replay_event"]) assert.equal(ro(n), false, n);
  assert.ok((await m.client.listPrompts()).prompts.some((p) => p.name === "set_up_portalops"));
});

test("mcp: example tools work with no API key; big fields only on request; unknown ids are a clear error", async (t) => {
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = await connect({ portal: null, cwd: dir }); t.after(() => m.close());
  const list = await m.call("portalops_list_examples");
  assert.deepEqual(list.json.map((e: any) => e.id).sort(), ["bounty", "quest", "token"]);

  const lean = await m.call("portalops_get_example", { id: "token" });
  assert.equal(lean.json.contractName, "PortalToken");
  assert.match(lean.json.handler, /constructEvent/);
  assert.ok(!("abi" in lean.json) && !("bytecode" in lean.json) && !("source" in lean.json), "no big blobs unless asked");
  const full = await m.call("portalops_get_example", { id: "token", include: ["abi", "source"] });
  assert.ok(full.json.abi.some((x: any) => x.name === "Transfer") && /contract PortalToken/.test(full.json.source));

  const bad = await m.call("portalops_get_example", { id: "nope" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /quest, token, bounty/);
});

test("mcp: without a key, setup status explains how to get one and every other tool refuses politely", async (t) => {
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = await connect({ portal: null, cwd: dir }); t.after(() => m.close());
  const s = await m.call("portalops_setup_status");
  assert.equal(s.json.ready, false);
  assert.match(s.text, /Settings/);
  assert.match(s.text, /PORTALOPS_API_KEY/);
  assert.match(s.text, /Do not paste the key/);
  for (const [name, args] of [["portalops_list_events", {}], ["portalops_register_contract", { address: DEPLOYED }], ["portalops_create_webhook", { builtinReceiver: true }]] as const) {
    const r = await m.call(name, args as Record<string, unknown>);
    assert.equal(r.isError, true, name);
    assert.match(r.text, /No PortalOps API key/);
  }
  assert.equal(existsSync(join(dir, ".env.portalops")), false, "nothing was written");
});

test("mcp: the whole setup through the tools: register an example, create a webhook, test it, see events, replay; the secret never enters the conversation", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.env.*\n");
  const key = await api.mkKey("write");
  const m = await connect({ portal: new PortalOps({ apiKey: key, baseUrl: api.base }), cwd: dir }); t.after(() => m.close());
  const everything: string[] = [];
  const call = async (n: string, a: Record<string, unknown> = {}) => { const r = await m.call(n, a); everything.push(r.text); return r; };

  // 0. fresh project: the first step is the contract
  let s = await call("portalops_setup_status");
  assert.equal(s.json.progress.split("/")[0], "1"); // only the network step is done
  assert.match(s.json.nextSteps[0], /Register a contract/);

  // 1. register an example by id: the server fills in the ABI, the model never handles it
  const reg = await call("portalops_register_contract", { address: DEPLOYED, example: "token" });
  assert.equal(reg.isError, false, reg.text);
  assert.deepEqual([...reg.json.contract.events].sort(), ["Approval", "Transfer"]);
  assert.equal(reg.json.codeFoundOnChain, true);
  assert.equal((await call("portalops_register_contract", { address: DEPLOYED, example: "token" })).isError, true, "duplicate is refused with an explanation");
  assert.equal((await call("portalops_register_contract", { address: DEPLOYED.replace(/a1$/, "a2"), example: "token", abi: [] })).isError, true, "example and abi together are ambiguous");

  // 2. webhook: the secret goes to a local file, not into the transcript
  const hook = await call("portalops_create_webhook", { builtinReceiver: true, events: ["Transfer"], description: "via mcp" });
  assert.equal(hook.isError, false, hook.text);
  const file = readFileSync(join(dir, ".env.portalops"), "utf8");
  const secret = /^PORTALOPS_WEBHOOK_SECRET=(whsec_\S+)$/m.exec(file)?.[1];
  assert.ok(secret && secret.length > 20, "secret saved locally");
  assert.equal(hook.json.secret.savedTo, ".env.portalops");
  assert.ok(!("warning" in hook.json), ".env.* is git-ignored here, so no warning");
  assert.deepEqual(hook.json.webhook.eventFilter, ["Transfer"]);
  assert.ok(!("secret" in hook.json.webhook), "the full secret is not returned");

  // 3. a second webhook keeps both secrets under different names
  const hook2 = await call("portalops_create_webhook", { builtinReceiver: true });
  assert.notEqual(hook2.json.secret.variable, "PORTALOPS_WEBHOOK_SECRET");
  assert.equal((readFileSync(join(dir, ".env.portalops"), "utf8").match(/^PORTALOPS_WEBHOOK_SECRET\w*=/gm) ?? []).length, 2);

  // 4. test delivery through the real engine path
  const test = await call("portalops_send_test_delivery", { webhookId: hook.json.webhook.id });
  assert.equal(test.json.ok, true, test.text);
  assert.match(test.json.meaning, /Delivered/);

  // 5. events and replay
  const proj = await call("portalops_list_events");
  assert.equal(proj.json.total, 0);
  const e = await api.seed(7, DEPLOYED);
  const ev = await call("portalops_list_events", { limit: 5 });
  assert.equal(ev.json.total, 1);
  assert.equal(ev.json.events[0].id, e.id);
  const detail = await call("portalops_get_event", { eventId: e.id });
  assert.equal(detail.json.id, e.id);
  const rep = await call("portalops_replay_event", { eventId: e.id, webhookId: hook.json.webhook.id });
  assert.equal(rep.isError, false, rep.text);
  assert.deepEqual((await call("portalops_failed_deliveries")).json, []);

  // 6. status now reflects the work
  s = await call("portalops_setup_status");
  assert.ok(Number(s.json.progress.split("/")[0]) >= 4, s.text);

  // the headline guarantee: neither key nor secret ever appeared in anything the model saw
  const transcript = everything.join("\n");
  assert.ok(!transcript.includes(secret), "webhook secret is not in any tool output");
  assert.ok(!transcript.includes(key), "API key is not in any tool output");
});

test("mcp: the secrets file can only be an .env-style file inside the project, and a bad path creates no webhook", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), "{}");
  const m = await connect({ portal: new PortalOps({ apiKey: await api.mkKey("write"), baseUrl: api.base }), cwd: dir }); t.after(() => m.close());

  for (const bad of ["../evil.env", "package.json", "/etc/passwd", "sub/../../x.env", ".env/../../y", "notes.txt"]) {
    const r = await m.call("portalops_create_webhook", { builtinReceiver: true, secretsFile: bad });
    assert.equal(r.isError, true, bad);
  }
  assert.equal(readFileSync(join(dir, "package.json"), "utf8"), "{}", "existing files are never touched");
  const hooks = await new PortalOps({ apiKey: await api.mkKey("read"), baseUrl: api.base }).webhooks.list();
  // none of the rejected calls may have left a webhook behind (the one-time secret would have been lost)
  const before = hooks.length;
  const r = await m.call("portalops_create_webhook", { builtinReceiver: true, secretsFile: "../out.env" });
  assert.equal(r.isError, true);
  assert.equal((await new PortalOps({ apiKey: await api.mkKey("read"), baseUrl: api.base }).webhooks.list()).length, before);

  // and the path helper itself
  assert.throws(() => resolveSecretFile(dir, "../x.env"), /inside the current project/);
  assert.throws(() => resolveSecretFile(dir, "config.json"), /\.env/);
  assert.equal(resolveSecretFile(dir, ".env.local").display, ".env.local");
  assert.equal(resolveSecretFile(dir, undefined).display, ".env.portalops");
  assert.equal(resolveSecretFile(dir, "  ").display, ".env.portalops", "blank falls back to the default");
});

test("mcp: a webhook is created with a clear warning when the secrets file is not git-ignored", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = await connect({ portal: new PortalOps({ apiKey: await api.mkKey("write"), baseUrl: api.base }), cwd: dir }); t.after(() => m.close());
  const r = await m.call("portalops_create_webhook", { builtinReceiver: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.warning, /not listed in \.gitignore/);
});

test("mcp: a read-only key is told what to do, and bad input is explained rather than thrown", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = await connect({ portal: new PortalOps({ apiKey: await api.mkKey("read"), baseUrl: api.base }), cwd: dir }); t.after(() => m.close());

  const w = await m.call("portalops_create_webhook", { builtinReceiver: true });
  assert.equal(w.isError, true);
  assert.match(w.text, /write/i, w.text);
  assert.equal((await m.call("portalops_list_events")).isError, false, "reads still work");

  assert.equal((await m.call("portalops_create_webhook", {})).isError, true, "neither url nor builtinReceiver");
  assert.equal((await m.call("portalops_create_webhook", { builtinReceiver: true, url: "https://x.example/h" })).isError, true, "both");
  const badAddr = await m.client.callTool({ name: "portalops_register_contract", arguments: { address: "0x123" } });
  assert.equal(badAddr.isError, true, "schema validation rejects a malformed address before any API call");
});

test("mcp: a rejected key is reported without echoing it", async (t) => {
  const api = await startApi(); t.after(() => api.close());
  const dir = tmp(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bogus = "pops_" + "x".repeat(40);
  const m = await connect({ portal: new PortalOps({ apiKey: bogus, baseUrl: api.base }), cwd: dir }); t.after(() => m.close());
  const r = await m.call("portalops_setup_status");
  assert.equal(r.isError, true);
  assert.match(r.text, /rejected|revoked|Settings/i);
  assert.ok(!r.text.includes(bogus));
});
