// Runs the whole test suite against a real PostgreSQL server.
//
//   npm run test:pg
//
// If TEST_DATABASE_URL is already set (a CI service container, your own server) that server is used as-is. Otherwise a throwaway
// PostgreSQL is started from the `embedded-postgres` dev dependency in a temp directory and removed afterwards.
// Each test gets its own schema on the server (see packages/database/testing.ts), so tests never see each other's data.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });

let server = null;
let dir = null;
let url = process.env.TEST_DATABASE_URL;

if (!url) {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  dir = mkdtempSync(join(tmpdir(), "portalops-pg-"));
  const port = await freePort();
  const password = randomBytes(12).toString("hex"); // throwaway server on loopback only
  server = new EmbeddedPostgres({ databaseDir: join(dir, "data"), port, user: "pops", password, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  await server.createDatabase("pops_test");
  url = `postgres://pops:${password}@127.0.0.1:${port}/pops_test`;
  console.log(`started a throwaway PostgreSQL on 127.0.0.1:${port}`);
}

const cleanup = async () => {
  if (server) { try { await server.stop(); } catch { /* already gone */ } }
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

const args = ["--test", "--no-warnings=ExperimentalWarning", ...process.argv.slice(2)];
if (!process.argv.slice(2).length) args.push("packages/**/*.test.ts", "apps/**/*.test.ts");

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, TEST_DB: "postgres", TEST_DATABASE_URL: url } });
  child.on("exit", (c) => resolve(c ?? 1));
});
await cleanup();
process.exit(code);
