import { useState } from "react";
import { Link } from "../router.jsx";
import { api } from "../api.js";
import { shortHash, timeAgo, useApi } from "../state.jsx";
import Orb from "../orb.jsx";
import PlaygroundPing from "./PlaygroundPing.jsx";
import "./pages.css";
import "./landing.css";
import "./playground.css";

const QUEST = "0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649";
const BUSY = "0xe0114adc0a2072b602c645f5a07eefa1eadbdbc2";
// How to read a pasted contract's events. "Raw" captures them undecoded; the others use that example's ABI (a copy of it, or a game you built on it).
const KINDS = [["", "Show raw events (no ABI)"], ["quest", "Quest board"], ["token", "Token"], ["bounty", "Bounty board"], ["arena", "Arena game"]];
const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export default function Playground() {
  const pg = useApi(() => api.playground(), [], { refreshMs: 6000 });
  const [addr, setAddr] = useState("");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);

  const data = pg.data;
  const pinned = new Set((data?.pinned ?? []).map((a) => a.toLowerCase()));

  async function watch(address, example) {
    if (!isAddress(address)) { setMsg({ err: true, text: "That isn't a valid address (0x + 40 hex)." }); return; }
    setBusy(true); setMsg(null);
    try {
      const c = await api.playgroundWatch(address.trim(), example);
      setMsg({ err: false, text: `Watching ${c.name || shortHash(c.address, 8, 6)} — events will appear below.` });
      setAddr("");
      pg.reload();
    } catch (e) { setMsg({ err: true, text: e.message }); }
    finally { setBusy(false); }
  }

  async function sendTest() {
    setBusy(true); setTest(null);
    try {
      const r = await api.playgroundTest();
      setTest(r.ok ? { ok: true, text: `Delivered: ${r.status} in ${r.durationMs}ms, signature verified.` } : { ok: false, text: `${r.status ?? r.errorCode}` });
      setTimeout(() => pg.reload(), 600);
    } catch (e) { setTest({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="lp pg">
      <nav className="lp-nav">
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg)" }}>
          <span className="brand-mark" style={{ width: 22, height: 22, borderRadius: 6 }}><i style={{ width: 8, height: 8 }} /></span>
          <span style={{ fontWeight: 600, fontSize: 16 }}>PortalOps</span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Link className="top-link" href="/docs" style={{ fontSize: 14 }}>Docs</Link>
          <Link className="pbtn" href="/auth#signup" style={{ fontSize: 14, padding: "9px 16px", borderRadius: 8 }}>Start Building</Link>
        </div>
      </nav>

      <header className="pg-head">
        <span className="pg-tag"><Orb size={20} state="breathing" label="" /> Playground · no signup</span>
        <h1 className="lp-h1" style={{ fontSize: 46, margin: "16px 0 0", letterSpacing: "-0.03em" }}>Watch a contract. See it <span className="i" style={{ fontFamily: "var(--mono)", fontStyle: "normal", color: "var(--accent)" }}>work.</span></h1>
        <p style={{ fontSize: 17, color: "var(--fg-3)", maxWidth: 620, margin: "14px 0 0", lineHeight: 1.55 }}>
          Paste any Portaldot V3.0 testnet contract, or pick one of ours. PortalOps decodes its events live. Send a real transaction yourself, then send a <b style={{ color: "var(--fg)" }}>signed test delivery</b> and watch it arrive verified. No account needed.
        </p>
      </header>

      <section className="pg-watch">
        <div className="pg-form">
          <input className="pops-in mono" placeholder="0x… contract address on the Portaldot testnet" value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && watch(addr, kind || undefined)} />
          <select className="pops-in pg-kind" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="How to decode its events">
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="pbtn" disabled={busy} onClick={() => watch(addr, kind || undefined)} style={{ padding: "12px 22px", whiteSpace: "nowrap" }}>Watch</button>
        </div>
        <div className="pg-quick">
          <span className="muted">Or try:</span>
          <button className="chip-btn" onClick={() => watch(QUEST, "quest")}>PortalOps Quest board</button>
          <button className="chip-btn" onClick={() => watch(BUSY, "token")}>A busy token</button>
        </div>
        {msg && <div className={"pg-msg " + (msg.err ? "err" : "ok")}>{msg.text}</div>}
      </section>

      <PlaygroundPing info={data?.ping} onProgress={pg.reload} />

      <section className="pg-grid">
        <div className="pg-col">
          <h2 className="pg-h2">Watching now</h2>
          <div className="pg-cards">
            {(data?.contracts ?? []).map((c) => (
              <div key={c.id} className="pg-card">
                <div className="pg-card-top">
                  <span className="pg-name">{c.name || "Contract"}</span>
                  {pinned.has(c.address.toLowerCase()) ? <span className="pg-pin">ours</span> : <span className="pg-pin community">added</span>}
                </div>
                <code className="pg-addr">{shortHash(c.address, 12, 8)}</code>
                <div className="pg-card-meta">
                  <span>{c.eventCount} event{c.eventCount === 1 ? "" : "s"}</span>
                  <span>{c.hasAbi ? `${c.events.length} type${c.events.length === 1 ? "" : "s"}` : "raw logs"}</span>
                </div>
                {c.events.length > 0 && <div className="pg-events-list">{c.events.join(" · ")}</div>}
              </div>
            ))}
            {pg.loading && !data && <div className="pg-muted">Loading…</div>}
          </div>

          <h2 className="pg-h2" style={{ marginTop: 30 }}>Send a signed delivery</h2>
          <p className="pg-muted" style={{ margin: "0 0 12px" }}>One signed webhook to the built-in receiver — exactly what your app would get.</p>
          <button className="sbtn" disabled={busy} onClick={sendTest} style={{ padding: "11px 20px", gap: 9 }}>
            <Orb size={20} state="connecting" label="" />Send a signed test
          </button>
          {test && <div className={"pg-msg " + (test.ok ? "ok" : "err")} style={{ marginTop: 12 }}>{test.text}</div>}
          <div className="pg-receiver">
            {(data?.receiver ?? []).map((r, i) => (
              <div key={i} className="pg-rcv-row">
                <span className={"pg-rcv-dot " + (r.signatureOk ? "ok" : "bad")} />
                <span className="mono">{r.httpStatus}</span>
                <span className="pg-rcv-out">{r.outcome}{r.signatureOk ? " · signature verified ✓" : ""}</span>
                <span className="pg-muted" style={{ marginLeft: "auto" }}>{timeAgo(r.receivedAt)}</span>
              </div>
            ))}
            {(data?.receiver ?? []).length === 0 && <div className="pg-muted">No deliveries yet — press the button above.</div>}
          </div>
        </div>

        <div className="pg-col">
          <h2 className="pg-h2">Live events <span className="pg-live"><span className="dot green" style={{ animation: "blink 2s infinite" }} />live</span></h2>
          <div className="pg-timeline">
            {(data?.events ?? []).map((e) => (
              <div key={e.id} className="pg-ev">
                <span className="pg-ev-name">{e.eventName ?? "Raw log"}</span>
                <span className="mono pg-ev-sub">{shortHash(e.contractAddress, 6, 4)} · #{e.blockNumber}</span>
                <span className="pg-ev-fin">{e.finalityStatus}</span>
              </div>
            ))}
            {(data?.events ?? []).length === 0 && <div className="pg-muted">No events captured yet. Add a busy contract, or wait a few seconds.</div>}
          </div>
        </div>
      </section>

      <section className="pg-cta">
        <div>
          <h2 className="lp-h2" style={{ fontSize: 26 }}>Like what you see?</h2>
          <p style={{ color: "var(--fg-3)", margin: "8px 0 0" }}>Create your own project to deliver to your real endpoint, with retries and replay.</p>
        </div>
        <Link className="pbtn btn-lg" href="/auth#signup">Start Building →</Link>
      </section>

      <div className="pg-note mono">The playground is a shared, rate-limited sandbox. Contracts you add are public and may be removed. Deliveries go only to PortalOps' built-in receiver.</div>
    </div>
  );
}
