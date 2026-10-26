import test from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hashRecoveryCode, newRecoveryCodes, otpauthUri, stepAt, totpCode, verifyTotp } from "./totp.ts";

// RFC 6238 appendix B: the SHA-1 test secret is the ASCII string "12345678901234567890", with 8-digit codes.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("totp: matches the RFC 6238 test vectors", () => {
  for (const [time, want] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) {
    assert.equal(totpCode(RFC_SECRET, Math.floor(time / 30), 8), want, "t=" + time);
  }
});

test("totp: base32 round-trips and tolerates spaces, dashes and lower case", () => {
  const raw = Buffer.from("portalops-secret!");
  assert.deepEqual(base32Decode(base32Encode(raw)), raw);
  assert.deepEqual(base32Decode(base32Encode(raw).toLowerCase().replace(/(.{4})/g, "$1 ")), raw);
  assert.throws(() => base32Decode("not*base32"));
});

test("totp: a code is accepted within one step either side, refused beyond that, and cannot be reused", () => {
  const t = 1_800_000_000_000;
  const code = totpCode(RFC_SECRET, stepAt(t));
  const ok = verifyTotp(RFC_SECRET, code, t);
  assert.equal(ok.ok, true);
  assert.equal(verifyTotp(RFC_SECRET, code, t + 30_000).ok, true, "the next step still accepts it (clock drift)");
  assert.equal(verifyTotp(RFC_SECRET, code, t + 90_000).ok, false, "three steps later it is stale");
  assert.equal(verifyTotp(RFC_SECRET, code, t - 90_000).ok, false);
  assert.equal(verifyTotp(RFC_SECRET, code, t, stepAt(t)).ok, false, "the step already used is a replay");
  assert.equal(verifyTotp(RFC_SECRET, code, t, stepAt(t) - 1).ok, true);
  assert.equal(verifyTotp(RFC_SECRET, code.slice(0, 5), t).ok, false);
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", t).ok, false);
  assert.equal(verifyTotp(RFC_SECRET, code.slice(0, 3) + " " + code.slice(3), t).ok, true, "spaces are ignored");
});

test("totp: otpauth link and recovery codes", () => {
  const u = otpauthUri("ada@example.com", "ABCDEFGH");
  assert.equal(u, "otpauth://totp/PortalOps:ada%40example.com?secret=ABCDEFGH&issuer=PortalOps&algorithm=SHA1&digits=6&period=30");
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)));
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toUpperCase().replace("-", " ")), "case, dash and spaces do not matter");
});
