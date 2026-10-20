import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { timeAgo, useApi, useSession } from "../state.jsx";
import { Empty, ErrorBox, Loading, NeedsProject, deliveryColor, deliveryLabel } from "../ui.jsx";
import { eventTitle } from "./Overview.jsx";

export default function Replay({ go }) {
  const { projectId, readOnly } = useSession();
  const failed = useApi(() => api.deliveries(projectId, { status: "failed", limit: 100 }), [projectId], { refreshMs: 5000, enabled: !!projectId && !readOnly });
  const retrying = useApi(() => api.deliveries(projectId, { status: "retrying", limit: 100 }), [projectId], { refreshMs: 5000, enabled: !!projectId && !readOnly });
  const [selected, setSelected] = useState(null);
  const [run, setRun] = useState({ phase: "idle", deliveryId: null, error: null });
  // Outlives the list item: a delivered replay leaves the "failed" list, but the confirmation must stay visible.
  const [notice, setNotice] = useState(null);
  const poll = useRef();
  useEffect(() => () => clearInterval(poll.current), []);

  const items = [...(failed.data ?? []), ...(retrying.data ?? [])];
  const sel = items.find((d) => d.id === selected) ?? items[0] ?? null;
  const detail = useApi(() => api.event(sel.eventId), [sel?.eventId], { enabled: !!sel, refreshMs: run.phase === "running" ? 1500 : 0 });

  if (readOnly) return <NeedsProject what="replay failed deliveries" />;

  async function replay() {
    setRun({ phase: "running", deliveryId: null, error: null });
    try {
      const r = await api.replay(sel.eventId, sel.endpointId);
      const deliveryId = r.deliveryIds[0];
      setRun({ phase: "running", deliveryId, error: null });
      clearInterval(poll.current);
      let ticks = 0;
      poll.current = setInterval(async () => {
        ticks++;
        try {
          const ev = await api.event(sel.eventId);
          const d = ev.deliveries.find((x) => x.id === deliveryId);
          if (d && (d.status === "delivered" || d.status === "failed" || d.status === "retrying")) {
            clearInterval(poll.current);
            setRun({ phase: "done", deliveryId, error: null, result: d });
            const last = d.attempts.at(-1);
            setNotice({
              ok: d.status === "delivered",
              eventId: sel.eventId,
              text: d.status === "delivered"
                ? `Replay delivered: ${eventTitle(sel.event)} (block #${sel.event.blockNumber}) · ${last?.responseStatus ? "HTTP " + last.responseStatus : last?.errorCode} · ${last?.responseDurationMs}ms`
                : `Replay ${deliveryLabel(d.status).toLowerCase()}: ${last?.responseStatus ? "HTTP " + last.responseStatus : last?.errorCode ?? "no response"}. It will keep retrying per the webhook's retry policy.`,
            });
            failed.reload(); retrying.reload(); detail.reload();
          } else if (ticks > 30) {
            clearInterval(poll.current);
            setRun({ phase: "done", deliveryId, error: "Still queued after 45s. Is the worker running? (npm run worker)" });
          }
        } catch (e) { clearInterval(poll.current); setRun({ phase: "done", deliveryId, error: e.message }); }
      }, 1500);
    } catch (e) {
      setRun({ phase: "done", deliveryId: null, error: e.message });
    }
  }

  return (
    <div>
      <h1 className="h1">Replay Centre</h1>
      <p className="sub">Re-deliver the stored event to a failed endpoint. The blockchain transaction is never resubmitted.</p>
      <ErrorBox error={failed.error || retrying.error} onRetry={() => { failed.reload(); retrying.reload(); }} />
      {notice && (
        <div className={"banner " + (notice.ok ? "ok" : "warn")} style={{ marginTop: 18, marginBottom: 0 }} role="status">
          <div>{notice.ok ? "✓ " : ""}{notice.text}</div>
          <span style={{ display: "flex", gap: 12 }}>
            <button className="link-btn" onClick={() => go("eventDetail", { id: notice.eventId })}>Open event →</button>
            <button className="link-btn" onClick={() => setNotice(null)}>Dismiss</button>
          </span>
        </div>
      )}
      {(failed.loading && !failed.data) ? <div style={{ marginTop: 24 }}><Loading /></div> : items.length === 0 ? (
        <div style={{ marginTop: 24 }}><Empty title="Nothing to replay">Failed and retrying deliveries appear here. You can also replay any event from its detail page.</Empty></div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr)", gap: 16, marginTop: 24 }}>
          <div className="panel" style={{ padding: 16 }}>
            <div className="mono" style={{ fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--faint)", padding: "0 4px 8px" }}>Failed or retrying ({items.length})</div>
            {items.map((d) => (
              <div key={d.id} className={"replay-row" + (sel && d.id === sel.id ? " on" : "")} onClick={() => { setSelected(d.id); setRun({ phase: "idle", deliveryId: null, error: null }); }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{d.event.eventName ?? "Undecoded log"}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 2 }}>{d.lastResponseStatus ? `HTTP ${d.lastResponseStatus}` : d.lastError} · {timeAgo(d.updatedAt)}</div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: deliveryColor(d.status) }}>×{d.attemptCount}</span>
              </div>
            ))}
          </div>

          <div style={{ background: "linear-gradient(170deg,#121016,#0d0d0d)", border: "1px solid #201d2b", borderRadius: 14, padding: 24 }}>
            <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>Selected event</div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 6 }}>{eventTitle(sel.event)}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 4 }}>block #{sel.event.blockNumber} · {sel.event.transactionHash.slice(0, 18)}…</div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 18 }}>
              <div style={{ background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 10, padding: 13 }}>
                <div style={{ fontSize: 11, color: "var(--dim)" }}>Delivery</div>
                <div style={{ fontSize: 14, color: deliveryColor(sel.status), marginTop: 4 }}>{deliveryLabel(sel.status)}</div>
              </div>
              <div style={{ background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 10, padding: 13 }}>
                <div style={{ fontSize: 11, color: "var(--dim)" }}>Last result</div>
                <div className="mono" style={{ fontSize: 13, marginTop: 4 }}>{sel.lastResponseStatus ? `HTTP ${sel.lastResponseStatus}` : sel.lastError ?? "—"}</div>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              {detail.data?.deliveries.filter((d) => d.id === sel.id).flatMap((d) => d.attempts).map((a) => (
                <div key={a.id} className="attempt">
                  <span style={{ color: a.responseStatus && a.responseStatus < 300 ? "var(--green)" : "var(--red)" }}>{a.responseStatus ?? a.errorCode}</span>
                  <span style={{ color: "var(--muted)" }}>attempt {a.attemptNumber}{a.sanitisedResponse ? ` · ${a.sanitisedResponse.slice(0, 80)}` : ""}</span>
                  <span style={{ color: "var(--fg-3)" }}>{a.responseDurationMs}ms</span>
                </div>
              ))}
            </div>

            {run.phase === "idle" && <button className="btn primary block" style={{ marginTop: 20, fontSize: 14, padding: 14, borderRadius: 11 }} onClick={replay}>Replay to this endpoint</button>}
            {run.phase === "running" && (
              <div style={{ marginTop: 20, background: "#151515", border: "1px solid #2a2740", color: "var(--accent)", fontWeight: 600, fontSize: 14, textAlign: "center", padding: 14, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                <span className="spinner" />Re-delivering…
              </div>
            )}
            {run.phase === "done" && run.error && <div className="banner error" style={{ marginTop: 20, marginBottom: 0 }}>{run.error}</div>}
            {run.phase === "done" && run.result && (
              <div style={{ marginTop: 20, borderRadius: 12, padding: 18, textAlign: "center", animation: "pop 0.4s ease both", ...(run.result.status === "delivered" ? { background: "#0e1611", border: "1px solid #1f3a2a" } : { background: "#160f10", border: "1px solid #3a1f22" }) }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: run.result.status === "delivered" ? "var(--green)" : "var(--red)" }}>{run.result.status === "delivered" ? "✓ Replay delivered" : `Replay ${deliveryLabel(run.result.status).toLowerCase()}`}</div>
                {run.result.attempts.at(-1) && <div className="mono" style={{ fontSize: 13, marginTop: 10, color: "var(--fg-2)" }}>{run.result.attempts.at(-1).responseStatus ? `HTTP ${run.result.attempts.at(-1).responseStatus}` : run.result.attempts.at(-1).errorCode} · {run.result.attempts.at(-1).responseDurationMs}ms</div>}
                <button className="link-btn" style={{ marginTop: 10 }} onClick={() => go("eventDetail", { id: sel.eventId })}>Open event →</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
