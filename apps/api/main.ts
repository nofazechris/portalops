// HTTP API server.   npm run api
import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvmAdapter } from "../../packages/chain-adapters/evm.ts";
import { createEmailSender } from "../../packages/email/index.ts";
import { describeDatabase, openStore } from "../../packages/database/store.ts";
import { parseKey } from "../../packages/database/secrets.ts";
import { createApp, type NetworkProbe } from "./app.ts";
import { loadServiceEnv } from "../../packages/config/env.ts";
import { installProcessDiagnostics } from "../../packages/config/diagnostics.ts";
import { createStaticHandler } from "./static.ts";
import { existsSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadServiceEnv(ROOT); // also drops the deploy-script private keys: this process never needs them

const RPC = process.env.PORTALDOT_EVM_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev";
const CHAIN_ID = Number(process.env.PORTALDOT_EVM_CHAIN_ID || 420420777);
const DB = process.env.PORTALOPS_DB_PATH || resolve(ROOT, "data/portalops.sqlite");
const PORT = Number(process.env.PORTALOPS_API_PORT || process.env.PORT || 8787); // $PORT is what most hosts inject
const PUBLIC_URL = process.env.PORTALOPS_PUBLIC_URL || "http://localhost:5173";
const NETWORK_ID = "portaldot-v3-testnet";
// Where the WORKER reaches this API; used for the built-in test receiver URL. Must be public https in production.
const API_PUBLIC_URL = process.env.PORTALOPS_API_PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const ALLOW_PRIVATE = process.env.PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS === "1";
const TRUSTED_PROXY_HOPS = Number(process.env.PORTALOPS_TRUSTED_PROXY_HOPS || 0);

// Safety interlock: private/loopback webhook targets are a local-development convenience. They are also the SSRF hole the
// guard exists to close, so refuse to run with them on when the app is configured as a public https deployment.
if (ALLOW_PRIVATE && (PUBLIC_URL.startsWith("https://") || API_PUBLIC_URL.startsWith("https://"))) {
  console.error("Refusing to start: PORTALOPS_ALLOW_PRIVATE_WEBHOOK_TARGETS=1 cannot be combined with an https public URL.");
  process.exit(1);
}

// DATABASE_URL=postgres://… selects PostgreSQL; otherwise SQLite at PORTALOPS_DB_PATH.
const DATABASE = process.env.DATABASE_URL || DB;
if (!/^postgres(ql)?:\/\//i.test(DATABASE)) mkdirSync(dirname(DB), { recursive: true });
const store = await openStore(DATABASE);

// Seed the public, read-only demo project once. It watches every log on the chain (undecoded) so the product is explorable pre-signup.
if (!await store.getPublicDemoProject()) {
  await store.createProject({ ownerId: null, name: "Public testnet explorer", description: "Read-only view of live Portaldot V3.0 testnet events.", networkId: NETWORK_ID, kind: "public_demo" });
}

// Seed the public, no-signup PLAYGROUND project once. Unlike the demo, visitors can add contracts and fire test deliveries
// (rate-limited, built-in receiver only); its webhook and pinned example contracts are set up lazily on first use by the API.
if (!await store.getPlaygroundProject()) {
  await store.createProject({ ownerId: null, name: "Playground", description: "No-signup sandbox: watch a contract and send a signed test delivery.", networkId: NETWORK_ID, kind: "playground" });
}

const chain = new EvmAdapter(RPC, CHAIN_ID, 10_000);
const network: NetworkProbe = {
  async check() {
    const t = Date.now();
    try {
      const head = await chain.getHead();
      let verified = false, reported: number | null = null;
      try { await chain.assertChain(); verified = true; reported = CHAIN_ID; } catch (e) { const m = /reports chain ID (\d+)/.exec(e instanceof Error ? e.message : ""); reported = m ? Number(m[1]) : null; }
      return { chainIdVerified: verified, reportedChainId: reported, headBlock: head.number, latencyMs: Date.now() - t, error: null };
    } catch (e) {
      return { chainIdVerified: false, reportedChainId: null, headBlock: null, latencyMs: Date.now() - t, error: e instanceof Error ? e.message : String(e) };
    }
  },
  getCode: (address) => chain.getCode(address),
};

const isHttps = PUBLIC_URL.startsWith("https://");
const handler = createApp({
  store,
  network,
  config: {
    networkId: NETWORK_ID,
    networkLabel: "Portaldot V3.0 Testnet",
    chainId: CHAIN_ID,
    encryptionKey: parseKey(process.env.WEBHOOK_ENCRYPTION_KEY),
    allowedOrigins: [PUBLIC_URL, "http://localhost:5173", "http://127.0.0.1:5173"],
    cookieSecure: isHttps,
    sessionTtlMs: 7 * 24 * 3600 * 1000,
    allowPrivateWebhookTargets: ALLOW_PRIVATE,
    receiverBaseUrl: API_PUBLIC_URL,
    trustedProxyHops: TRUSTED_PROXY_HOPS,
    maxProjectsPerUser: 20,
    publicUrl: PUBLIC_URL,
    // Account emails: Resend when RESEND_API_KEY is set, otherwise printed to this log (development only; never in production).
    email: createEmailSender(process.env, { production: isHttps }),
    github: process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET } : null,
  },
});

// Optionally serve the built web app from this process (one container = whole product). Off unless PORTALOPS_STATIC_DIR is set.
const STATIC_DIR = process.env.PORTALOPS_STATIC_DIR ? resolve(ROOT, process.env.PORTALOPS_STATIC_DIR) : null;
if (STATIC_DIR && !existsSync(resolve(STATIC_DIR, "index.html"))) console.error(`Warning: PORTALOPS_STATIC_DIR=${STATIC_DIR} has no index.html (did you run \`npm run build\`?)`);
const serveStatic = STATIC_DIR ? createStaticHandler({ root: STATIC_DIR, hsts: isHttps }) : null;
const HOST = process.env.PORTALOPS_API_HOST || "127.0.0.1"; // containers set 0.0.0.0 and sit behind a TLS-terminating proxy

const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
  if (serveStatic && !(req.url ?? "").startsWith("/api/")) { void serveStatic(req, res); return; }
  void handler(req, res);
});
// Slow-client (slowloris) limits. Node's defaults allow minutes.
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;
// Expired and long-revoked sessions are dead weight in the database.
setInterval(() => { store.purgeSessions().catch((e) => console.error("session purge failed:", e)); }, 3_600_000).unref();
server.listen(PORT, HOST, () => console.log(`PortalOps API on http://${HOST}:${PORT} · ${RPC} · db ${describeDatabase(DATABASE)}${STATIC_DIR ? " · serving web app" : ""}`));
installProcessDiagnostics("api", async () => { server.close(); await store.close(); });
