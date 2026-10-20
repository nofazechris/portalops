import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookPayload } from "./types.ts";

/**
 * Webhook signature verification.
 *
 *   header:  portalops-signature: t=<unix seconds>,v1=<hex>
 *   v1    =  HMAC_SHA256(secret, `${t}.${rawBody}`)
 *
 * Always verify against the RAW request body (the exact bytes received), compare in constant time, and reject stale
 * timestamps. These are the same rules the PortalOps built-in receiver applies.
 */

export const SIGNATURE_HEADER = "portalops-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "expired" | "mismatch" };

export interface VerifyOptions {
  /** Maximum allowed difference between the signed timestamp and now. Default 300 s. */
  toleranceSeconds?: number;
  /** Override "now" (for tests). */
  now?: Date;
}

export function verifyWebhookSignature(secret: string, rawBody: string | Uint8Array, header: string | null | undefined, opts: VerifyOptions = {}): VerifyResult {
  if (!header) return { ok: false, reason: "malformed" };
  const parts: Record<string, string> = {};
  for (const p of header.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isInteger(t) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "malformed" };

  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - t) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return { ok: false, reason: "expired" };

  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export class SignatureVerificationError extends Error {
  readonly reason: "malformed" | "expired" | "mismatch";
  constructor(reason: "malformed" | "expired" | "mismatch") {
    super(`Webhook signature verification failed (${reason}).`);
    this.name = "SignatureVerificationError";
    this.reason = reason;
  }
}

/** Verifies the signature and returns the parsed payload, or throws SignatureVerificationError. Never parses an unverified body. */
export function constructEvent(secret: string, rawBody: string | Uint8Array, header: string | null | undefined, opts?: VerifyOptions): WebhookPayload {
  const r = verifyWebhookSignature(secret, rawBody, header, opts);
  if (!r.ok) throw new SignatureVerificationError(r.reason);
  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
  return JSON.parse(body) as WebhookPayload;
}
