import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signing format (documented for SDK/receiver authors):
 *
 *   signed_payload = `${timestamp}.${rawBody}`          (timestamp = unix seconds, decimal)
 *   signature      = hex( HMAC_SHA256(secret, signed_payload) )
 *   header         = `PortalOps-Signature: t=${timestamp},v1=${signature}`
 *
 * Receivers must verify against the RAW request body bytes (not re-serialised JSON),
 * compare in constant time, and reject timestamps outside a tolerance window.
 */

export const SIGNATURE_HEADER = "portalops-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function signHeader(secret: string, rawBody: string, now: Date = new Date()): { timestamp: number; header: string } {
  const timestamp = Math.floor(now.getTime() / 1000);
  return { timestamp, header: `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}` };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "expired" | "mismatch" };

export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  opts: { toleranceSeconds?: number; now?: Date } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "malformed" };
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isInteger(t) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "malformed" };

  const nowS = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowS - t) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return { ok: false, reason: "expired" };

  const expected = Buffer.from(computeSignature(secret, t, rawBody), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "mismatch" };
}
