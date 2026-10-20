// Consistent online backup of the PortalOps SQLite database (safe while the API and worker are running).
//
//   npm run db:backup                         -> backups/portalops-<timestamp>.sqlite
//   npm run db:backup -- /path/to/file.sqlite
//   PORTALOPS_DB_PATH=/data/portalops.sqlite node scripts/backup-db.mjs /backups/pops.sqlite
//
// Uses `VACUUM INTO`, which writes a transactionally consistent copy (including anything still in the WAL), then opens the
// copy and runs integrity checks before reporting success. It refuses to overwrite an existing file.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || "")) {
  console.error("backup failed: DATABASE_URL points at PostgreSQL. This script only backs up SQLite; use pg_dump (or your provider's snapshots).");
  process.exit(1);
}

const source = resolve(process.env.PORTALOPS_DB_PATH || resolve(ROOT, "data/portalops.sqlite"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = resolve(process.argv[2] || resolve(ROOT, `backups/portalops-${stamp}.sqlite`));

const fail = (msg) => { console.error(`backup failed: ${msg}`); process.exit(1); };
if (!existsSync(source)) fail(`database not found: ${source}`);
if (existsSync(dest)) fail(`refusing to overwrite existing file: ${dest}`);
if (dest === source) fail("destination is the source database");
mkdirSync(dirname(dest), { recursive: true });

const src = new DatabaseSync(source, { readOnly: true });
try {
  src.exec("PRAGMA busy_timeout = 10000");
  src.prepare("VACUUM INTO ?").run(dest);
} catch (e) {
  try { unlinkSync(dest); } catch { /* nothing written */ }
  fail(e instanceof Error ? e.message : String(e));
} finally {
  src.close();
}

// Verify the copy independently of the source.
const copy = new DatabaseSync(dest, { readOnly: true });
try {
  const integrity = copy.prepare("PRAGMA integrity_check").all();
  const fk = copy.prepare("PRAGMA foreign_key_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || fk.length) {
    unlinkSync(dest);
    fail(`the copy did not pass verification (integrity=${JSON.stringify(integrity)}, foreign_key_violations=${fk.length}); it was deleted`);
  }
  const n = (t) => copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(`backup ok: ${dest} (${(statSync(dest).size / 1024).toFixed(0)} KiB)`);
  console.log(`  verified: integrity ok · users ${n("users")} · projects ${n("projects")} · events ${n("events")} · deliveries ${n("webhook_deliveries")} · api keys ${n("api_keys")}`);
  console.log("  restore: stop the API and worker, replace the live database file with this copy (delete any -wal/-shm files beside it), start again.");
} finally {
  copy.close();
}
