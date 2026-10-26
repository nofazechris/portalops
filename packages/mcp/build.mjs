// Compiles the MCP server (plus the SDK and example catalog it imports) to plain JS in dist/, so `npx @portalops/mcp` runs on Node 20+
// without TypeScript support. The example artifacts are data files the catalog reads at runtime, so they are copied next to it.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
rmSync(resolve(here, "dist"), { recursive: true, force: true });
const tsc = resolve(here, "../../node_modules/typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", resolve(here, "tsconfig.build.json")], { stdio: "inherit" });
mkdirSync(resolve(here, "dist/examples"), { recursive: true });
for (const f of ["generated.json", "featured.json"]) cpSync(resolve(here, "../examples", f), resolve(here, "dist/examples", f));
console.log("built packages/mcp/dist");
