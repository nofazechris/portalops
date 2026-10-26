import { useEffect, useState } from "react";
import { api } from "../api.js";
import { timeAgo, useApi, useSession } from "../state.jsx";
import { Empty, ErrorBox, Loading, NeedsProject, deliveryLabel } from "../ui.jsx";

const label = { color: "var(--dim)", fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase" };
const tone = { high: "var(--green)", medium: "var(--amber)", low: "var(--fg-3)" };

/**
 * Why did this delivery fail? The explanation comes from the server, built only from the attempts PortalOps recorded. A model-written
 * explanation is optional, and the exact evidence it would receive is shown BEFORE the user decides to ask for it.
 */
export function Diagnostics({ go }) {
  const { projectId, readOnly } = useSession();
  const failed = useApi(() => api.deliveries(projectId, { status: "failed", limit: 20 }), [projectId], { enabled: !!projectId && !readOnly });
  const [pick, setPick] = useState(null);
  const sel = failed.data?.find((d) => d.id === pick) ?? failed.data?.[0];
  const dx = useApi(() => api.diagnosis(sel.id), [sel?.id], { enabled: !!sel });
  const [showEvidence, setShowEvidence] = useState(false);
  const [ai, setAi] = useState({ busy: false, result: null, error: null });
  useEffect(() => { setAi({ busy: false, result: null, error: null }); setShowEvidence(false); }, [sel?.id]);
  if (readOnly) return <NeedsProject what="diagnose failed deliveries" />;

  async function ask() {
    setAi({ busy: true, result: null, error: null });
    try { setAi({ busy: false, result: await api.explainDelivery(sel.id), error: null }); }
    catch (e) { setAi({ busy: false, result: null, error: e }); }
  }
  const r = dx.data?.rules;
  const evidence = dx.data?.evidence;

  return (
    <div>
      <h1 className="h1">Diagnostics</h1>
      <p className="sub">An explanation of why a delivery failed, derived only from the attempts PortalOps recorded.</p>
      <ErrorBox error={failed.error} onRetry={failed.reload} />
      {failed.loading && !failed.data ? <div style={{ marginTop: 24 }}><Loading /></div> : !sel ? <div style={{ marginTop: 24 }}><Empty title="No failed deliveries">Nothing to diagnose right now.</Empty></div> : (
        <div style={{ marginTop: 24, maxWidth: 700, background: "linear-gradient(170deg,#121016,#0d0d0d)", border: "1px solid #201d2b", borderRadius: 16, padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Why did this delivery fail?</span>
            {failed.data.length > 1 && (
              <select className="select" style={{ width: 240, marginLeft: "auto" }} value={sel.id} onChange={(e) => setPick(e.target.value)}>
                {failed.data.map((d) => <option key={d.id} value={d.id}>{d.event.eventName ?? "Raw log"} · {timeAgo(d.updatedAt)}</option>)}
              </select>
            )}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>{deliveryLabel(sel.status)} · event {sel.eventId.slice(0, 16)}…</div>
          <ErrorBox error={dx.error} onRetry={dx.reload} />
          {!r ? (dx.error ? null : <div style={{ marginTop: 16 }}><Loading /></div>) : (
            <>
              <div style={{ marginTop: 16, fontSize: 15, lineHeight: 1.5 }}>{r.summary}</div>
              <div style={{ marginTop: 18, ...label }}>PortalOps recorded</div>
              <div className="stack" style={{ gap: 8, marginTop: 10, fontSize: 14, color: "var(--fg-2)" }}>
                {r.facts.map((f, i) => <div key={i} style={{ display: "flex", gap: 10 }}><span style={{ color: "var(--accent)" }}>•</span><span>{f}</span></div>)}
              </div>
              <div style={{ marginTop: 18, background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", ...label }}><span>Likely cause</span><span style={{ color: tone[r.confidence] }}>{r.confidence} confidence</span></div>
                <div style={{ fontSize: 14, marginTop: 7, lineHeight: 1.5 }}>{r.cause}</div>
              </div>
              {r.fixes.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={label}>What to check</div>
                  <ol style={{ margin: "9px 0 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 7, fontSize: 14, color: "var(--fg-2)", lineHeight: 1.5 }}>
                    {r.fixes.map((x, i) => <li key={i}>{x}</li>)}
                  </ol>
                </div>
              )}
              <div style={{ marginTop: 14, fontSize: 13, color: "var(--fg-3)", lineHeight: 1.5 }}>{r.replay}</div>
              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>Rule-based analysis of recorded evidence. Suggestions are for you to review; nothing is changed automatically.</div>

              <div style={{ marginTop: 20, borderTop: "1px solid #1d1b27", paddingTop: 16 }}>
                {!dx.data.ai.available ? (
                  <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>Written explanations from Claude are off on this server (the operator can turn them on with an Anthropic API key). The analysis above always works.</div>
                ) : !ai.result ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <button className="btn secondary" disabled={ai.busy} onClick={ask}>{ai.busy ? "Asking Claude…" : "Explain with Claude"}</button>
                      <button className="link-btn" style={{ fontSize: 12.5 }} onClick={() => setShowEvidence((v) => !v)}>{showEvidence ? "Hide" : "See"} exactly what is sent</button>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>Sends the evidence below to a Claude model ({dx.data.ai.model}). Never your signing secrets, keys or the event payload.</div>
                    {showEvidence && <pre className="mono" style={{ margin: "10px 0 0", padding: 12, borderRadius: 9, background: "#08080a", border: "1px solid #1f1f1f", fontSize: 11.5, lineHeight: 1.55, color: "var(--fg-3)", overflow: "auto", maxHeight: 260 }}>{JSON.stringify(evidence, null, 2)}</pre>}
                    {ai.error && <div className="field-error" style={{ marginTop: 10 }}>{ai.error.message}</div>}
                  </>
                ) : (
                  <div style={{ background: "rgba(185,167,255,0.06)", border: "1px solid #2a2740", borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ ...label, color: "var(--accent)" }}>Claude's explanation · {ai.result.model}</div>
                    <div style={{ fontSize: 14.5, marginTop: 8, lineHeight: 1.5 }}>{ai.result.explanation.summary}</div>
                    <div style={{ fontSize: 13.5, marginTop: 8, color: "var(--fg-2)", lineHeight: 1.55 }}><b>Likely cause:</b> {ai.result.explanation.likelyCause}</div>
                    {ai.result.explanation.suggestedFixes.length > 0 && (
                      <ol style={{ margin: "10px 0 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
                        {ai.result.explanation.suggestedFixes.map((x, i) => <li key={i}>{x}</li>)}
                      </ol>
                    )}
                    {ai.result.explanation.missingEvidence.length > 0 && <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 10 }}>Not enough evidence for: {ai.result.explanation.missingEvidence.join("; ")}.</div>}
                    <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>Written by an AI model from the recorded evidence. Check it against your own logs before changing anything.</div>
                  </div>
                )}
              </div>
            </>
          )}
          <div style={{ display: "flex", gap: 9, marginTop: 18 }}>
            <button className="btn secondary" onClick={() => go("logs")}>View logs</button>
            <button className="btn primary" onClick={() => go("replay")}>Replay</button>
          </div>
        </div>
      )}
    </div>
  );
}
