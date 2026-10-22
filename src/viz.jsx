import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { shortHash, timeAgo, useApi } from "./state.jsx";
import { DeliveryBadge, Empty, ErrorBox, Loading } from "./ui.jsx";
import { bucketByMinute, deliveryFlow, finalityProgress, fmtMs, groupByBlock, newIds } from "./viz.js";

/** Re-renders every `everyMs` so countdowns and "x ago" labels stay live. */
export function useNow(everyMs = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs, enabled]);
  return now;
}

const STEP_MARK = { done: "✓", failed: "✕", skipped: "–", current: "●", todo: "" };

/** Seen → Confirmed → Finalized, with the depth bar filling between the first two. Shows an Orphaned branch instead when the block was replaced. */
export function FinalityProgress({ status, blockNumber, headBlock }) {
  const f = useMemo(() => finalityProgress(status, blockNumber, headBlock), [status, blockNumber, headBlock]);
  return (
    <div className="viz" role="group" aria-label={`Finality: ${status}. ${f.summary}`}>
      <ol className="fin-steps">
        {f.steps.map((s, i) => (
          <li key={s.id} className={"fin-step " + s.state}>
            <span className="fin-mark" aria-hidden="true">{STEP_MARK[s.state]}</span>
            <span className="fin-label">{s.label}</span>
            <span className="fin-note">{s.note}</span>
            {i < f.steps.length - 1 && (
              <span className={"fin-link " + (f.steps[i + 1].state === "failed" ? "bad" : "")} aria-hidden="true">
                {i === 0 && !f.orphaned && <span className="fin-fill" style={{ width: `${Math.round(f.progress * 100)}%` }} />}
                {(i === 1 && s.state === "done") && <span className="fin-fill" style={{ width: "100%" }} />}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="viz-summary">{f.summary}</p>
    </div>
  );
}

/** A tiny three-segment meter for list rows: depth progress then finalized. */
export function FinalityMeter({ status, blockNumber, headBlock }) {
  const f = finalityProgress(status, blockNumber, headBlock);
  const cls = f.orphaned ? "orphaned" : status;
  return (
    <span className={"fin-meter " + cls} role="img" aria-label={`Finality ${status}${f.blocksDeep !== null && !f.orphaned ? `, ${f.blocksDeep} blocks deep` : ""}`} title={f.summary}>
      <i style={{ "--p": f.orphaned ? 1 : f.progress }} />
      <i style={{ "--p": status === "finalized" ? 1 : 0 }} />
    </span>
  );
}

/** One delivery as queued → attempts (with backoff waits) → outcome, with a live countdown to the next retry. */
export function DeliveryFlow({ delivery }) {
  const live = delivery.status === "retrying" || delivery.status === "pending";
  const now = useNow(1000, live);
  const flow = useMemo(() => deliveryFlow(delivery, now), [delivery, now]);
  return (
    <div className="viz" role="group" aria-label={`Delivery ${delivery.status}. ${flow.summary}`}>
      <div className="flow" role="list">
        {flow.nodes.map((n, i) => (
          <span key={n.id} role="listitem" className="flow-item">
            {i > 0 && <span className={"flow-line" + (n.kind === "wait" && n.pending ? " pending" : "")} aria-hidden="true" />}
            {n.kind === "queued" && <span className="node neutral"><b>{n.label}</b></span>}
            {n.kind === "wait" && (
              <span className={"node wait" + (n.pending ? " pending" : "")} title="Time between attempts">
                {n.pending && n.ms === 0 ? "retry due now" : `${n.label} ${n.ms === null ? "–" : fmtMs(n.ms)}`}
              </span>
            )}
            {n.kind === "attempt" && (
              <span className={"node " + (n.ok ? "ok" : "bad")} title={n.detail ?? undefined}>
                <b>{n.ok ? "✓" : "✕"} Attempt {n.n}</b>
                <small>{String(n.result)} · {fmtMs(n.durationMs)}</small>
                {!n.ok && <small>{n.retryable ? "will retry" : "permanent"}</small>}
              </span>
            )}
            {n.kind === "end" && (
              <span className={"node end " + n.tone}>
                <b>{n.tone === "ok" ? "✓" : n.tone === "bad" ? "✕" : "…"} {n.label}</b>
                {n.note && <small>{n.note}</small>}
              </span>
            )}
          </span>
        ))}
      </div>
      {flow.nodes.at(-1).note !== flow.summary && <p className="viz-summary">{flow.summary}</p>}
    </div>
  );
}

/** Mini bar chart of events per minute over the last 15 minutes. */
export function Sparkline({ values }) {
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <span className="spark" role="img" aria-label={`${total} events in the last ${values.length} minutes`}>
      {values.map((v, i) => <i key={i} style={{ height: `${v === 0 ? 6 : 12 + Math.round((v / max) * 88)}%` }} className={v ? "on" : ""} />)}
    </span>
  );
}

const MAX_ROWS = 20;

/**
 * The live stream: polls every few seconds, groups events under their block, animates new arrivals, and can be paused so you can
 * read without the list moving. While paused it counts what arrived.
 */
export function LiveTimeline({ projectId, headBlock, openEvent, go }) {
  const [paused, setPaused] = useState(false);
  const { data, error, loading, reload } = useApi(() => api.events(projectId, { limit: 40 }), [projectId], { refreshMs: 3000, enabled: !!projectId && !paused });
  const [frozen, setFrozen] = useState(null);
  const [fresh, setFresh] = useState(() => new Set());
  const seen = useRef(null);
  const items = data?.items;
  const now = useNow(5000);

  // detect arrivals; the very first load is not "news"
  useEffect(() => {
    if (!items) return;
    const added = newIds(seen.current, items);
    seen.current = new Set(items.map((e) => e.id));
    if (!added.length) return;
    setFresh((s) => new Set([...s, ...added]));
    const t = setTimeout(() => setFresh((s) => { const n = new Set(s); added.forEach((id) => n.delete(id)); return n; }), 6000);
    return () => clearTimeout(t);
  }, [items]);

  useEffect(() => { seen.current = null; setFresh(new Set()); setFrozen(null); }, [projectId]);

  function togglePause() {
    if (!paused) setFrozen(items ?? null);
    setPaused(!paused);
  }
  const shown = (paused ? frozen : items) ?? [];
  const arrivedWhilePaused = paused && items && frozen ? newIds(new Set(frozen.map((e) => e.id)), items).length : 0;
  const groups = groupByBlock(shown.slice(0, MAX_ROWS));
  const spark = bucketByMinute(shown, now, 15);

  return (
    <div className="panel tight timeline">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 className="h2" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          Live timeline
          <span className={"live-tag" + (paused ? " paused" : "")}><span className={"dot " + (paused ? "grey" : "live")} />{paused ? "paused" : "live"}</span>
        </h2>
        <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="spark-wrap"><Sparkline values={spark} /><small>per min · 15 min</small></span>
          <button className="btn secondary small" onClick={togglePause} aria-pressed={paused}>{paused ? (arrivedWhilePaused ? `Resume · ${arrivedWhilePaused} new` : "Resume") : "Pause"}</button>
          <button className="link-btn" onClick={() => go("events")}>View all →</button>
        </span>
      </div>
      <ErrorBox error={error && !items ? error : null} onRetry={reload} />
      {loading && !items && <Loading label="Loading events…" />}
      {items && shown.length === 0 && <Empty title="No events captured yet">Register a contract and trigger a transaction, and it will appear here within seconds.</Empty>}
      <div className="tl" aria-live={paused ? "off" : "polite"}>
        {groups.map((g) => {
          const depth = Number.isInteger(headBlock) ? Math.max(0, headBlock - g.block) : null;
          return (
            <section key={g.block} className="tl-block">
              <header><span className="mono">Block #{g.block.toLocaleString()}</span>{depth !== null && <small>{depth === 0 ? "head" : `${depth} deep`}</small>}</header>
              {g.events.map((e) => (
                <button key={e.id} type="button" className={"tl-event" + (fresh.has(e.id) ? " fresh" : "") + (e.finalityStatus === "orphaned" ? " orphaned" : "")} onClick={() => openEvent(e.id)}>
                  <FinalityMeter status={e.finalityStatus} blockNumber={e.blockNumber} headBlock={headBlock} />
                  <span className="tl-main">
                    <span className="tl-name">{e.eventName ?? "Undecoded log"}{fresh.has(e.id) && <em className="new-tag">new</em>}</span>
                    <span className="mono tl-sub">{shortHash(e.contractAddress, 8, 6)} · {shortHash(e.transactionHash, 8, 4)}</span>
                  </span>
                  <span className="tl-right">
                    <DeliveryBadge delivery={e.delivery} />
                    <small>{timeAgo(e.observedAt, now)}</small>
                  </span>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
