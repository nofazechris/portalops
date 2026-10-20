import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";

/** Test helper: the compiled PortalQuest ABI. Run `npm run contract:compile` first. */
export function loadArtifactAbi(): Abi {
  const p = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts/evm/artifacts/PortalQuest.json");
  return JSON.parse(readFileSync(p, "utf8")).abi as Abi;
}
