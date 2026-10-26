import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords (RFC 6238) for two-factor sign-in, with no dependency: HMAC-SHA1, 30-second steps, 6 digits, the
// format every authenticator app (Google Authenticator, 1Password, Authy, ...) understands.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=-]/g, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new random shared secret: 160 bits, base32 (what authenticator apps expect). */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** The code for one time step. */
export function totpCode(secretB32: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * Checks a 6-digit code against the steps around `nowMs` (one step either side, for clock drift). A step at or below `lastStep` is
 * refused, so a code that was already used cannot be replayed within its validity window.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: number | null = null, window = 1): { ok: true; step: number } | { ok: false } {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return { ok: false };
  const want = Buffer.from(c);
  const now = stepAt(nowMs);
  let hit: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    const got = Buffer.from(totpCode(secretB32, s));
    if (timingSafeEqual(got, want) && hit === null && (lastStep === null || s > lastStep)) hit = s; // no early exit: constant work
  }
  return hit === null ? { ok: false } : { ok: true, step: hit };
}

/** The otpauth:// link an authenticator app can import (also what a QR code would encode). */
export function otpauthUri(email: string, secretB32: string, issuer = "PortalOps"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** One-time recovery codes for a lost phone, e.g. "k3m9x-4tq2w". Shown once; only hashes are stored. */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (i l o 0 1)
  const pick = () => { const b = randomBytes(10); return [...b].map((x) => alphabet[x % alphabet.length]).join(""); };
  return Array.from({ length: n }, () => { const c = pick(); return c.slice(0, 5) + "-" + c.slice(5); });
}

export const normaliseRecoveryCode = (c: string): string => c.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecoveryCode = (c: string): string => createHash("sha256").update(normaliseRecoveryCode(c)).digest("hex");
