import { useState } from "react";
import { Link } from "../router.jsx";
import { apiEndpoints as endpoints, signatureSnippet } from "../data.js";
import "./pages.css";

const sections = [
  { label: "Getting started", items: [["intro", "Introduction"], ["quickstart", "Quickstart"]] },
  { label: "Concepts", items: [["concepts", "Core concepts"]] },
  { label: "Guides", items: [["webhooks", "Webhooks & replay"]] },
  { label: "Reference", items: [["api", "API reference"]] },
];

const concepts = [
  { tag: "events", title: "Events", body: "Normalized records of on-chain activity, decoded from your contract's ABI and stored durably." },
  { tag: "webhooks", title: "Webhooks", body: "Signed HTTP deliveries to your endpoints, with retries, response timing and full history." },
  { tag: "replay", title: "Replay", body: "Re-deliver any stored event exactly as it happened — no reconstructing blockchain state." },
  { tag: "automations", title: "Automations", body: "When an event matches your conditions, trigger a webhook or action automatically." },
];

const Eyebrow = ({ children }) => <div className="mono-tag">{children}</div>;
const Card = ({ title, children }) => (
  <div className="card" style={{ borderRadius: 12 }}>
    <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
    <p style={{ fontSize: 13.5, color: "var(--muted)", margin: "7px 0 0", lineHeight: 1.5 }}>{children}</p>
  </div>
);

function Intro() {
  return (
    <div>
      <Eyebrow>Getting started</Eyebrow>
      <h1 className="doc-h1">Introduction</h1>
      <p className="doc-p">PortalOps is the operational event layer for Portaldot applications. It ingests on-chain events, normalizes them into clean records, stores them, and delivers them wherever your application needs — with monitoring, retries and one-click replay built in.</p>
      <div className="grid docs-grid-2" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 28 }}>
        <Card title="Event ingestion">A worker polls the chain for new blocks, stores each log once, and decodes it when you supply an ABI.</Card>
        <Card title="Reliable delivery">Webhooks with signing, retries, history and replay.</Card>
      </div>
      <h2 className="doc-h2" style={{ marginTop: 40 }}>How it fits together</h2>
      <div className="doc-code" style={{ marginTop: 16, padding: 20, fontSize: 12.5, color: "var(--fg-3)", lineHeight: 1.9 }}>
        Contract → <span style={{ color: "var(--green)" }}>decode</span> → <span style={{ color: "var(--green)" }}>normalize</span> → <span style={{ color: "var(--green)" }}>store</span> → <span style={{ color: "var(--accent)" }}>deliver</span> → monitor → retry → <span style={{ color: "var(--accent)" }}>replay</span> → automate
      </div>
    </div>
  );
}

function Quickstart() {
  return (
    <div>
      <Eyebrow>Getting started</Eyebrow>
      <h1 className="doc-h1">Quickstart</h1>
      <p className="doc-p">Receive your first captured event at your own backend. Webhooks are plain signed HTTP; the TypeScript SDK (packages/sdk) adds a typed client and verification helpers.</p>
      <div className="doc-label" style={{ margin: "30px 0 10px" }}>1 — Register a contract</div>
      <p className="doc-p" style={{ marginTop: 0, fontSize: 14 }}>Create a project, then add your contract address (and ABI, to decode events) on the Contracts screen.</p>
      <div className="doc-label" style={{ margin: "26px 0 10px" }}>2 — Add a webhook</div>
      <p className="doc-p" style={{ marginTop: 0, fontSize: 14 }}>On the Webhooks screen, add an HTTPS URL. Copy the signing secret when it is shown; it is displayed once.</p>
      <div className="doc-label" style={{ margin: "26px 0 10px" }}>3 — Verify the signature in your receiver</div>
      <div className="doc-code" style={{ overflow: "hidden" }}>
        <div className="mono" style={{ padding: "10px 16px", borderBottom: "1px solid #1a1a1a", fontSize: 11, color: "var(--dim)" }}>verify.mjs</div>
        <pre style={{ padding: 18, lineHeight: 1.7, overflowX: "auto", fontSize: 12.5 }}>{signatureSnippet}</pre>
      </div>
      <div className="doc-label" style={{ margin: "26px 0 10px" }}>4 — Send a test delivery</div>
      <p className="doc-p" style={{ marginTop: 0, fontSize: 14 }}>Use “Send test delivery” on the webhook. A 2xx response from your route confirms the integration.</p>
    </div>
  );
}

function Concepts() {
  return (
    <div>
      <Eyebrow>Concepts</Eyebrow>
      <h1 className="doc-h1">Core concepts</h1>
      <div className="stack" style={{ gap: 14, marginTop: 24 }}>
        {concepts.map((c) => (
          <div key={c.tag} className="card" style={{ borderRadius: 12, padding: "18px 20px" }}>
            <span className="mono-tag">{c.tag}</span>
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: "8px 0 0" }}>{c.title}</h3>
            <p style={{ fontSize: 14, color: "#9a968e", margin: "7px 0 0", lineHeight: 1.55 }}>{c.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApiRef() {
  return (
    <div>
      <Eyebrow>Reference</Eyebrow>
      <h1 className="doc-h1">API reference</h1>
      <p className="doc-p">Endpoints live under <span className="mono">/api/v1</span> on the PortalOps host. Send <span className="mono">Authorization: Bearer pops_…</span> with a project API key (Settings → API keys), or use the dashboard's session cookie.</p>
      <div className="table" style={{ marginTop: 24, borderRadius: 12 }}>
        {endpoints.map((ep) => (
          <div key={ep.method + ep.path} className="mono" style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 14, alignItems: "center", padding: "13px 18px", borderBottom: "1px solid #161616", fontSize: 13 }}>
            <span style={{ color: ep.color, fontWeight: 500 }}>{ep.method}</span>
            <span style={{ color: "var(--fg-2)" }}>{ep.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WebhooksDoc() {
  return (
    <div>
      <Eyebrow>Guides</Eyebrow>
      <h1 className="doc-h1">Webhooks &amp; replay</h1>
      <p className="doc-p">Every delivery is signed and recorded. When a destination fails, PortalOps retains the normalized event and retries on a backoff schedule — and you can replay any event by hand.</p>
      <h2 className="doc-h2">Verifying signatures</h2>
      <div className="doc-code" style={{ marginTop: 14, padding: 18, lineHeight: 1.7, overflowX: "auto" }}>
        <pre><span className="n">const</span> ok = portal.webhooks.<span className="n">verify</span>(req.body, sig, secret);</pre>
      </div>
      <h2 className="doc-h2">Replaying an event</h2>
      <div className="doc-code" style={{ marginTop: 14, padding: 18, lineHeight: 1.7, overflowX: "auto" }}>
        <pre><span className="k">POST</span> /v1/events/:id/replay</pre>
      </div>
      <div style={{ marginTop: 20 }}><Link href="/app#replay" style={{ fontSize: 14 }}>Open the Replay Center in the dashboard →</Link></div>
    </div>
  );
}

const pages = { intro: Intro, quickstart: Quickstart, concepts: Concepts, api: ApiRef, webhooks: WebhooksDoc };

export default function Docs() {
  const [page, setPage] = useState("intro");
  const Page = pages[page];
  const go = (id) => { setPage(id); window.scrollTo(0, 0); };

  return (
    <div className="docs-shell">
      <aside className="docs-aside" style={{ background: "#0b0b0b", borderRight: "1px solid #1b1b1b", padding: "18px 16px", position: "sticky", top: 0, height: "100vh", display: "flex", flexDirection: "column" }}>
        <Link href="/" className="brand" style={{ padding: "4px 8px 18px" }}>
          <span className="brand-mark"><i /></span>
          <span className="brand-name">PortalOps</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)", marginLeft: 2 }}>docs</span>
        </Link>
        <div style={{ background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 9, padding: "8px 11px", marginBottom: 16, display: "flex", alignItems: "center", gap: 9, color: "var(--faint)", fontSize: 13 }}>
          <span>⌕</span>Search docs
          <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, border: "1px solid #242424", borderRadius: 5, padding: "1px 6px" }}>⌘K</span>
        </div>
        <nav className="pops-scroll" style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {sections.map((g) => (
            <div key={g.label}>
              <div className="nav-label" style={{ padding: "4px 10px 6px" }}>{g.label}</div>
              {g.items.map(([id, label]) => (
                <button key={id} className={"docs-nav-item" + (id === page ? " on" : "")} onClick={() => go(id)}>{label}</button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="docs-main" style={{ padding: "48px 56px 80px" }}>
        <div style={{ maxWidth: 720 }}>
          <Page />
          <div style={{ marginTop: 48, paddingTop: 22, borderTop: "1px solid #1b1b1b", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Link className="muted-link" href="/" style={{ fontSize: 13.5 }}>← Back to site</Link>
            <Link className="pbtn" href="/auth#signup" style={{ fontSize: 13.5, padding: "9px 16px", borderRadius: 9 }}>Start Building</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
