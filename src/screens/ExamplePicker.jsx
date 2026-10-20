import { useState } from "react";
import { api } from "../api.js";
import { useApi } from "../state.jsx";
import { CopyButton, ErrorBox, Loading } from "../ui.jsx";

const TABS = [
  { id: "events", label: "Events" },
  { id: "deploy", label: "Deploy it" },
  { id: "handler", label: "Webhook code" },
  { id: "source", label: "Solidity" },
  { id: "abi", label: "ABI" },
];

function Code({ title, text }) {
  return (
    <div className="code-box" style={{ marginTop: 10 }}>
      <div className="code-head"><span>{title}</span><CopyButton text={text} label="Copy" /></div>
      <pre style={{ maxHeight: 320, overflow: "auto" }}>{text}</pre>
    </div>
  );
}

function Detail({ id, onUse }) {
  const [tab, setTab] = useState("events");
  const { data: ex, error, loading } = useApi(() => api.example(id), [id]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!ex) return null;
  return (
    <div className="card" style={{ marginTop: 12, padding: 18 }}>
      <p style={{ margin: "0 0 12px", color: "var(--fg-2)", fontSize: 13.5, lineHeight: 1.6 }}>{ex.description}</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <button type="button" className="btn primary small" onClick={() => onUse(ex)}>Use this ABI in the form below</button>
        <span style={{ fontSize: 12.5, color: "var(--muted)", alignSelf: "center" }}>Then paste the address of your deployed copy.</span>
      </div>
      <div className="tabs" role="tablist" aria-label="Example details">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="chip" onClick={() => setTab(t.id)}
            style={tab === t.id ? { color: "#080808", background: "var(--accent)", borderColor: "var(--accent)" } : undefined}>{t.label}</button>
        ))}
      </div>

      {tab === "events" && (
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          {ex.eventDetails.map((e) => (
            <div key={e.name} className="replay-row" style={{ display: "block" }}>
              <div><span className="mono" style={{ color: "var(--accent)" }}>{e.name}</span> <span style={{ color: "var(--muted)", fontSize: 12.5 }}>{e.meaning}</span></div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 6, wordBreak: "break-all" }}>{JSON.stringify(e.samplePayload)}</div>
              <div style={{ fontSize: 12.5, color: "var(--fg-2)", marginTop: 6 }}>Typical use: {e.idea}</div>
            </div>
          ))}
        </div>
      )}
      {tab === "deploy" && (
        <div style={{ marginTop: 12, fontSize: 13.5, lineHeight: 1.65, color: "var(--fg-2)" }}>
          <p style={{ margin: "0 0 8px" }}>You need a funded Portaldot V3.0 testnet account. Put a <strong>throwaway</strong> key in your local <span className="mono">.env</span> (never in chat or a commit), then:</p>
          <Code title="1 · check everything first (sends nothing)" text={`npm run contract:deploy -- --example ${ex.id}`} />
          <Code title="2 · deploy" text={ex.deployCommand} />
          <p style={{ margin: "12px 0 0" }}>It prints the contract address. Paste it below. Prefer another tool? Deploy the bytecode with any EVM tool and use that address.</p>
          <Code title={`creation bytecode · ${ex.compiler.name} ${ex.compiler.version} · evm ${ex.compiler.evmVersion}`} text={ex.bytecode} />
        </div>
      )}
      {tab === "handler" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>A receiver for your backend. It verifies the signature on the raw body, ignores duplicates, and has a branch for every event of this contract.</div>
          <Code title="receiver.ts · Node.js + Express" text={ex.handler} />
        </div>
      )}
      {tab === "source" && <Code title={`${ex.contractName}.sol`} text={ex.source} />}
      {tab === "abi" && <Code title={`${ex.contractName} ABI`} text={JSON.stringify(ex.abi, null, 2)} />}
    </div>
  );
}

/** "Start from an example": pick a ready-made contract and get its ABI, deploy command and webhook code with no Solidity knowledge. */
export default function ExamplePicker({ onUse }) {
  const { data: examples, error, loading } = useApi(() => api.examples(), []);
  const [open, setOpen] = useState(null);
  if (loading) return null;
  if (error || !examples?.length) return null; // the manual form below always works
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Start from an example</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        {examples.map((e) => (
          <button key={e.id} type="button" className={"replay-row" + (open === e.id ? " on" : "")} aria-pressed={open === e.id}
            onClick={() => setOpen(open === e.id ? null : e.id)} style={{ display: "block", textAlign: "left", cursor: "pointer" }}>
            <div style={{ fontWeight: 600 }}>{e.title}</div>
            <div style={{ color: "var(--muted)", fontSize: 12.5, margin: "4px 0 8px" }}>{e.tagline}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>{e.category} · {e.events.length} events</div>
          </button>
        ))}
      </div>
      {open && <Detail id={open} onUse={onUse} />}
      <div className="eyebrow" style={{ margin: "20px 0 8px" }}>Or register your own contract</div>
    </div>
  );
}
