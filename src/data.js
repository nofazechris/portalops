// Static, non-chain content only: navigation, the product tour, API reference and code samples.
// Nothing here pretends to be live data; all events, deliveries and metrics come from the API.

export const LANDING_URL = "/";
export const DOCS_URL = "/docs";

export const tourSteps = [
  { target: "overview", title: "Your infrastructure at a glance", body: "Overview shows events received, deliveries and failures, with live network status for your project." },
  { target: "events", title: "Every event, decoded and stored", body: "Browse captured events and open any one to inspect its payload, chain references and delivery history." },
  { target: "webhooks", title: "Deliver events anywhere", body: "Point webhooks at your backend, with signing, retries and a full delivery history." },
  { target: "replay", title: "Recover failed deliveries", body: "When a destination fails, replay the stored event exactly as it was captured. No chain state to rebuild." },
  { target: "automations", title: "Route events with rules", body: "Send events that match a name or contract to a specific webhook." },
  { target: "logs", title: "Follow the pipeline", body: "A searchable log of ingestion, deliveries, retries and replays." },
  { target: "apisdk", title: "Build on the API", body: "The REST API behind this dashboard, plus how to verify webhook signatures." },
  { target: "aisetup", title: "Or let your coding agent set it up", body: "Copy a project-specific prompt for Claude Code or Codex that wires up webhook handling." },
];

export const navGroups = [
  { label: null, items: [{ id: "overview", label: "Overview", icon: "◫" }, { id: "setup", label: "Guided setup", icon: "▸" }] },
  { label: "Workspace", items: [
    { id: "events", label: "Events", icon: "⇥" },
    { id: "webhooks", label: "Webhooks", icon: "↗" },
    { id: "automations", label: "Automations", icon: "⌁" },
    { id: "contracts", label: "Contracts", icon: "◈" },
  ] },
  { label: "Operations", items: [
    { id: "replay", label: "Replay", icon: "↺" },
    { id: "logs", label: "Logs", icon: "≣" },
    { id: "diagnostics", label: "Diagnostics", icon: "✦" },
  ] },
  { label: "Developer", items: [
    { id: "aisetup", label: "AI Setup", icon: "✧" },
    { id: "apisdk", label: "API/SDK", icon: "{ }" },
    { id: "docs", label: "Documentation", icon: "⧉", href: DOCS_URL },
  ] },
  { label: "Project", items: [{ id: "settings", label: "Settings", icon: "⚙" }] },
];

export const validScreens = ["overview", "setup", "events", "webhooks", "replay", "logs", "contracts", "automations", "diagnostics", "apisdk", "aisetup", "settings"];

/** Implemented REST endpoints (all under /api/v1). */
export const apiEndpoints = [
  { method: "POST", color: "#b9a7ff", path: "/auth/signup · /auth/login · /auth/logout" },
  { method: "GET", color: "#6ee7a8", path: "/projects" },
  { method: "POST", color: "#b9a7ff", path: "/projects" },
  { method: "GET", color: "#6ee7a8", path: "/projects/:projectId/overview" },
  { method: "GET", color: "#6ee7a8", path: "/projects/:projectId/network/status" },
  { method: "POST", color: "#b9a7ff", path: "/projects/:projectId/network/test" },
  { method: "GET", color: "#6ee7a8", path: "/projects/:projectId/events?q=&contract=&delivery=&limit=&offset=" },
  { method: "GET", color: "#6ee7a8", path: "/events/:eventId" },
  { method: "POST", color: "#b9a7ff", path: "/events/:eventId/replay" },
  { method: "GET", color: "#6ee7a8", path: "/projects/:projectId/contracts" },
  { method: "POST", color: "#b9a7ff", path: "/projects/:projectId/contracts" },
  { method: "POST", color: "#b9a7ff", path: "/contracts/:contractId/test" },
  { method: "GET", color: "#6ee7a8", path: "/projects/:projectId/webhooks" },
  { method: "POST", color: "#b9a7ff", path: "/projects/:projectId/webhooks" },
  { method: "PATCH", color: "#e9c46a", path: "/webhooks/:webhookId" },
  { method: "DELETE", color: "#f08a86", path: "/webhooks/:webhookId" },
  { method: "POST", color: "#b9a7ff", path: "/webhooks/:webhookId/test · /rotate-secret" },
  { method: "GET", color: "#6ee7a8", path: "/webhooks/:webhookId/deliveries" },
  { method: "GET", color: "#6ee7a8", path: "/projects/:projectId/logs" },
  { method: "POST", color: "#b9a7ff", path: "/projects/:projectId/api-keys (session only)" },
  { method: "DELETE", color: "#f08a86", path: "/api-keys/:keyId (session only)" },
  { method: "GET", color: "#6ee7a8", path: "/projects/:projectId/automations" },
  { method: "POST", color: "#b9a7ff", path: "/projects/:projectId/automations" },
];

/** Verification code for webhook consumers. Matches packages/webhook-engine/sign.ts exactly. */
export const signatureSnippet = `import { createHmac, timingSafeEqual } from "node:crypto";

// Header:  PortalOps-Signature: t=<unix seconds>,v1=<hex hmac>
// Signed:  HMAC_SHA256(secret, \`\${t}.\${rawBody}\`)   (use the RAW request body, not re-serialised JSON)
export function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false; // reject stale requests
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Also sent: PortalOps-Event-Id (stable per event; use it as your idempotency key) and PortalOps-Delivery-Id.`;

/** Matches packages/sdk (tested against the real API). */
export const sdkSnippet = `import { PortalOps, constructEvent } from "@portalops/sdk";

const portal = new PortalOps({
  apiKey: process.env.PORTALOPS_API_KEY,   // pops_… (server-side only)
  baseUrl: process.env.PORTALOPS_API_URL,
});

// newest events, and only the ones the network has finalized
const { items } = await portal.events.list({ finality: "finalized", limit: 20 });

// re-send a stored event to your endpoints (the chain is untouched)
await portal.events.replay(items[0].id);

// in your webhook receiver: verify the raw body, then use the typed event
const event = constructEvent(process.env.PORTALOPS_WEBHOOK_SECRET, rawBody, req.headers["portalops-signature"]);`;

export const docsEndpoints = apiEndpoints;
