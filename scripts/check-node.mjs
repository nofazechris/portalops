#!/usr/bin/env node
// Runs before `npm test` (the "pretest" script). The tests and the servers are TypeScript run directly by Node, which needs Node 24 (or 22.18+).
// A reviewer on an older Node would otherwise see a cryptic syntax error; this says what to do instead.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`\nPortalOps needs Node 24 or newer (it runs TypeScript directly). You have Node ${process.versions.node}.\n` +
    "  Install it from https://nodejs.org, or with nvm:   nvm install 24 && nvm use 24\n" +
    "  (the repository's .nvmrc says 24, so `nvm use` alone is enough once it is installed)\n");
  process.exit(1);
}
if (major < 24) console.warn(`Note: PortalOps is developed and tested on Node 24; you have ${process.versions.node}. It should work, but CI runs 24.`);
