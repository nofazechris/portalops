import test from "node:test";
import assert from "node:assert/strict";
import { AI_FINAL, AI_PROMPT, AI_SCRIPT, AI_TOTAL_MS, snapshotAt } from "./landingAi.js";

const ORBS = ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"];
const REAL_TOOLS = ["portalops_setup_status", "portalops_register_contract", "portalops_create_webhook", "portalops_send_test_delivery", "portalops_list_events"];

test("script: steps are in time order, do not overlap badly, and finish before the total", () => {
  let last = -1;
  for (const s of AI_SCRIPT) { assert.ok(s.at > last || s.at === 0, `${s.id} is after the previous step`); last = s.at; assert.ok(s.at + s.duration <= AI_TOTAL_MS, `${s.id} ends within the total`); }
  for (let i = 1; i < AI_SCRIPT.length; i++) assert.ok(AI_SCRIPT[i].at >= AI_SCRIPT[i - 1].at + 200, "each step starts after the previous has begun showing");
});

test("script: only uses tools the real PortalOps MCP server exposes, and real orb states", () => {
  for (const s of AI_SCRIPT) {
    assert.ok(ORBS.includes(s.orb), `${s.id}: ${s.orb} is a real orb state`);
    if (s.kind === "tool") assert.ok(REAL_TOOLS.includes(s.tool), `${s.tool} exists in packages/mcp/server.ts`);
  }
});

test("script: the contract in the prompt is the one we deployed, and Claude never shows a secret", () => {
  assert.match(AI_PROMPT, /0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649/);
  const everything = JSON.stringify(AI_SCRIPT) + AI_PROMPT;
  assert.ok(!/whsec_[0-9a-f]{8}/.test(everything) && !/pops_[A-Za-z0-9_-]{20}/.test(everything), "no secret-looking value");
  assert.ok(AI_SCRIPT.find((s) => s.id === "webhook").note.includes("never saw"));
});

test("snapshot: starts empty with the orb listening, reveals steps over time, tools show a result only when done", () => {
  const t0 = snapshotAt(0);
  assert.equal(t0.steps.length, 0);
  assert.equal(t0.promptChars, 0);
  assert.equal(t0.orb, "listening");
  assert.equal(t0.finished, false);

  const mid = snapshotAt(4000); // inside the setup_status call
  assert.equal(mid.promptChars, AI_PROMPT.length, "the prompt has finished typing");
  const status = mid.steps.find((s) => s.id === "status");
  assert.equal(status.status, "running");
  assert.equal(status.result, undefined, "no result while it is still running");
  assert.equal(mid.orb, "searching");

  const later = snapshotAt(6300);
  assert.equal(later.steps.find((s) => s.id === "status").status, "done");
  assert.match(later.steps.find((s) => s.id === "status").result, /1 of 5/);
  assert.equal(later.steps.find((s) => s.id === "register").status, "running");
  assert.equal(later.orb, "connecting");
});

test("snapshot: the prompt types out progressively and never exceeds its length", () => {
  const a = snapshotAt(500).promptChars, b = snapshotAt(1200).promptChars, c = snapshotAt(2400).promptChars;
  assert.ok(a > 0 && a < b && b < c);
  assert.ok(snapshotAt(99999).promptChars <= AI_PROMPT.length);
});

test("snapshot: monotonic: once a step is shown it stays, and the end state is complete, finished and calm", () => {
  let prev = 0;
  for (let t = 0; t <= AI_TOTAL_MS; t += 250) { const n = snapshotAt(t).steps.length; assert.ok(n >= prev, `step count never drops (t=${t})`); prev = n; }
  assert.equal(AI_FINAL.steps.length, AI_SCRIPT.filter((s) => s.kind !== "prompt").length);
  assert.ok(AI_FINAL.steps.every((s) => s.status === "done"));
  assert.equal(AI_FINAL.finished, true);
  assert.equal(AI_FINAL.orb, "breathing");
  assert.equal(AI_FINAL.progress, 1);
  assert.match(AI_FINAL.steps.at(-1).text, /3 real events/);
});
