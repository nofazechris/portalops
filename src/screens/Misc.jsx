import { useMemo, useState } from "react";
import { api } from "../api.js";
import { shortHash, timeAgo, useApi, useSession } from "../state.jsx";
import { ConfirmDialog, CopyButton, Empty, ErrorBox, Field, Loading, Modal, NeedsProject, PageHead, ReadOnlyNote, deliveryLabel, fieldErrors } from "../ui.jsx";
import { apiEndpoints, sdkSnippet, signatureSnippet } from "../data.js";

// ------------------------------------------------------------------ Logs
const LEVEL_COLOR = { info: "var(--fg-3)", warn: "var(--amber)", error: "var(--red)" };

export function Logs() {
  const { projectId, readOnly } = useSession();
  const { data, error, loading, reload } = useApi(() => api.logs(projectId, 300), [projectId], { refreshMs: 5000, enabled: !!projectId && !readOnly });
  const [level, setLevel] = useState("all");
  const [area, setArea] = useState("all");
  const [text, setText] = useState("");
  const areas = useMemo(() => [...new Set((data ?? []).map((l) => l.area))].sort(), [data]);
  if (readOnly) return <NeedsProject what="read operational logs" />;

  const rows = (data ?? []).filter((l) => (level === "all" || l.level === level) && (area === "all" || l.area === area) && (!text || (l.message + JSON.stringify(l.meta ?? "")).toLowerCase().includes(text.toLowerCase())));
  return (
    <div>
      <h1 className="h1">Logs</h1>
      <p className="sub">Operational log of ingestion, webhook attempts, replays and configuration. Credentials are redacted before storage.</p>
      <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap", alignItems: "center" }}>
        <div className="chips">{["all", "info", "warn", "error"].map((l) => <button key={l} className={"chip" + (level === l ? " on" : "")} onClick={() => setLevel(l)}>{l}</button>)}</div>
        <select className="select" style={{ width: 150 }} value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area">
          <option value="all">All areas</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input className="input mono" style={{ maxWidth: 280, marginLeft: "auto" }} placeholder="Search logs" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search logs" />
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <div style={{ marginTop: 16 }}><Loading /></div> : rows.length === 0 ? <div style={{ marginTop: 16 }}><Empty title="No log entries">Nothing matches, or nothing has happened yet.</Empty></div> : (
        <div className="mono" style={{ marginTop: 16, background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: 14, padding: "10px 18px", fontSize: 12.5 }}>
          {rows.map((l, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "88px 78px 90px 1fr", gap: 12, padding: "7px 0", borderBottom: "1px solid #141414" }}>
              <span style={{ color: "var(--faint)" }} title={l.createdAt}>{new Date(l.createdAt).toLocaleTimeString()}</span>
              <span style={{ color: LEVEL_COLOR[l.level] }}>{l.level.toUpperCase()}</span>
              <span style={{ color: "var(--accent)" }}>{l.area}</span>
              <span style={{ color: "var(--muted)", wordBreak: "break-word" }}>{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Contracts
function parseAbi(text) {
  if (!text.trim()) return undefined;
  let v;
  try { v = JSON.parse(text); } catch { throw new Error("ABI is not valid JSON."); }
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.abi)) return v.abi; // compiler artifact
  throw new Error("Paste the ABI array, or a compiler artifact that has an \"abi\" field.");
}

function AddContractModal({ projectId, onClose, onAdded }) {
  const [f, setF] = useState({ address: "", name: "", abi: "", startBlock: "" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(ev) {
    ev.preventDefault(); setBusy(true); setErr(null);
    try {
      const body = { address: f.address.trim() };
      if (f.name.trim()) body.name = f.name.trim();
      const abi = parseAbi(f.abi); if (abi) body.abi = abi;
      if (f.startBlock.trim()) body.startBlock = Number(f.startBlock);
      await api.addContract(projectId, body);
      onAdded();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const fe = fieldErrors(err);
  return (
    <Modal title="Register contract" onClose={onClose} wide>
      <form noValidate onSubmit={submit}>
        <Field label="Contract address" error={fe.address}><input className="input mono" autoFocus placeholder="0x…" value={f.address} onChange={set("address")} required /></Field>
        <Field label="Name (optional)" error={fe.name}><input className="input" value={f.name} onChange={set("name")} /></Field>
        <Field label="ABI (optional)" hint="Without an ABI, logs are stored raw and undecoded." error={fe.abi}><textarea className="textarea mono" value={f.abi} onChange={set("abi")} placeholder='[{"type":"event","name":"QuestCreated", …}]' /></Field>
        <Field label="Start block (optional)" hint="Capture from this block. Defaults to roughly the last 1,000 blocks." error={fe.startBlock}><input className="input mono" inputMode="numeric" value={f.startBlock} onChange={set("startBlock")} /></Field>
        {err && !err.details && <div className="field-error" style={{ marginBottom: 10 }}>{err.message}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Registering…" : "Register contract"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Contracts() {
  const { projectId, readOnly } = useSession();
  const { data, error, loading, reload } = useApi(() => api.contracts(projectId), [projectId], { refreshMs: 8000, enabled: !!projectId });
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState({});
  if (!projectId) return <NeedsProject what="register contracts" />;

  async function test(id) {
    setTests((t) => ({ ...t, [id]: { busy: true } }));
    try {
      const data = await api.testContract(id);
      setTests((t) => ({ ...t, [id]: { done: true, data } }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { done: true, err: e.message } }));
    }
  }
  return (
    <div>
      <PageHead title="Contracts" sub="Contracts PortalOps is monitoring for this project." action={!readOnly && <button className="btn primary" onClick={() => setAdding(true)}>Register contract</button>} />
      {readOnly && <div style={{ marginTop: 16 }}><ReadOnlyNote /></div>}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <div style={{ marginTop: 24 }}><Loading /></div> : data?.length === 0 ? (
        <div style={{ marginTop: 24 }}><Empty title={readOnly ? "The public explorer watches every contract" : "No contracts registered"}>{readOnly ? "Individual contracts are listed in the Events view." : "Register an address and PortalOps will capture its events."}</Empty></div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", marginTop: 24 }}>
          {data?.map((c) => {
            const t = tests[c.id];
            return (
              <div key={c.id} className="card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{c.name || "Contract"}</span>
                  <span className="pill" style={{ color: "var(--green)" }}>{c.status}</span>
                </div>
                <div className="mono" style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, wordBreak: "break-all" }}>{c.address} <CopyButton text={c.address} /></div>
                <div style={{ display: "flex", gap: 22, marginTop: 14, paddingTop: 12, borderTop: "1px solid #1a1a1a" }}>
                  <div><div style={{ fontSize: 11, color: "var(--dim)" }}>Events captured</div><div style={{ fontSize: 16, fontWeight: 600, marginTop: 3 }}>{c.eventCount}</div></div>
                  <div><div style={{ fontSize: 11, color: "var(--dim)" }}>Decoding</div><div style={{ fontSize: 13, marginTop: 5 }}>{c.hasAbi ? `${c.events.length} event type(s)` : "no ABI (raw logs)"}</div></div>
                  <div><div style={{ fontSize: 11, color: "var(--dim)" }}>From block</div><div className="mono" style={{ fontSize: 13, marginTop: 5 }}>{c.startBlock ?? "recent"}</div></div>
                </div>
                {c.events.length > 0 && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-3)" }}>{c.events.join(" · ")}</div>}
                {!readOnly && (
                  <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
                    <button className="btn secondary small" disabled={t?.busy} onClick={() => test(c.id)}>Check code on chain</button>
                    {t?.done && <span style={{ fontSize: 12, color: t.err ? "var(--red)" : t.data.codeFound ? "var(--green)" : "var(--amber)" }}>{t.err ?? t.data.note}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {adding && <AddContractModal projectId={projectId} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

// ----------------------------------------------------------- Automations
function AutomationModal({ projectId, onClose, onCreated }) {
  const eps = useApi(() => api.webhooks(projectId), [projectId]);
  const cts = useApi(() => api.contracts(projectId), [projectId]);
  const [f, setF] = useState({ name: "", event: "", contract: "", endpoint: "" });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(ev) {
    ev.preventDefault(); setErr(null);
    try {
      await api.createAutomation(projectId, { name: f.name.trim(), triggerEventName: f.event.trim() || null, triggerContract: f.contract || null, endpointId: f.endpoint });
      onCreated();
    } catch (e) { setErr(e); }
  }
  const fe = fieldErrors(err);
  return (
    <Modal title="New automation" onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <Field label="Name" error={fe.name}><input className="input" autoFocus value={f.name} onChange={set("name")} required /></Field>
        <Field label="WHEN event name (optional)" hint="Empty matches any event." error={fe.triggerEventName}><input className="input mono" placeholder="QuestCompleted" value={f.event} onChange={set("event")} /></Field>
        <Field label="ON contract (optional)" error={fe.triggerContract}>
          <select className="select" value={f.contract} onChange={set("contract")}><option value="">Any contract</option>{cts.data?.map((c) => <option key={c.id} value={c.address}>{c.name || c.address}</option>)}</select>
        </Field>
        <Field label="THEN send webhook to" error={fe.endpointId}>
          <select className="select" value={f.endpoint} onChange={set("endpoint")} required><option value="">Select endpoint…</option>{eps.data?.map((w) => <option key={w.id} value={w.id}>{w.description || w.url}</option>)}</select>
        </Field>
        {eps.data?.length === 0 && <div className="field-hint" style={{ marginBottom: 12 }}>Create a webhook first.</div>}
        {err && !err.details && <div className="field-error" style={{ marginBottom: 10 }}>{err.message}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary">Create automation</button>
        </div>
      </form>
    </Modal>
  );
}

export function Automations() {
  const { projectId, readOnly } = useSession();
  const { data, error, loading, reload } = useApi(() => api.automations(projectId), [projectId], { enabled: !!projectId && !readOnly });
  const eps = useApi(() => api.webhooks(projectId), [projectId], { enabled: !!projectId && !readOnly });
  const [adding, setAdding] = useState(false);
  if (readOnly) return <NeedsProject what="create automations" />;
  const epName = (id) => { const w = eps.data?.find((x) => x.id === id); return w ? w.description || w.url : id; };
  return (
    <div>
      <PageHead title="Automations" sub="When an event matches, deliver it to a webhook. Rules run at ingestion time and appear in Logs." action={<button className="btn primary" onClick={() => setAdding(true)}>New automation</button>} />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <div style={{ marginTop: 24 }}><Loading /></div> : data?.length === 0 ? <div style={{ marginTop: 24 }}><Empty title="No automations">Rules let you route specific events to specific endpoints.</Empty></div> : (
        <div className="stack" style={{ marginTop: 24, gap: 14, maxWidth: 560 }}>
          {data?.map((a) => (
            <div key={a.id} className="card" style={{ opacity: a.enabled ? 1 : 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{a.name}</span>
                <span style={{ display: "flex", gap: 12 }}>
                  <button className="link-btn" onClick={async () => { await api.setAutomationEnabled(a.id, !a.enabled); reload(); }}>{a.enabled ? "Disable" : "Enable"}</button>
                  <button className="link-btn danger" onClick={async () => { await api.deleteAutomation(a.id); reload(); }}>Delete</button>
                </span>
              </div>
              <div className="kv"><span className="k mono" style={{ color: "var(--accent)" }}>WHEN</span><span className="v">{a.triggerEventName ?? "any event"}</span></div>
              <div className="kv"><span className="k mono" style={{ color: "var(--accent-deep)" }}>ON</span><span className="v mono" style={{ fontSize: 12 }}>{a.triggerContract ? shortHash(a.triggerContract, 10, 6) : "any contract"}</span></div>
              <div className="kv"><span className="k mono" style={{ color: "var(--accent)" }}>THEN</span><span className="v">Send webhook → {epName(a.endpointId)}</span></div>
            </div>
          ))}
        </div>
      )}
      {adding && <AutomationModal projectId={projectId} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

// ----------------------------------------------------------- Diagnostics
/** Deterministic reading of recorded delivery evidence. No model, no guessing beyond what the attempts show. */
function diagnose(delivery) {
  const attempts = delivery.attempts ?? [];
  const last = attempts.at(-1);
  const facts = [];
  const statuses = attempts.map((a) => a.responseStatus ?? a.errorCode);
  facts.push(`${attempts.length} attempt(s) recorded: ${statuses.join(", ") || "none"}.`);
  if (attempts.length >= 2) {
    const first = attempts[0].responseDurationMs, lastMs = last.responseDurationMs;
    if (first > 0 && lastMs / first >= 2) facts.push(`Response time rose ${(lastMs / first).toFixed(1)}× between the first (${first}ms) and last (${lastMs}ms) attempt.`);
  }
  if (last?.sanitisedResponse) facts.push(`The destination replied: “${last.sanitisedResponse.slice(0, 160)}”.`);

  let cause = "There is not enough recorded evidence to name a cause.";
  const s = last?.responseStatus, code = last?.errorCode;
  if (s === 401 || s === 403) cause = "The destination rejected the request as unauthorised. If it verifies the PortalOps signature, the secret in your receiver probably does not match this webhook's secret (rotate it and update the receiver).";
  else if (s >= 500) cause = "The destination server returned an internal error while handling the request. The failure is on the receiving side; check its logs for the same time window.";
  else if (s === 404 || s === 405) cause = "The destination does not serve this route or method. Check the endpoint path.";
  else if (s >= 400) cause = "The destination rejected the payload as invalid (HTTP " + s + "). Compare its validation rules with the delivered body.";
  else if (code === "timeout") cause = "The destination did not respond within the timeout, so no status was received.";
  else if (code === "ECONNREFUSED") cause = "Nothing is listening at the destination address (connection refused).";
  else if (code === "ENOTFOUND" || code === "invalid_url") cause = "The destination host could not be resolved or the URL is invalid.";
  else if (code === "blocked_target") cause = "The destination resolves to a private or otherwise blocked address, which PortalOps refuses to contact.";
  return { facts, cause };
}

export function Diagnostics({ go }) {
  const { projectId, readOnly } = useSession();
  const failed = useApi(() => api.deliveries(projectId, { status: "failed", limit: 20 }), [projectId], { enabled: !!projectId && !readOnly });
  const [pick, setPick] = useState(null);
  const sel = failed.data?.find((d) => d.id === pick) ?? failed.data?.[0];
  const ev = useApi(() => api.event(sel.eventId), [sel?.eventId], { enabled: !!sel });
  if (readOnly) return <NeedsProject what="diagnose failed deliveries" />;
  const delivery = ev.data?.deliveries.find((d) => d.id === sel?.id);
  const dx = delivery ? diagnose(delivery) : null;

  return (
    <div>
      <h1 className="h1">Diagnostics</h1>
      <p className="sub">An explanation of why a delivery failed, derived only from the attempts PortalOps recorded.</p>
      <ErrorBox error={failed.error} onRetry={failed.reload} />
      {failed.loading && !failed.data ? <div style={{ marginTop: 24 }}><Loading /></div> : !sel ? <div style={{ marginTop: 24 }}><Empty title="No failed deliveries">Nothing to diagnose right now.</Empty></div> : (
        <div style={{ marginTop: 24, maxWidth: 680, background: "linear-gradient(170deg,#121016,#0d0d0d)", border: "1px solid #201d2b", borderRadius: 16, padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Why did this delivery fail?</span>
            {failed.data.length > 1 && (
              <select className="select" style={{ width: 240, marginLeft: "auto" }} value={sel.id} onChange={(e) => setPick(e.target.value)}>
                {failed.data.map((d) => <option key={d.id} value={d.id}>{d.event.eventName ?? "Raw log"} · {timeAgo(d.updatedAt)}</option>)}
              </select>
            )}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>{deliveryLabel(sel.status)} · event {sel.eventId.slice(0, 16)}…</div>
          {!dx ? <div style={{ marginTop: 16 }}><Loading /></div> : (
            <>
              <div style={{ marginTop: 16, fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--dim)" }}>PortalOps recorded</div>
              <div className="stack" style={{ gap: 8, marginTop: 10, fontSize: 14, color: "var(--fg-2)" }}>
                {dx.facts.map((f, i) => <div key={i} style={{ display: "flex", gap: 10 }}><span style={{ color: "var(--accent)" }}>•</span><span>{f}</span></div>)}
              </div>
              <div style={{ marginTop: 18, background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--dim)" }}>Likely cause</div>
                <div style={{ fontSize: 14, marginTop: 7, lineHeight: 1.5 }}>{dx.cause}</div>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>Rule-based analysis of recorded evidence; no AI model is used.</div>
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

// --------------------------------------------------------------- API / SDK
export function ApiSdk() {
  const base = `${window.location.origin}/api/v1`;
  return (
    <div>
      <h1 className="h1">API / SDK</h1>
      <p className="sub">The REST API the dashboard itself uses, and how to verify webhook signatures.</p>

      <div className="eyebrow" style={{ margin: "28px 0 12px" }}>REST API</div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="card" style={{ borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Base URL</div>
          <div className="mono" style={{ fontSize: 13, marginTop: 8, color: "var(--fg-2)", wordBreak: "break-all" }}>{base} <CopyButton text={base} /></div>
        </div>
        <div className="card" style={{ borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Authentication</div>
          <div style={{ fontSize: 13, marginTop: 8, color: "var(--fg-2)", lineHeight: 1.5 }}><span className="mono">Authorization: Bearer pops_…</span><br />Create a project key under <strong>Settings → API keys</strong> (read or write). Keys never expire silently: revoke them there.</div>
        </div>
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 className="h2 sm" style={{ marginBottom: 14 }}>Endpoints</h2>
        {apiEndpoints.map((ep) => (
          <div key={ep.method + ep.path} className="mono" style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 14, alignItems: "center", padding: "8px 0", borderTop: "1px solid #1a1a1a", fontSize: 12.5 }}>
            <span style={{ color: ep.color, fontWeight: 500 }}>{ep.method}</span><span style={{ color: "var(--fg-2)" }}>{ep.path}</span>
          </div>
        ))}
      </div>

      <div className="eyebrow" style={{ margin: "28px 0 12px" }}>TypeScript SDK</div>
      <div className="code-box" style={{ maxWidth: 720 }}>
        <div className="code-head"><span>app.ts</span><CopyButton text={sdkSnippet} /></div>
        <pre style={{ fontSize: 12.5 }}>{sdkSnippet}</pre>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8, maxWidth: 720, lineHeight: 1.5 }}>The SDK lives in <span className="mono">packages/sdk</span> of the PortalOps repository and is not published to npm yet. Build it with <span className="mono">npm run sdk:build</span>.</div>

      <div className="eyebrow" style={{ margin: "28px 0 12px" }}>Verifying webhook signatures</div>
      <div className="code-box" style={{ maxWidth: 720 }}>
        <div className="code-head"><span>verify.mjs</span><CopyButton text={signatureSnippet} /></div>
        <pre style={{ fontSize: 12.5 }}>{signatureSnippet}</pre>
      </div>
    </div>
  );
}


function ApiKeysPanel({ projectId }) {
  const { data, error, reload } = useApi(() => api.apiKeys(projectId), [projectId]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("read");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [fresh, setFresh] = useState(null);

  async function create(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setFresh(await api.createApiKey(projectId, { name: name.trim(), scope })); setName(""); reload(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  }
  const [confirming, setConfirming] = useState(null);
  const [revoking, setRevoking] = useState(false);
  async function revoke() {
    setRevoking(true);
    try { await api.revokeApiKey(confirming.id); setConfirming(null); reload(); } catch (x) { setConfirming(null); setErr(x); } finally { setRevoking(false); }
  }
  const active = (data ?? []).filter((k) => !k.revokedAt);
  return (
    <div className="panel" style={{ marginTop: 14, maxWidth: 560 }}>
      {confirming && (
        <ConfirmDialog title="Revoke this API key?" confirmLabel="Revoke key" danger busy={revoking} onConfirm={revoke} onCancel={() => setConfirming(null)}>
          <strong>{confirming.name}</strong> will stop working immediately. Anything using it (servers, scripts, Claude) will start getting <span className="mono">invalid_api_key</span> errors. This cannot be undone, but you can create a new key.
        </ConfirmDialog>
      )}
      <h2 className="h2 sm">API keys</h2>
      <div style={{ fontSize: 12.5, color: "var(--muted)", margin: "4px 0 12px", lineHeight: 1.5 }}>
        For servers and scripts. A key works inside this project only. <strong>Read</strong> keys can only fetch data; <strong>write</strong> keys can also manage webhooks and replay events. Keys cannot create projects or other keys.
      </div>
      <ErrorBox error={error} />
      {fresh && (
        <div className="banner warn" style={{ display: "block" }}>
          <strong>Copy your new key now.</strong> It is shown once and cannot be retrieved later.
          <div className="secret-box" style={{ margin: "10px 0" }}>{fresh.key}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <CopyButton text={fresh.key} label="Copy key" className="btn primary small" />
            <button className="btn secondary small" onClick={() => setFresh(null)}>I have saved it</button>
          </div>
        </div>
      )}
      {active.length === 0 ? <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>No active keys.</div> : active.map((k) => (
        <div key={k.id} className="row-sep">
          <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{k.name} <span className="pill" style={{ fontSize: 11, marginLeft: 6, color: k.scope === "write" ? "var(--amber)" : "var(--fg-3)" }}>{k.scope}</span><br /><span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>{k.prefix}… · {k.lastUsedAt ? "used " + timeAgo(k.lastUsedAt) : "never used"}</span></span>
          <button className="link-btn danger" onClick={() => setConfirming(k)}>Revoke</button>
        </div>
      ))}
      <form noValidate onSubmit={create} style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <input className="input" style={{ flex: "1 1 160px" }} placeholder="Key name (e.g. CI)" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} aria-label="Key name" />
        <select className="select" style={{ width: 110 }} value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope"><option value="read">read</option><option value="write">write</option></select>
        <button className="btn primary small" disabled={busy}>Create key</button>
      </form>
      {err && <div className="field-error" style={{ marginTop: 8 }}>{err.message}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Settings
export function Settings() {
  const { project, readOnly, refreshProjects, projectId } = useSession();
  const net = useApi(() => api.networkStatus(projectId), [projectId], { enabled: !!projectId });
  const audit = useApi(() => api.audit(projectId), [projectId], { enabled: !!projectId && !readOnly });
  const [name, setName] = useState(project?.name ?? "");
  const [desc, setDesc] = useState(project?.description ?? "");
  const [msg, setMsg] = useState(null);
  const [testing, setTesting] = useState(false);
  if (readOnly) return <NeedsProject what="change project settings" />;

  async function save(e) {
    e.preventDefault(); setMsg(null);
    try { await api.updateProject(project.id, { name: name.trim(), description: desc.trim() || null }); await refreshProjects(); setMsg({ ok: true, text: "Saved." }); }
    catch (err) { setMsg({ ok: false, text: err.message }); }
  }
  async function testNet() {
    setTesting(true);
    try { const r = await api.testNetwork(project.id); setMsg({ ok: r.chainIdVerified, text: r.chainIdVerified ? `RPC reachable: chain ${r.expectedChainId} verified, head #${r.headBlock}, ${r.latencyMs}ms.` : `Network test failed: ${r.error ?? "chain id mismatch"}` }); net.reload(); }
    catch (err) { setMsg({ ok: false, text: err.message }); } finally { setTesting(false); }
  }
  return (
    <div>
      <h1 className="h1">Settings</h1>
      <p className="sub">Project configuration.</p>
      {msg && <div className={"banner " + (msg.ok ? "ok" : "error")} style={{ marginTop: 16 }}>{msg.text}</div>}
      <form noValidate onSubmit={save} className="card" style={{ marginTop: 20, maxWidth: 560 }}>
        <Field label="Project name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
        <Field label="Description"><textarea className="textarea" style={{ minHeight: 70 }} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} /></Field>
        <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 12 }}>Project ID <span style={{ color: "var(--fg-3)" }}>{project.id}</span> <CopyButton text={project.id} /></div>
        <button className="btn primary">Save changes</button>
      </form>
      <div className="card" style={{ marginTop: 14, maxWidth: 560 }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>Environment</div>
        <div style={{ fontSize: 15, marginTop: 7, display: "flex", alignItems: "center", gap: 8 }}>
          <span className={"dot " + (net.data?.connection === "connected" ? "green" : "red")} />Portaldot V3.0 Testnet · EVM chain {net.data?.chainId ?? "…"}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>{net.data ? `Head ${net.data.headBlock !== null ? "#" + net.data.headBlock : "unknown"} · ingestion ${net.data.ingestion}` : ""}</div>
        <button className="btn secondary small" style={{ marginTop: 12 }} disabled={testing} onClick={testNet}>{testing ? "Testing…" : "Test connection"}</button>
      </div>
      <ApiKeysPanel projectId={project.id} />
      <div className="panel" style={{ marginTop: 14, maxWidth: 560 }}>
        <h2 className="h2 sm" style={{ marginBottom: 8 }}>Audit log</h2>
        {audit.data?.length === 0 ? <div style={{ fontSize: 13, color: "var(--muted)" }}>No changes recorded yet.</div> : audit.data?.slice(0, 15).map((a, i) => (
          <div key={i} className="row-sep"><span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>{a.action}</span><span style={{ fontSize: 12, color: "var(--dim)" }}>{timeAgo(a.createdAt)}</span></div>
        ))}
      </div>
    </div>
  );
}
