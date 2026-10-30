import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { hasWallet, sendPingFromWallet } from "../wallet.js";
import { journeyComplete, pingJourney } from "./pingJourney.js";
import VerifyOnChain from "../VerifyOnChain.jsx";

const POLL_MS = 2000;
const GIVE_UP_MS = 4 * 60_000;

/**
 * "Make an event happen": send a REAL transaction to the Portaldot testnet from this page (free, from our demo wallet, or from your own wallet)
 * and watch it travel: sent, captured by PortalOps, decoded, finalized, delivered as a signed webhook.
 */
export default function PlaygroundPing({ info, onProgress }) {
  const [note, setNote] = useState("hello from my browser");
  const [phase, setPhase] = useState("idle"); // idle | sending | tracking
  const [error, setError] = useState(null);
  const [run, setRun] = useState({ hash: null, via: null, events: [], sentAt: null, capturedAt: null });
  const timer = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);

  const steps = pingJourney(run);
  const wallet = hasWallet();

  function track(hash, via, sentAt) {
    setRun({ hash, via, events: [], sentAt, capturedAt: null });
    setPhase("tracking");
    const poll = async () => {
      if (!alive.current) return;
      try {
        const r = await api.playgroundTx(hash);
        setRun((cur) => {
          if (cur.hash !== hash) return cur;
          const captured = r.events.length > 0;
          return { ...cur, events: r.events, capturedAt: cur.capturedAt ?? (captured ? Date.now() : null) };
        });
        onProgress?.();
        if (r.events.length && journeyComplete(pingJourney({ hash, events: r.events, sentAt, capturedAt: 1 }))) return;
      } catch { /* a missed poll is retried */ }
      if (Date.now() - sentAt < GIVE_UP_MS) timer.current = setTimeout(poll, POLL_MS);
    };
    timer.current = setTimeout(poll, 1200);
  }

  async function free() {
    clearTimeout(timer.current);
    setPhase("sending"); setError(null);
    try {
      const r = await api.playgroundPing(note);
      track(r.transactionHash, "demo wallet", Date.now());
    } catch (e) { setPhase("idle"); setError(e.message); }
  }

  async function mine() {
    clearTimeout(timer.current);
    setPhase("sending"); setError(null);
    try {
      const hash = await sendPingFromWallet(note.trim().slice(0, 60) || "hello from my wallet", info.contract);
      track(hash, "your wallet", Date.now());
    } catch (e) { setPhase("idle"); setError(e.message); }
  }

  if (!info?.contract) return null;
  const busy = phase === "sending";
  return (
    <section className="pg-ping" aria-label="Make an event happen">
      <div className="pg-ping-head">
        <div>
          <span className="pg-ping-tag">Real transaction · Portaldot testnet</span>
          <h2>Make an event happen</h2>
          <p>Send a real <code>ping</code> to our PortalPing contract and watch the transaction travel: onto the chain, into PortalOps, decoded, finalized and delivered as a signed webhook.</p>
        </div>
      </div>

      <div className="pg-ping-form">
        <input className="pops-in" maxLength={60} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your note (what the event will say)" aria-label="Note for the ping" />
        {info.sponsored && <button className="pbtn" disabled={busy} onClick={free} style={{ padding: "12px 20px", whiteSpace: "nowrap" }}>{busy ? "Sending…" : "Send a free ping"}</button>}
        <button className={info.sponsored ? "sbtn" : "pbtn"} disabled={busy || !wallet} onClick={mine} style={{ padding: "12px 20px", whiteSpace: "nowrap" }} title={wallet ? "" : "No wallet detected in this browser"}>Send from my wallet</button>
      </div>
      <div className="pg-ping-hint">
        {info.sponsored ? `Free pings come from a small demo wallet (${info.perDay} a day, one per visitor every 5 minutes).` : "Free pings are not switched on for this server."}{" "}
        {wallet ? "Your wallet is added to the Portaldot testnet automatically and needs a little tPOT." : "No browser wallet found: install MetaMask or Rabby to send from your own."}{" "}
        Contract <code>{info.contract.slice(0, 10)}…{info.contract.slice(-6)}</code>
      </div>
      {error && <div className="pg-msg err" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      {phase === "tracking" && (
        <ol className="pg-journey" aria-live="polite">
          {steps.map((s) => (
            <li key={s.id} className={"pg-step " + s.state}>
              <span className="pg-step-dot" aria-hidden="true">{s.state === "done" ? "✓" : s.state === "bad" ? "!" : ""}</span>
              <div><b>{s.title}</b>{s.detail ? <span>{s.detail}</span> : null}</div>
            </li>
          ))}
          {run.events[0] && <li className="pg-journey-verify"><VerifyOnChain key={run.hash} event={run.events[0]} /></li>}
          <li className="pg-journey-foot">Sent via {run.via}. {steps[1].state === "done" ? "Finality can take a minute or two more: the page keeps watching." : "Blocks arrive about every 6 seconds."}</li>
        </ol>
      )}
    </section>
  );
}
