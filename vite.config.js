import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// The production build gets a strict CSP. It is not applied in dev because Vite's HMR needs inline scripts and websockets.
// frame-ancestors cannot be set from a <meta> tag: also send  Content-Security-Policy: frame-ancestors 'none'  from the web server.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const cspForBuild = {
  name: "portalops-csp",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
};

// /api is proxied to the PortalOps API so the session cookie is same-origin (no CORS, SameSite=Strict works).
export default defineConfig({
  plugins: [react(), cspForBuild],
  server: { port: 5173, headers: securityHeaders, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } } },
  preview: { headers: securityHeaders },
});
