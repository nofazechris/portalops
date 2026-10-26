import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "../router.jsx";
import Orb, { useReducedMotion } from "../orb.jsx";
import Reveal from "../reveal.jsx";
import { AI_FINAL, AI_PROMPT, AI_TOTAL_MS, snapshotAt } from "./landingAi.js";

const MCP_COMMAND = `claude mcp add portalops \\
  --env PORTALOPS_API_URL=https://portalops.onrender.com \\
  --env PORTALOPS_API_KEY=pops_your_key_here \\
  -- npx -y @portalops/mcp`;

/** What the orb is "doing", in words a visitor understands. */
const ORB_LABEL = {
  listening: "Waiting for your request",
  searching: "Looking around your project",
  connecting: "Reaching the chain",
  working: "Setting things up",
  weaving: "Testing the delivery",
  composing: "Reading the results",
  breathing: "Done. Watching your contract",
};

/** Copy-to-clipboard that never throws (clipboard access can be refused) and tells the user what happened. */
function CopyButton({ text, label = "Copy" }) {
  const [state, setState] = useState("idle");
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState("done"); } catch { setState("failed"); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };
  return <button type="button" className="ai-copy" onClick={copy} aria-live="polite">{state === "done" ? "Copied ✓" : state === "failed" ? "Press Ctrl+C" : label}</button>;
}

/** Drives snapshotAt(): null until Run is pressed, then milliseconds elapsed. Jumps straight to the end for reduced motion. */
function useReplay(reduced) {
  const [t, setT] = useState(null);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const run = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (reduced) { setT(AI_TOTAL_MS); return; }
    const started = performance.now();
    setT(0);
    const tick = (now) => {
      const elapsed = now - started;
      if (elapsed >= AI_TOTAL_MS) { setT(AI_TOTAL_MS); return; }
      setT(elapsed);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [reduced]);
  return [t, run];
}

function Step({ s }) {
  if (s.kind === "thought") return <div className="ai-line ai-thought"><span className="ai-gutter">…</span>{s.text}</div>;
  if (s.kind === "final") return <div className="ai-line ai-final"><span className="ai-gutter ai-ok">✓</span><span>{s.text}</span></div>;
  return (
    <div className={"ai-line ai-tool" + (s.status === "done" ? " done" : "")}>
      <span className="ai-gutter">{s.status === "done" ? <b className="ai-ok">✓</b> : <i className="ai-spin" aria-hidden="true" />}</span>
      <div>
        <div><code className="ai-tname">{s.tool}</code>{s.args ? <span className="ai-targs">({s.args})</span> : null}</div>
        {s.result ? <div className="ai-result">{s.result}</div> : null}
        {s.note ? <div className="ai-note">🔒 {s.note}</div> : null}
      </div>
    </div>
  );
}

export default function LandingAi() {
  const reduced = useReducedMotion();
  const [t, run] = useReplay(reduced);
  const idle = t === null;
  const snap = idle ? { ...snapshotAt(0), promptChars: 0, orb: "listening" } : snapshotAt(t);
  const running = !idle && !snap.finished;
  const view = reduced && !idle ? AI_FINAL : snap;

  return (
    <section id="ai" className="ai">
      <Reveal className="ai-head">
        <span className="ai-tag"><Orb size={20} state="breathing" label="" /> AI-native setup</span>
        <h2 className="lp-h2-big ai-h2">Tell Claude what to watch.<br />It sets up the rest.</h2>
        <p className="ai-sub">
          PortalOps ships a Claude tool server. Describe your goal in one sentence and your coding agent registers the contract, creates the webhook,
          sends a signed test delivery and shows you real events, all without leaving your editor. Press <b>Run</b> to watch it happen.
        </p>
      </Reveal>

      <div className="ai-grid">
        <Reveal className="ai-left">
          <ol className="ai-paths">
            <li>
              <span className="ai-n">1</span>
              <div>
                <h3>Create an API key</h3>
                <p>Sign in, then <b>Settings → API keys</b>. Pick <i>write</i> so Claude can set things up. Keys are shown once, never paste one into a chat.</p>
              </div>
            </li>
            <li>
              <span className="ai-n">2</span>
              <div>
                <h3>Add the PortalOps server to Claude Code</h3>
                <div className="ai-cmd"><pre>{MCP_COMMAND}</pre><CopyButton text={MCP_COMMAND} /></div>
              </div>
            </li>
            <li>
              <span className="ai-n">3</span>
              <div>
                <h3>Ask in plain English</h3>
                <div className="ai-cmd ai-cmd-prompt"><pre>{AI_PROMPT}</pre><CopyButton text={AI_PROMPT} label="Copy prompt" /></div>
              </div>
            </li>
          </ol>
          <div className="ai-actions">
            <Link className="pbtn btn-lg" href="/docs/guides/claude-setup">Read the setup guide →</Link>
            <Link className="sbtn btn-lg" href="/auth#signup">Create an account</Link>
          </div>
          <p className="ai-safe">
            <b>Your secrets stay out of the chat.</b> The signing secret is written straight to a git-ignored <code>.env.portalops</code> file on your machine.
            Claude only ever sees a masked preview. Works with any MCP-capable agent.
          </p>
        </Reveal>

        <Reveal delay={120} className="ai-term" aria-label="Animated replay of Claude setting up PortalOps">
          <div className="ai-term-bar">
            <span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="ai-term-title">claude · portalops</span>
            <span className="ai-term-flag">illustrated replay of a real run</span>
          </div>

          <div className="ai-orbrow" aria-live="polite">
            <Orb size={64} state={view.orb} label={ORB_LABEL[view.orb]} speed={running ? 1.25 : 1} />
            <div>
              <div className="ai-orb-state">{ORB_LABEL[view.orb]}</div>
              <div className="ai-orb-sub">{idle ? "Press Run to start the replay" : running ? "Claude is calling PortalOps tools…" : "Finished in about 14 seconds"}</div>
            </div>
          </div>

          <div className="ai-body">
            <div className="ai-line ai-user">
              <span className="ai-gutter">&gt;</span>
              <span>{idle ? <em className="ai-placeholder">Describe what you want PortalOps to watch…</em> : (reduced ? AI_PROMPT : AI_PROMPT.slice(0, view.promptChars))}{running && view.promptChars < AI_PROMPT.length ? <span className="ai-caret" /> : null}</span>
            </div>
            {view.steps.map((s) => <Step key={s.id} s={s} />)}
          </div>

          <div className="ai-term-foot">
            <button type="button" className="ai-run" onClick={run} disabled={running}>
              {idle ? <>▶ Run</> : running ? <>Running…</> : <>↻ Replay</>}
            </button>
            <div className="ai-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress * 100)} aria-label="Replay progress"><i style={{ width: `${(idle ? 0 : view.progress) * 100}%` }} /></div>
            <span className="ai-foot-note">nothing here calls a server</span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
