import { useState } from "react";
import { Link } from "../router.jsx";
import { signatureSnippet } from "../data.js";
import { useSession } from "../state.jsx";
import { CopyButton } from "../ui.jsx";

const AGENTS = [
  { id: "claude", name: "Claude Code", status: "Copy & paste", color: "#6ee7a8", desc: "Paste the prompt into Claude Code in your repository. It inspects your code and implements the receiver." },
  { id: "codex", name: "Codex", status: "Copy & paste", color: "#6ee7a8", desc: "Paste the prompt into Codex in your repository. Same instructions, same verified facts." },
  { id: "manual", name: "Manual", status: "Docs", color: "#8d8980", desc: "Implement the receiver yourself using the signature verification code below." },
];

function buildPrompt(project, origin, network) {
  return `Set up a PortalOps webhook receiver in this repository.

Context (verified facts, do not change them)
- PortalOps project: ${project ? `${project.name} (id ${project.id})` : "<create a project in PortalOps first>"}
- Network: ${network}
- PortalOps delivers captured on-chain events to an HTTPS endpoint you control, as a signed JSON POST.
- API base (for reference): ${origin}/api/v1

What to do
1. Inspect the repository: language, framework, existing routing and test setup. Match its conventions.
2. Add one POST route (suggested path: /portal-events) that:
   a. reads the RAW request body (do not re-serialise JSON before verifying),
   b. verifies the "portalops-signature" header (format below) with the signing secret from an environment variable named PORTALOPS_WEBHOOK_SECRET,
   c. rejects requests whose timestamp is more than 300 seconds old,
   d. de-duplicates on the "portalops-event-id" header (store processed ids; replays re-send the same id),
   e. returns 2xx only after the event is safely handled; any 5xx/timeout is retried by PortalOps, a 4xx (except 408/425/429) is not.
3. Never hard-code the secret and never log it. Add PORTALOPS_WEBHOOK_SECRET to the environment documentation (never in a committed file).
4. Add tests: valid signature, tampered body, expired timestamp, duplicate event id.
5. Run the tests and type checks. Report exactly what passed, what failed, and what still needs manual action.

Signature format
  Header: portalops-signature: t=<unix seconds>,v1=<hex>
  v1 = HMAC_SHA256(secret, "<t>." + rawBody), compared in constant time.

Request headers PortalOps sends
  portalops-signature, portalops-timestamp, portalops-event-id, portalops-delivery-id, portalops-attempt, idempotency-key

Body shape
  { "id": "<event id>", "type": "event.received", "network": "${network}",
    "data": { "eventName": string | null, "decoded": boolean, "contractAddress": string, "payload": object | null,
              "topics": string[], "data": string, "transactionHash": string, "blockNumber": number,
              "blockHash": string, "eventIndex": number, "observedAt": string, "finalityStatus": "included" | "confirmed" | "finalized" | "orphaned" } }

Chain status values
  included  = seen in a block; confirmed = 12+ blocks deep (a heuristic); finalized = finalized by the network and verified (permanent);
  orphaned  = its block is not on the canonical chain. For irreversible actions (payouts, access grants) wait for "finalized".

Rules
- Do not invent SDK methods, endpoints or configuration values. Use only what is described here.
- Do not claim the integration works until a delivery has actually been received and verified.

After you finish, tell me the public URL of the route so I can add it as a webhook in PortalOps and send a test delivery.`;
}

export default function AiSetup() {
  const { project, user } = useSession();
  const [agentId, setAgentId] = useState("claude");
  const [copied, setCopied] = useState(false);
  const agent = AGENTS.find((a) => a.id === agentId);
  const prompt = buildPrompt(project, window.location.origin, "portaldot-v3-testnet");
  const cmd = agentId === "claude" ? "claude" : agentId === "codex" ? "codex" : null;

  return (
    <div>
      <h1 className="h1">Let your coding agent set up PortalOps.</h1>
      <p className="sub" style={{ maxWidth: 640, lineHeight: 1.5 }}>
        Copy a project-specific prompt into your coding agent. It will add a verified webhook receiver to your repository. PortalOps cannot see inside your editor, so completion is confirmed by a real delivery, not by copying the prompt.
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", marginTop: 26 }}>
        {AGENTS.map((a) => (
          <div key={a.id} className={"agent-card" + (a.id === agentId ? " on" : "")} onClick={() => { setAgentId(a.id); setCopied(false); }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>{a.name}</span>
              <span className="mono" style={{ fontSize: 11, color: a.color }}>{a.status}</span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.45 }}>{a.desc}</div>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: 16, marginTop: 16, alignItems: "start" }}>
        <div className="stack" style={{ gap: 16 }}>
          <div className="panel tight">
            <h2 className="h2">{agent.name} setup</h2>
            {[
              { n: "1", title: "Open your repository", body: cmd ? "Start the agent in the root of the project that should receive events." : "Open the backend project that should receive events.", code: cmd },
              { n: "2", title: agentId === "manual" ? "Implement the receiver" : "Paste the generated prompt", body: agentId === "manual" ? "Use the verification code on this page, keeping the raw-body and timestamp rules." : "Copy it from the panel below and paste it into the agent." },
              { n: "3", title: "Review and test", body: "Read the diff. Run the tests the agent added. The agent must report failures honestly; do not accept “done” without passing tests." },
              { n: "4", title: "Add the webhook in PortalOps", body: <>Create a webhook pointing at your deployed route on the <Link href="/app#webhooks">Webhooks</Link> screen. Copy the signing secret when it is shown (it is shown once) into <span className="mono">PORTALOPS_WEBHOOK_SECRET</span>.</> },
              { n: "5", title: "Send a test delivery", body: "Use “Send test delivery” on the webhook. A 2xx response from your route is the real confirmation that the integration works." },
            ].map((st) => (
              <div key={st.n} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 14, padding: "14px 0", borderTop: "1px solid #1a1a1a" }}>
                <span className="step-n">{st.n}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{st.title}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>{st.body}</div>
                  {st.code && <div className="mono" style={{ marginTop: 9, fontSize: 12, color: "var(--fg-2)", background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: 8, padding: "9px 12px" }}>{st.code}</div>}
                </div>
              </div>
            ))}
          </div>

          {agentId !== "manual" ? (
            <div className="ai-card" style={{ padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Generated setup prompt</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{project ? `Tailored to ${project.name}` : user ? "Create a project to include its id" : "Sign in and create a project to include its id"} · Portaldot V3.0 Testnet</div>
                </div>
                <span onClick={() => setCopied(true)}><CopyButton text={prompt} label={copied ? "Copied ✓" : "Copy prompt"} className="btn primary" /></span>
              </div>
              <pre className="mono" style={{ margin: "14px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--fg-2)", background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: 10, padding: 16, overflowX: "auto", whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto" }}>{prompt}</pre>
            </div>
          ) : (
            <div className="code-box"><div className="code-head"><span>verify.mjs</span><CopyButton text={signatureSnippet} /></div><pre style={{ fontSize: 12.5 }}>{signatureSnippet}</pre></div>
          )}
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="panel">
            <h2 className="h2 sm" style={{ marginBottom: 12 }}>Setup progress</h2>
            <div className="checklist">
              <div className={"check" + (prompt ? " done" : "")}><span className="box">✓</span>Prompt generated</div>
              <div className={"check" + (copied ? " done" : "")}><span className="box">{copied ? "✓" : ""}</span>Prompt copied</div>
              <div className="check"><span className="box" /> Changes reported by agent</div>
              <div className="check"><span className="box" /> Tests executed by agent</div>
              <div className="check"><span className="box" /> Verified by PortalOps</div>
            </div>
            <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 14, lineHeight: 1.55 }}>
              Only the first two steps can be tracked here. PortalOps does not yet receive reports from coding agents, so the last three are confirmed by your own review and a successful test delivery, never by this page.
            </div>
          </div>
          <div className="panel">
            <h2 className="h2 sm" style={{ marginBottom: 8 }}>What the agent is told</h2>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--fg-3)", lineHeight: 1.7 }}>
              <li>Verify signatures on the raw body</li>
              <li>Reject stale timestamps</li>
              <li>De-duplicate on the event id</li>
              <li>Never log or hard-code the secret</li>
              <li>Write tests and report results honestly</li>
              <li>Not to invent SDK methods or endpoints</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
