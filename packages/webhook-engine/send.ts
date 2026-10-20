import http from "node:http";
import https from "node:https";
import type { AttemptOutcome } from "./retry.ts";
import { BlockedTargetError, validateWebhookUrl, type GuardOptions } from "./url-guard.ts";

export interface SendResult extends AttemptOutcome {
  durationMs: number;
  /** Truncated, control-character-free, credential-redacted response body. */
  sanitisedResponse: string | null;
}

export const MAX_RESPONSE_CAPTURE_BYTES = 2048;
export const MAX_RESPONSE_READ_BYTES = 64 * 1024;

const SENSITIVE = [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, /\bwhsec_[A-Za-z0-9_-]+/g, /((?:secret|password|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi];

export function sanitiseResponse(text: string): string {
  let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const re of SENSITIVE) out = out.replace(re, (_m, p1) => (typeof p1 === "string" ? p1 : "") + "[redacted]");
  return out.slice(0, MAX_RESPONSE_CAPTURE_BYTES);
}

/**
 * POSTs a body to a vetted webhook target. Connects to the pre-resolved address (DNS pinning),
 * never follows redirects (a 3xx is recorded as a non-success response), enforces a timeout and caps response size.
 */
export async function sendWebhook(
  targetUrl: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number; guard?: GuardOptions },
): Promise<SendResult> {
  const started = Date.now();
  const done = (r: Omit<SendResult, "durationMs">): SendResult => ({ ...r, durationMs: Date.now() - started });

  let target;
  try {
    target = await validateWebhookUrl(targetUrl, opts.guard);
  } catch (e) {
    const code = e instanceof BlockedTargetError ? e.code : "invalid_url";
    return done({ status: null, errorCode: code, sanitisedResponse: e instanceof Error ? e.message : String(e) });
  }

  const { url, address, family } = target;
  const lib = url.protocol === "https:" ? https : http;

  return new Promise<SendResult>((resolve) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "PortalOps-Webhooks/1.0" },
        timeout: opts.timeoutMs,
        // Pin the socket to the address we validated instead of resolving again.
        lookup: (_host, _o, cb) => (_o && (_o as { all?: boolean }).all ? (cb as unknown as (e: null, a: unknown) => void)(null, [{ address, family }]) : cb(null, address, family)),
        servername: url.hostname,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_READ_BYTES) {
            tooLarge = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () =>
          resolve(
            done({
              status: res.statusCode ?? null,
              errorCode: tooLarge ? "response_too_large" : null,
              sanitisedResponse: sanitiseResponse(Buffer.concat(chunks).toString("utf8")) || null,
            }),
          );
        res.on("end", finish);
        res.on("close", () => tooLarge && finish());
        res.on("error", () => finish());
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(done({ status: null, errorCode: "timeout", sanitisedResponse: null }));
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve(done({ status: null, errorCode: e.code ?? "network_error", sanitisedResponse: null })));
    req.end(body);
  });
}
