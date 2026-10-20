import type { IncomingMessage, ServerResponse } from "node:http";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body (undefined for GET/DELETE or empty bodies). */
  body: unknown;
  userId: string | null;
  ip: string;
  /** Raw session token from the cookie, if any (needed by logout). */
  sessionToken: string | null;
  /** Exact request body bytes as a string. Needed to verify webhook signatures over the raw payload. */
  rawBody: string;
  /** Set when the request authenticated with an API key instead of a session. Keys are limited to one project. */
  apiKey: { id: string; projectId: string; scope: "read" | "write" } | null;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  auth: "required" | "optional" | "none";
  /** When set, the body is NOT parsed as JSON (handler gets rawBody) and is capped at maxBytes. */
  raw?: { maxBytes: number };
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, auth: Route["auth"] = "required", raw?: Route["raw"]): void {
    const keys: string[] = [];
    const pattern = path.replace(/:([A-Za-z]+)/g, (_m, k: string) => {
      keys.push(k);
      return "([A-Za-z0-9_-]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler, auth, raw });
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      if (route.method !== method) { allowed.add(route.method); continue; }
      return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]])) };
    }
    return allowed.size ? { allowed: [...allowed] } : null;
  }
}

/** Fixed-window counter. Good enough for a single-process deployment; swap for Redis when scaling out. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Returns seconds until retry when the caller is over the limit, otherwise 0. */
  hit(key: string): number {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return 0;
    }
    cur.count++;
    return cur.count > this.limit ? Math.max(1, Math.ceil((cur.resetAt - t) / 1000)) : 0;
  }
}

export const MAX_BODY_BYTES = 1_000_000;

/** Reads the body as a UTF-8 string, enforcing the size cap on both the declared length and the bytes actually received. */
export async function readRaw(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw new ApiError(413, "payload_too_large", "Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new ApiError(413, "payload_too_large", "Request body is too large.");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJsonBody(raw: string, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  if (!/^application\/json\b/i.test(String(contentType ?? ""))) throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json.");
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

/**
 * Client IP for rate limiting. Behind a reverse proxy the socket address is the proxy's, so every user would share one
 * bucket. With trustedProxyHops = N we take the Nth address from the right of X-Forwarded-For (the one our own proxy
 * appended). With 0 hops the header is ignored entirely, so it cannot be spoofed to dodge limits.
 */
export function clientIp(req: IncomingMessage, trustedProxyHops: number): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (trustedProxyHops <= 0) return socketIp;
  const parts = String(req.headers["x-forwarded-for"] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= trustedProxyHops ? parts[parts.length - trustedProxyHops] : socketIp;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string | string[]> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
