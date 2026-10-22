import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPortalOpsMcpServer } from "../../packages/mcp/server.ts";

// Documentation that drifts from the code is worse than none, so the parts that CAN be checked mechanically are.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function walk(dir: string, accept: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

test("docs: the API reference documents every route, and nothing that no longer exists", () => {
  const routes = new Set([...read("apps/api/app.ts").matchAll(/router\.add\("([A-Z]+)", "(\/api\/v1[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`));
  const documented = new Set([...read("docs/reference/api.md").matchAll(/^### ([A-Z]+) (\/api\/v1\S*)$/gm)].map((m) => `${m[1]} ${m[2]}`));
  assert.ok(routes.size > 40, "found the routes");
  assert.deepEqual([...routes].filter((r) => !documented.has(r)).sort(), [], "routes missing from docs/reference/api.md");
  assert.deepEqual([...documented].filter((r) => !routes.has(r)).sort(), [], "documented routes that do not exist");
});

test("docs: every environment variable the code reads is in the configuration reference", () => {
  const files = [...walk(resolve(ROOT, "apps"), (f) => f.endsWith(".ts")), ...walk(resolve(ROOT, "packages"), (f) => f.endsWith(".ts")), resolve(ROOT, "scripts/start-all.mjs"), resolve(ROOT, "scripts/db-check.mjs"), resolve(ROOT, "scripts/backup-db.mjs")];
  const used = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
  const doc = read("docs/reference/environment.md");
  const missing = [...used].filter((v) => !doc.includes("`" + v + "`")).sort();
  assert.ok(used.size > 10);
  assert.deepEqual(missing, [], "environment variables missing from docs/reference/environment.md");
});

test("docs: every Claude tool is documented", async () => {
  const server = createPortalOpsMcpServer({ portal: null, cwd: ROOT });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "docs-check", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close(); await server.close();
  const doc = read("docs/guides/claude-setup.md");
  assert.deepEqual(names.filter((n) => !doc.includes("`" + n + "`")), [], "tools missing from docs/guides/claude-setup.md");
});

// ---- links ------------------------------------------------------------------------------------------------------
/** GitHub-style heading anchor. */
const slug = (h: string) => h.trim().toLowerCase().replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const anchorsOf = (md: string) => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    const m = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const s = slug(m[1]); const n = seen.get(s) ?? 0; seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  return out;
};

test("docs: every relative link and heading anchor in the markdown resolves", () => {
  const files = [...walk(resolve(ROOT, "docs"), (f) => f.endsWith(".md")), resolve(ROOT, "README.md"), resolve(ROOT, "packages/sdk/README.md")];
  const problems: string[] = [];
  for (const f of files) {
    const md = readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, ""); // links inside code samples are not links
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#$)/.test(target)) continue;
      const [pathPart, anchor] = target.split("#");
      const resolved = pathPart ? resolve(dirname(f), pathPart) : f;
      const where = `${relative(ROOT, f)} → ${target}`;
      if (!existsSync(resolved)) { problems.push(`${where} (no such file)`); continue; }
      if (anchor && resolved.endsWith(".md") && !anchorsOf(readFileSync(resolved, "utf8")).has(anchor)) problems.push(`${where} (no such heading)`);
    }
  }
  assert.deepEqual(problems, []);
});

test("docs site: the Docker build stage receives the markdown it bundles (otherwise every docs page fails to load in production)", () => {
  const docker = read("Dockerfile");
  const buildStage = docker.slice(docker.indexOf("AS build"), docker.indexOf("AS runtime"));
  assert.match(buildStage, /^COPY docs \.\/docs$/m, "the build stage copies docs/");
  const ignore = read(".dockerignore").split(/\r?\n/).map((l) => l.trim());
  assert.ok(!ignore.includes("docs") && !ignore.includes("docs/") && !ignore.includes("/docs") && !ignore.includes("**/*.md"), ".dockerignore must not exclude docs/");
});
