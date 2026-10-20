import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Secrets that exist only for the contract deploy/interact scripts. The API and worker load the same .env file, but they
 * have no use for these, and anything in process.env is visible to every dependency and child process in that process.
 * Least privilege: drop them right after loading.
 */
export const SCRIPT_ONLY_SECRETS = ["PORTALDOT_DEPLOYER_PRIVATE_KEY", "PORTALDOT_PARTICIPANT_PRIVATE_KEY"] as const;

export function scrubScriptSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of SCRIPT_ONLY_SECRETS) {
    if (env[name] !== undefined) { delete env[name]; removed.push(name); }
  }
  return removed;
}

/** Loads <root>/.env if present (existing environment variables win), then scrubs script-only secrets. */
export function loadServiceEnv(root: string): void {
  const file = resolve(root, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
  scrubScriptSecrets();
}
