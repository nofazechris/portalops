import { useState } from "react";
import { api } from "../api.js";
import { timeAgo, useApi, useSession } from "../state.jsx";
import { CopyButton, Empty, ErrorBox, Field, Loading, Modal, NeedsProject, PageHead, deliveryColor, deliveryLabel, fieldErrors } from "../ui.jsx";

function SecretModal({ secret, title, onClose }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="banner warn">
        <div><strong>Copy this secret now.</strong><div className="banner-sub">It is shown once and cannot be retrieved again. If you lose it, rotate it.</div></div>
      </div>
      <div className="secret-box">{secret}</div>
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <CopyButton text={secret} label="Copy secret" className="btn primary small" />
        <button className="btn secondary small" onClick={onClose}>I have saved it</button>
      </div>
    </Modal>
  );
}

function CreateModal({ projectId, onClose, onCreated }) {
  const [form, setForm] = useState({ url: "", description: "", filter: "", builtin: false });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function submit(ev) {
    ev.preventDefault(); setBusy(true); setErr(null);
    try {
      const body = { eventFilter: form.filter.split(",").map((s) => s.trim()).filter(Boolean) };
      if (form.builtin) body.builtinReceiver = true; else body.url = form.url.trim();
      if (form.description.trim()) body.description = form.description.trim();
      onCreated(await api.createWebhook(projectId, body));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const fe = fieldErrors(err);
  return (
    <Modal title="Create webhook" onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={form.builtin} onChange={(e) => setForm({ ...form, builtin: e.target.checked })} style={{ marginTop: 3, accentColor: "#b9a7ff" }} />
          <span style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.45 }}>
            <strong>Use the built-in test receiver</strong><br />
            <span style={{ color: "var(--muted)" }}>PortalOps hosts an endpoint that verifies signatures for you. No backend needed. Good for trying retries and replay.</span>
          </span>
        </label>
        {form.builtin
          ? (err && !err.details && <div className="field-error" style={{ marginBottom: 12 }}>{err.message}</div>)
          : (
            <Field label="Endpoint URL" hint="HTTPS only in production. Private and loopback addresses are blocked." error={fe.url || (err && !err.details ? err.message : null)}>
              <input className="input mono" autoFocus placeholder="https://api.example.com/portal-events" value={form.url} onChange={set("url")} required />
            </Field>
          )}
        <Field label="Description (optional)" error={fe.description}><input className="input" value={form.description} onChange={set("description")} /></Field>
        <Field label="Events (optional)" hint="Comma-separated event names. Empty = every event, including undecoded logs." error={fe.eventFilter}>
          <input className="input mono" placeholder="QuestCompleted, RewardIssued" value={form.filter} onChange={set("filter")} />
        </Field>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create webhook"}</button>
        </div>
      </form>
    </Modal>
  );
}


const MODES = [
  { id: "ok", label: "Healthy (HTTP 200)" },
  { id: "fail500", label: "Fail with HTTP 500 (retryable)" },
  { id: "fail400", label: "Fail with HTTP 400 (not retried)" },
  { id: "timeout", label: "Never answer (timeout)" },
];
const OUTCOME_COLOR = { ok: "var(--green)", duplicate: "var(--amber)", rejected: "var(--red)", fail500: "var(--red)", fail400: "var(--red)", timeout: "var(--amber)" };

/** Controls and history of the PortalOps-hosted receiver: what it got, whether the signature verified, and how it answered. */
function ReceiverPanel({ id }) {
  const { data, error, reload } = useApi(() => api.receiver(id), [id], { refreshMs: 3000 });
  const [busy, setBusy] = useState(false);
  async function setMode(mode) {
    setBusy(true);
    try { await api.setReceiverMode(id, mode); await reload(); } finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 className="h2 sm">Built-in test receiver</h2>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Hosted by PortalOps. It verifies the signature, rejects stale timestamps and ignores duplicate event ids, like a correct consumer.</div>
        </div>
        <select className="select" style={{ width: 260 }} value={data?.mode ?? "ok"} disabled={busy || !data} onChange={(e) => setMode(e.target.value)} aria-label="Receiver behaviour">
          {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      {data && data.mode !== "ok" && <div className="banner warn" style={{ margin: "14px 0 0" }}>Failure mode is on: deliveries to this endpoint will {data.mode === "timeout" ? "time out" : "fail"}. Switch back to Healthy, then replay from the Replay Centre.</div>}
      <div style={{ marginTop: 14 }}>
        {!data ? <Loading /> : data.requests.length === 0 ? <div style={{ fontSize: 13, color: "var(--muted)" }}>Nothing received yet. Send a test delivery, or wait for an event.</div> : data.requests.slice(0, 12).map((r) => (
          <div key={r.id} className="attempt" style={{ gridTemplateColumns: "76px 100px 1fr auto" }}>
            <span style={{ color: OUTCOME_COLOR[r.outcome] ?? "var(--fg-3)" }}>{r.httpStatus}</span>
            <span style={{ color: OUTCOME_COLOR[r.outcome] ?? "var(--fg-3)" }}>{r.outcome}</span>
            <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              signature {r.signatureOk ? "verified" : `FAILED (${r.signatureReason})`}{r.attempt ? ` · attempt ${r.attempt}` : ""}{r.eventId ? ` · ${r.eventId.slice(0, 14)}…` : ""}
            </span>
            <span style={{ color: "var(--dim)" }}>{timeAgo(r.receivedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Webhooks({ openWebhook }) {
  const { projectId, readOnly } = useSession();
  const { data, error, loading, reload } = useApi(() => api.webhooks(projectId), [projectId], { refreshMs: 8000, enabled: !!projectId && !readOnly });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState(null);

  if (readOnly) return <NeedsProject what="manage webhooks" />;
  return (
    <div>
      <PageHead title="Webhooks" sub="Deliver events to your endpoints with signing, retries and history." action={<button className="btn primary" onClick={() => setCreating(true)}>Create webhook</button>} />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <div style={{ marginTop: 22 }}><Loading /></div> : data && (data.length === 0
        ? <div style={{ marginTop: 22 }}><Empty title="No webhook endpoints yet">Create one to start receiving captured events at your backend.</Empty></div>
        : (
          <div className="table" style={{ marginTop: 22 }}>
            <div className="tr head" style={{ gridTemplateColumns: "1.2fr 2.4fr 1.2fr 0.8fr" }}><span>Name</span><span>Endpoint</span><span>Events</span><span style={{ textAlign: "right" }}>Status</span></div>
            {data.map((w) => (
              <div key={w.id} className="tr clickable" style={{ gridTemplateColumns: "1.2fr 2.4fr 1.2fr 0.8fr" }} onClick={() => openWebhook(w.id)}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 500 }}><span className={"dot " + (w.enabled ? "green" : "grey")} style={{ boxShadow: "none" }} />{w.description || "Webhook"}{w.builtinReceiver && <span className="pill" style={{ color: "var(--accent)", fontSize: 11 }}>built-in</span>}</span>
                <span className="mono" style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.builtinReceiver ? "hosted by PortalOps" : w.url}</span>
                <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>{w.eventFilter.length ? w.eventFilter.join(", ") : "All events"}</span>
                <span style={{ textAlign: "right", fontSize: 12, color: w.enabled ? "var(--green)" : "var(--dim)" }}>{w.enabled ? "Enabled" : "Paused"}</span>
              </div>
            ))}
          </div>
        ))}
      {creating && <CreateModal projectId={projectId} onClose={() => setCreating(false)} onCreated={(w) => { setCreating(false); setSecret({ title: "Webhook created", value: w.secret }); reload(); }} />}
      {secret && <SecretModal title={secret.title} secret={secret.value} onClose={() => setSecret(null)} />}
    </div>
  );
}

export function WebhookDetail({ id, go }) {
  const { projectId } = useSession();
  const list = useApi(() => api.webhooks(projectId), [projectId, id], { enabled: !!projectId });
  const deliveries = useApi(() => api.webhookDeliveries(id, { limit: 30 }), [id], { refreshMs: 4000 });
  const [msg, setMsg] = useState(null);
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(null);

  const w = list.data?.find((x) => x.id === id);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!w) return <><button className="back" onClick={() => go("webhooks")}>← Webhooks</button><Empty title="Webhook not found">It may have been deleted.</Empty></>;

  async function run(name, fn) {
    setBusy(name); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(""); }
  }
  const test = () => run("test", async () => {
    const r = await api.testWebhook(id);
    setMsg({ ok: r.ok, text: r.ok ? `Test delivery succeeded: HTTP ${r.status} in ${r.durationMs}ms.` : `Test delivery failed: ${r.status ? "HTTP " + r.status : r.errorCode} (${r.durationMs}ms)${r.response ? " — " + r.response : ""}` });
  });
  const toggle = () => run("toggle", async () => { await api.updateWebhook(id, { enabled: !w.enabled }); list.reload(); });
  const rotate = () => run("rotate", async () => { const r = await api.rotateSecret(id); setConfirm(null); setSecret({ title: "New signing secret", value: r.secret }); });
  const remove = () => run("delete", async () => { await api.deleteWebhook(id); go("webhooks"); });

  return (
    <div>
      <button className="back" onClick={() => go("webhooks")}>← Webhooks</button>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
        <h1 className="h1" style={{ fontSize: 24 }}>{w.description || "Webhook"}</h1>
        <span className="pill" style={{ color: w.enabled ? "var(--green)" : "var(--dim)" }}>{w.enabled ? "● Enabled" : "● Paused"}</span>
      </div>
      <div className="mono" style={{ fontSize: 13, color: "var(--accent)", marginTop: 8, wordBreak: "break-all" }}>{w.builtinReceiver ? "Hosted by PortalOps (built-in test receiver)" : w.url}</div>
      {msg && <div className={"banner " + (msg.ok ? "ok" : "error")} style={{ marginTop: 16 }}>{msg.text}</div>}

      <div style={{ display: "flex", gap: 9, marginTop: 18, flexWrap: "wrap" }}>
        <button className="btn primary" disabled={!!busy} onClick={test}>{busy === "test" ? "Sending…" : "Send test delivery"}</button>
        <button className="btn secondary" disabled={!!busy} onClick={toggle}>{w.enabled ? "Pause" : "Enable"}</button>
        <button className="btn secondary" disabled={!!busy} onClick={() => setConfirm("rotate")}>Rotate secret</button>
        <button className="btn secondary" style={{ color: "var(--red)" }} disabled={!!busy} onClick={() => setConfirm("delete")}>Delete</button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16, marginTop: 18 }}>
        <div className="panel">
          <h2 className="h2 sm" style={{ marginBottom: 8 }}>Configuration</h2>
          <div className="kv"><span className="k">Events</span><span className="v">{w.eventFilter.length ? w.eventFilter.join(", ") : "All events"}</span></div>
          <div className="kv"><span className="k">Max attempts</span><span className="v">{w.retryPolicy.maxAttempts}</span></div>
          <div className="kv"><span className="k">Backoff</span><span className="v">{w.retryPolicy.baseDelayMs / 1000}s base, {w.retryPolicy.maxDelayMs / 1000}s cap, jittered</span></div>
          <div className="kv"><span className="k">Timeout</span><span className="v">{w.retryPolicy.timeoutMs / 1000}s</span></div>
          <div className="kv"><span className="k">Signing secret</span><span className="v">Stored encrypted. Not viewable; rotate to get a new one.</span></div>
        </div>
        <div className="panel">
          <h2 className="h2 sm" style={{ marginBottom: 8 }}>Recent deliveries</h2>
          {deliveries.loading && !deliveries.data ? <Loading /> : deliveries.data?.length === 0 ? <div style={{ fontSize: 13, color: "var(--muted)" }}>No deliveries yet.</div>
            : deliveries.data?.map((d) => (
              <div key={d.id} style={{ borderTop: "1px solid #1a1a1a", padding: "10px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <button className="link-btn" style={{ fontSize: 13 }} onClick={() => go("eventDetail", { id: d.eventId })}>{d.eventId.slice(0, 16)}…</button>
                  <span style={{ color: deliveryColor(d.status) }}>{deliveryLabel(d.status)}</span>
                </div>
                {d.attempts.map((a) => (
                  <div key={a.id} className="attempt" style={{ borderTop: 0, padding: "3px 0" }}>
                    <span style={{ color: a.responseStatus && a.responseStatus < 300 ? "var(--green)" : "var(--red)" }}>{a.responseStatus ?? a.errorCode}</span>
                    <span style={{ color: "var(--muted)" }}>#{a.attemptNumber} · {timeAgo(a.finishedAt)}</span>
                    <span style={{ color: "var(--fg-3)" }}>{a.responseDurationMs}ms</span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>

      {w.builtinReceiver && <ReceiverPanel id={id} />}

      {confirm && (
        <Modal title={confirm === "delete" ? "Delete this webhook?" : "Rotate signing secret?"} onClose={() => setConfirm(null)}>
          <p style={{ fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.55, marginTop: 0 }}>
            {confirm === "delete" ? "Its delivery history will be deleted too. Events are not affected." : "The old secret stops working immediately. Update your receiver with the new one."}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button className="btn secondary" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn primary" disabled={!!busy} onClick={confirm === "delete" ? remove : rotate}>{confirm === "delete" ? "Delete webhook" : "Rotate secret"}</button>
          </div>
        </Modal>
      )}
      {secret && <SecretModal title={secret.title} secret={secret.value} onClose={() => setSecret(null)} />}
    </div>
  );
}
