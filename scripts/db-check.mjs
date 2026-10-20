// Checks that PortalOps can use the configured database, and tells you what to fix if not.
//
//   npm run db:check
//
// Reads DATABASE_URL from .env (or the environment). Never prints the password. It connects, applies the schema (idempotent:
// safe on an existing database), does a write/read/delete round trip inside a rolled-back transaction, and reports latency.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

const { describeDatabase, openStore } = await import("../packages/database/store.ts");

const url = (process.env.DATABASE_URL || "").trim();
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

if (!url) {
  console.log("DATABASE_URL is empty: PortalOps will use local SQLite (PORTALOPS_DB_PATH).");
  console.log("To use Neon or another PostgreSQL, put the connection string in .env as DATABASE_URL=postgres://… (never in chat).");
  process.exit(0);
}
if (!/^postgres(ql)?:\/\//i.test(url)) {
  console.log(`DATABASE_URL is not a postgres:// URL, so it is treated as a SQLite path: ${url}`);
  process.exit(0);
}

console.log(`Checking ${describeDatabase(url)}`);
let host = "";
try { host = new URL(url).hostname; } catch { bad("DATABASE_URL could not be parsed. Expected postgres://user:password@host/dbname?sslmode=require"); process.exit(1); }

if (/-pooler\./.test(host)) warn("This is a pooled (pgbouncer) endpoint. It works, but the DIRECT endpoint (same host without \"-pooler\") is the safer choice for a long-running API and worker, which already pool connections themselves.");
if (!/sslmode=(require|verify-ca|verify-full)/.test(url) && !/^(localhost|127\.|::1)/.test(host)) warn("No sslmode=require in the URL. Remote databases should use TLS.");

const t0 = Date.now();
let store;
try {
  store = await openStore(url, { max: 2 });
} catch (e) {
  bad(`Could not connect or apply the schema: ${e.message}`);
  if (/password|authentication/i.test(e.message)) console.error("    Check the user and password in DATABASE_URL (copy the string again from the Neon dashboard).");
  if (/ENOTFOUND|EAI_AGAIN/.test(e.message)) console.error("    The host name does not resolve. Check for a typo.");
  if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message)) console.error("    The server did not answer. A suspended Neon database can take a few seconds to wake: run this again.");
  process.exit(1);
}
ok(`connected and applied the schema in ${Date.now() - t0}ms`);

try {
  const [v] = await store.rawAll("SHOW server_version");
  ok(`PostgreSQL ${v.server_version}`);

  const lat = [];
  for (let i = 0; i < 5; i++) { const s = Date.now(); await store.rawAll("SELECT 1"); lat.push(Date.now() - s); }
  ok(`round trip ${Math.min(...lat)}–${Math.max(...lat)}ms (best of 5)`);

  const [{ n }] = await store.rawAll("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema()");
  ok(`${n} tables in schema "${(await store.rawAll("SELECT current_schema() AS s"))[0].s}"`);

  // write → read → roll back, so the check leaves nothing behind
  const marker = "dbcheck_" + Date.now();
  let readBack = null;
  try {
    await store.tx(async (s) => {
      await s.rawRun("INSERT INTO service_status (name, updated_at, detail) VALUES (?, ?, ?)", [marker, new Date().toISOString(), "ok"]);
      readBack = (await s.rawAll("SELECT detail FROM service_status WHERE name = ?", [marker]))[0]?.detail ?? null;
      throw new Error("rollback");
    });
  } catch (e) { if (e.message !== "rollback") throw e; }
  const after = await store.rawAll("SELECT detail FROM service_status WHERE name = ?", [marker]);
  if (readBack === "ok" && after.length === 0) ok("write, read and rollback all work");
  else bad(`round trip failed (read back: ${readBack}, left behind: ${after.length})`);

  const counts = {};
  for (const t of ["users", "projects", "events", "webhook_deliveries"]) counts[t] = Number((await store.rawAll(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
  console.log(`  · rows: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
} catch (e) {
  bad(e.message);
} finally {
  await store.close();
}
console.log(process.exitCode ? "\nNot ready. Fix the items marked ✗ and run it again." : "\nReady: start the API and worker with this DATABASE_URL.");
