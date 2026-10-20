import { makeTestStore } from "./testing.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Store, redact } from "./store.ts";
import { decryptSecret, encryptSecret, generateWebhookSecret, parseKey } from "./secrets.ts";
import { evmEventId, normalizeEvmLog } from "../event-engine/normalize.ts";
import { DEFAULT_RETRY_POLICY, type RawEvmLog } from "../shared-types/index.ts";

const log = (over: Partial<RawEvmLog> = {}): RawEvmLog => ({
  address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
  topics: ["0xAAAA"],
  data: "0x",
  blockNumber: 100,
  blockHash: "0xBLOCK1",
  transactionHash: "0xTX1",
  transactionIndex: 0,
  logIndex: 3,
  removed: false,
  ...over,
});
const ctx = { projectId: "p1", chainId: 420420777, now: () => new Date("2026-10-19T10:00:00Z") };

test("event id: deterministic, case-insensitive, sensitive to every identity component", async () => {
  const base = evmEventId("p1", 1, "0xB", "0xT", 0);
  assert.equal(base, evmEventId("p1", 1, "0xb", "0xt", 0));
  assert.match(base, /^evt_[0-9a-f]{32}$/);
  assert.notEqual(base, evmEventId("p2", 1, "0xB", "0xT", 0)); // project: two projects may watch one contract
  assert.notEqual(base, evmEventId("p1", 2, "0xB", "0xT", 0)); // chain
  assert.notEqual(base, evmEventId("p1", 1, "0xC", "0xT", 0)); // block hash (reorg => new identity)
  assert.notEqual(base, evmEventId("p1", 1, "0xB", "0xU", 0)); // tx
  assert.notEqual(base, evmEventId("p1", 1, "0xB", "0xT", 1)); // log index
});

test("two projects watching the same contract each get their own copy of every event", async () => {
  const s = await makeTestStore();
  const a = normalizeEvmLog(log(), { ...ctx, projectId: "p1" });
  const b = normalizeEvmLog(log(), { ...ctx, projectId: "p2" });
  assert.notEqual(a.id, b.id);
  assert.equal(await s.insertEvent(a), true);
  assert.equal(await s.insertEvent(b), true, "the second project must not see the event as a duplicate");
  assert.equal(await s.countEvents("p1"), 1);
  assert.equal(await s.countEvents("p2"), 1);
});

test("normalisation: undecoded log keeps raw data, never invents an event name", async () => {
  const e = normalizeEvmLog(log(), ctx);
  assert.equal(e.eventName, null);
  assert.equal(e.decoded, false);
  assert.equal(e.payload, null);
  assert.equal(e.contractAddress, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.equal(e.finalityStatus, "included");
  assert.equal(e.observedAt, "2026-10-19T10:00:00.000Z");
});

test("normalisation: decodes with ABI and makes bigint JSON-safe", async () => {
  const { loadArtifactAbi } = await import("./testing-abi.ts");
  const abi = loadArtifactAbi();
  const { encodeEventTopics, encodeAbiParameters } = await import("viem");
  const addr = "0x1111111111111111111111111111111111111111";
  const topics = encodeEventTopics({ abi, eventName: "QuestCreated", args: { questId: 7n, creator: addr } });
  const data = encodeAbiParameters([{ type: "string" }], ["hello"]);
  const e = normalizeEvmLog(log({ address: addr, topics: topics.filter((t): t is `0x${string}` => typeof t === "string"), data }), { ...ctx, abis: new Map([[addr, abi]]) });
  assert.equal(e.eventName, "QuestCreated");
  assert.equal(e.decoded, true);
  assert.deepEqual(e.payload, { questId: "7", creator: addr, title: "hello" });
  JSON.stringify(e); // must not throw on bigint
});

test("store: event insertion is idempotent", async () => {
  const s = await makeTestStore();
  await s.ensureProject("p1", "demo", "portaldot-v3-testnet");
  const e = normalizeEvmLog(log(), ctx);
  assert.equal(await s.insertEvent(e), true);
  assert.equal(await s.insertEvent(e), false);
  assert.equal(await s.countEvents("p1"), 1);
  assert.deepEqual(await s.getEvent(e.id), e);
});

test("store: the same log in a different block (reorg) is a distinct event", async () => {
  const s = await makeTestStore();
  assert.equal(await s.insertEvent(normalizeEvmLog(log(), ctx)), true);
  assert.equal(await s.insertEvent(normalizeEvmLog(log({ blockHash: "0xBLOCK2" }), ctx)), true);
  assert.equal(await s.countEvents("p1"), 2);
});

test("store: initial delivery is created once per (event, endpoint); replays are unlimited", async () => {
  const s = await makeTestStore();
  const key = randomBytes(32);
  const e = normalizeEvmLog(log(), ctx);
  await s.insertEvent(e);
  const ep = await s.createEndpoint(
    { projectId: "p1", url: "https://x.example/hook", description: null, enabled: true, eventFilter: [], retryPolicy: DEFAULT_RETRY_POLICY },
    encryptSecret("whsec_abc", key),
  );
  assert.ok(await s.createDelivery(e.id, ep.id, "initial"));
  assert.equal(await s.createDelivery(e.id, ep.id, "initial"), null);
  assert.ok(await s.createDelivery(e.id, ep.id, "replay"));
  assert.ok(await s.createDelivery(e.id, ep.id, "replay"));
  assert.equal((await s.listDeliveries({ eventId: e.id })).length, 3);
});

test("secrets: AES-GCM round trip, random IV, tamper and wrong key detected, plaintext never stored", async () => {
  const key = randomBytes(32);
  const secret = generateWebhookSecret();
  const a = encryptSecret(secret, key);
  const b = encryptSecret(secret, key);
  assert.notEqual(a, b);
  assert.ok(!a.includes(secret));
  assert.equal(decryptSecret(a, key), secret);
  assert.throws(() => decryptSecret(a, randomBytes(32)));
  const parts = a.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptSecret(parts.join("."), key));
  assert.throws(() => parseKey(undefined));
  assert.throws(() => parseKey("abcd"));
  assert.equal(parseKey(key.toString("hex")).length, 32);
  assert.equal(parseKey(key.toString("base64")).length, 32);

  // the stored column is ciphertext
  const s = await makeTestStore();
  const ep = await s.createEndpoint({ projectId: "p1", url: "https://x.example/h", description: null, enabled: true, eventFilter: [], retryPolicy: DEFAULT_RETRY_POLICY }, a);
  const raw = (await s.rawAll("SELECT encrypted_secret FROM webhook_endpoints WHERE id = ?", [ep.id]))[0] as { encrypted_secret: string };
  assert.ok(!raw.encrypted_secret.includes(secret));
  assert.equal(decryptSecret((await s.getEndpointWithSecret(ep.id))!.encryptedSecret, key), secret);
  assert.equal("encryptedSecret" in (await s.getEndpoint(ep.id) as object), false); // API-facing shape has no secret
});

test("logs: credentials are redacted before storage", async () => {
  const s = await makeTestStore();
  await s.log("info", "webhook", 'sent with Authorization: Bearer sk_live_ABC and whsec_SECRETVALUE', { token: "t0k3n", note: "fine" }, "p1");
  const [row] = await s.listLogs("p1");
  const all = JSON.stringify(row);
  assert.ok(!all.includes("sk_live_ABC"));
  assert.ok(!all.includes("whsec_SECRETVALUE"));
  assert.ok(!all.includes("t0k3n"));
  assert.ok(all.includes("fine"));
  assert.ok(!redact("private_key=0xdeadbeef").includes("deadbeef"));
});

// ------------------------------------------------------------------ concurrency & transactions (run on every backend)
test("store: concurrent identical inserts store exactly one event (idempotency holds under races)", async () => {
  const s = await makeTestStore();
  await s.ensureProject("p1", "demo", "portaldot-v3-testnet");
  const e = normalizeEvmLog(log(), ctx);
  const results = await Promise.all(Array.from({ length: 20 }, () => s.insertEvent(e)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await s.countEvents("p1"), 1);
});

test("store: a delivery can be claimed by exactly one of many concurrent workers", async () => {
  const s = await makeTestStore();
  await s.ensureProject("p1", "demo", "portaldot-v3-testnet");
  const e = normalizeEvmLog(log(), ctx);
  await s.insertEvent(e);
  const ep = await s.createEndpoint({ projectId: "p1", url: "https://x.example/h", description: null, enabled: true, eventFilter: [], retryPolicy: DEFAULT_RETRY_POLICY }, encryptSecret("whsec_abc", randomBytes(32)));
  const d = (await s.createDelivery(e.id, ep.id, "initial"))!;
  const now = new Date(Date.now() + 1000);
  const claims = await Promise.all(Array.from({ length: 12 }, () => s.claimDelivery(d, now, 60_000)));
  assert.equal(claims.filter(Boolean).length, 1, "at-most-one claimant while the lease is held");
});

test("store: a failed transaction rolls back everything, including the cursor; a good one commits together", async () => {
  const s = await makeTestStore();
  await s.ensureProject("p1", "demo", "portaldot-v3-testnet");
  const e = normalizeEvmLog(log(), ctx);
  await assert.rejects(s.tx(async (t) => {
    await t.insertEvent(e);
    await t.setCursor("p1", "portaldot-v3-testnet", 100, "0xh");
    throw new Error("boom");
  }), /boom/);
  assert.equal(await s.countEvents("p1"), 0);
  assert.equal(await s.getCursor("p1", "portaldot-v3-testnet"), null);

  await s.tx(async (t) => {
    await t.insertEvent(e);
    await t.setCursor("p1", "portaldot-v3-testnet", 100, "0xh");
  });
  assert.equal(await s.countEvents("p1"), 1);
  assert.deepEqual(await s.getCursor("p1", "portaldot-v3-testnet"), { block: 100, hash: "0xh" });
});

test("store: reads issued during an open transaction never see its uncommitted rows", async () => {
  const s = await makeTestStore();
  await s.ensureProject("p1", "demo", "portaldot-v3-testnet");
  const e = normalizeEvmLog(log(), ctx);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const writer = s.tx(async (t) => { await t.insertEvent(e); await gate; });
  await new Promise((r) => setTimeout(r, 50));
  const seen = await Promise.race([s.countEvents("p1"), new Promise<string>((r) => setTimeout(() => r("blocked"), 300))]);
  assert.ok(seen === 0 || seen === "blocked", "either the committed state (0) or queued behind the writer; never the uncommitted row");
  release();
  await writer;
  assert.equal(await s.countEvents("p1"), 1);
});

// ------------------------------------------------------------------ accounts: upgrade of a pre-existing database
test("migration: accounts that existed before email verification are grandfathered as verified, exactly once", async () => {
  const { TEST_BACKEND } = await import("./testing.ts");
  const { openStore } = await import("./store.ts");
  let store: Store;
  let cleanup: () => Promise<void> = async () => {};
  let reopen: (() => Promise<Store>) | null = null;
  const old = "2026-01-02T03:04:05.000Z";

  if (TEST_BACKEND === "postgres") {
    const pg = (await import("pg")).default;
    const schema = "pops_mig_" + randomBytes(5).toString("hex");
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
    await admin.query(`INSERT INTO ${schema}.users VALUES ('usr_old', 'old@example.com', 'scrypt$x', $1)`, [old]);
    store = await openStore(process.env.TEST_DATABASE_URL!, { schema, dropSchemaOnClose: true, max: 2 });
    cleanup = async () => { await admin.end(); };
  } else {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "pops-mig-"));
    const file = join(dir, "old.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
    raw.prepare("INSERT INTO users VALUES ('usr_old', 'old@example.com', 'scrypt$x', ?)").run(old);
    raw.close();
    store = await openStore(file);
    reopen = async () => { await store.close(); return openStore(file); };
    cleanup = async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); };
  }

  try {
    const u = (await store.getUserByEmail("old@example.com"))!;
    assert.equal(u.emailVerifiedAt, old, "existing accounts keep working: verified as of their creation");
    assert.equal(u.githubId, null);

    // a user who signs up AFTER the upgrade is unverified, and re-running the migration (a restart) must not verify them
    const fresh = (await store.createUser("new@example.com", "scrypt$y"))!;
    assert.equal((await store.getUser(fresh.id))!.emailVerifiedAt, null);
    if (reopen) {
      store = await reopen(); // a restart runs the migration again
      assert.equal((await store.getUser(fresh.id))!.emailVerifiedAt, null, "a restart does not verify anyone");
      assert.equal((await store.getUserByEmail("old@example.com"))!.emailVerifiedAt, old);
    }
  } finally {
    await cleanup();
  }
});

test("auth tokens: single use, expiry, supersede, concurrent use has exactly one winner, purge", async () => {
  const s = await makeTestStore();
  const u = (await s.createUser("tok@example.com", "scrypt$x"))!;
  const now = new Date("2026-10-20T10:00:00Z");
  const later = (ms: number) => new Date(now.getTime() + ms);

  await s.createAuthToken(u.id, "reset_password", "h1", later(3_600_000), now);
  assert.equal(await s.consumeAuthToken("verify_email", "h1", now), null, "wrong kind");
  assert.equal(await s.consumeAuthToken("reset_password", "h1", later(3_600_001)), null, "expired");
  const results = await Promise.all(Array.from({ length: 8 }, () => s.consumeAuthToken("reset_password", "h1", now)));
  assert.equal(results.filter((r) => r === u.id).length, 1, "exactly one concurrent use wins");
  assert.equal(await s.consumeAuthToken("reset_password", "h1", now), null, "already used");

  await s.createAuthToken(u.id, "verify_email", "h2", later(60_000), now);
  await s.createAuthToken(u.id, "verify_email", "h3", later(60_000), now);
  assert.equal(await s.consumeAuthToken("verify_email", "h2", now), null, "superseded by a newer link");
  assert.equal(await s.consumeAuthToken("verify_email", "h3", now), u.id);

  await s.createAuthToken(u.id, "reset_password", "h4", later(1000), now);
  await s.purgeSessions(later(3 * 86_400_000));
  assert.equal(Number((await s.rawAll("SELECT COUNT(*) AS n FROM auth_tokens"))[0].n), 0, "old tokens are purged");
});
