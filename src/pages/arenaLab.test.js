import test from "node:test";
import assert from "node:assert/strict";
import { GRADER_SOURCE, MISSIONS, backoffCeilingMs, isRetryableStatus, nextDelayMs } from "./arenaLab.js";
import { DEFAULT_RETRY_POLICY } from "../../packages/shared-types/index.ts";
import { backoffDelayMs, isRetryable } from "../../packages/webhook-engine/retry.ts";

// The grader is the same source the browser runs in a Worker. Here it runs directly.
const grade = new Function(GRADER_SOURCE + "\nreturn grade;")();

test("arena lab: every reference solution passes every test case", async () => {
  for (const m of MISSIONS) {
    const results = await grade(m.id, m.solution);
    assert.ok(results.length >= 5, `${m.id} has several cases`);
    assert.deepEqual(results.filter((r) => !r.pass), [], `${m.id} solution`);
  }
});

test("arena lab: every starter fails something (so there is a challenge) and never crashes the grader", async () => {
  for (const m of MISSIONS) {
    const results = await grade(m.id, m.starter);
    assert.ok(results.some((r) => !r.pass), `${m.id} starter should not already pass`);
    assert.ok(results.every((r) => typeof r.name === "string" && typeof r.pass === "boolean"));
  }
});

test("arena lab: each challenge is solved only by the right behaviour (a plausible wrong answer is caught)", async () => {
  // No de-duplication: the replay case must fail.
  const noDedupe = MISSIONS[0].solution;
  assert.ok((await grade("dedupe", noDedupe)).some((r) => !r.pass));
  // De-duplicates but marks loot seen too early: the finality case must fail.
  assert.ok((await grade("finality", MISSIONS[1].solution)).some((r) => !r.pass));
  // Accepts any well-formed signature: the mismatch cases must fail.
  const lax = "async function verify(secret, rawBody, header, now) { return header && /^t=/.test(header) ? { ok: true } : { ok: false, reason: 'malformed' }; }";
  assert.ok((await grade("signature", lax)).some((r) => !r.pass));
  // Retries everything: the permanent-error cases must fail.
  const retryAll = "function plan(s, a) { return s >= 200 && s < 300 ? 'delivered' : 'retry'; } function backoffCeilingMs(a) { return 0; }";
  assert.ok((await grade("retries", retryAll)).some((r) => !r.pass));
});

test("arena lab: broken code is reported, not thrown", async () => {
  const syntax = await grade("leaderboard", "function handle( {");
  assert.equal(syntax[0].pass, false);
  const missing = await grade("signature", "const x = 1;");
  assert.match(missing[0].detail, /verify/);
  const throws = await grade("leaderboard", "function handle() { throw new Error('boom'); }");
  assert.ok(throws.every((r) => !r.pass && /boom/.test(r.detail)));
});

test("arena lab: the simulator's retry rules are PortalOps' own", () => {
  for (const status of [null, 200, 204, 301, 400, 401, 404, 408, 425, 429, 500, 502, 503]) {
    const real = isRetryable({ status, errorCode: null });
    assert.equal(isRetryableStatus(status), real, `status ${status}`);
  }
  for (let attempt = 1; attempt <= 14; attempt++) {
    // With random() = 1 the engine returns exactly the ceiling, so the two must agree.
    assert.equal(backoffDelayMs(attempt, DEFAULT_RETRY_POLICY, () => 1), backoffCeilingMs(attempt), `attempt ${attempt}`);
  }
  assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 5);
  assert.ok(nextDelayMs(1, () => 0) >= 1000);
});
