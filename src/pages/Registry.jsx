import { useEffect, useState } from "react";
import { Link } from "../router.jsx";
import { api } from "../api.js";
import { shortHash, timeAgo, useApi } from "../state.jsx";
import Orb from "../orb.jsx";
import "./pages.css";
import "./landing.css";
import "./playground.css";
import "./registry.css";

const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
const settings = (v) => `${v.compiler.split("+")[0]} · ${v.evmVersion} · optimizer ${v.optimizerRuns === null ? "off" : v.optimizerRuns + " runs"}`;
const MATCH = {
  full: "Exact match: the code on chain is byte for byte what this source compiles to.",
  partial: "Same code: identical to what this source compiles to, apart from the compiler's metadata tail (a hash of the source file and compiler version).",
};

function fromHash() {
  try { const h = window.location.hash.replace(/^#/, ""); return isAddress(h) ? h.toLowerCase() : null; } catch { return null; }
}

function Detail({ address }) {
  const one = useApi(() => api.registryOne(address), [address]);
  const v = one.data;
  if (one.loading) return <div className="rg-detail pg-muted">Loading…</div>;
  if (!v) return <div className="rg-detail pg-muted">{one.error?.message ?? "Not found."}</div>;
  return (
    <div className="rg-detail">
      <p className="rg-match">{MATCH[v.matchType]}</p>
      <div className="rg-facts">
        <span>{settings(v)}</span><span>{v.runtimeBytes.toLocaleString()} bytes on chain</span><span>{v.functions} functions</span>
        <span>{v.activity.events} events seen{v.activity.lastEventAt ? `, last ${timeAgo(v.activity.lastEventAt)}` : ""}</span>
      </div>
      {v.events.length > 0 && <div className="rg-events">{v.events.map((e) => <code key={e}>{e}{v.activity.names[e] ? ` × ${v.activity.names[e]}` : ""}</code>)}</div>}
      <details className="rg-src" open>
        <summary>Source ({v.source.split("\n").length} lines)</summary>
        <pre>{v.source}</pre>
      </details>
      <div className="rg-actions">
        <button className="sbtn soft" onClick={() => navigator.clipboard?.writeText(JSON.stringify(v.abi, null, 2))}>Copy ABI</button>
        <Link className="sbtn soft" href="/playground">Watch it in the playground</Link>
      </div>
    </div>
  );
}

export default function Registry() {
  const list = useApi(() => api.registry(), [], { refreshMs: 15000 });
  const [open, setOpen] = useState(fromHash());
  const [addr, setAddr] = useState("");
  const [src, setSrc] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { const on = () => setOpen(fromHash()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  const toggle = (a) => { const next = open === a ? null : a; setOpen(next); try { window.history.replaceState(null, "", next ? "#" + next : window.location.pathname); } catch { /* ignore */ } };

  async function submit() {
    if (!isAddress(addr)) { setResult({ err: true, text: "That isn't a valid address (0x + 40 hex)." }); return; }
    if (src.trim().length < 10) { setResult({ err: true, text: "Paste the Solidity source of the contract." }); return; }
    setBusy(true); setResult(null);
    try {
      const r = await api.registryVerify({ address: addr.trim(), source: src, ...(name.trim() ? { contractName: name.trim() } : {}) });
      setResult({ err: false, text: `Verified: ${r.name} at ${shortHash(r.address, 8, 6)} (${r.matchType === "full" ? "exact match" : "same code"}). Its events are now decoded by name for everyone.` });
      setAddr(""); setSrc(""); setName("");
      list.reload();
      toggle(r.address);
    } catch (e) {
      setResult({ err: true, text: e.message, details: Array.isArray(e.details) ? e.details.map((d) => d.message) : [] });
    } finally { setBusy(false); }
  }

  const items = list.data?.items ?? [];
  return (
    <div className="lp pg">
      <nav className="lp-nav">
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg)" }}>
          <span className="brand-mark" style={{ width: 22, height: 22, borderRadius: 6 }}><i style={{ width: 8, height: 8 }} /></span>
          <span style={{ fontWeight: 600, fontSize: 16 }}>PortalOps</span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Link className="top-link" href="/playground" style={{ fontSize: 14 }}>Playground</Link>
          <Link className="top-link" href="/docs/guides/verified-contracts" style={{ fontSize: 14 }}>Docs</Link>
          <Link className="pbtn" href="/auth#signup" style={{ fontSize: 14, padding: "9px 16px", borderRadius: 8 }}>Start Building</Link>
        </div>
      </nav>

      <header className="pg-head">
        <span className="pg-tag"><Orb size={20} state="breathing" label="" /> Verified contracts · Portaldot testnet</span>
        <h1 className="lp-h1" style={{ fontSize: 46, margin: "16px 0 0", letterSpacing: "-0.03em" }}>Source you can <span className="i" style={{ fontFamily: "var(--mono)", fontStyle: "normal", color: "var(--accent)" }}>trust.</span></h1>
        <p style={{ fontSize: 17, color: "var(--fg-3)", maxWidth: 660, margin: "14px 0 0", lineHeight: 1.55 }}>
          A public directory of Portaldot contracts whose source was compiled here and <b style={{ color: "var(--fg)" }}>proven to be the code running on chain</b>. Verify yours once and everyone gets its ABI, named events and live activity, with no setup.
        </p>
      </header>

      <section className="rg-grid">
        <div>
          <h2 className="pg-h2">Verified <span className="pg-muted">{list.data ? `${list.data.total} contract${list.data.total === 1 ? "" : "s"}` : ""}</span></h2>
          {list.loading && <div className="pg-muted">Loading…</div>}
          {list.error && !list.data && <div className="pg-msg err">{list.error.message}</div>}
          {list.data && items.length === 0 && <div className="pg-muted">Nothing verified yet. Be the first.</div>}
          <div className="pg-cards">
            {items.map((v) => (
              <article key={v.address} className={"pg-card rg-card" + (open === v.address ? " open" : "")}>
                <button className="rg-head" onClick={() => toggle(v.address)} aria-expanded={open === v.address}>
                  <span className="pg-name">{v.name}</span>
                  <span className={"rg-badge " + v.matchType}>{v.matchType === "full" ? "Exact match" : "Same code"}</span>
                </button>
                <code className="pg-addr">{v.address}</code>
                <div className="pg-card-meta"><span>{v.events.length} event{v.events.length === 1 ? "" : "s"}</span><span>{v.activity.events} seen</span><span>verified {timeAgo(v.verifiedAt)}</span></div>
                {v.events.length > 0 && <div className="pg-events-list">{v.events.join(" · ")}</div>}
                {open === v.address && <Detail address={v.address} />}
              </article>
            ))}
          </div>
        </div>

        <div>
          <h2 className="pg-h2">Verify a contract</h2>
          <div className="rg-form">
            <input className="pops-in mono" placeholder="0x… address of the deployed contract" value={addr} onChange={(e) => setAddr(e.target.value)} />
            <textarea className="pops-in mono rg-src-in" placeholder={"// Paste the single-file Solidity source\npragma solidity ^0.8.20;\ncontract …"} value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} />
            <input className="pops-in" placeholder="Contract name (optional, if the file has several)" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="pbtn" disabled={busy} onClick={submit} style={{ padding: "12px 22px" }}>{busy ? "Compiling and comparing…" : "Verify"}</button>
            {result && (
              <div className={"pg-msg " + (result.err ? "err" : "ok")} role={result.err ? "alert" : "status"}>
                {result.text}
                {result.details?.length > 0 && <ul className="rg-why">{result.details.map((d, i) => <li key={i}><code>{d}</code></li>)}</ul>}
              </div>
            )}
            <p className="pg-note" style={{ textAlign: "left", marginTop: 4 }}>
              One file, no imports (flatten with <code>forge flatten</code>). PortalOps tries the usual settings (paris, optimizer on 200 runs or off) and compiles with the Solidity compiler PortalOps ships. Three tries per ten minutes.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
