import test from "node:test";
import assert from "node:assert/strict";
import { computeSignature, signHeader, verifySignature } from "./sign.ts";
import { backoffDelayMs, isRetryable, planNext } from "./retry.ts";
import { BlockedTargetError, isBlockedAddress, validateWebhookUrl } from "./url-guard.ts";
import { sanitiseResponse } from "./send.ts";
import { DEFAULT_RETRY_POLICY } from "../shared-types/index.ts";

const SECRET = "whsec_test_secret";
const BODY = '{"id":"evt_1","n":1}';

test("signature: valid header verifies", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  const { header } = signHeader(SECRET, BODY, now);
  assert.deepEqual(verifySignature(SECRET, BODY, header, { now }), { ok: true });
});

test("signature: known vector (format is part of the public contract)", () => {
  // Computed independently with: printf '%s' '1700000000.{}' | openssl dgst -sha256 -hmac k
  assert.equal(computeSignature("k", 1700000000, "{}"), "c6ef4734033cee2367414a0939385eca0397754aa7a59716da7463a9298b5146");
});

test("signature: tampered body, wrong secret and bad header are rejected", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  const { header } = signHeader(SECRET, BODY, now);
  assert.deepEqual(verifySignature(SECRET, BODY + " ", header, { now }), { ok: false, reason: "mismatch" });
  assert.deepEqual(verifySignature("other", BODY, header, { now }), { ok: false, reason: "mismatch" });
  assert.deepEqual(verifySignature(SECRET, BODY, "garbage", { now }), { ok: false, reason: "malformed" });
  assert.deepEqual(verifySignature(SECRET, BODY, undefined, { now }), { ok: false, reason: "malformed" });
});

test("signature: expired timestamps are rejected (replay protection)", () => {
  const signedAt = new Date("2026-10-19T10:00:00Z");
  const { header } = signHeader(SECRET, BODY, signedAt);
  assert.deepEqual(verifySignature(SECRET, BODY, header, { now: new Date("2026-10-19T10:10:00Z") }), { ok: false, reason: "expired" });
  assert.deepEqual(verifySignature(SECRET, BODY, header, { now: new Date("2026-10-19T10:04:00Z") }), { ok: true });
});

test("retry: classification", () => {
  assert.equal(isRetryable({ status: 500, errorCode: null }), true);
  assert.equal(isRetryable({ status: 503, errorCode: null }), true);
  assert.equal(isRetryable({ status: 429, errorCode: null }), true);
  assert.equal(isRetryable({ status: 408, errorCode: null }), true);
  assert.equal(isRetryable({ status: null, errorCode: "timeout" }), true);
  assert.equal(isRetryable({ status: null, errorCode: "ECONNREFUSED" }), true);
  assert.equal(isRetryable({ status: 400, errorCode: null }), false);
  assert.equal(isRetryable({ status: 404, errorCode: null }), false);
  assert.equal(isRetryable({ status: 401, errorCode: null }), false);
  assert.equal(isRetryable({ status: 302, errorCode: null }), false);
  assert.equal(isRetryable({ status: 200, errorCode: null }), false);
  assert.equal(isRetryable({ status: null, errorCode: "blocked_target" }), false);
});

test("retry: exponential backoff with full jitter, capped", () => {
  const p = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1_000, maxDelayMs: 10_000 };
  assert.equal(backoffDelayMs(1, p, () => 0.5), 1_000); // ceiling 1000 * 0.5 = 500, raised to the 1s floor
  assert.equal(backoffDelayMs(3, p, () => 0.999), 3_996); // ceiling 4000
  assert.equal(backoffDelayMs(10, p, () => 0.999), 9_990); // capped at 10000
  assert.equal(backoffDelayMs(2, p, () => 0), 1_000); // jitter floor: never a hot loop
});

test("retry: plan stops at max attempts, max age and for permanent errors", () => {
  const p = { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, maxAgeMs: 60_000, baseDelayMs: 1_000 };
  const created = new Date("2026-10-19T10:00:00Z");
  const soon = new Date("2026-10-19T10:00:05Z");
  const r = () => 0.5;
  assert.equal(planNext({ status: 500, errorCode: null }, 1, created, p, soon, r).action, "retry");
  assert.deepEqual(planNext({ status: 500, errorCode: null }, 3, created, p, soon, r), { action: "fail", reason: "max_attempts" });
  assert.deepEqual(planNext({ status: 400, errorCode: null }, 1, created, p, soon, r), { action: "fail", reason: "not_retryable" });
  assert.deepEqual(planNext({ status: 500, errorCode: null }, 1, created, p, new Date("2026-10-19T10:02:00Z"), r), { action: "fail", reason: "max_age" });
  assert.deepEqual(planNext({ status: 200, errorCode: null }, 1, created, p, soon, r), { action: "deliver" });
});

test("ssrf: private, loopback, link-local, metadata and mapped addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("ssrf: URL policy", async () => {
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  const priv = async () => [{ address: "10.0.0.5", family: 4 }];
  const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }];

  const ok = await validateWebhookUrl("https://hooks.example.com/x", { resolver: pub });
  assert.equal(ok.address, "93.184.216.34");

  await assert.rejects(validateWebhookUrl("http://hooks.example.com/x", { resolver: pub }), (e: BlockedTargetError) => e.code === "invalid_url"); // https required
  await assert.rejects(validateWebhookUrl("ftp://hooks.example.com/x", { resolver: pub }), (e: BlockedTargetError) => e.code === "invalid_url");
  await assert.rejects(validateWebhookUrl("https://user:pw@hooks.example.com/", { resolver: pub }), (e: BlockedTargetError) => e.code === "invalid_url");
  await assert.rejects(validateWebhookUrl("not a url", { resolver: pub }), (e: BlockedTargetError) => e.code === "invalid_url");
  await assert.rejects(validateWebhookUrl("https://internal.example.com/", { resolver: priv }), (e: BlockedTargetError) => e.code === "blocked_target");
  await assert.rejects(validateWebhookUrl("https://rebind.example.com/", { resolver: mixed }), (e: BlockedTargetError) => e.code === "blocked_target"); // ANY bad answer blocks
  await assert.rejects(validateWebhookUrl("https://169.254.169.254/latest/meta-data", {}), (e: BlockedTargetError) => e.code === "blocked_target");
  await assert.rejects(validateWebhookUrl("https://[::1]/", {}), (e: BlockedTargetError) => e.code === "blocked_target");

  // explicit local-dev escape hatch
  const local = await validateWebhookUrl("http://127.0.0.1:4010/webhook", { allowPrivate: true });
  assert.equal(local.address, "127.0.0.1");
});

test("response sanitising: strips control chars, redacts credentials, truncates", () => {
  const out = sanitiseResponse('ok\u0000\u0007 {"token":"abc123","Authorization":"Bearer sk_live_999"} whsec_ABCDEF');
  assert.ok(!out.includes("abc123"));
  assert.ok(!out.includes("sk_live_999"));
  assert.ok(!out.includes("whsec_ABCDEF"));
  assert.ok(!/[\u0000-\u0008]/.test(out));
  assert.ok(sanitiseResponse("x".repeat(10_000)).length <= 2048);
});

test("ssrf: IPv6 transition and embedding forms cannot smuggle in internal IPv4 addresses", () => {
  for (const ip of [
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "64:ff9b:1::1", // NAT64
    "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101::", // 6to4 embedding loopback / metadata / RFC1918
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", // Teredo, documentation
    "::7f00:1", "::127.0.0.1", "::a9fe:a9fe", // IPv4-compatible
    "100::1", "fec0::1", "ff02::1", "::ffff:10.0.0.1", "0:0:0:0:0:ffff:a9fe:a9fe",
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "64:ff9b::808:808", "2002:808:808::1", "8.8.8.8"]) {
    assert.equal(isBlockedAddress(ip), false, ip); // embedded PUBLIC addresses and ordinary global unicast stay reachable
  }
  assert.equal(isBlockedAddress("not an ip"), true, "unparseable input fails closed");
  assert.equal(isBlockedAddress("1:2:3:4:5:6:7:8:9"), true);
  assert.equal(isBlockedAddress("1::2::3"), true);
});
