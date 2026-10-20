// Runs the API (which also serves the web app) and the worker together in ONE container.
//
//   node --no-warnings=ExperimentalWarning scripts/start-all.mjs
//
// For hosts that give you a single service (Render, Fly, Railway…). They stay two separate processes, so they behave exactly as
// they do in docker-compose, they just share a container:
//   - the API is the main process: if it exits, the container exits and the platform restarts it
//   - the worker is restarted with backoff if it crashes, without taking the API down
//   - SIGTERM/SIGINT are forwarded to both so deploys shut down cleanly
// With PostgreSQL (DATABASE_URL) you can also run the worker as its own service; this script is only a convenience.
import { spawn } from "node:child_process";

const node = process.execPath;
const flags = ["--no-warnings=ExperimentalWarning"];
let stopping = false;

const log = (m) => console.log(`[start-all] ${m}`);
const api = spawn(node, [...flags, "apps/api/main.ts"], { stdio: "inherit", env: process.env });

let worker = null;
let backoff = 2_000;
let startedAt = 0;
function startWorker() {
  if (stopping) return;
  startedAt = Date.now();
  worker = spawn(node, [...flags, "apps/worker/main.ts"], { stdio: "inherit", env: process.env });
  worker.on("exit", (code, signal) => {
    if (stopping) return;
    if (Date.now() - startedAt > 60_000) backoff = 2_000; // it ran for a while: a fresh crash, not a crash loop
    log(`worker exited (${signal ?? "code " + code}); restarting in ${backoff / 1000}s`);
    setTimeout(startWorker, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
}
startWorker();

function shutdown(signal, code) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${signal})`);
  for (const p of [api, worker]) if (p && p.exitCode === null) p.kill("SIGTERM");
  const force = setTimeout(() => { for (const p of [api, worker]) if (p && p.exitCode === null) p.kill("SIGKILL"); process.exit(code ?? 1); }, 10_000);
  force.unref();
  const wait = (p) => (!p || p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.once("exit", r)));
  Promise.all([wait(api), wait(worker)]).then(() => process.exit(code ?? 0));
}

api.on("exit", (code, signal) => shutdown(`api exited: ${signal ?? "code " + code}`, code ?? 1));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));
