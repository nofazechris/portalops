// Secret scan: stops sensitive files and values from ever reaching git or GitHub.
//
//   npm run security:scan                 scans everything `git add -A` would commit (tracked + untracked, minus ignored)
//   npm run security:scan -- --history    also scans every commit already in the repository
//   node scripts/security-scan.mjs --install-hook   installs pre-commit and pre-push hooks that run it
//
// What it checks
//   1. FILE NAMES: no env file of ANY kind (.env, .env.production, .env.example, *.env), no keys/certificates, no databases, no backups.
//   2. CONTENT: private-key blocks, connection strings with a real password, cloud/API tokens, webhook secrets, API keys,
//      long hex values assigned to secret-looking names.
//   3. YOUR OWN VALUES: if a local .env exists, every value in it is searched for in the files and the history, so a real secret
//      is caught even when it matches no known pattern (this is the check that catches a pasted Neon password).
// It never prints a matched value: only the file, line and rule. Exit code 1 means "do not push".
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const git = (a, opts = {}) => spawnSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

if (args.has("--install-hook")) {
  const hooks = resolve(ROOT, ".git/hooks");
  if (!existsSync(hooks)) { console.error("not a git repository (no .git/hooks)"); process.exit(1); }
  const body = (extra) => `#!/bin/sh\n# installed by scripts/security-scan.mjs: blocks secrets from being committed or pushed\nnode scripts/security-scan.mjs ${extra} || { echo "security scan failed: nothing was committed/pushed"; exit 1; }\n`;
  writeFileSync(resolve(hooks, "pre-commit"), body(""));
  writeFileSync(resolve(hooks, "pre-push"), body("--history"));
  for (const h of ["pre-commit", "pre-push"]) try { chmodSync(resolve(hooks, h), 0o755); } catch { /* windows */ }
  console.log("installed .git/hooks/pre-commit and .git/hooks/pre-push");
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------ rules
const FORBIDDEN_NAME = [
  [/(^|\/)\.env($|[./])/i, "env file"],
  [/(^|\/)[^/]*\.env$/i, "env file"],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, "key/certificate file"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, "ssh key"],
  [/\.(sqlite|sqlite3|db)(-wal|-shm)?$/i, "database file"],
  [/(^|\/)(data|backups|\.claude)\//, "local data / backup / tool-settings folder"],
  [/(^|\/)\.mcp\.json$/i, "MCP config (may hold an API key)"],
  [/(^|\/)(credentials|secrets?)\.(json|ya?ml|txt)$/i, "credentials file"],
];

/** Applied to "user:password" only (never the host), so a real-looking password on an example.com host is still caught. */
const PLACEHOLDER = /(PASSWORD|CHANGE_?ME|^USER:|YOUR|EXAMPLE|xxxx|\*{3,}|\[hidden\]|\[redacted\]|ci-only|\$\{|<[^>]+>|^[^:]*:(pass|secret|pops|p|smoke-pw|test)$)/i;

const CONTENT = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Neon password", /\bnpg_[A-Za-z0-9]{10,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["provider secret key", /\bsk-[A-Za-z0-9_-]{32,}/],
  ["PortalOps API key", /\bpops_[A-Za-z0-9_-]{30,}/],
  ["webhook signing secret", /\bwhsec_[0-9a-fA-F]{24,}/],
  ["secret-looking value", /(PRIVATE_KEY|SECRET|PASSWORD|TOKEN|API_KEY|ENCRYPTION_KEY)["']?\s*[=:]\s*["']?(0x)?[0-9a-fA-F]{40,}/i],
];
const URL_WITH_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/([^:@/\s'"`]+):([^@/\s'"`]{6,})@([^/\s'"`]+)/gi;

const findings = [];
const add = (where, rule) => findings.push({ where, rule });

function scanText(where, text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000) continue;
    for (const [rule, re] of CONTENT) if (re.test(line)) add(`${where}:${i + 1}`, rule);
    for (const m of line.matchAll(URL_WITH_PASSWORD)) if (!PLACEHOLDER.test(`${m[1]}:${m[2]}`)) add(`${where}:${i + 1}`, "connection string with a password");
  }
}

// ------------------------------------------------------------------------------------------------ your own values
/** An http(s)/ws(s) URL with no embedded username or password is a public setting (an RPC address), not a secret. */
function isPublicUrl(v) {
  try { const u = new URL(v); return /^(https?|wss?):$/.test(u.protocol) && !u.username && !u.password; } catch { return false; }
}
function localSecretValues() {
  const f = resolve(ROOT, ".env");
  if (!existsSync(f)) return [];
  const vals = new Set();
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = m[1].trim().replace(/^["']|["']$/g, "");
    // public settings are not secrets; everything else long enough to be unique is treated as one
    if (v.length >= 12 && !isPublicUrl(v) && !/^(true|false)$/i.test(v)) vals.add(v);
    // the password inside a URL is the part that must never leak, even if the rest is public
    for (const u of v.matchAll(URL_WITH_PASSWORD)) if (u[2].length >= 6) vals.add(decodeURIComponent(u[2]));
  }
  return [...vals];
}

// ------------------------------------------------------------------------------------------------ working tree
const list = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
if (list.status !== 0) { console.error("git ls-files failed: is this a git repository?"); process.exit(2); }
const files = [...new Set(list.stdout.split("\0").filter(Boolean))].filter((f) => existsSync(resolve(ROOT, f)));
const secrets = localSecretValues();

for (const f of files) {
  for (const [re, why] of FORBIDDEN_NAME) if (re.test(f)) add(f, `forbidden file (${why})`);
  const p = resolve(ROOT, f);
  let size = 0; try { size = statSync(p).size; } catch { continue; }
  if (size > 3_000_000 || /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|pdf|zip|gz)$/i.test(f)) continue;
  const buf = readFileSync(p);
  if (buf.includes(0)) continue; // binary
  const text = buf.toString("utf8");
  scanText(f, text);
  for (const s of secrets) if (text.includes(s)) add(f, "contains a value from your local .env");
}

// ------------------------------------------------------------------------------------------------ history
if (args.has("--history")) {
  const commits = git(["rev-list", "--all"]).stdout.split("\n").filter(Boolean);
  for (const c of commits) {
    const names = git(["ls-tree", "-r", "--name-only", c]).stdout.split("\n").filter(Boolean);
    for (const n of names) for (const [re, why] of FORBIDDEN_NAME) if (re.test(n)) add(`${c.slice(0, 8)}:${n}`, `forbidden file in history (${why})`);
  }
  const log = git(["log", "--all", "-p", "--no-color", "--format=commit %h"]);
  let commit = "?"; let file = "?";
  for (const line of log.stdout.split(/\r?\n/)) {
    if (line.startsWith("commit ")) { commit = line.slice(7); continue; }
    if (line.startsWith("+++ ")) { file = line.slice(6); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const where = `${commit}:${file}`;
    for (const [rule, re] of CONTENT) if (re.test(line)) add(where, `${rule} (history)`);
    for (const m of line.matchAll(URL_WITH_PASSWORD)) if (!PLACEHOLDER.test(`${m[1]}:${m[2]}`)) add(where, "connection string with a password (history)");
    for (const s of secrets) if (line.includes(s)) add(where, "contains a value from your local .env (history)");
  }
}

// ------------------------------------------------------------------------------------------------ report
const seen = new Set();
const unique = findings.filter((f) => { const k = f.where + f.rule; if (seen.has(k)) return false; seen.add(k); return true; });
console.log(`security scan: ${files.length} files${args.has("--history") ? " + full history" : ""}, ${secrets.length} local secret value(s) checked`);
if (unique.length) {
  console.error(`\n${unique.length} problem(s). Values are never printed.`);
  for (const f of unique) console.error(`  ✗ ${f.where}  ${f.rule}`);
  console.error("\nDo NOT push. Remove the file or value, then rotate any credential that was exposed.");
  process.exit(1);
}
console.log("clean: no env files, key files, databases, secrets or local .env values found.");
