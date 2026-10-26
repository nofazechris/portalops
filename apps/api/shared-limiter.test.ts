import test from "node:test";
import assert from "node:assert/strict";
import { makeTestStore } from "../../packages/database/testing.ts";
import { SharedRateLimiter } from "./shared-limiter.ts";

test("shared rate limiter: two instances over one database enforce a single limit, and the window resets", async () => {
  const store = await makeTestStore();
  let t = 1_000_000;
  const a = new SharedRateLimiter(store, "auth", 3, 60_000, () => t);
  const b = new SharedRateLimiter(store, "auth", 3, 60_000, () => t); // "another API instance"
  assert.equal(await a.hit("ip:1"), 0);
  assert.equal(await b.hit("ip:1"), 0);
  assert.equal(await a.hit("ip:1"), 0);
  const wait = await b.hit("ip:1"); // the 4th request overall, though neither instance has seen more than two
  assert.ok(wait >= 1 && wait <= 60, "told to wait: " + wait);
  assert.equal(await a.hit("ip:2"), 0, "another key is independent");
  const other = new SharedRateLimiter(store, "global", 3, 60_000, () => t);
  assert.equal(await other.hit("ip:1"), 0, "another limiter name does not share counters");

  t += 61_000; // the window has ended
  assert.equal(await a.hit("ip:1"), 0, "a new window starts at one");
  assert.equal(await b.hit("ip:1"), 0);
  assert.equal(await a.hit("ip:1"), 0);
  assert.ok(await b.hit("ip:1") > 0);

  await store.pruneRateLimits(t + 120_000);
  assert.equal((await store.hitRateLimit("auth:ip:1", 60_000, t + 120_000)).hits, 1, "expired counters are pruned and restart");
});

test("shared rate limiter: a database failure lets the request through instead of failing it", async () => {
  const store = await makeTestStore();
  const limiter = new SharedRateLimiter(store, "auth", 1, 60_000);
  store.hitRateLimit = async () => { throw new Error("db down"); };
  assert.equal(await limiter.hit("ip:1"), 0);
  assert.equal(await limiter.hit("ip:1"), 0);
});
