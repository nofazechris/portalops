import { useEffect, useState } from "react";
import { api } from "../api.js";
import { shortHash, timeAgo, useApi, useSession } from "../state.jsx";
import { CopyButton, DeliveryBadge, Empty, ErrorBox, FinalityBadge, Loading, NeedsProject, ReadOnlyNote, deliveryColor, deliveryLabel } from "../ui.jsx";
import { eventSub, eventTitle } from "./Overview.jsx";
import { DeliveryFlow, FinalityProgress } from "../viz.jsx";

const FILTERS = [
  { label: "All", params: {} },
  { label: "Delivered", params: { delivery: "delivered" } },
  { label: "Failed", params: { delivery: "failed" } },
  { label: "Retrying", params: { delivery: "retrying" } },
  { label: "Finalized", params: { finality: "finalized" } },
  { label: "Orphaned", params: { finality: "orphaned" } },
];
const COLS = "1.5fr 1.1fr 1fr 0.8fr 0.9fr 1fr";
const PAGE = 25;

export function Events({ openEvent }) {
  const { projectId, readOnly } = useSession();
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [search]);

  const params = { ...FILTERS.find((f) => f.label === filter).params, q, limit: PAGE, offset };
  const { data, error, loading, reload } = useApi(() => api.events(projectId, params), [projectId, filter, q, offset], { refreshMs: 6000, enabled: !!projectId });

  if (!projectId) return <NeedsProject what="browse your events" />;
  return (
    <div>
      <h1 className="h1">Events</h1>
      <p className="sub">Every normalized event ingested from the chain, with its delivery state.</p>
      {readOnly && <div style={{ marginTop: 16 }}><ReadOnlyNote /></div>}
      <div style={{ display: "flex", gap: 12, marginTop: 22, flexWrap: "wrap", alignItems: "center" }}>
        <div className="chips">
          {FILTERS.map((f) => <button key={f.label} className={"chip" + (f.label === filter ? " on" : "")} onClick={() => { setFilter(f.label); setOffset(0); }}>{f.label}</button>)}
        </div>
        <input className="input mono" style={{ maxWidth: 340, marginLeft: "auto" }} placeholder="Search tx hash, contract or event name" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search events" />
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <div style={{ marginTop: 16 }}><Loading /></div> : data && (
        <>
          <div className="table" style={{ marginTop: 16 }}>
            <div className="tr head" style={{ gridTemplateColumns: COLS }}><span>Event</span><span>Contract</span><span>Transaction</span><span>Block</span><span>Chain status</span><span style={{ textAlign: "right" }}>Delivery</span></div>
            {data.items.length === 0 && <div style={{ padding: 8 }}><Empty title={q || filter !== "All" ? "No events match" : "No events yet"}>{q || filter !== "All" ? "Try clearing the search or filter." : "Nothing has been captured for this project yet."}</Empty></div>}
            {data.items.map((e) => (
              <div key={e.id} className="tr clickable" style={{ gridTemplateColumns: COLS }} onClick={() => openEvent(e.id)}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{eventTitle(e)}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis" }}>{e.eventName ? timeAgo(e.observedAt) : eventSub(e)}</div>
                </div>
                <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }} title={e.contractAddress}>{shortHash(e.contractAddress, 8, 6)}</span>
                <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }} title={e.transactionHash}>{shortHash(e.transactionHash, 8, 4)}</span>
                <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>#{e.blockNumber}</span>
                <span><FinalityBadge status={e.finalityStatus} /></span>
                <span style={{ textAlign: "right" }}><DeliveryBadge delivery={e.delivery} /></span>
              </div>
            ))}
          </div>
          <div className="pager">
            <span>{data.total === 0 ? "0 events" : `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total.toLocaleString()}`}</span>
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn secondary small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Newer</button>
              <button className="btn secondary small" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Older →</button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const Field = ({ label, children, mono = true }) => (
  <div style={{ background: "#0f0f0f", padding: "14px 16px", minWidth: 0 }}>
    <div style={{ fontSize: 11, color: "var(--dim)" }}>{label}</div>
    <div className={mono ? "mono" : ""} style={{ fontSize: 12.5, marginTop: 5, color: "var(--fg-2)", wordBreak: "break-all" }}>{children}</div>
  </div>
);

export function EventDetail({ id, go }) {
  const { readOnly } = useSession();
  const { data: e, error, loading, reload } = useApi(() => api.event(id), [id], { refreshMs: 4000 });
  const [replayMsg, setReplayMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const net = useApi(() => api.networkStatus(e?.projectId), [e?.projectId], { refreshMs: 6000, enabled: !!e?.projectId });

  async function replay() {
    setBusy(true); setReplayMsg(null);
    try {
      const r = await api.replay(id);
      setReplayMsg({ ok: true, text: `Replay queued (${r.deliveryIds.length} delivery). The stored payload will be re-sent; the transaction is not resubmitted.` });
      reload();
    } catch (err) {
      setReplayMsg({ ok: false, text: err.message });
    } finally { setBusy(false); }
  }

  if (loading && !e) return <Loading />;
  if (error && !e) return <><button className="back" onClick={() => go("events")}>← Events</button><ErrorBox error={error} onRetry={reload} /></>;

  const payload = e.payload ? JSON.stringify(e.payload, null, 2) : null;
  return (
    <div>
      <button className="back" onClick={() => go("events")}>← Events</button>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
        <h1 className="h1">{eventTitle(e)}</h1>
        <FinalityBadge status={e.finalityStatus} />
      </div>
      <div className="mono" style={{ fontSize: 12, color: "var(--dim)", marginTop: 6 }}>{e.id}</div>

      <div className="panel" style={{ marginTop: 18 }}>
        <h2 className="h2 sm">Finality</h2>
        <FinalityProgress status={e.finalityStatus} blockNumber={e.blockNumber} headBlock={net.data?.headBlock ?? null} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 1, background: "#1a1a1a", border: "1px solid #1f1f1f", borderRadius: 14, overflow: "hidden", marginTop: 20 }}>
        <Field label="Contract">{e.contractAddress}</Field>
        <Field label="Transaction hash">{e.transactionHash} <CopyButton text={e.transactionHash} /></Field>
        <Field label="Block">#{e.blockNumber} · log index {e.eventIndex}</Field>
        <Field label="Block hash">{e.blockHash}</Field>
        <Field label="Observed by PortalOps">{new Date(e.observedAt).toLocaleString()}</Field>
        <Field label="Network" mono={false}>{e.network}</Field>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: 16, marginTop: 16 }}>
        <div className="stack" style={{ gap: 16 }}>
          <div className="code-box">
            <div className="code-head"><span>{payload ? "decoded payload" : "raw log (no ABI registered for this contract)"}</span><CopyButton text={payload ?? JSON.stringify({ topics: e.topics, data: e.data }, null, 2)} /></div>
            <pre>{payload ?? JSON.stringify({ topics: e.topics, data: e.data }, null, 2)}</pre>
          </div>
          {payload && <div className="code-box"><div className="code-head"><span>raw log</span></div><pre>{JSON.stringify({ topics: e.topics, data: e.data }, null, 2)}</pre></div>}
        </div>

        <div className="stack" style={{ gap: 12 }}>
          {!readOnly && (
            <div className="panel">
              <h2 className="h2 sm">Actions</h2>
              <div className="stack" style={{ gap: 9, marginTop: 12 }}>
                <button className="btn primary block" disabled={busy} onClick={replay}>{busy ? "Queuing…" : "Replay to all endpoints"}</button>
                <button className="btn secondary block" onClick={() => go("diagnostics")}>Diagnose failures</button>
              </div>
              {replayMsg && <div className={"banner " + (replayMsg.ok ? "ok" : "error")} style={{ marginTop: 12, marginBottom: 0 }}>{replayMsg.text}</div>}
              <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 12, lineHeight: 1.5 }}>Replay re-sends the stored payload with the same event id, so consumers can de-duplicate.</div>
            </div>
          )}
          <div className="panel">
            <h2 className="h2 sm">Delivery history</h2>
            {readOnly ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 10 }}>Delivery history is private to project owners.</div>
              : e.deliveries.length === 0 ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 10 }}>No delivery was created for this event. Add a webhook endpoint and replay it.</div>
              : e.deliveries.map((d) => (
                <div key={d.id} style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #1a1a1a" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                    <span style={{ color: deliveryColor(d.status) }}>{deliveryLabel(d.status)}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>{d.kind} · {timeAgo(d.updatedAt)}</span>
                  </div>
                  <DeliveryFlow delivery={d} />
                  {d.attempts.length > 0 && (
                    <details style={{ marginTop: 10 }}>
                      <summary style={{ fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>Attempt details</summary>
                      {d.attempts.map((a) => (
                        <div key={a.id} className="attempt">
                          <span style={{ color: a.responseStatus && a.responseStatus < 300 ? "var(--green)" : "var(--red)" }}>{a.responseStatus ?? a.errorCode}</span>
                          <span style={{ color: "var(--muted)" }}>attempt {a.attemptNumber}</span>
                          <span style={{ color: "var(--fg-3)" }}>{a.responseDurationMs}ms</span>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
