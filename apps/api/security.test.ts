import { makeTestStore } from "../../packages/database/testing.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { scrubScriptSecrets } from "../../packages/config/env.ts";
import { hashPassword, verifyPassword } from "./auth.ts";
import { clientIp } from "./http.ts";
import { Store } from "../../packages/database/store.ts";
import { encryptSecret } from "../../packages/database/secrets.ts";
import { normalizeEvmLog } from "../../packages/event-engine/normalize.ts";
import { enqueueEvent, runDueDeliveries } from "../../packages/webhook-engine/runner.ts";
import { startReceiver } from "../../examples/webhook-receiver/server.ts";
import { DEFAULT_RETRY_POLICY } from "../../packages/shared-types/index.ts";

test("least privilege: deploy-script private keys are removed from the API/worker environment", async () => {
  const env: NodeJS.ProcessEnv = {
    PORTALDOT_DEPLOYER_PRIVATE_KEY: "0x" + "ab".repeat(32),
    PORTALDOT_PARTICIPANT_PRIVATE_KEY: "0x" + "cd".repeat(32),
    WEBHOOK_ENCRYPTION_KEY: "keep-me",
    PORTALDOT_EVM_RPC_URL: "https://example",
  };
  assert.deepEqual(scrubScriptSecrets(env).sort(), ["PORTALDOT_DEPLOYER_PRIVATE_KEY", "PORTALDOT_PARTICIPANT_PRIVATE_KEY"]);
  assert.equal(env.PORTALDOT_DEPLOYER_PRIVATE_KEY, undefined);
  assert.equal(env.PORTALDOT_PARTICIPANT_PRIVATE_KEY, undefined);
  assert.equal(env.WEBHOOK_ENCRYPTION_KEY, "keep-me", "unrelated settings are untouched");
  assert.deepEqual(scrubScriptSecrets(env), [], "idempotent");
});

test("passwords: new hashes use the stronger cost, older hashes keep verifying, absurd parameters are refused", async () => {
  const h = await hashPassword("a long enough passphrase");
  assert.match(h, /^scrypt\$65536\$8\$1\$/);
  assert.equal(await verifyPassword("a long enough passphrase", h), true);
  assert.equal(await verifyPassword("wrong", h), false);

  // a hash written by the previous version (N = 2^15)
  const salt = randomBytes(16);
  const old = ["scrypt", 32768, 8, 1, salt.toString("base64url"), scryptSync("legacy password!!", salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString("base64url")].join("$");
  assert.equal(await verifyPassword("legacy password!!", old), true);

  // a tampered row must not be able to make the server allocate gigabytes
  const evil = ["scrypt", 2 ** 30, 8, 1, salt.toString("base64url"), randomBytes(32).toString("base64url")].join("$");
  assert.equal(await verifyPassword("anything", evil), false);
  assert.equal(await verifyPassword("anything", "bcrypt$whatever"), false);
});

test("rate-limit identity: X-Forwarded-For is ignored unless a trusted proxy is configured, then only the proxy-appended hop is used", async () => {
  const req = (xff: string | undefined, socket = "10.0.0.9") => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: socket } }) as unknown as IncomingMessage;
  // no proxy: a client can put anything in the header, and it must not change who we think they are
  assert.equal(clientIp(req("1.2.3.4"), 0), "10.0.0.9");
  assert.equal(clientIp(req("1.2.3.4, 5.6.7.8"), 0), "10.0.0.9");
  // one trusted proxy appends the real client address last; earlier entries are attacker-supplied and are ignored
  assert.equal(clientIp(req("6.6.6.6, 203.0.113.7"), 1), "203.0.113.7");
  assert.equal(clientIp(req("203.0.113.7"), 1), "203.0.113.7");
  // header missing or shorter than the configured hops: fall back to the socket
  assert.equal(clientIp(req(undefined), 1), "10.0.0.9");
  assert.equal(clientIp(req("203.0.113.7"), 2), "10.0.0.9");
});

test("delivery claim: two workers racing for the same due delivery send it exactly once; a crashed worker's lease expires", async (t) => {
  const receiver = await startReceiver("whsec_claim_test");
  t.after(() => receiver.close());
  const store = await makeTestStore();
  const key = randomBytes(32);
  const event = normalizeEvmLog({ address: "0x" + "11".repeat(20), topics: ["0xaa"], data: "0x", blockNumber: 1, blockHash: "0xb1", transactionHash: "0xt1", transactionIndex: 0, logIndex: 0, removed: false }, { projectId: "p1", chainId: 420420777 });
  await store.insertEvent(event);
  const ep = await store.createEndpoint({ projectId: "p1", url: receiver.url, description: null, enabled: true, eventFilter: [], retryPolicy: DEFAULT_RETRY_POLICY }, encryptSecret("whsec_claim_test", key));
  let skew = 0;
  const ctx = { store, encryptionKey: key, guard: { allowPrivate: true }, now: () => new Date(Date.now() + skew), random: () => 0.5 };
  const [id] = await enqueueEvent(store, event, ctx.now());

  const [a, b] = await Promise.all([runDueDeliveries(ctx), runDueDeliveries(ctx)]);
  assert.equal(a + b, 1, "exactly one worker attempted the delivery");
  assert.equal(receiver.requests.length, 1);
  assert.equal((await store.getDelivery(id))!.status, "delivered");

  // lease behaviour: a claimed-but-unfinished delivery is invisible until its lease expires, then becomes claimable again
  const id2 = (await store.createDelivery(event.id, ep.id, "replay", ctx.now()))!;
  assert.equal(await store.claimDelivery(id2, ctx.now(), 60_000), true);
  assert.equal(await store.claimDelivery(id2, ctx.now(), 60_000), false, "already claimed");
  assert.equal((await store.dueDeliveries(ctx.now())).some((d) => d.id === id2), false);
  skew += 61_000; // the worker "crashed"; the lease runs out
  assert.equal((await store.dueDeliveries(ctx.now())).some((d) => d.id === id2), true);
  assert.equal(await store.claimDelivery(id2, ctx.now(), 60_000), true);
});
