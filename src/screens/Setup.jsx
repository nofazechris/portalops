import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { timeAgo, useApi, useSession } from "../state.jsx";
import { CopyButton, ErrorBox, Field, Loading, NeedsProject, fieldErrors } from "../ui.jsx";
import ExamplePicker from "./ExamplePicker.jsx";

const STEPS = [
  { id: "welcome", title: "Welcome" },
  { id: "network", title: "Connect network" },
  { id: "contract", title: "Add contract", optional: true },
  { id: "events", title: "Select events", optional: true },
  { id: "delivery", title: "Configure delivery", optional: true },
  { id: "test", title: "Test integration", optional: true },
  { id: "finish", title: "Finish" },
];

function parseAbi(text) {
  if (!text.trim()) return undefined;
  let v;
  try { v = JSON.parse(text); } catch { throw new Error("The ABI is not valid JSON."); }
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.abi)) return v.abi;
  throw new Error('Paste the ABI array, or a compiler artifact that has an "abi" field.');
}

/** Every step explains why it matters, validates inline, offers a way out, and recovers from errors. */
const Why = ({ children }) => (
  <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.55, margin: "6px 0 18px" }}><span style={{ color: "var(--accent)" }}>Why this matters: </span>{children}</div>
);

function Stepper({ step, done, goTo }) {
  return (
    <ol style={{ display: "flex", gap: 6, flexWrap: "wrap", listStyle: "none", padding: 0, margin: "22px 0 0" }} aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const state = i === step ? "now" : done.has(s.id) ? "done" : "todo";
        const clickable = i <= Math.max(step, ...[...done].map((d) => STEPS.findIndex((x) => x.id === d)));
        return (
          <li key={s.id}>
            <button
              className="chip"
              disabled={!clickable}
              onClick={() => goTo(i)}
              aria-current={state === "now" ? "step" : undefined}
              style={{ display: "inline-flex", gap: 8, alignItems: "center", opacity: clickable ? 1 : 0.5, ...(state === "now" ? { color: "#080808", background: "var(--accent)", borderColor: "var(--accent)" } : state === "done" ? { color: "var(--green)" } : {}) }}
            >
              <span>{state === "done" ? "✓" : i + 1}</span>{s.title}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function NetworkStep({ projectId, net, setNet, onVerified }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ran = useRef(false);
  async function run() {
    setBusy(true); setErr(null);
    try { const r = await api.testNetwork(projectId); setNet(r); if (r.chainIdVerified) onVerified(); }
    catch (e) { setErr(e); setNet(null); } finally { setBusy(false); }
  }
  useEffect(() => { if (!ran.current && !net) { ran.current = true; run(); } }); // validate on arrival, once
  const ok = net?.chainIdVerified;
  return (
    <div>
      <h2 className="h2">Connect to the Portaldot V3.0 testnet</h2>
      <Why>PortalOps only shows a connected network after it has verified the endpoint answers and reports the expected chain id. Nothing downstream works without it.</Why>
      {busy && <div className="state-box"><span className="spinner" />Checking the RPC endpoint…</div>}
      {!busy && ok && (
        <div className="banner ok"><div>
          <strong>Network verified.</strong>
          <div className="banner-sub">Chain id {net.reportedChainId} matches · head block #{net.headBlock?.toLocaleString()} · {net.latencyMs}ms round trip</div>
        </div></div>
      )}
      {!busy && net && !ok && (
        <div className="banner error"><div>
          <strong>Not verified.</strong>
          <div className="banner-sub">{net.error ?? `The endpoint reports chain id ${net.reportedChainId ?? "unknown"}, expected ${net.expectedChainId}.`}</div>
          <div className="banner-sub" style={{ marginTop: 6 }}>Check that <span className="mono">PORTALDOT_EVM_RPC_URL</span> on the server points at the testnet and is reachable, then retry.</div>
        </div></div>
      )}
      <ErrorBox error={err} />
      {!busy && <button className="btn secondary small" onClick={run}>{net ? "Test again" : "Test connection"}</button>}
    </div>
  );
}

function ContractStep({ projectId, contracts, reload, chosen, setChosen, onDone }) {
  const [f, setF] = useState({ address: "", name: "", abi: "", startBlock: "" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function add(ev) {
    ev.preventDefault(); setBusy(true); setErr(null); setCheck(null);
    try {
      const body = { address: f.address.trim() };
      if (f.name.trim()) body.name = f.name.trim();
      const abi = parseAbi(f.abi); if (abi) body.abi = abi;
      if (f.startBlock.trim()) body.startBlock = Number(f.startBlock);
      const c = await api.addContract(projectId, body);
      const t = await api.testContract(c.id).catch(() => null);
      setCheck(t);
      await reload();
      setChosen(c.id);
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const fe = fieldErrors(err);
  return (
    <div>
      <h2 className="h2">Add the contract to monitor</h2>
      <Why>PortalOps captures logs from the contracts you register. With an ABI it can decode them into named events; without one the raw logs are still stored and delivered.</Why>
      {contracts?.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Already registered</div>
          {contracts.map((c) => (
            <label key={c.id} className={"replay-row" + (chosen === c.id ? " on" : "")} style={{ cursor: "pointer" }}>
              <span><input type="radio" name="contract" checked={chosen === c.id} onChange={() => { setChosen(c.id); onDone(); }} style={{ accentColor: "#b9a7ff", marginRight: 10 }} />{c.name || "Contract"} <span className="mono" style={{ color: "var(--dim)", fontSize: 11.5 }}>{c.address.slice(0, 10)}…{c.address.slice(-6)}</span></span>
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{c.events.length ? `${c.events.length} event types` : "no ABI"}</span>
            </label>
          ))}
          <div className="eyebrow" style={{ margin: "16px 0 8px" }}>Or register another</div>
        </div>
      )}
      <ExamplePicker onUse={(ex) => setF((cur) => ({ ...cur, name: cur.name || ex.title, abi: JSON.stringify(ex.abi) }))} />
      <form onSubmit={add}>
        <Field label="Contract address" error={fe.address} hint="A 0x-prefixed 20-byte address on the Portaldot V3.0 testnet."><input className="input mono" placeholder="0x…" value={f.address} onChange={set("address")} required /></Field>
        <Field label="Name (optional)" error={fe.name}><input className="input" value={f.name} onChange={set("name")} /></Field>
        <Field label="ABI (optional)" error={fe.abi} hint="Paste the ABI array or a compiler artifact. Skip to receive undecoded logs."><textarea className="textarea mono" value={f.abi} onChange={set("abi")} /></Field>
        <Field label="Start block (optional)" error={fe.startBlock} hint="Capture history from this block. Defaults to roughly the last 1,000 blocks."><input className="input mono" inputMode="numeric" value={f.startBlock} onChange={set("startBlock")} /></Field>
        {err && !err.details && <div className="banner error"><div>{err.message}{err.code === "contract_exists" ? " Choose it from the list above instead." : ""}</div></div>}
        {check && <div className={"banner " + (check.codeFound ? "ok" : "warn")}><div>{check.note}</div></div>}
        <button className="btn primary" disabled={busy}>{busy ? "Registering…" : "Register contract"}</button>
      </form>
    </div>
  );
}

function EventsStep({ contract, selected, setSelected }) {
  const names = contract?.events ?? [];
  const toggle = (n) => { const s = new Set(selected); s.has(n) ? s.delete(n) : s.add(n); setSelected(s); };
  return (
    <div>
      <h2 className="h2">Choose which events to receive</h2>
      <Why>Your endpoint only gets the events you pick, so it never has to ignore noise. Leaving everything unchecked means <em>all</em> events, including logs that cannot be decoded.</Why>
      {!contract && <div className="banner info"><div>No contract chosen yet, so there are no event names to pick from. Every event will be delivered; you can narrow this later on the webhook.</div></div>}
      {contract && names.length === 0 && <div className="banner info"><div>This contract has no ABI, so event names are unknown. Every log will be delivered as an undecoded event. Add an ABI to the contract later to filter by name.</div></div>}
      {names.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          {names.map((n) => (
            <label key={n} className="replay-row" style={{ cursor: "pointer" }}>
              <span><input type="checkbox" checked={selected.has(n)} onChange={() => toggle(n)} style={{ accentColor: "#b9a7ff", marginRight: 10 }} /><span className="mono">{n}</span></span>
            </label>
          ))}
          <div className="field-hint">{selected.size === 0 ? "Nothing checked: all events will be delivered." : `${selected.size} selected: only these will be delivered.`}</div>
        </div>
      )}
    </div>
  );
}

function DeliveryStep({ projectId, filter, hook, setHook, secretShown, setSecretShown, existing }) {
  const [mode, setMode] = useState("builtin");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function create(ev) {
    ev.preventDefault(); setBusy(true); setErr(null);
    try {
      const body = { eventFilter: [...filter], description: mode === "builtin" ? "Setup wizard · built-in receiver" : "Setup wizard" };
      if (mode === "builtin") body.builtinReceiver = true; else body.url = url.trim();
      const w = await api.createWebhook(projectId, body);
      setHook(w); setSecretShown(false);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const fe = fieldErrors(err);

  if (hook) {
    return (
      <div>
        <h2 className="h2">Webhook created</h2>
        <Why>Deliveries are signed with this webhook's secret. Your receiver uses it to prove a request really came from PortalOps.</Why>
        <div className="banner ok"><div><strong>{hook.builtinReceiver ? "Built-in test receiver ready." : "Endpoint registered."}</strong><div className="banner-sub mono" style={{ wordBreak: "break-all" }}>{hook.builtinReceiver ? "hosted by PortalOps" : hook.url}</div></div></div>
        {hook.secret && (
          <div className="banner warn" style={{ display: "block" }}>
            <strong>Signing secret (shown once).</strong>
            <div className="secret-box" style={{ margin: "10px 0" }}>{hook.secret}</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span onClick={() => setSecretShown(true)}><CopyButton text={hook.secret} label="Copy secret" className="btn primary small" /></span>
              <span style={{ fontSize: 12.5 }}>{secretShown ? "Copied. Store it somewhere safe: it cannot be shown again." : "Copy it now: it cannot be shown again."}</span>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      <h2 className="h2">Where should events be delivered?</h2>
      <Why>A webhook is how captured events reach your application. Each delivery is signed, retried on failure, recorded, and replayable.</Why>
      {existing?.length > 0 && <div className="banner info"><div>You already have {existing.length} webhook{existing.length > 1 ? "s" : ""} in this project. Creating another is optional; you can also continue with the existing one on the Webhooks screen.</div></div>}
      <form onSubmit={create}>
        <label className={"replay-row" + (mode === "builtin" ? " on" : "")} style={{ cursor: "pointer" }}>
          <span><input type="radio" checked={mode === "builtin"} onChange={() => setMode("builtin")} style={{ accentColor: "#b9a7ff", marginRight: 10 }} /><strong>Built-in test receiver</strong><br /><span style={{ color: "var(--muted)", fontSize: 12.5, marginLeft: 24 }}>No backend needed. PortalOps verifies signatures and shows what it received.</span></span>
        </label>
        <label className={"replay-row" + (mode === "url" ? " on" : "")} style={{ cursor: "pointer", marginBottom: 14 }}>
          <span><input type="radio" checked={mode === "url"} onChange={() => setMode("url")} style={{ accentColor: "#b9a7ff", marginRight: 10 }} /><strong>My own endpoint</strong><br /><span style={{ color: "var(--muted)", fontSize: 12.5, marginLeft: 24 }}>An HTTPS URL on your backend.</span></span>
        </label>
        {mode === "url" && <Field label="Endpoint URL" error={fe.url} hint="HTTPS only in production. Private and loopback addresses are blocked."><input className="input mono" placeholder="https://api.example.com/portal-events" value={url} onChange={(e) => setUrl(e.target.value)} required /></Field>}
        <div className="field-hint" style={{ marginBottom: 12 }}>Events: {filter.size ? [...filter].join(", ") : "all events"}</div>
        {err && !err.details && <div className="banner error"><div>{err.message}</div></div>}
        <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create webhook"}</button>
      </form>
    </div>
  );
}

function TestStep({ projectId, hook, testResult, setTestResult, go }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [replayMsg, setReplayMsg] = useState(null);
  const ov = useApi(() => api.overview(projectId), [projectId], { refreshMs: 5000 });
  const rcv = useApi(() => api.receiver(hook.id), [hook?.id, testResult?.at], { enabled: !!hook?.builtinReceiver });

  async function send() {
    setBusy(true); setErr(null);
    try { const r = await api.testWebhook(hook.id); setTestResult({ ...r, at: Date.now() }); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function replayLatest() {
    setReplayMsg(null);
    try {
      const evs = await api.events(projectId, { limit: 1 });
      if (!evs.items[0]) { setReplayMsg({ ok: false, text: "No captured events to replay yet." }); return; }
      await api.replay(evs.items[0].id, hook.id);
      setReplayMsg({ ok: true, text: "Queued a replay of your latest event. Check the delivery on the Events screen in a few seconds." });
    } catch (e) { setReplayMsg({ ok: false, text: e.message }); }
  }
  const sig = rcv.data?.requests?.[0];
  const m = ov.data?.metrics;
  return (
    <div>
      <h2 className="h2">Test the integration</h2>
      <Why>A test delivery proves the full path (signing, network, your endpoint) works before real events depend on it. Confirmation comes from the response, not from this page.</Why>
      {!hook ? <div className="banner info"><div>You skipped the webhook step, so there is nothing to test yet. Add one on the Webhooks screen when you're ready.</div></div> : (
        <>
          <button className="btn primary" disabled={busy} onClick={send}>{busy ? "Sending…" : testResult ? "Send another test delivery" : "Send test delivery"}</button>
          <ErrorBox error={err} />
          {testResult && (
            <div className={"banner " + (testResult.ok ? "ok" : "error")} style={{ marginTop: 14 }}>
              <div>
                <strong>{testResult.ok ? "Test delivery succeeded" : "Test delivery failed"}</strong>
                <div className="banner-sub">{testResult.ok ? `HTTP ${testResult.status} in ${testResult.durationMs}ms` : `${testResult.status ? "HTTP " + testResult.status : testResult.errorCode} after ${testResult.durationMs}ms${testResult.response ? ": " + testResult.response : ""}`}</div>
                {hook.builtinReceiver && sig && <div className="banner-sub">Receiver saw it: signature {sig.signatureOk ? "verified ✓" : `FAILED (${sig.signatureReason})`}</div>}
                {!testResult.ok && <div className="banner-sub" style={{ marginTop: 6 }}>Check the URL is reachable from the PortalOps worker, that it returns 2xx, and that it verifies the signature with this webhook's secret.</div>}
              </div>
            </div>
          )}
          <div className="panel" style={{ marginTop: 18 }}>
            <h2 className="h2 sm">Real events</h2>
            {!m ? <Loading /> : (
              <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6, marginTop: 8 }}>
                {m.eventsReceived} event{m.eventsReceived === 1 ? "" : "s"} captured so far{ov.data?.network.lastEventObservedAt ? ` (last ${timeAgo(ov.data.network.lastEventObservedAt)})` : ""}; {m.delivered} delivered, {m.failed} failed.
                {m.eventsReceived === 0 && <div style={{ color: "var(--muted)" }}>Trigger a transaction on your contract and it will appear here within a few seconds. This page updates automatically.</div>}
              </div>
            )}
            {m?.eventsReceived > 0 && <button className="btn secondary small" style={{ marginTop: 10 }} onClick={replayLatest}>Replay latest event to this webhook</button>}
            {replayMsg && <div className={"banner " + (replayMsg.ok ? "ok" : "error")} style={{ marginTop: 10, marginBottom: 0 }}>{replayMsg.text}</div>}
          </div>
        </>
      )}
      <button className="link-btn" style={{ marginTop: 14 }} onClick={() => go("events")}>Open the Events screen →</button>
    </div>
  );
}

function FinishStep({ net, contract, selected, hook, testResult, ov, go }) {
  const m = ov?.metrics;
  const rows = [
    ["Network verified", !!net?.chainIdVerified, net?.chainIdVerified ? `chain ${net.reportedChainId}, head #${net.headBlock?.toLocaleString()}` : "not verified"],
    ["Contract registered", !!contract, contract ? (contract.name || contract.address) : "skipped"],
    ["Event selection", !!contract, selected.size ? [...selected].join(", ") : "all events"],
    ["Webhook configured", !!hook, hook ? (hook.builtinReceiver ? "built-in test receiver" : hook.url) : "skipped"],
    ["Test delivery succeeded", !!testResult?.ok, testResult ? (testResult.ok ? `HTTP ${testResult.status}` : "failed") : "not run"],
    ["A real event was captured", (m?.eventsReceived ?? 0) > 0, m ? `${m.eventsReceived} captured` : "…"],
    ["A real event was delivered", (m?.delivered ?? 0) > 0, m ? `${m.delivered} delivered` : "…"],
  ];
  const doneCount = rows.filter((r) => r[1]).length;
  return (
    <div>
      <h2 className="h2">{doneCount === rows.length ? "You're set up" : "Setup summary"}</h2>
      <Why>This is an honest status, not a celebration: each line is derived from what actually happened. Anything unchecked still needs attention, but you can finish it from the matching screen at any time.</Why>
      <div className="panel">
        {rows.map(([label, ok, detail]) => (
          <div key={label} className={"check" + (ok ? " done" : "")} style={{ padding: "9px 0", borderTop: "1px solid #1a1a1a" }}>
            <span className="box">{ok ? "✓" : ""}</span>
            <span style={{ flex: 1 }}>{label}</span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--dim)", textAlign: "right", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{detail}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
        <button className="btn primary" onClick={() => go("overview")}>Go to Overview</button>
        <button className="btn secondary" onClick={() => go("events")}>View events</button>
        <button className="btn secondary" onClick={() => go("aisetup")}>Set up with an AI agent</button>
      </div>
    </div>
  );
}

export default function Setup({ go }) {
  const { projectId, readOnly, project } = useSession();
  const contracts = useApi(() => api.contracts(projectId), [projectId], { enabled: !!projectId && !readOnly });
  const hooks = useApi(() => api.webhooks(projectId), [projectId], { enabled: !!projectId && !readOnly });
  const ov = useApi(() => api.overview(projectId), [projectId], { enabled: !!projectId && !readOnly, refreshMs: 6000 });

  const [step, setStep] = useState(0);
  const [done, setDone] = useState(() => new Set());
  const [net, setNet] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [hook, setHook] = useState(null);
  const [secretShown, setSecretShown] = useState(false);
  const [testResult, setTestResult] = useState(null);

  if (readOnly) return <NeedsProject what="run the guided setup" />;
  if (contracts.loading && !contracts.data) return <Loading />;

  const contract = contracts.data?.find((c) => c.id === chosen) ?? null;
  const markDone = (id) => setDone((d) => new Set(d).add(id));
  const cur = STEPS[step];
  const next = () => { markDone(cur.id); setStep((s) => Math.min(STEPS.length - 1, s + 1)); };
  const back = () => setStep((s) => Math.max(0, s - 1));

  // Per-step gate for the primary action: what must be true before moving on.
  const gate = {
    network: !net?.chainIdVerified ? "Verify the network connection to continue." : null,
    delivery: hook && hook.secret && !secretShown ? "Copy the signing secret before continuing: it cannot be shown again." : null,
  }[cur.id] ?? null;
  const canSkip = cur.optional && cur.id !== "finish";

  return (
    <div>
      <h1 className="h1">Guided setup</h1>
      <p className="sub">{project?.name} · seven short steps from an empty project to a verified delivery.</p>
      <Stepper step={step} done={done} goTo={setStep} />

      <div className="panel tight" style={{ marginTop: 22, maxWidth: 720 }}>
        {cur.id === "welcome" && (
          <div>
            <h2 className="h2">Let's get a real event delivered</h2>
            <Why>You will connect the network, register a contract, choose events, add a webhook and send a test delivery. Optional steps can be skipped and finished later.</Why>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.9 }}>
              {STEPS.slice(1).map((s) => <li key={s.id}>{s.title}{s.optional ? <span style={{ color: "var(--dim)" }}> (optional)</span> : null}</li>)}
            </ol>
          </div>
        )}
        {cur.id === "network" && <NetworkStep projectId={projectId} net={net} setNet={setNet} onVerified={() => markDone("network")} />}
        {cur.id === "contract" && <ContractStep projectId={projectId} contracts={contracts.data} reload={contracts.reload} chosen={chosen} setChosen={setChosen} onDone={() => markDone("contract")} />}
        {cur.id === "events" && <EventsStep contract={contract} selected={selected} setSelected={setSelected} />}
        {cur.id === "delivery" && <DeliveryStep projectId={projectId} filter={selected} hook={hook} setHook={(h) => { setHook(h); hooks.reload(); markDone("delivery"); }} secretShown={secretShown} setSecretShown={setSecretShown} existing={hooks.data} />}
        {cur.id === "test" && <TestStep projectId={projectId} hook={hook} testResult={testResult} setTestResult={(r) => { setTestResult(r); if (r.ok) markDone("test"); }} go={go} />}
        {cur.id === "finish" && <FinishStep net={net} contract={contract} selected={selected} hook={hook} testResult={testResult} ov={ov.data} go={go} />}

        {cur.id !== "finish" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 24, paddingTop: 16, borderTop: "1px solid #1a1a1a", flexWrap: "wrap" }}>
            <button className="btn secondary small" disabled={step === 0} onClick={back}>← Back</button>
            <span style={{ flex: 1 }} />
            {gate && <span style={{ fontSize: 12, color: "var(--amber)" }}>{gate}</span>}
            {canSkip && <button className="btn secondary small" onClick={() => setStep((s) => s + 1)}>Skip this step</button>}
            <button className="btn primary small" disabled={!!gate} onClick={next}>{cur.id === "welcome" ? "Start" : "Continue →"}</button>
          </div>
        )}
      </div>
    </div>
  );
}
