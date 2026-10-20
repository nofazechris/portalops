import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ARTIFACT_PATH = resolve(ROOT, "contracts/evm/artifacts/PortalQuest.json");
export const DEPLOYMENT_PATH = resolve(ROOT, "docs/architecture/deployment.json");
export const EVIDENCE_PATH = resolve(ROOT, "docs/architecture/evidence.json");

// Values in .env take effect unless already set in the shell.
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  rpcUrl: process.env.PORTALDOT_EVM_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev",
  chainId: Number(process.env.PORTALDOT_EVM_CHAIN_ID || 420420777),
  gasLimit: process.env.PORTALDOT_GAS_LIMIT ? BigInt(process.env.PORTALDOT_GAS_LIMIT) : undefined,
};

export const chain = defineChain({
  id: config.chainId,
  name: "Portaldot V3.0 Testnet",
  // The EVM view of tPOT; the native chain uses 14 decimals, so treat formatted amounts as indicative.
  nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 30_000 }) });

export function accountFromEnv(name, { required = true } = {}) {
  const raw = (process.env[name] || "").trim();
  if (!raw) {
    if (!required) return null;
    fail(
      `${name} is not set.\n` +
        `  Create ${envFile} (it is git-ignored) and add a THROWAWAY testnet key there (variable names: docs/reference/environment.md).\n` +
        `  Do not paste the key into chat or commit it.`,
    );
  }
  const key = raw.startsWith("0x") ? raw : "0x" + raw;
  // Never echo the value: report only that the format is wrong.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail(`${name} is set but is not 64 hex characters (value not shown).`);
  return privateKeyToAccount(key);
}

export const walletFor = (account) => createWalletClient({ account, chain, transport: http(config.rpcUrl, { timeout: 30_000 }) });

/** `--example quest|token|bounty` picks one of the catalog contracts (packages/examples); the default is PortalQuest. */
export const exampleId = (() => {
  const i = process.argv.indexOf("--example");
  return i === -1 ? null : (process.argv[i + 1] || "").trim();
})();

export function loadArtifact() {
  if (exampleId && exampleId !== "quest") {
    const file = resolve(ROOT, "packages/examples/generated.json");
    if (!existsSync(file)) fail("Example artifacts missing. Run: npm run examples:build");
    const g = JSON.parse(readFileSync(file, "utf8"));
    const c = g.contracts[exampleId];
    if (!c) fail(`Unknown example "${exampleId}". Available: ${Object.keys(g.contracts).join(", ")}`);
    return { contractName: c.name, compiler: g.compiler, abi: c.abi, bytecode: c.bytecode };
  }
  if (!existsSync(ARTIFACT_PATH)) fail("Contract artifact missing. Run: npm run contract:compile");
  return JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
}

/** Where the deployment record goes: PortalQuest keeps its historical path, other examples get their own file. */
export const deploymentPathFor = () => (exampleId && exampleId !== "quest" ? resolve(ROOT, `docs/architecture/deployment-${exampleId}.json`) : DEPLOYMENT_PATH);

export function loadDeployment() {
  const fromEnv = process.env.DEMO_CONTRACT_ADDRESS?.trim();
  if (fromEnv) return { contractAddress: fromEnv };
  if (!existsSync(DEPLOYMENT_PATH)) fail("No deployment found. Run: npm run contract:deploy -- --send");
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
}

export async function assertChain() {
  const id = await publicClient.getChainId();
  if (id !== config.chainId) fail(`RPC reports chain ID ${id}, expected ${config.chainId}. Refusing to continue.`);
  return id;
}

export const fmt = (wei) => `${formatEther(wei)} tPOT (${wei} wei)`;

export function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

export const hasFlag = (f) => process.argv.includes(f);
