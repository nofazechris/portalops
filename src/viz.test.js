import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRMATION_DEPTH, bucketByMinute, deliveryFlow, failureReason, finalityProgress, fmtMs, groupByBlock, isRetryableAttempt, newIds } from "./viz.js";

test("fmtMs: readable durations at every scale", () => {
  assert.equal(fmtMs(340), "340ms");
  assert.equal(fmtMs(5200), "5.2s");
  assert.equal(fmtMs(42_000), "42s");
  assert.equal(fmtMs(190_000), "3m 10s");
  assert.equal(fmtMs(180_000), "3m");
  assert.equal(fmtMs(3_720_000), "1h 2m");
  assert.equal(fmtMs(-1), "–");
  assert.equal(fmtMs(NaN), "–");
});

test("finality: an included event shows how many blocks remain and never invents depth when the head is unknown", () => {
  const f = finalityProgress("included", 100, 107);
  assert.equal(f.blocksDeep, 7);
  assert.ok(Math.abs(f.progress - 7 / 12) < 1e-9);
  assert.deepEqual(f.steps.map((s) => s.state), ["done", "current", "todo"]);
  assert.equal(f.steps[1].note, "7/12 deep");
  assert.match(f.summary, /5 more blocks/);

  const one = finalityProgress("included", 100, 111);
  assert.match(one.summary, /1 more block until/);

  const unknown = finalityProgress("included", 100, null);
  assert.equal(unknown.blocksDeep, null);
  assert.equal(unknown.progress, 0);
  assert.match(unknown.summary, /head is unknown/);
  assert.equal(finalityProgress("included", 100, undefined).blocksDeep, null);
});

test("finality: deep enough but not yet promoted, confirmed, finalized and orphaned each tell the truth", () => {
  assert.match(finalityProgress("included", 100, 130).summary, /next pass/);
  assert.equal(finalityProgress("included", 100, 130).steps[1].note, "12/12 deep", "depth is capped at the threshold");

  const c = finalityProgress("confirmed", 100, 140);
  assert.deepEqual(c.steps.map((s) => s.state), ["done", "done", "current"]);
  assert.equal(c.progress, 1);
  assert.match(c.summary, /heuristic/);

  const f = finalityProgress("finalized", 100, 500);
  assert.deepEqual(f.steps.map((s) => s.state), ["done", "done", "done"]);
  assert.match(f.summary, /no longer be reorganised/);

  const o = finalityProgress("orphaned", 100, 500);
  assert.equal(o.orphaned, true);
  assert.deepEqual(o.steps.map((s) => s.state), ["done", "failed", "skipped"]);
  assert.match(o.summary, /reorganisation/);
});

test("finality: the threshold is the server's (12) and head below block never goes negative", () => {
  assert.equal(CONFIRMATION_DEPTH, 12);
  assert.equal(finalityProgress("included", 100, 90).blocksDeep, 0);
});

const att = (n, status, startedAt, finishedAt, over = {}) => ({ id: "a" + n, attemptNumber: n, startedAt, finishedAt, responseStatus: status, responseDurationMs: 120, sanitisedResponse: null, errorCode: null, ...over });

test("retry classification mirrors the server", () => {
  assert.equal(isRetryableAttempt({ responseStatus: 200 }), false);
  assert.equal(isRetryableAttempt({ responseStatus: 500 }), true);
  assert.equal(isRetryableAttempt({ responseStatus: 429 }), true);
  assert.equal(isRetryableAttempt({ responseStatus: 408 }), true);
  assert.equal(isRetryableAttempt({ responseStatus: 404 }), false);
  assert.equal(isRetryableAttempt({ responseStatus: 302 }), false);
  assert.equal(isRetryableAttempt({ responseStatus: null, errorCode: "timeout" }), true);
  assert.equal(isRetryableAttempt({ responseStatus: null, errorCode: "ECONNREFUSED" }), true);
  assert.equal(isRetryableAttempt({ responseStatus: null, errorCode: "blocked_target" }), false);
  assert.equal(isRetryableAttempt({ responseStatus: null, errorCode: "response_too_large" }), false);
});

test("failure reasons separate a permanent error from exhausted retries", () => {
  assert.match(failureReason(att(1, 400, "t", "t"), 1), /Not retried: HTTP 400 is a permanent error/);
  assert.match(failureReason(att(1, null, "t", "t", { errorCode: "blocked_target" }), 1), /Not retried: blocked_target/);
  assert.match(failureReason(att(5, 500, "t", "t"), 5), /Retries exhausted after 5 attempts/);
  assert.match(failureReason(att(1, 503, "t", "t"), 1), /after 1 attempt \(/);
  assert.match(failureReason(undefined, 0), /No attempt/);
});

test("delivery flow: fail, back off, fail, succeed reads left to right with the waits between attempts", () => {
  const d = {
    id: "dlv_1", kind: "initial", status: "delivered", createdAt: "2026-10-20T10:00:00.000Z", nextAttemptAt: null,
    attempts: [
      att(2, 200, "2026-10-20T10:00:12.000Z", "2026-10-20T10:00:12.150Z"),
      att(1, 500, "2026-10-20T10:00:01.000Z", "2026-10-20T10:00:01.200Z"),
    ],
  };
  const f = deliveryFlow(d, Date.parse("2026-10-20T10:05:00Z"));
  assert.deepEqual(f.nodes.map((n) => n.kind), ["queued", "attempt", "wait", "attempt", "end"], "the 1s before attempt 1 is not drawn as a wait");
  const attempts = f.nodes.filter((n) => n.kind === "attempt");
  assert.deepEqual(attempts.map((a) => [a.n, a.ok, a.result]), [[1, false, 500], [2, true, 200]], "attempts are in order even if the API returned them reversed");
  assert.equal(attempts[0].retryable, true);
  assert.equal(f.nodes[2].ms, 10_800, "backoff = gap between the end of attempt 1 and the start of attempt 2");
  assert.equal(f.nodes.at(-1).tone, "ok");
  assert.match(f.summary, /attempt 2/);
});

test("delivery flow: a scheduled retry counts down to now; a first attempt not yet made says so", () => {
  const retrying = deliveryFlow({
    id: "d", kind: "initial", status: "retrying", createdAt: "2026-10-20T10:00:00Z", nextAttemptAt: "2026-10-20T10:04:00Z",
    attempts: [att(1, 502, "2026-10-20T10:00:01Z", "2026-10-20T10:00:02Z")],
  }, Date.parse("2026-10-20T10:01:00Z"));
  const wait = retrying.nodes.at(-2);
  assert.equal(wait.pending, true);
  assert.equal(wait.ms, 180_000);
  assert.equal(wait.label, "next retry in");
  assert.equal(retrying.nodes.at(-1).tone, "pending");

  const overdue = deliveryFlow({ id: "d", kind: "initial", status: "retrying", createdAt: "t", nextAttemptAt: "2026-10-20T10:00:00Z", attempts: [att(1, 500, "2026-10-19T09:00:00Z", "2026-10-19T09:00:01Z")] }, Date.parse("2026-10-20T10:01:00Z"));
  assert.equal(overdue.nodes.at(-2).ms, 0, "never a negative countdown");

  const fresh = deliveryFlow({ id: "d", kind: "replay", status: "pending", createdAt: "2026-10-20T10:00:00Z", nextAttemptAt: "2026-10-20T10:00:00Z", attempts: [] }, Date.parse("2026-10-20T10:00:05Z"));
  assert.equal(fresh.nodes[0].label, "Replay queued");
  assert.equal(fresh.nodes.at(-2).label, "first attempt in");
  assert.match(fresh.summary, /first attempt/);
});

test("delivery flow: failed deliveries carry the reason", () => {
  const permanent = deliveryFlow({ id: "d", kind: "initial", status: "failed", createdAt: "2026-10-20T10:00:00Z", nextAttemptAt: null, attempts: [att(1, 401, "2026-10-20T10:00:01Z", "2026-10-20T10:00:01.1Z")] });
  const end = permanent.nodes.at(-1);
  assert.equal(end.tone, "bad");
  assert.match(end.note, /Not retried: HTTP 401/);
  assert.deepEqual(permanent.nodes.map((n) => n.kind), ["queued", "attempt", "end"], "a tiny gap before the first attempt is not drawn as a wait");
});

test("timeline helpers: per-minute buckets, block grouping and 'new' detection", () => {
  const now = Date.parse("2026-10-20T10:15:30Z");
  const ev = (id, block, iso) => ({ id, blockNumber: block, observedAt: iso });
  const events = [ev("a", 12, "2026-10-20T10:15:10Z"), ev("b", 12, "2026-10-20T10:15:00Z"), ev("c", 11, "2026-10-20T10:13:59Z"), ev("old", 3, "2026-10-20T09:00:00Z"), ev("future", 13, "2026-10-20T10:20:00Z")];
  const b = bucketByMinute(events, now, 15);
  assert.equal(b.length, 15);
  assert.equal(b[14], 2, "current minute");
  assert.equal(b[13], 1, "the previous minute (91s ago)");
  assert.equal(b.reduce((x, y) => x + y, 0), 3, "old and future events are not counted");

  const g = groupByBlock(events.slice(0, 3));
  assert.deepEqual(g.map((x) => [x.block, x.events.length]), [[12, 2], [11, 1]]);

  assert.deepEqual(newIds(null, events), [], "the first load is not news");
  assert.deepEqual(newIds(new Set(["b", "c", "old", "future"]), events), ["a"]);
});
