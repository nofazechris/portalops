// Thin client for the PortalOps REST API. The session lives in an HttpOnly cookie, so no token ever touches JS.
const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the PortalOps API. Is it running?");
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json?.data;
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
};

export const api = {
  publicStatus: () => request("GET", "/public/status"),
  examples: () => request("GET", "/examples"),
  example: (id) => request("GET", `/examples/${encodeURIComponent(id)}`),

  me: () => request("GET", "/auth/me"),
  signup: (email, password) => request("POST", "/auth/signup", { email, password }),
  login: (email, password) => request("POST", "/auth/login", { email, password }),
  logout: () => request("POST", "/auth/logout", {}),
  authProviders: () => request("GET", "/auth/providers"),
  verifyEmail: (token) => request("POST", "/auth/verify-email", { token }),
  resendVerification: () => request("POST", "/auth/resend-verification", {}),
  forgotPassword: (email) => request("POST", "/auth/forgot-password", { email }),
  resetPassword: (token, password) => request("POST", "/auth/reset-password", { token, password }),

  projects: () => request("GET", "/projects"),
  project: (id) => request("GET", `/projects/${id}`),
  createProject: (body) => request("POST", "/projects", body),
  updateProject: (id, body) => request("PATCH", `/projects/${id}`, body),

  overview: (pid) => request("GET", `/projects/${pid}/overview`),
  networkStatus: (pid) => request("GET", `/projects/${pid}/network/status`),
  testNetwork: (pid) => request("POST", `/projects/${pid}/network/test`, {}),

  events: (pid, params) => request("GET", `/projects/${pid}/events${qs(params)}`),
  event: (id) => request("GET", `/events/${id}`),
  replay: (eventId, endpointId) => request("POST", `/events/${eventId}/replay`, endpointId ? { endpointId } : {}),
  deliveries: (pid, params) => request("GET", `/projects/${pid}/deliveries${qs(params)}`),

  contracts: (pid) => request("GET", `/projects/${pid}/contracts`),
  addContract: (pid, body) => request("POST", `/projects/${pid}/contracts`, body),
  testContract: (id) => request("POST", `/contracts/${id}/test`, {}),

  webhooks: (pid) => request("GET", `/projects/${pid}/webhooks`),
  createWebhook: (pid, body) => request("POST", `/projects/${pid}/webhooks`, body),
  updateWebhook: (id, body) => request("PATCH", `/webhooks/${id}`, body),
  deleteWebhook: (id) => request("DELETE", `/webhooks/${id}`),
  rotateSecret: (id) => request("POST", `/webhooks/${id}/rotate-secret`, {}),
  testWebhook: (id) => request("POST", `/webhooks/${id}/test`, {}),
  receiver: (id) => request("GET", `/webhooks/${id}/receiver`),
  setReceiverMode: (id, mode) => request("PATCH", `/webhooks/${id}/receiver`, { mode }),
  webhookDeliveries: (id, params) => request("GET", `/webhooks/${id}/deliveries${qs(params)}`),

  apiKeys: (pid) => request("GET", `/projects/${pid}/api-keys`),
  createApiKey: (pid, body) => request("POST", `/projects/${pid}/api-keys`, body),
  revokeApiKey: (id) => request("DELETE", `/api-keys/${id}`),

  logs: (pid, limit = 200) => request("GET", `/projects/${pid}/logs${qs({ limit })}`),
  audit: (pid) => request("GET", `/projects/${pid}/audit`),

  automations: (pid) => request("GET", `/projects/${pid}/automations`),
  createAutomation: (pid, body) => request("POST", `/projects/${pid}/automations`, body),
  setAutomationEnabled: (id, enabled) => request("PATCH", `/automations/${id}`, { enabled }),
  deleteAutomation: (id) => request("DELETE", `/automations/${id}`),
};
