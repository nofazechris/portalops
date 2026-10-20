import { useState } from "react";
import { Link } from "../router.jsx";
import { api } from "../api.js";
import { shortHash, timeAgo, useApi } from "../state.jsx";
import { signatureSnippet } from "../data.js";
import "./pages.css";

const walk = [
  { k: "01", title: "Sign up", desc: "Create your account with email or GitHub.", panelTitle: "Create your account", panelBody: "No infrastructure to provision. Sign in and your workspace is ready.", code: "→ Continue with GitHub · Email", cta: "Create account", href: "/auth#signup" },
  { k: "02", title: "Create a project", desc: "Name it and default to Portaldot Testnet.", panelTitle: "New project", panelBody: "Pick an environment and you're dropped straight into guided setup.", code: "project: portalops-demo · Testnet", cta: "Start setup", href: "/app#tour" },
  { k: "03", title: "Connect your contract", desc: "Paste an address or use the demo contract.", panelTitle: "Add a contract", panelBody: "Addresses are validated against the selected network before you continue.", code: "0x… your contract address", cta: "Connect contract", href: "/app#tour" },
  { k: "04", title: "Choose your events", desc: "Select the events your application cares about.", panelTitle: "Select events", panelBody: "Discovered from the contract ABI — pick what PortalOps should process.", code: "QuestCompleted · RewardMinted · AccessGranted", cta: "Choose events", href: "/app#tour" },
  { k: "05", title: "Test a real event", desc: "Trigger a transaction and watch it flow end to end.", panelTitle: "Send your first event", panelBody: "Transaction → decoded → stored → delivered, with real references.", code: "expected: HTTP 2xx from your endpoint", cta: "Try the live demo", href: "/app" },
  { k: "06", title: "Let AI help (optional)", desc: "Hand setup to your coding agent and verify.", panelTitle: "Connect an AI agent", panelBody: "Copy a project-specific prompt into Claude Code or Codex. It builds the receiver; a test delivery confirms it.", code: "prompt → your agent → test delivery", cta: "Set up with AI", href: "/app#aisetup" },
];

const pipeline = ["Decode", "→", "Normalize", "→", "Store", "→", "Deliver", "→", "Monitor", "→", "Retry", "→", "Replay", "→", "Automate"];

const features = [
  { glyph: "⇥", title: "Event ingestion", desc: "Decode and normalize on-chain events into clean, application-ready records.", meta: "block tracker · idempotent storage" },
  { glyph: "↗", title: "Webhooks", desc: "Deliver events to any endpoint with signing, retries and delivery history.", meta: "signed · retried · replayable" },
  { glyph: "↺", title: "Replay & retry", desc: "Recover failed deliveries in one click, without reconstructing state.", meta: "signature feature" },
  { glyph: "◎", title: "Observability", desc: "Logs, metrics and contextual diagnostics across every event and delivery.", meta: "real-time logs" },
  { glyph: "⌁", title: "Automations", desc: "Trigger webhooks and actions when events match the conditions you set.", meta: "when · if · then" },
  { glyph: "{ }", title: "REST API", desc: "The same API the dashboard uses, plus signed webhooks for your backend.", meta: "REST · signed webhooks" },
];

const Brand = ({ size = 22, inner = 8, font = 16, href }) => {
  const mark = (
    <>
      <span className="brand-mark" style={{ width: size, height: size, borderRadius: 6 }}>
        <i style={{ width: inner, height: inner }} />
      </span>
      <span style={{ fontWeight: 600, letterSpacing: "-0.01em", fontSize: font }}>PortalOps</span>
    </>
  );
  return href ? <a href={href} style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg)" }}>{mark}</a>
    : <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{mark}</div>;
};

const Pill = ({ children }) => <span className="mono-pill">{children}</span>;

export default function Landing() {
  const [step, setStep] = useState(0);
  const cur = walk[step];
  const status = useApi(() => api.publicStatus(), [], { refreshMs: 10_000 });
  const demoId = status.data?.demo?.projectId;
  const live = useApi(() => api.events(demoId, { limit: 3 }), [demoId], { enabled: !!demoId, refreshMs: 10_000 });
  const conn = status.data?.connection ?? (status.error ? "disconnected" : "checking");
  const connText = { connected: "Connected", disconnected: "Disconnected", wrong_chain: "Wrong chain", checking: "Checking…" }[conn];
  const connDot = { connected: "green", disconnected: "red", wrong_chain: "amber", checking: "grey" }[conn];
  const latest = live.data?.items?.[0];

  return (
    <div className="lp" id="landing-top">
      {/* NAV */}
      <nav className="lp-nav">
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          <Brand href="#top" />
          <div className="lp-nav-links" style={{ display: "flex", gap: 28, fontSize: 14 }}>
            <a className="top-link" href="#pipeline">Product</a>
            <a className="top-link" href="#replay">Replay</a>
            <a className="top-link" href="#sdk">Developers</a>
            <Link className="top-link" href="/docs">Docs</Link>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Link className="top-link" href="/auth#signin" style={{ fontSize: 14 }}>Sign in</Link>
          <Link className="pbtn" href="/auth#signup" style={{ fontSize: 14, padding: "9px 16px", borderRadius: 8 }}>Start Building</Link>
        </div>
      </nav>

      {/* HERO */}
      <section id="top" className="lp-hero" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.05fr) minmax(0,0.95fr)", gap: 56, alignItems: "center", padding: "84px 0 72px" }}>
        <div>
          <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, letterSpacing: "0.02em", color: "var(--accent)", border: "1px solid #2a2740", background: "rgba(185,167,255,0.06)", padding: "6px 11px", borderRadius: 999 }}>
            <span className="dot" style={{ width: 6, height: 6, background: "var(--accent)", animation: "blink 2.2s infinite" }} />
            Built for Portaldot V3.0
          </span>
          <h1 className="lp-h1" style={{ fontSize: 54, lineHeight: 1.04, letterSpacing: "-0.03em", fontWeight: 600, margin: "22px 0 0", textWrap: "balance" }}>
            Turn Portaldot events into reliable application infrastructure.
          </h1>
          <p style={{ fontSize: 18, lineHeight: 1.55, color: "var(--fg-3)", maxWidth: 520, margin: "22px 0 0" }}>
            PortalOps gives Portaldot developers event ingestion, webhooks, replay, monitoring and automation — without building the infrastructure themselves.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 34 }}>
            <Link className="pbtn btn-lg" href="/auth#signup">Start Building</Link>
            <Link className="sbtn btn-lg" href="/app" style={{ gap: 9, padding: "13px 20px" }}>
              <svg width="15" height="15" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20" fill="#B9A7FF" /></svg>
              View Live Demo
            </Link>
          </div>
          <div className="mono" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, columnGap: 22, marginTop: 38, fontSize: 12, color: "var(--dim)" }}>
            <span>The event layer for</span>
            {["DApps", "Games", "Agents", "Backends"].map((t) => <span key={t} style={{ color: "var(--muted)" }}>{t}</span>)}
          </div>
        </div>

        {/* hero visual */}
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", inset: -40, background: "radial-gradient(60% 55% at 70% 20%, rgba(185,167,255,0.14), transparent 70%)", filter: "blur(8px)", pointerEvents: "none", animation: "glowpulse 6s ease-in-out infinite" }} />
          <div style={{ position: "relative", background: "linear-gradient(180deg,#121212,#0d0d0d)", border: "1px solid #242424", borderRadius: 18, padding: 22, boxShadow: "0 30px 80px -30px rgba(0,0,0,0.9)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, paddingBottom: 16, borderBottom: "1px solid #1d1d1d" }}>
              <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>infrastructure.flow</span>
              <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "var(--fg-3)" }}>
                <span className={"dot " + connDot} style={connDot === "green" ? { animation: "blink 2s infinite" } : { boxShadow: "none" }} />Portaldot V3.0 Testnet · {connText}{status.data?.headBlock != null ? ` · #${status.data.headBlock.toLocaleString()}` : ""}
              </span>
            </div>

            <div style={{ position: "relative", padding: "26px 6px 10px", display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div className="flow-node"><b>Portaldot contract</b><span>{latest ? `${shortHash(latest.contractAddress, 8, 6)} · block #${latest.blockNumber}` : "waiting for events"}</span></div>
              <div style={{ position: "relative", width: 2, height: 46, background: "#2a2740" }}><span className="flow-dot" /></div>
              <div style={{ position: "relative", width: 250 }}>
                <span style={{ position: "absolute", inset: 0, borderRadius: 14, border: "1px solid var(--accent)", animation: "pulsering 2.8s ease-out infinite" }} />
                <div style={{ position: "relative", background: "linear-gradient(160deg,#1a1726,#111016)", border: "1px solid #3a355a", borderRadius: 14, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>PortalOps</span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--accent)", border: "1px solid #37325a", padding: "2px 7px", borderRadius: 999 }}>processing</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 7, marginTop: 12 }}>
                    {["Decode", "Store", "Monitor", "Deliver"].map((c) => <span key={c} className="flow-chip">{c}</span>)}
                  </div>
                </div>
              </div>
              <div style={{ position: "relative", width: 2, height: 46, background: "#2a2740" }}><span className="flow-dot" style={{ animationDelay: "1.3s" }} /></div>
              <div className="flow-node"><b>Your application</b><span>signed webhook · retried · replayable</span></div>
            </div>

            <div className="mono" style={{ marginTop: 18, borderTop: "1px solid #1d1d1d", paddingTop: 14, display: "flex", flexDirection: "column", gap: 7, fontSize: 11.5 }}>
              <div style={{ color: "var(--dim)", fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase" }}>Latest captured on the testnet (live)</div>
              {live.data?.items?.length ? live.data.items.map((e) => (
                <div key={e.id} className="log-line">
                  <span style={{ color: "var(--dim)" }}>{timeAgo(e.observedAt)}</span>
                  <span style={{ color: "var(--green)" }}>{e.eventName ?? "UNDECODED_LOG"}</span>
                  <span style={{ color: "var(--fg-3)" }}>#{e.blockNumber} {shortHash(e.transactionHash, 8, 4)}</span>
                </div>
              )) : <div style={{ color: "var(--fg-3)" }}>{status.error || conn === "disconnected" ? "Testnet unreachable right now." : "No events captured yet."}</div>}
            </div>
          </div>
        </div>
      </section>

      {/* AI-NATIVE CALLOUT */}
      <section id="ai" style={{ background: "linear-gradient(120deg,#0d0d0d,#141019)", border: "1px solid #231d33", borderRadius: 16, padding: "22px 26px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--accent)", border: "1px solid #37325a", background: "rgba(185,167,255,0.06)", padding: "7px 12px", borderRadius: 999, whiteSpace: "nowrap" }}>✧ AI-native</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Already building with Claude Code or Codex?</div>
            <div style={{ fontSize: 14, color: "#9a968e", marginTop: 3, lineHeight: 1.45 }}>Connect PortalOps to your coding agent and set up your integration directly from your development environment.</div>
          </div>
        </div>
        <Link className="pbtn btn-lg" href="/app#aisetup" style={{ fontSize: 14.5, padding: "11px 20px", whiteSpace: "nowrap" }}>Set Up With AI →</Link>
      </section>

      {/* WALKTHROUGH */}
      <section id="walkthrough" style={{ padding: "64px 0 20px" }}>
        <div className="lp-section-head">
          <h2 className="lp-h2">From zero to a live integration in six steps.</h2>
          <p className="lp-aside">// guided setup</p>
        </div>
        <div className="lp-grid-2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 24, marginTop: 34, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {walk.map((w, i) => (
              <button key={w.k} className={"walk-row" + (i === step ? " on" : "")} onClick={() => setStep(i)}>
                <span className="k">{w.k}</span>
                <div>
                  <div className="t">{w.title}</div>
                  <div style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 3, lineHeight: 1.45 }}>{w.desc}</div>
                </div>
              </button>
            ))}
          </div>
          <div className="lp-sticky" style={{ position: "sticky", top: 88, background: "linear-gradient(160deg,#121016,#0d0d0d)", border: "1px solid #201d2b", borderRadius: 16, padding: 28 }}>
            <div className="mono" style={{ fontSize: 11, color: "var(--accent)", letterSpacing: "0.04em" }}>STEP {cur.k}</div>
            <h3 style={{ fontSize: 23, fontWeight: 600, letterSpacing: "-0.01em", margin: "12px 0 0" }}>{cur.panelTitle}</h3>
            <p style={{ fontSize: 15, color: "var(--fg-3)", margin: "12px 0 0", lineHeight: 1.55 }}>{cur.panelBody}</p>
            <div className="mono" style={{ marginTop: 22, fontSize: 13, color: "var(--fg-2)", background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: 10, padding: "14px 16px" }}>{cur.code}</div>
            <Link className="pbtn btn-lg" href={cur.href} style={{ marginTop: 22, fontSize: 14.5, padding: "11px 20px" }}>{cur.cta} →</Link>
          </div>
        </div>
      </section>

      {/* PIPELINE */}
      <section id="pipeline" style={{ padding: "56px 0 20px" }}>
        <div className="lp-section-head">
          <h2 className="lp-h2">Everything that happens after an on-chain event exists.</h2>
          <p className="lp-aside">// the operational event layer</p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 34, alignItems: "center" }}>
          {pipeline.map((s, i) => <span key={i} className="pipe-chip">{s}</span>)}
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" style={{ padding: "48px 0 20px" }}>
        <div className="lp-grid-3" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 16 }}>
          {features.map((f) => (
            <div key={f.title} className="feature">
              <span className="ico">{f.glyph}</span>
              <h3 style={{ fontSize: 16.5, fontWeight: 600, margin: "16px 0 0" }}>{f.title}</h3>
              <p style={{ fontSize: 14, lineHeight: 1.5, color: "#9a968e", margin: "8px 0 0" }}>{f.desc}</p>
              <span className="mono" style={{ marginTop: "auto", paddingTop: 14, fontSize: 11.5, color: "var(--dim)" }}>{f.meta}</span>
            </div>
          ))}
        </div>
      </section>

      {/* LIVE STATUS */}
      <section className="lp-grid-4" style={{ margin: "44px 0", background: "linear-gradient(120deg,#0d0d0d,#121016)", border: "1px solid #201d2b", borderRadius: 16, padding: "34px 36px", display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 24 }}>
        {[
          { value: status.data?.demo ? status.data.demo.eventsIndexed.toLocaleString() : "—", label: "Testnet events indexed (public explorer)", color: "var(--accent)" },
          { value: status.data?.headBlock != null ? "#" + status.data.headBlock.toLocaleString() : "—", label: "Current head block" },
          { value: connText, label: "Network connection" },
          { value: status.data?.demo?.lastEventObservedAt ? timeAgo(status.data.demo.lastEventObservedAt) : "—", label: "Last event captured" },
        ].map((m) => (
          <div key={m.label}>
            <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", color: m.color || "var(--fg)" }}>{m.value}</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>{m.label}</div>
          </div>
        ))}
      </section>

      {/* REPLAY HIGHLIGHT */}
      <section id="replay" className="lp-grid-2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 48, alignItems: "center", padding: "48px 0" }}>
        <div>
          <span className="mono-tag">// signature feature</span>
          <h2 className="lp-h2-big" style={{ fontSize: 36, letterSpacing: "-0.025em", fontWeight: 600, margin: "14px 0 0", lineHeight: 1.08 }}>Recover failed deliveries. Instantly.</h2>
          <p style={{ fontSize: 17, lineHeight: 1.55, color: "var(--fg-3)", maxWidth: 460, margin: "16px 0 0" }}>
            When a destination fails, PortalOps keeps the normalized event. Replay re-delivers it exactly as it happened — no reconstructing blockchain state by hand.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 26, flexWrap: "wrap" }}>
            <Pill>Automatic retry</Pill><Pill>One-click replay</Pill><Pill>Full delivery history</Pill>
          </div>
        </div>
        <div className="mono" style={{ background: "#0f0f0f", border: "1px solid #242424", borderRadius: 16, padding: 22, fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#7f7b73", fontSize: 11.5 }}><span>delivery.log</span><span style={{ color: "var(--amber)" }}>illustration, not live data</span></div>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#160f10", border: "1px solid #3a1f22", borderRadius: 9, padding: "11px 13px" }}>
              <span style={{ color: "var(--red)" }}>✕ 500</span><span style={{ color: "var(--fg-3)" }}>431ms</span><span style={{ color: "#7f7b73", marginLeft: "auto" }}>attempt 3 of 5</span>
            </div>
            <div style={{ textAlign: "center", color: "var(--accent)", fontSize: 12 }}>↓ replay event</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#0e1611", border: "1px solid #1f3a2a", borderRadius: 9, padding: "11px 13px" }}>
              <span style={{ color: "var(--green)" }}>✓ 200</span><span style={{ color: "var(--fg-3)" }}>184ms</span><span style={{ color: "var(--green)", marginLeft: "auto" }}>delivered</span>
            </div>
          </div>
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <span style={{ display: "inline-block", background: "var(--accent)", color: "#080808", fontWeight: 600, fontSize: 12.5, padding: "9px 18px", borderRadius: 8 }}>Replay Event</span>
          </div>
        </div>
      </section>

      {/* DEVELOPERS */}
      <section id="sdk" className="lp-grid-2" style={{ display: "grid", gridTemplateColumns: "minmax(0,0.9fr) minmax(0,1.1fr)", gap: 48, alignItems: "center", padding: "48px 0" }}>
        <div>
          <span className="mono-tag">// built for developers</span>
          <h2 className="lp-h2-big" style={{ fontSize: 34, letterSpacing: "-0.025em", fontWeight: 600, margin: "14px 0 0", lineHeight: 1.1 }}>A REST API, an SDK and signed webhooks.</h2>
          <p style={{ fontSize: 16, lineHeight: 1.55, color: "var(--fg-3)", maxWidth: 440, margin: "16px 0 0" }}>
            List events, replay deliveries and manage webhooks over HTTP, and verify every delivery with a documented HMAC signature. A typed TypeScript SDK (in this repo, not yet on npm) wraps it with retries and verification helpers.
          </p>
          <div className="mono" style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 26, fontSize: 12.5, color: "var(--muted)" }}>
            <span><span style={{ color: "var(--accent)" }}>GET</span>  /api/v1/projects/:id/events</span>
            <span><span style={{ color: "var(--accent)" }}>GET</span>  /api/v1/webhooks/:id/deliveries</span>
            <span><span style={{ color: "var(--green)" }}>POST</span> /api/v1/events/:id/replay</span>
          </div>
        </div>
        <div style={{ background: "#0d0d0d", border: "1px solid #242424", borderRadius: 16, overflow: "hidden" }}>
          <div className="mono" style={{ padding: "12px 16px", borderBottom: "1px solid #1d1d1d", fontSize: 12, color: "var(--muted)" }}>verify.mjs · webhook signature check</div>
          <pre className="mono" style={{ padding: "20px 22px", fontSize: 12, lineHeight: 1.65, color: "var(--fg-2)", overflowX: "auto" }}>{signatureSnippet}</pre>
        </div>
      </section>

      {/* CLOSING */}
      <section id="start" className="lp-closing" style={{ margin: "40px 0 72px", position: "relative", background: "linear-gradient(160deg,#0a0a0a 0%,#121016 55%,#1a1530 100%)", border: "1px solid #221d33", borderRadius: 20, padding: "72px 48px", textAlign: "center", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(50% 80% at 50% 120%, rgba(185,167,255,0.22), transparent 70%)", pointerEvents: "none" }} />
        <div style={{ position: "relative" }}>
          <h2 className="lp-closing-h2" style={{ fontSize: 40, letterSpacing: "-0.03em", fontWeight: 600, margin: 0, lineHeight: 1.08, textWrap: "balance" }}>
            Build the application.<br />Let PortalOps handle the operations.
          </h2>
          <p style={{ fontSize: 17, color: "var(--fg-3)", maxWidth: 560, margin: "18px auto 0", lineHeight: 1.55 }}>
            Connect your Portaldot application, listen for events, deliver them wherever they need to go, and recover when things fail.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center", marginTop: 32 }}>
            <Link className="pbtn btn-lg" href="/auth#signup" style={{ padding: "13px 24px" }}>Start Building</Link>
            <Link className="sbtn soft btn-lg" href="/docs">View Documentation</Link>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer id="pricing" style={{ borderTop: "1px solid #1b1b1b", padding: "36px 0 56px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 28 }}>
        <div style={{ maxWidth: 280 }}>
          <Brand size={20} inner={7} font={15} />
          <p style={{ fontSize: 13, color: "#7f7b73", lineHeight: 1.5, margin: "14px 0 0" }}>The operational event layer for Portaldot applications.</p>
        </div>
        <div style={{ display: "flex", gap: 56, flexWrap: "wrap" }}>
          <div className="foot-col">
            <span className="h">Product</span>
            <a className="muted-link" href="#features">Events</a>
            <a className="muted-link" href="#features">Webhooks</a>
            <a className="muted-link" href="#replay">Replay</a>
            <a className="muted-link" href="#pipeline">Automations</a>
          </div>
          <div className="foot-col">
            <span className="h">Developers</span>
            <a className="muted-link" href="#sdk">API / SDK</a>
            <Link className="muted-link" href="/app#aisetup">AI Setup</Link>
            <Link className="muted-link" href="/docs">Docs</Link>
          </div>
        </div>
        <div className="mono" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--muted)" }}>
          <span className={"dot " + connDot} style={connDot === "green" ? undefined : { boxShadow: "none" }} />Testnet {connText.toLowerCase()}
        </div>
      </footer>
    </div>
  );
}
