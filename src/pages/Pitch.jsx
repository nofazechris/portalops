import { useCallback, useEffect, useState } from "react";
import Orb from "../orb.jsx";
import StageArt from "../stageArt.jsx";
import "./pitch.css";

// The pitch deck, served from the product's own site (/pitch) so the link is public and never depends on a third-party host.
// 16:9 slides on a fixed 1280x720 stage that scales to the window; arrow keys / space / buttons; #N deep-links a slide;
// printing (or ?print) lays every slide on its own page, which is how the PDF is made.
//
// Story: where Portaldot is heading (agents, games, fast builders) -> the gap today -> what PortalOps is today (proof) ->
// where it goes next (agents, fast deploy, security watching) -> why Portaldot should back it.
// Every slide is tagged Built today / Part built / Next, so roadmap is never presented as shipped.

const REPO = "https://github.com/nofazechris/portalops";
const SITE = "https://portalops.onrender.com";
const QUEST = "0x274F8AbeCAa7FE3772A2cB92F67F2ed4A64bc649";
const PING = "0x6a8705e4621dd87a261b1c5f97b73871616537ec";

const Hl = ({ children, tone = "blue" }) => <span className={"pt-hl " + tone}>{children}</span>;
const Kicker = ({ children }) => <div className="pt-kicker">{children}</div>;
const Badge = ({ kind }) => <span className={"pt-badge " + kind}>{{ built: "Built today", part: "Part built", next: "On the roadmap" }[kind]}</span>;

const slides = [
  {
    id: "title",
    el: (
      <div className="pt-center">
        <div className="pt-logo"><span className="pt-mark"><i /></span>PortalOps</div>
        <h1 className="pt-h1">The nervous system<br />for <Hl>Portaldot</Hl>.</h1>
        <p className="pt-lede">Today: signed, retried, replayable events for any contract. Next: the layer that AI agents, games and security tools build on.</p>
        <div className="pt-foot-row"><span>Portaldot Hacker House</span><span>·</span><span>Track: Modular Cloud &amp; Middleware</span></div>
      </div>
    ),
  },
  {
    id: "vision",
    el: (
      <>
        <Kicker>Where Portaldot is heading</Kicker>
        <h2 className="pt-h2">The next apps on Portaldot will be <Hl>agents and games</Hl>.</h2>
        <div className="pt-cards3">
          <div className="pt-card"><b>AI agents</b><p>They act on-chain and react to what happens on-chain, all day, with no human watching.</p></div>
          <div className="pt-card"><b>Games</b><p>Every move, quest and reward is an event. Games live and die by how fast they can react.</p></div>
          <div className="pt-card"><b>Builders</b><p>They need to ship contracts fast, and know right away if something is going wrong.</p></div>
        </div>
        <p className="pt-note">All three need the same thing: to know, reliably and in real time, <b>what just happened on the chain</b>. That is the layer PortalOps provides.</p>
      </>
    ),
  },
  {
    id: "gap",
    el: (
      <>
        <Kicker>The gap today</Kicker>
        <h2 className="pt-h2">But a contract's events are <Hl tone="gold">unreadable</Hl> out of the box.</h2>
        <div className="pt-stats">
          <div><b>32</b><span>contracts</span></div>
          <div><b>225</b><span>events</span></div>
          <div><b>65</b><span>kinds</span></div>
          <div className="zero"><b>0</b><span>readable without an ABI</span></div>
        </div>
        <div className="pt-chips"><span>raw hex</span><span>reorganised blocks</span><span>servers that go down</span></div>
        <p className="pt-src">Portaldot V3.0 testnet · blocks 91,528 to 145,105 · measured 2026-10-22 with PortalOps' public explorer (no ABIs registered, so every event is raw)</p>
      </>
    ),
  },
  {
    id: "today",
    el: (
      <>
        <Badge kind="built" />
        <Kicker>What PortalOps is today</Kicker>
        <h2 className="pt-h2">Watch. Decode. Deliver. <Hl>Recover.</Hl></h2>
        <div className="pt-stages">
          {[
            { v: <Orb size={64} state="searching" label="Watch" />, t: "Watch", d: "Follows the chain block by block and spots logs from the contracts you register." },
            { v: <StageArt kind="decode" size={64} label="Decode" />, t: "Decode", d: "Turns raw logs into named, typed events using the contract ABI. Stored exactly once." },
            { v: <StageArt kind="deliver" size={64} label="Deliver" />, t: "Deliver", d: "Posts each event to your endpoint as a signed webhook and records what came back." },
            { v: <StageArt kind="recover" size={64} label="Recover" />, t: "Recover", d: "Retries with backoff when you are down. Replays any event later, without touching the chain." },
          ].map((s) => <div key={s.t} className="pt-stage">{s.v}<b>{s.t}</b><p>{s.d}</p></div>)}
        </div>
        <div className="pt-chips"><span>Dashboard</span><span>No-signup playground</span><span>REST API</span><span>TypeScript SDK</span><span>Claude (MCP)</span></div>
      </>
    ),
  },
  {
    id: "proof",
    el: (
      <>
        <Badge kind="built" />
        <Kicker>Proof it works</Kicker>
        <h2 className="pt-h2">Not a mock-up. <Hl>Live on the Portaldot testnet.</Hl></h2>
        <div className="pt-two">
          <div className="pt-contract">
            <div className="pt-ck">PortalQuest · deployed by us</div>
            <code>{QUEST}</code>
            <p>Block 145,098 · real events: <b>QuestCreated</b>, <b>QuestCompleted</b>, <b>RewardIssued</b></p>
          </div>
          <div className="pt-contract">
            <div className="pt-ck">PortalPing · deployed by us</div>
            <code>{PING}</code>
            <p>Block 152,078 · live <b>Ping</b> events, captured and delivered on demand</p>
          </div>
        </div>
        <div className="pt-flow"><span>captured</span>→<span>decoded</span>→<span>delivered ✓ signature verified</span>→<span className="bad">fails (500)</span>→<span>retried</span>→<span>replayed ✓</span></div>
        <div className="pt-chips"><span>170+ tests, incl. real testnet logs</span><span>HMAC-signed</span><span>SSRF-safe</span><span>AES-256-GCM secrets</span><span>Reorg-aware, honest finality</span></div>
      </>
    ),
  },
  {
    id: "agents-today",
    el: (
      <>
        <Badge kind="built" />
        <Kicker>AI agents, already</Kicker>
        <h2 className="pt-h2">An agent can <Hl>operate PortalOps</Hl> today.</h2>
        <div className="pt-two">
          <div className="pt-panel">
            <h3>Ten Claude (MCP) tools</h3>
            <ul>
              <li>Ask in plain English: <i>"Watch my Quest contract and send its events to the test receiver."</i></li>
              <li>The agent checks the project, registers the contract with the right ABI, creates the webhook and sends a signed test.</li>
              <li>Signing secrets are written to a local file. They never enter the chat.</li>
            </ul>
          </div>
          <div className="pt-panel">
            <h3>Why this matters</h3>
            <ul>
              <li>Setting up chain monitoring is a conversation, not a project.</li>
              <li>Agents get a safe, scoped way in: project-limited keys, read or write.</li>
              <li>It is the first step toward agents that <b>watch</b> the chain, not just write to it.</li>
            </ul>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "agents-next",
    el: (
      <>
        <Badge kind="next" />
        <Kicker>The future: agents on Portaldot</Kicker>
        <h2 className="pt-h2">PortalOps becomes the <Hl>eyes of every agent</Hl> on the chain.</h2>
        <div className="pt-cards4">
          <div className="pt-card"><b>Events as triggers</b><p>On-chain events flow straight into an agent's loop as signed, decoded messages.</p></div>
          <div className="pt-card"><b>Finality-gated actions</b><p>An agent acts only on <i>finalized</i> data, so it never moves money on a reorganised block.</p></div>
          <div className="pt-card"><b>Crash recovery</b><p>If an agent goes down, replay catches it up exactly, with nothing missed or doubled.</p></div>
          <div className="pt-card"><b>Agent audit trail</b><p>Watch what each agent's wallet does on-chain, as readable events with full history.</p></div>
        </div>
        <div className="pt-flow"><span>event on chain</span>→<span>PortalOps: decoded, finalized</span>→<span>agent decides</span>→<span>contract call</span>→<span>PortalOps confirms</span></div>
      </>
    ),
  },
  {
    id: "deploy-next",
    el: (
      <>
        <Badge kind="part" />
        <Kicker>The future: building on Portaldot, fast</Kicker>
        <h2 className="pt-h2">From idea to a <Hl>live game contract in minutes</Hl>.</h2>
        <div className="pt-flow big"><span>describe it</span>→<span>template</span>→<span>compile</span>→<span>deploy</span>→<span>watch</span>→<span>webhooks live</span></div>
        <div className="pt-two">
          <div className="pt-panel">
            <h3>Built today</h3>
            <ul>
              <li>Game-shaped starter contracts: a quest board, a bounty board and a token, each with ABI and a ready receiver.</li>
              <li>Scripts that compile and deploy a contract, with gas and balance checks for Portaldot's weight-based costs, then the dashboard watches it once you paste the address and ABI.</li>
            </ul>
          </div>
          <div className="pt-panel">
            <h3>Next</h3>
            <ul>
              <li>One command, or one sentence to Claude, that deploys <b>and</b> starts watching.</li>
              <li>More templates for common game and agent patterns, with events already wired to webhooks.</li>
            </ul>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "security-next",
    el: (
      <>
        <Badge kind="next" />
        <Kicker>The future: security that never sleeps</Kicker>
        <h2 className="pt-h2">Real-time <Hl>security watching</Hl> for every contract.</h2>
        <div className="pt-chips big"><span>unlimited approvals</span><span>ownership transferred</span><span>mint / burn spikes</span><span>repeated failed calls</span><span>admin functions called</span></div>
        <div className="pt-two">
          <div className="pt-panel">
            <h3>How it works</h3>
            <ul>
              <li>Alert rules run over the same live event stream, as soon as an event is captured.</li>
              <li>Reorg- and finality-aware, so alerts are not false alarms.</li>
              <li>Delivered to Slack, Discord, email, a webhook, or an agent that can react.</li>
            </ul>
          </div>
          <div className="pt-panel">
            <h3>Built on what exists</h3>
            <ul>
              <li>The event stream and decoding.</li>
              <li>Automations that already route events by rule.</li>
              <li>The delivery engine with signing, retries and replay.</li>
            </ul>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "why",
    el: (
      <>
        <Kicker>Why Portaldot should back this</Kicker>
        <h2 className="pt-h2">Make Portaldot the chain where <Hl>agents and games ship fastest</Hl>.</h2>
        <div className="pt-two">
          <div className="pt-panel">
            <h3>What it does for the ecosystem</h3>
            <ul>
              <li>Every developer and every agent gets observability from day one, instead of rebuilding it.</li>
              <li>Faster building and safer contracts means more apps, and apps that last.</li>
              <li>A visible reason to build here: events are readable, reliable and secure by default.</li>
            </ul>
          </div>
          <div className="pt-panel">
            <h3>Built around how Portaldot really behaves</h3>
            <ul>
              <li>pallet-revive EVM: account mapping handled and documented.</li>
              <li>Only ~256 recent blocks are served by number, so backfill uses log queries.</li>
              <li>Finality comes from the node's finalized head, never guessed.</li>
              <li>Weight-based gas shaped our deploy tooling.</li>
            </ul>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "roadmap",
    el: (
      <>
        <Kicker>Roadmap</Kicker>
        <h2 className="pt-h2">The core is live. <Hl>Support turns it into the platform.</Hl></h2>
        <div className="pt-cols3">
          <div className="pt-col now"><h3>Now · live</h3><ul><li>Watch, decode, deliver, recover</li><li>Dashboard, playground, REST API</li><li>Claude (MCP) setup</li><li>Live on the testnet, open source</li></ul></div>
          <div className="pt-col next"><h3>Next</h3><ul><li>SDK and Claude tools on npm: done</li><li>Security alert rules</li><li>Agent triggers and audit trail</li><li>One-step deploy and watch</li></ul></div>
          <div className="pt-col later"><h3>Later</h3><ul><li>Live ink! proof on the testnet</li><li>Hosted multi-tenant service</li><li>More Portaldot networks and chains</li><li>Chat, email and queue targets</li></ul></div>
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
