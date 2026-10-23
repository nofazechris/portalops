import { useCallback, useEffect, useState } from "react";
import Orb from "../orb.jsx";
import StageArt from "../stageArt.jsx";
import "./pitch.css";

// The pitch deck, served from the product's own site (/pitch) so the link is public and never depends on a third-party host.
// 16:9 slides on a fixed 1280x720 stage that scales to the window; arrow keys / space / swipe-friendly buttons; #N deep-links a slide;
// printing (or ?print) lays every slide on its own page, which is how the PDF is made.

const REPO = "https://github.com/nofazechris/portalops";
const SITE = "https://portalops.onrender.com";
const QUEST = "0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649";
const PING = "0x6a8705e4621dd87a261b1c5f97b73871616537ec";

const Hl = ({ children, tone = "blue" }) => <span className={"pt-hl " + tone}>{children}</span>;
const Kicker = ({ children }) => <div className="pt-kicker">{children}</div>;

const slides = [
  {
    id: "title",
    el: (
      <div className="pt-center">
        <div className="pt-logo"><span className="pt-mark"><i /></span>PortalOps</div>
        <h1 className="pt-h1">The operational event layer<br />for <Hl>Portaldot</Hl>.</h1>
        <p className="pt-lede">Watch any contract. Get clean, signed, retried, replayable webhooks.</p>
        <div className="pt-foot-row"><span>Portaldot Hacker House</span><span>·</span><span>Track: Modular Cloud &amp; Middleware</span></div>
      </div>
    ),
  },
  {
    id: "problem",
    el: (
      <>
        <Kicker>The problem</Kicker>
        <h2 className="pt-h2">Contracts write down everything they do.<br /><Hl tone="gold">Apps barely see it.</Hl></h2>
        <div className="pt-cards3">
          <div className="pt-card"><b>Raw hex</b><p>An on-chain event is just topics and data. You need the contract's ABI to read it.</p></div>
          <div className="pt-card"><b>Reorganisations</b><p>The newest blocks can be replaced. Act too early, and you act on something that never happened.</p></div>
          <div className="pt-card red"><b>Downtime</b><p>Your server goes offline for ten minutes. The chain does not wait. Those events are gone.</p></div>
        </div>
        <p className="pt-note">So every team rebuilds the same plumbing: polling, decoding, signing, retrying. Usually after the first event they miss.</p>
      </>
    ),
  },
  {
    id: "gap",
    el: (
      <>
        <Kicker>The gap, measured</Kicker>
        <h2 className="pt-h2">We pointed PortalOps at the testnet <Hl>and just listened</Hl>.</h2>
        <div className="pt-stats">
          <div><b>32</b><span>contracts</span></div>
          <div><b>225</b><span>events</span></div>
          <div><b>65</b><span>kinds</span></div>
          <div className="zero"><b>0</b><span>readable out of the box</span></div>
        </div>
        <p className="pt-src">Portaldot V3.0 testnet · blocks 91,528 to 145,105 · measured 2026-10-22 with PortalOps' public explorer (no ABIs registered, so every event is raw)</p>
      </>
    ),
  },
  {
    id: "solution",
    el: (
      <>
        <Kicker>The solution</Kicker>
        <h2 className="pt-h2">Watch. Decode. Deliver. <Hl>Recover.</Hl></h2>
        <div className="pt-stages">
          {[
            { v: <Orb size={64} state="searching" label="Watch" />, t: "Watch", d: "Follows the chain block by block and spots logs from the contracts you register." },
            { v: <StageArt kind="decode" size={64} label="Decode" />, t: "Decode", d: "Turns raw logs into named, typed events using the contract ABI. Stored exactly once." },
            { v: <StageArt kind="deliver" size={64} label="Deliver" />, t: "Deliver", d: "Posts each event to your endpoint as a signed webhook and records what came back." },
            { v: <StageArt kind="recover" size={64} label="Recover" />, t: "Recover", d: "Retries with backoff when you are down. Replays any event later, without touching the chain." },
          ].map((s) => <div key={s.t} className="pt-stage">{s.v}<b>{s.t}</b><p>{s.d}</p></div>)}
        </div>
        <div className="pt-chips"><span>Signed (HMAC-SHA256)</span><span>Retried with backoff</span><span>Replayable, same event id</span></div>
      </>
    ),
  },
  {
    id: "why",
    el: (
      <>
        <Kicker>Why Portaldot needs it</Kicker>
        <h2 className="pt-h2">A young network. <Hl>Event tooling that has to be built.</Hl></h2>
        <div className="pt-two">
          <div className="pt-panel">
            <h3>What we found</h3>
            <ul>
              <li>32 contracts already emitting 65 kinds of events, none readable without their ABI.</li>
              <li>Builders get raw logs, then write ingestion, retries and signing themselves.</li>
              <li>The EVM layer means standard ABIs work: decoding and webhooks fit naturally.</li>
            </ul>
          </div>
          <div className="pt-panel">
            <h3>Built around how Portaldot really behaves</h3>
            <ul>
              <li>pallet-revive EVM (V3.0): account mapping handled and documented.</li>
              <li>Only ~256 recent blocks are served by number, so backfill uses log queries.</li>
              <li>Finality comes from the node's finalized head, never guessed: <i>seen, confirmed, finalized</i>.</li>
              <li>Weight-based gas: a full contract deploy costs ~180 tPOT, which shaped our demo contracts.</li>
            </ul>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "proof",
    el: (
      <>
        <Kicker>Proof it works</Kicker>
        <h2 className="pt-h2">Not a mock-up. <Hl>Live on the Portaldot testnet.</Hl></h2>
        <div className="pt-two">
          <div className="pt-contract">
            <div className="pt-ck">PortalQuest · deployed by us</div>
            <code>{QUEST}</code>
            <p>Block 145,098 · 3 real events: <b>QuestCreated</b>, <b>QuestCompleted</b>, <b>RewardIssued</b></p>
          </div>
          <div className="pt-contract">
            <div className="pt-ck">PortalPing · deployed by us</div>
            <code>{PING}</code>
            <p>Block 152,078 · live <b>Ping</b> events, captured and delivered on demand</p>
          </div>
        </div>
        <div className="pt-flow"><span>captured</span>→<span>decoded</span>→<span>delivered ✓ signature verified</span>→<span className="bad">fails (500)</span>→<span>retried</span>→<span>replayed ✓</span></div>
        <p className="pt-note">170+ automated tests, including against real testnet logs and a real PostgreSQL. A secret scan runs in CI.</p>
      </>
    ),
  },
  {
    id: "product",
    el: (
      <>
        <Kicker>The product</Kicker>
        <h2 className="pt-h2">Easy at every level, <Hl>from click to code to chat</Hl>.</h2>
        <div className="pt-cards4">
          <div className="pt-card"><b>Dashboard</b><p>A three-step quick start: pick a contract, choose where events go, watch it work.</p></div>
          <div className="pt-card"><b>Playground</b><p>No signup. Paste a contract, watch events decode live, send a signed test delivery.</p></div>
          <div className="pt-card"><b>REST API + SDK</b><p>The same API the dashboard uses, plus a typed TypeScript SDK and webhook verification.</p></div>
          <div className="pt-card"><b>Claude</b><p>Ten MCP tools: ask in plain English and it registers, wires and tests. Secrets never enter the chat.</p></div>
        </div>
      </>
    ),
  },
  {
    id: "arch",
    el: (
      <>
        <Kicker>Architecture</Kicker>
        <h2 className="pt-h2">Two small processes. <Hl>One database.</Hl></h2>
        <div className="pt-arch">
          <div className="pt-node"><b>Portaldot</b><span>logs · blocks</span></div><i>→</i>
          <div className="pt-node hot"><b>Worker</b><span>decode · finality · deliver</span></div><i>→</i>
          <div className="pt-node"><b>Store</b><span>SQLite or PostgreSQL</span></div><i>→</i>
          <div className="pt-node"><b>Your app</b><span>signed webhook</span></div>
        </div>
        <div className="pt-chips"><span>Dashboard</span><span>REST API</span><span>TypeScript SDK</span><span>Claude / MCP</span></div>
        <p className="pt-note">The API and worker share only the database. Chains plug in through a small <code>ChainAdapter</code> interface, so new sources are an adapter, not a rewrite.</p>
      </>
    ),
  },
  {
    id: "trust",
    el: (
      <>
        <Kicker>Reliability &amp; security</Kicker>
        <h2 className="pt-h2">Built to be <Hl>trusted</Hl>.</h2>
        <div className="pt-grid6">
          {[
            ["Atomic writes", "Events, deliveries and the read position move together or not at all."],
            ["Signed deliveries", "HMAC-SHA256 with a timestamp; verified with constant-time compare."],
            ["Honest finality", "Seen, confirmed, finalized by the network. Never guessed from depth."],
            ["SSRF-safe", "Deliveries cannot reach internal addresses, checked when saved and on every send."],
            ["Secrets encrypted", "AES-256-GCM at rest, shown once. Claude writes them to a local file only."],
            ["Reorg-aware", "A reorganised log becomes a different event; the old one is marked orphaned."],
          ].map(([t, d]) => <div key={t} className="pt-card"><b>{t}</b><p>{d}</p></div>)}
        </div>
      </>
    ),
  },
  {
    id: "next",
    el: (
      <>
        <Kicker>Why keep supporting it</Kicker>
        <h2 className="pt-h2">The core is built and live. <Hl>Here is what comes next.</Hl></h2>
        <div className="pt-two">
          <div className="pt-panel">
            <h3>Roadmap</h3>
            <ul>
              <li><b>Native Rust / ink! adapter</b> through the existing ChainAdapter interface.</li>
              <li><b>More Portaldot networks</b> and other chains.</li>
              <li><b>SDK on npm</b> and a hosted multi-tenant service.</li>
              <li><b>More delivery targets</b>: chat, email and queues, on the same retry and replay engine.</li>
            </ul>
          </div>
          <div className="pt-panel">
            <h3>Why it matters to Portaldot</h3>
            <ul>
              <li>Every app on the network needs this layer, and none should have to rebuild it.</li>
              <li>It makes Portaldot contracts usable from ordinary backends, bots and agents.</li>
              <li>Open source, documented, and already running against the live testnet.</li>
            </ul>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "links",
    el: (
      <div className="pt-center">
        <div className="pt-logo sm"><span className="pt-mark"><i /></span>PortalOps</div>
        <h2 className="pt-h2 c">Watch any contract. <Hl tone="gold">Never miss an event.</Hl></h2>
        <div className="pt-links">
          <div><span>Live app</span><a href={SITE}>portalops.onrender.com</a></div>
          <div><span>Try it, no signup</span><a href={`${SITE}/playground`}>portalops.onrender.com/playground</a></div>
          <div><span>Code &amp; docs</span><a href={REPO}>github.com/nofazechris/portalops</a></div>
        </div>
        <div className="pt-foot-row"><span>PortalQuest {QUEST.slice(0, 10)}…{QUEST.slice(-6)}</span><span>·</span><span>PortalPing {PING.slice(0, 10)}…{PING.slice(-6)}</span></div>
      </div>
    ),
  },
];

const startIndex = () => {
  const n = parseInt((window.location.hash || "").replace("#", ""), 10);
  return Number.isInteger(n) && n >= 1 && n <= slides.length ? n - 1 : 0;
};

export default function Pitch() {
  const [i, setI] = useState(startIndex);
  const [scale, setScale] = useState(1);
  const printing = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("print");

  const go = useCallback((n) => {
    const next = Math.max(0, Math.min(slides.length - 1, n));
    setI(next);
    try { window.history.replaceState(null, "", `#${next + 1}`); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1280, (window.innerHeight - 56) / 720));
    fit(); window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); go(i + 1); }
      else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); go(i - 1); }
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(slides.length - 1);
      else if (e.key === "f") document.documentElement.requestFullscreen?.().catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, go]);

  return (
    <div className={"pt-root" + (printing ? " printing" : "")}>
      <div className="pt-viewport">
        <div className="pt-stage-wrap" style={{ width: 1280 * scale, height: 720 * scale }}>
          <div className="pt-scaler" style={{ transform: `scale(${scale})` }}>
            {slides.map((s, k) => (
              <section key={s.id} className={"pt-slide" + (k === i ? " on" : "")} aria-hidden={k !== i} aria-label={`Slide ${k + 1} of ${slides.length}`}>
                <div className="pt-glow" />
                <div className="pt-body">{s.el}</div>
                <div className="pt-pager">{k + 1} / {slides.length}</div>
              </section>
            ))}
          </div>
        </div>
      </div>
      <nav className="pt-controls" aria-label="Slides">
        <button type="button" onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous slide">←</button>
        <div className="pt-dots">{slides.map((s, k) => <button key={s.id} type="button" className={k === i ? "on" : ""} onClick={() => go(k)} aria-label={`Go to slide ${k + 1}`} />)}</div>
        <button type="button" onClick={() => go(i + 1)} disabled={i === slides.length - 1} aria-label="Next slide">→</button>
        <span className="pt-sep" />
        <button type="button" className="txt" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>Fullscreen</button>
        <a className="txt" href="/pitch/portalops-pitch.pdf" download>PDF</a>
        <a className="txt" href="/">Home</a>
      </nav>
    </div>
  );
}
