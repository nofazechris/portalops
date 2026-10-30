import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serves the built single-page app (Vite `dist/`) from the same process as the API, so one container serves everything.
 *
 *  - GET/HEAD only. Paths are decoded once, normalised, and must stay inside the root (no `..`, no NUL, no dotfiles).
 *  - A missing file WITH an extension is a real 404 (never an HTML page pretending to be a script). A missing path WITHOUT
 *    an extension is a client-side route (/docs, /auth, /app) and gets index.html.
 *  - Every response carries the security headers the meta-tag CSP cannot express (`frame-ancestors`, HSTS).
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json; charset=utf-8", ".pdf": "application/pdf",
};

/** The policy. `connectOrigins` are extra origins the page may call: only the public chain RPC, so a visitor's browser can check an event against the chain itself. */
export function buildCsp(connectOrigins: string[] = []): string {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    ["connect-src 'self'", ...connectOrigins].join(" "), "img-src 'self' data:", "base-uri 'none'", "form-action 'self'", "object-src 'none'", "frame-ancestors 'none'",
  ].join("; ");
}
export const CSP = buildCsp();

export interface StaticOptions {
  root: string;
  /** Send Strict-Transport-Security (only when the site is really served over https). */
  hsts?: boolean;
  /** Origins (https://host) the page may connect to besides itself. */
  connectOrigins?: string[];
}

export function createStaticHandler(opts: StaticOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const root = resolve(opts.root);
  const csp = buildCsp(opts.connectOrigins);

  const headers = (extra: Record<string, string | number>): Record<string, string | number> => ({
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...(opts.hsts ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
    ...extra,
  });

  const plain = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, headers({ "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) }));
    res.end(text);
  };

  /** Maps a URL pathname to a file inside root, or null if the path is unsafe. */
  function locate(pathname: string): string | null {
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    const rel = normalize(decoded).replace(/^[/\\]+/, "");
    if (rel.split(sep).some((seg) => seg === ".." || seg.startsWith("."))) return null; // traversal and dotfiles (.env, .git, …)
    const full = join(root, rel);
    return full === root || full.startsWith(root + sep) ? full : null;
  }

  async function send(req: IncomingMessage, res: ServerResponse, file: string, size: number, immutable: boolean) {
    res.writeHead(200, headers({
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": size,
      // Vite fingerprints everything under /assets, so it can be cached forever; index.html must always be revalidated.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    }));
    if (req.method === "HEAD") { res.end(); return; }
    await new Promise<void>((done) => {
      const s = createReadStream(file);
      s.on("error", () => { res.destroy(); done(); });
      s.on("close", () => done());
      s.pipe(res);
    });
  }

  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("allow", "GET, HEAD"); plain(res, 405, "Method not allowed"); return true; }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const target = locate(pathname);
    if (!target) { plain(res, 404, "Not found"); return true; }

    try {
      const info = await stat(target);
      if (info.isFile()) { await send(req, res, target, info.size, pathname.startsWith("/assets/")); return true; }
      if (info.isDirectory()) {
        const index = join(target, "index.html");
        const idx = await stat(index).catch(() => null);
        if (idx?.isFile()) { await send(req, res, index, idx.size, false); return true; }
      }
    } catch { /* not found: fall through */ }

    // Missing file: a path with an extension is a genuine 404; otherwise it is an SPA route.
    if (extname(pathname)) { plain(res, 404, "Not found"); return true; }
    const index = join(root, "index.html");
    const idx = await stat(index).catch(() => null);
    if (!idx?.isFile()) { plain(res, 404, "The web app has not been built (run `npm run build`)."); return true; }
    await send(req, res, index, idx.size, false);
    return true;
  };
}
