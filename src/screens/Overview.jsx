import { api } from "../api.js";
import { timeAgo, shortHash, useApi, useSession } from "../state.jsx";
import { ErrorBox, Loading, NeedsProject, ReadOnlyNote } from "../ui.jsx";
import { LiveTimeline } from "../viz.jsx";

export const eventTitle = (e) => e.eventName ?? "Undecoded log";
export const eventSub = (e) => (e.eventName ? e.contractAddress : `topic0 ${shortHash(e.topics?.[0] ?? "", 10, 4)}`);

const connDot = { connected: "green", disconnected: "red", wrong_chain: "amber" };
const connText = { connected: "Connected", disconnected: "Disconnected", wrong_chain: "Wrong chain" };
const ingestText = { never_run: "Not started", healthy: "Healthy", stalled: "Stalled", unknown: "Unknown" };

export default function Overview({ openEvent, go }) {
  const { projectId, readOnly } = useSession();
  const { data, error, loading, reload } = useApi(() => api.overview(projectId), [projectId], { refreshMs: 6000, enabled: !!projectId });

  if (!projectId) return <NeedsProject what="see your overview" />;
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const { metrics, network, recentFailures, setup, nextAction } = data;

  return (
    <div>
      <h1 className="h1">Overview</h1>
      <p className="sub">{data.project.name} · {network.network}</p>
      {readOnly && <div style={{ marginTop: 16 }}><ReadOnlyNote /></div>}
      {error && <ErrorBox error={error} onRetry={reload} />}

      <div className="grid" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))", marginTop: 24 }}>
        <div className="card accent">
          <div className="stat-label">Events received</div>
          <div className="stat-value" style={{ color: "var(--accent)" }}>{metrics.eventsReceived.toLocaleString()}</div>
          <div className="stat-note">last {timeAgo(network.lastEventObservedAt)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Deliveries succeeded</div>
          <div className="stat-value">{metrics.delivered.toLocaleString()}</div>
          <div className="stat-note">{metrics.pending + metrics.retrying > 0 ? `${metrics.pending + metrics.retrying} in flight` : "none in flight"}</div>
        </div>
        <div className="card">
          <div className="stat-label">Deliveries failed</div>
          <div className="stat-value" style={{ color: metrics.failed ? "var(--red)" : undefined }}>{metrics.failed.toLocaleString()}</div>
          <div className="stat-note" style={{ color: metrics.failed ? "var(--red)" : undefined }}>{metrics.failed ? "needs replay" : "no failures"}</div>
        </div>
        <div className="card">
          <div className="stat-label">Active webhooks</div>
          <div className="stat-value">{metrics.activeWebhooks}</div>
          <div className="stat-note">{readOnly ? "sign in to add" : metrics.activeWebhooks ? "enabled" : "none configured"}</div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", gap: 16, marginTop: 16 }}>
        <LiveTimeline projectId={projectId} headBlock={network.headBlock} openEvent={openEvent} go={go} />

        <div className="stack" style={{ gap: 16 }}>
          <div className="panel">
            <h2 className="h2 sm" style={{ marginBottom: 12 }}>Network</h2>
            <div className="kv"><span className="k">Connection</span><span className="v"><span className={"dot " + (connDot[network.connection] ?? "grey")} style={{ marginRight: 8 }} />{connText[network.connection]}</span></div>
            <div className="kv"><span className="k">Head block</span><span className="v mono">{network.headBlock !== null ? `#${network.headBlock.toLocaleString()}` : "unknown"}</span></div>
            <div className="kv"><span className="k">Ingestion</span><span className="v">{ingestText[network.ingestion]}{network.lagBlocks !== null ? ` · ${network.lagBlocks} block lag` : ""}</span></div>
            <div className="kv"><span className="k">Last ingested</span><span className="v">{timeAgo(network.lastIngestionAt)}</span></div>
            {network.rpcError && <div className="field-error" style={{ marginTop: 8 }}>{network.rpcError}</div>}
          </div>

          {!readOnly && (
            <div className="ai-card">
              <div className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>// setup {setup.completed}/{setup.total}</div>
              <div className="checklist">
                {[["networkConnected", "Network connected"], ["contractAdded", "Contract registered"], ["webhookConfigured", "Webhook endpoint added"], ["firstEventReceived", "First event captured"], ["firstDeliverySucceeded", "First delivery succeeded"]].map(([k, label]) => (
                  <div key={k} className={"check" + (setup[k] ? " done" : "")}><span className="box">{setup[k] ? "✓" : ""}</span>{label}</div>
                ))}
              </div>
              {nextAction && <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 14, lineHeight: 1.5 }}><span style={{ color: "var(--accent)" }}>Next: </span>{nextAction}</div>}
              {setup.completed < setup.total && <button className="btn primary small" style={{ marginTop: 12 }} onClick={() => go("setup")}>{setup.completed <= 1 ? "Start guided setup" : "Continue guided setup"}</button>}
            </div>
          )}

          {!readOnly && recentFailures.length > 0 && (
            <div className="panel">
              <h2 className="h2 sm" style={{ marginBottom: 8 }}>Recent delivery failures</h2>
              {recentFailures.map((f) => (
                <div key={f.deliveryId} className="row-sep">
                  <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{f.eventName ?? "Undecoded log"}</span>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--red)" }}>{f.lastResponseStatus ?? f.lastError}</span>
                </div>
              ))}
              <button className="link-btn" style={{ marginTop: 10 }} onClick={() => go("replay")}>Open Replay Centre →</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
