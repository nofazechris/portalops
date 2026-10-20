import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

/**
 * Where a webhook signing secret goes. The secret is shown by the API exactly once, so the MCP server writes it straight to a
 * local env file and only ever reports a masked preview back to the model: the secret never enters the conversation.
 */
export interface SecretTarget {
  /** Absolute path of the env file. */
  path: string;
  /** Path as the user wrote it, relative to the working directory. */
  display: string;
}

/** Only `.env`-style files inside the working directory are accepted, so a prompt-injected path cannot write elsewhere. */
export function resolveSecretFile(cwd: string, requested: string | undefined): SecretTarget {
  const file = requested?.trim() || ".env.portalops";
  const path = resolve(cwd, file);
  const rel = relative(cwd, path);
  if (rel === "" || rel.startsWith("..") || resolve(cwd, rel) !== path || rel.split(sep).includes("..")) {
    throw new Error("The secrets file must be inside the current project directory.");
  }
  if (!/^\.env(\.[A-Za-z0-9_-]+)*$/.test(basename(path))) {
    throw new Error('The secrets file name must look like ".env" or ".env.portalops" (so it is covered by the usual git-ignore rules).');
  }
  return { path, display: rel.split(sep).join("/") };
}

/** Creates the file (private to the user) if needed and proves it can be written, BEFORE the one-time secret exists. */
export function prepareSecretFile(target: SecretTarget): void {
  const fd = openSync(target.path, "a", 0o600);
  closeSync(fd);
}

/** True when a line of the project's .gitignore plausibly covers the file. Best effort: a missing .gitignore returns false. */
export function isGitIgnored(cwd: string, target: SecretTarget): boolean {
  const gi = resolve(cwd, ".gitignore");
  if (!existsSync(gi)) return false;
  const name = basename(target.path);
  return readFileSync(gi, "utf8").split(/\r?\n/).map((l) => l.trim()).some((l) => {
    if (!l || l.startsWith("#") || l.startsWith("!")) return false;
    const p = l.replace(/^\//, "");
    if (p === name || p === target.display) return true;
    if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
    return false;
  });
}

const maskSecret = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

/** Appends `NAME=secret`. If `NAME` already exists in the file, a suffix derived from the webhook id keeps both. */
export function saveSecret(target: SecretTarget, webhookId: string, secret: string): { variable: string; preview: string } {
  const existing = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  let variable = "PORTALOPS_WEBHOOK_SECRET";
  if (new RegExp(`^${variable}=`, "m").test(existing)) variable += "_" + webhookId.replace(/^[a-z]+_/i, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  const fd = openSync(target.path, "a", 0o600);
  try {
    writeSync(fd, `${existing && !existing.endsWith("\n") ? "\n" : ""}${variable}=${secret}\n`);
  } finally {
    closeSync(fd);
  }
  return { variable, preview: maskSecret(secret) };
}
