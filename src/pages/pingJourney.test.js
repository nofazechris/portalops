import test from "node:test";
import assert from "node:assert/strict";
import { journeyComplete, pingJourney } from "./pingJourney.js";

const HASH = "0x" + "ab".repeat(32);
const ev = (over = {}) => ({ blockNumber: 152200, decoded: true, eventName: "Ping", payload: { from: "0x" + "11".repeat(20), seq: "9", note: "hello" }, finalityStatus: "included", delivery: null, ...over });
const states = (s) => pingJourney(s).map((x) => x.state);

test("journey: nothing yet, then sent, then captured and decoded, then finalized and delivered", () => {
  assert.deepEqual(states({ hash: null, events: [], sentAt: null, capturedAt: null }), ["waiting", "waiting", "waiting", "waiting", "waiting"]);
  assert.deepEqual(states({ hash: HASH, events: [], sentAt: 1000, capturedAt: null }), ["done", "active", "waiting", "waiting", "waiting"]);
  assert.deepEqual(states({ hash: HASH, events: [ev()], sentAt: 1000, capturedAt: 10_300 }), ["done", "done", "done", "active", "active"]);
  const done = pingJourney({ hash: HASH, events: [ev({ finalityStatus: "finalized", delivery: { status: "delivered", count: 1 } })], sentAt: 1000, capturedAt: 8000 });
  assert.deepEqual(done.map((x) => x.state), ["done", "done", "done", "done", "done"]);
  assert.equal(journeyComplete(done), true);
});

test("journey: says how long capture took, shows the decoded fields, and never invents a decode", () => {
  const s = pingJourney({ hash: HASH, events: [ev()], sentAt: 1000, capturedAt: 10_300 });
  assert.match(s[1].detail, /block #152,200 · 9\.3 s after you sent it/);
  assert.match(s[2].detail, /^Ping {2}from: 0x1111111111…111111 · seq: 9 · note: hello$/);
  const raw = pingJourney({ hash: HASH, events: [ev({ decoded: false, eventName: null, payload: null })], sentAt: 1, capturedAt: 2 });
  assert.equal(raw[2].state, "bad");
  assert.match(raw[2].detail, /stored raw/);
});

test("journey: orphaned and failed deliveries are dead ends that stop the waiting", () => {
  const orphan = pingJourney({ hash: HASH, events: [ev({ finalityStatus: "orphaned" })], sentAt: 1, capturedAt: 2 });
  assert.equal(orphan[3].state, "bad");
  assert.equal(journeyComplete(orphan), true);
  const failed = pingJourney({ hash: HASH, events: [ev({ delivery: { status: "failed", count: 3 } })], sentAt: 1, capturedAt: 2 });
  assert.equal(failed[4].state, "bad");
  assert.equal(journeyComplete(pingJourney({ hash: HASH, events: [ev()], sentAt: 1, capturedAt: 2 })), false);
});
