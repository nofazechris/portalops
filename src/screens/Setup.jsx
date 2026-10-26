import { ADDRESS_HELP, ContractSource, buildContractBody } from "../ContractSource.jsx";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { shortHash, useApi, useSession } from "../state.jsx";
import { Alert, CopyButton, Field, Loading, NeedsProject, fieldErrors } from "../ui.jsx";
import { LiveTimeline } from "../viz.jsx";

/**
 * Quick start: three short steps from an empty project to a delivered event.
 *   1. What to watch   (one click on a ready-made real contract, or your own)
 *   2. Where it goes   (the built-in test receiver needs nothing; or your own URL)
 *   3. See it work     (live events, a test delivery, a checklist)
 * Everything is explained in plain language, and the network is checked in the background instead of being a step of its own.
 */

const STEPS = [
  { id: "watch", title: "What to watch" },
  { id: "deliver", title: "Where events go" },
  { id: "see", title: "See it work" },
];

const Explain = ({ children }) => (
  <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.65, margin: "8px 0 18px", maxWidth: 620 }}>{children}</p>
);

function Stepper({ step, goTo, reached }) {
  return (
    <ol className="qs-steps" aria-label="Quick start progress">
      {STEPS.map((s, i) => {
        const state = i === step ? "now" : i < reached ? "done" : "todo";
        return (
          <li key={s.id}>
            <button type="button" className={"qs-step " + state} disabled={i > reached} onClick={() => goTo(i)} aria-current={i === step ? "step" : undefined}>
              <span className="qs-num">{state === "done" ? "✓" : i + 1}</span>{s.title}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Glossary() {
  return (
    <details className="qs-gloss">
      <summary>New to this? Three words you need</summary>
      <dl>
        <dt>Contract</dt><dd>A small program living on the blockchain. Anyone can use it, and it leaves a public record each time something happens.</dd>
        <dt>Event</dt><dd>That record. For example "Alice sent 5 tokens to Bob". PortalOps captures these and decodes them into readable names.</dd>
        <dt>Webhook</dt><dd>A web address PortalOps sends each event to, so your app can react. Each message is signed so you know it's genuine, and re-sent if your app is down.</dd>
      </dl>
    </details>
  );
}

/** One selectable card (a featured contract, or "my own"). */
function Choice({ selected, onSelect, title, tag, tagTone, children }) {
  return (
    <button type="button" className={"qs-choice" + (selected ? " on" : "")} onClick={onSelect} aria-pressed={selected}>
      <span className="qs-radio" aria-hidden="true" />
      <span className="qs-choice-body">
        <span className="qs-choice-title">{title}{tag && <span className={"qs-tag " + (tagTone ?? "")}>{tag}</span>}</span>
        {children}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------------------------------------------------- step 1
function WatchStep({ projectId, contracts, reloadContracts, onWatching, watching }) {
  const { data: featured, error: featErr } = useApi(() => api.featured(), []);
  const { data: examples } = useApi(() => api.examples(), []);
  const [pick, setPick] = useState(null); // featured id | "own"
  const [own, setOwn] = useState({ address: "", exampleId: "", abi: "", startBlock: "", type: "evm" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const fe = fieldErrors(problem);

  useEffect(() => { if (!pick && featured?.length) setPick(featured[0].id); }, [featured, pick]);

  async function start() {
    setBusy(true); setProblem(null);
    try {
      let body, events = [];
      if (pick === "own") {
        body = { address: own.address.trim() };
        if (own.type === "evm" && own.exampleId) {
          const ex = await api.example(own.exampleId);
          body.abi = ex.abi; body.name = ex.title; events = ex.eventDetails.map((e) => e.name);
        } else {
          Object.assign(body, buildContractBody(own.type, own.abi));
        }
        if (own.startBlock.trim()) body.startBlock = Number(own.startBlock);
      } else {
        const f = featured.find((x) => x.id === pick);
        const ex = await api.example(f.example);
        body = { address: f.address, name: f.title, abi: ex.abi, startBlock: f.startBlock };
        events = f.events;
      }
      let record;
      try { record = await api.addContract(projectId, body); }
      catch (e) {
        if (e.code !== "contract_exists") throw e;
        record = (await api.contracts(projectId)).find((c) => c.address.toLowerCase() === body.address.toLowerCase()); // already watching it: carry on
      }
      const check = record ? await api.testContract(record.id).catch(() => null) : null;
      await reloadContracts();
      onWatching({ record, events: record?.events?.length ? record.events : events, check });
    } catch (e) { setProblem(e); } finally { setBusy(false); }
  }

  const ready = pick && (pick !== "own" || own.address.trim());
  return (
    <div>
      <h2 className="h2">What do you want to watch?</h2>
      <Explain>PortalOps watches a contract on the Portaldot testnet and tells your app whenever something happens on it. Pick one to start with. You can add more any time.</Explain>
      <Glossary />

      {watching && (
        <Alert tone="ok" title={`You're watching ${watching.record?.name ?? shortHash(watching.record?.address, 8, 6)}`}>
          {watching.check?.codeFound === false ? "No contract was found at that address yet, but PortalOps will pick events up as soon as it exists." : `PortalOps is reading its history now. It emits ${watching.events.length ? watching.events.join(", ") : "events"}.`} Continue to the next step, or pick another below.
        </Alert>
      )}
      {!watching && contracts?.length > 0 && (
        <Alert tone="info" title={`This project already watches ${contracts.length} contract${contracts.length > 1 ? "s" : ""}`}>You can continue straight to the next step, or add another one below.</Alert>
      )}

      <div className="qs-choices">
        {featErr && <Alert tone="warn" title="Couldn't load the ready-made contracts">You can still add your own contract below.</Alert>}
        {featured?.map((f) => (
          <Choice key={f.id} selected={pick === f.id} onSelect={() => setPick(f.id)} title={f.title} tag={f.origin === "ours" ? "Deployed by us" : "Real, other team"} tagTone={f.origin === "ours" ? "accent" : ""}>
            <span className="qs-blurb">{f.blurb}</span>
            <span className="qs-meta mono">{shortHash(f.address, 10, 6)} · you'll see: {f.events.join(", ")}</span>
            {f.evidence && <span className="qs-meta mono">deployed in block #{f.evidence.deployBlock.toLocaleString()}</span>}
          </Choice>
        ))}
        <Choice selected={pick === "own"} onSelect={() => setPick("own")} title="My own contract" tag="Advanced">
          <span className="qs-blurb">Paste the address of a contract on the Portaldot testnet.</span>
        </Choice>
      </div>

      {pick === "own" && (
        <div className="qs-own">
          <Field label={ADDRESS_HELP[own.type].label} error={fe.address} hint={own.type === "ink" ? "An SS58 address starting with 5, for a Rust (ink!) contract on the Portaldot native runtime." : "Starts with 0x, 42 characters. Must be on the Portaldot V3.0 testnet."}>
            <input className="input mono" placeholder={ADDRESS_HELP[own.type].placeholder} value={own.address} onChange={(e) => setOwn({ ...own, address: e.target.value })} />
          </Field>
          {own.type === "evm" && (
            <Field label="How should its events be read?" hint="PortalOps needs the contract's ABI (its list of events) to show readable names. Not sure? Choose 'Show raw data': events are still captured.">
              <select className="select" value={own.exampleId} onChange={(e) => setOwn({ ...own, exampleId: e.target.value })}>
                <option value="">Upload or paste my own ABI below, or show raw data</option>
                {examples?.map((x) => <option key={x.id} value={x.id}>It's a copy of the "{x.title}" example</option>)}
              </select>
            </Field>
          )}
          {!(own.type === "evm" && own.exampleId) && (
            <ContractSource type={own.type} setType={(t) => setOwn((o) => ({ ...o, type: t, exampleId: t === "ink" ? "" : o.exampleId }))} text={own.abi} setText={(v) => setOwn((o) => ({ ...o, abi: v }))} error={fe.abi} />
          )}
          <Field label="Start from block (optional)" error={fe.startBlock} hint="Capture history from this block. Leave empty for roughly the last 1,000 blocks.">
            <input className="input mono" inputMode="numeric" value={own.startBlock} onChange={(e) => setOwn({ ...own, startBlock: e.target.value })} />
          </Field>
        </div>
      )}

      {problem && !problem.details && <div style={{ marginTop: 14 }}><Alert tone="error" title="That didn't work">{problem.message}</Alert></div>}
      <div className="qs-actions">
        <button className="btn primary" disabled={busy || !ready} onClick={start}>{busy ? "Starting…" : watching ? "Watch this one too" : "Start watching"}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------- step 2
function DeliverStep({ projectId, events, hook, setHook, existing }) {
  const [mode, setMode] = useState("builtin");
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState(() => new Set());
  const [showFilter, setShowFilter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [copied, setCopied] = useState(false);
  const fe = fieldErrors(problem);

  async function create() {
    setBusy(true); setProblem(null);
    try {
      const body = { eventFilter: showFilter ? [...chosen] : [], description: mode === "builtin" ? "Quick start · test receiver" : "Quick start" };
      if (mode === "builtin") body.builtinReceiver = true; else body.url = url.trim();
      setHook(await api.createWebhook(projectId, body));
    } catch (e) { setProblem(e); } finally { setBusy(false); }
  }
  const toggle = (n) => setChosen((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });

  if (hook) {
    return (
      <div>
        <h2 className="h2">{hook.builtinReceiver ? "Your test receiver is ready" : "Your webhook is set up"}</h2>
        <Explain>{hook.builtinReceiver ? "PortalOps will send every event to a receiver we host, check its signature, and show you what arrived. Nothing for you to run." : "PortalOps will send each event to your address. Your server should verify the signature (see the docs) and answer with a 2xx status."}</Explain>
        <Alert tone="ok" title="Events will be delivered here">{hook.builtinReceiver ? "Hosted by PortalOps" : <span className="mono" style={{ wordBreak: "break-all" }}>{hook.url}</span>}</Alert>
        {hook.secret && (
          <div style={{ marginTop: 14 }}>
            <Alert tone={hook.builtinReceiver ? "info" : "warn"} title="Signing secret (shown only once)">
              {hook.builtinReceiver ? "You don't need this for the test receiver. Keep it only if you later point the webhook at your own server." : "Your server uses this to prove a request really came from PortalOps. Copy it now: it can't be shown again."}
              <div className="secret-box" style={{ margin: "10px 0" }}>{hook.secret}</div>
              <span onClick={() => setCopied(true)}><CopyButton text={hook.secret} label="Copy secret" className="btn secondary small" /></span>
              {copied && <span style={{ fontSize: 12.5, marginLeft: 10 }}>Copied.</span>}
            </Alert>
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      <h2 className="h2">Where should events be delivered?</h2>
      <Explain>A webhook is a web address that receives each event. Don't have a server yet? Use our test receiver: it accepts events, checks they're genuine, and shows you what arrived.</Explain>
      {existing?.length > 0 && <Alert tone="info" title={`This project already has ${existing.length} webhook${existing.length > 1 ? "s" : ""}`}>You can continue to the next step, or add another here.</Alert>}
      <div className="qs-choices">
        <Choice selected={mode === "builtin"} onSelect={() => setMode("builtin")} title="Test receiver" tag="Recommended">
          <span className="qs-blurb">Nothing to set up. Perfect for trying PortalOps, and for breaking things on purpose to see retries and replay.</span>
        </Choice>
        <Choice selected={mode === "url"} onSelect={() => setMode("url")} title="My own server">
          <span className="qs-blurb">An https address on your backend, like https://api.myapp.dev/portal-events.</span>
        </Choice>
      </div>
      {mode === "url" && (
        <div className="qs-own">
          <Field label="Your server's address" error={fe.url} hint="Must start with https://. Addresses that only work on your own computer are blocked.">
            <input className="input mono" placeholder="https://api.example.com/portal-events" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <label className="qs-check"><input type="checkbox" checked={showFilter} onChange={(e) => setShowFilter(e.target.checked)} /> Only send some events <span style={{ color: "var(--dim)" }}>(default: all of them)</span></label>
        {showFilter && (
          <div className="qs-events">
            {(events?.length ? events : []).map((n) => <label key={n} className="qs-check"><input type="checkbox" checked={chosen.has(n)} onChange={() => toggle(n)} /> <span className="mono">{n}</span></label>)}
            {!events?.length && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>This contract's events aren't known, so everything will be sent.</span>}
          </div>
        )}
      </div>
      {problem && !problem.details && <div style={{ marginTop: 14 }}><Alert tone="error" title="That didn't work">{problem.message}</Alert></div>}
      <div className="qs-actions">
        <button className="btn primary" disabled={busy || (mode === "url" && !url.trim())} onClick={create}>{busy ? "Creating…" : "Create webhook"}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------- step 3
function SeeStep({ projectId, hook, hooks, go }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const ov = useApi(() => api.overview(projectId), [projectId], { refreshMs: 4000 });
  const target = hook ?? hooks?.[0] ?? null;
  const rcv = useApi(() => api.receiver(target.id), [target?.id, result?.at], { enabled: !!target && (hook?.builtinReceiver ?? target?.builtinReceiver ?? false) });
  const setup = ov.data?.setup;

  async function test() {
    setBusy(true); setErr(null);
    try { setResult({ ...(await api.testWebhook(target.id)), at: Date.now() }); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const sig = rcv.data?.requests?.[0];
  const items = [
    ["Connected to the Portaldot testnet", setup?.networkConnected],
    ["Watching a contract", setup?.contractAdded],
    ["A webhook is ready", setup?.webhookConfigured],
    ["First event captured", setup?.firstEventReceived],
    ["First delivery succeeded", setup?.firstDeliverySucceeded],
  ];
  return (
    <div>
      <h2 className="h2">Watch it work</h2>
      <Explain>Here's the whole loop. Events appear below as PortalOps captures them from the chain, and each one is sent to your webhook. If nothing shows yet, give it up to a minute: it's reading the contract's history.</Explain>

      <div className="qs-check-list">
        {items.map(([label, ok]) => <div key={label} className={"check" + (ok ? " done" : "")}><span className="box">{ok ? "✓" : ""}</span>{label}</div>)}
      </div>

      <div className="qs-test">
        <button className="btn primary" disabled={busy || !target} onClick={test}>{busy ? "Sending…" : result ? "Send another test" : "Send a test delivery"}</button>
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Sends one signed message to your webhook to prove the path works. It isn't a real chain event.</span>
      </div>
      {!target && <div style={{ marginTop: 12 }}><Alert tone="info" title="No webhook yet">Go back one step to create one, then test it here.</Alert></div>}
      {err && <div style={{ marginTop: 12 }}><Alert tone="error" title="Couldn't send the test">{err.message}</Alert></div>}
      {result && (
        <div style={{ marginTop: 12 }}>
          <Alert tone={result.ok ? "ok" : "error"} title={result.ok ? "Test delivery succeeded" : "Test delivery failed"}>
            {result.ok ? `Your webhook answered ${result.status} in ${result.durationMs}ms.` : `${result.status ? "HTTP " + result.status : result.errorCode} after ${result.durationMs}ms. Check the address is reachable from the internet and returns a 2xx.`}
            {result.ok && sig && <> The receiver checked the signature: <strong>{sig.signatureOk ? "verified ✓" : `failed (${sig.signatureReason})`}</strong>.</>}
          </Alert>
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <LiveTimeline projectId={projectId} headBlock={ov.data?.network?.headBlock ?? null} openEvent={(id) => go("eventDetail", { id })} go={go} />
      </div>

      <div className="qs-next">
        <div className="eyebrow">What next</div>
        <ul>
          <li><button className="link-btn" onClick={() => go("overview")}>Open the Overview</button>: your dashboard, with a live timeline of everything.</li>
          <li><button className="link-btn" onClick={() => go("webhooks")}>Break it on purpose</button>: set the test receiver to fail, then replay an event to see retries.</li>
          <li><button className="link-btn" onClick={() => go("aisetup")}>Set up with Claude</button>: let an AI assistant do all of this for you.</li>
        </ul>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------- page
export default function Setup({ go }) {
  const { projectId, readOnly, project } = useSession();
  const contracts = useApi(() => api.contracts(projectId), [projectId], { enabled: !!projectId && !readOnly });
  const hooks = useApi(() => api.webhooks(projectId), [projectId], { enabled: !!projectId && !readOnly });
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [watching, setWatching] = useState(null);
  const [hook, setHook] = useState(null);
  const [net, setNet] = useState(null);

  // the network is checked quietly in the background; it only becomes visible if something is wrong
  useEffect(() => {
    if (!projectId || readOnly) return;
    api.testNetwork(projectId).then(setNet).catch(() => setNet({ chainIdVerified: false, error: "The PortalOps server could not be reached." }));
  }, [projectId, readOnly]);

  const events = useMemo(() => watching?.events ?? [], [watching]);
  if (readOnly) return <NeedsProject what="run the quick start" />;
  if (contracts.loading && !contracts.data) return <Loading />;

  const go1 = (i) => { setStep(i); setReached((r) => Math.max(r, i)); };
  const canContinue = step === 0 ? !!watching || contracts.data?.length > 0 : step === 1 ? !!hook || hooks.data?.length > 0 : true;

  return (
    <div>
      <h1 className="h1">Quick start</h1>
      <p className="sub">{project?.name} · three short steps from an empty project to your first delivered event. About two minutes.</p>
      {net && !net.chainIdVerified && (
        <div style={{ marginTop: 14 }}><Alert tone="warn" title="Can't reach the Portaldot testnet right now">{net.error ?? "The network didn't answer as expected."} You can still set things up; events start flowing once it's back.</Alert></div>
      )}
      {net?.chainIdVerified && <div className="qs-net"><span className="dot green" /> Connected to the Portaldot testnet · block #{net.headBlock?.toLocaleString()}</div>}
      <Stepper step={step} goTo={setStep} reached={reached} />

      <div className="panel tight" style={{ marginTop: 20, maxWidth: 760 }}>
        {step === 0 && <WatchStep projectId={projectId} contracts={contracts.data} reloadContracts={contracts.reload} watching={watching} onWatching={(w) => { setWatching(w); setReached((r) => Math.max(r, 1)); }} />}
        {step === 1 && <DeliverStep projectId={projectId} events={events} hook={hook} setHook={(h) => { setHook(h); hooks.reload(); setReached((r) => Math.max(r, 2)); }} existing={hooks.data} />}
        {step === 2 && <SeeStep projectId={projectId} hook={hook} hooks={hooks.data} go={go} />}

        <div className="qs-nav">
          <button className="btn secondary small" disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
          <span style={{ flex: 1 }} />
          {step < 2 && <button className="btn primary small" disabled={!canContinue} onClick={() => go1(step + 1)}>Continue →</button>}
          {step === 2 && <button className="btn primary small" onClick={() => go("overview")}>Finish and open the Overview</button>}
        </div>
      </div>
    </div>
  );
}
