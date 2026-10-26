import { useEffect, useRef, useState } from "react";
import { Link } from "../router.jsx";
import { api } from "../api.js";
import { useApi } from "../state.jsx";
import { EVENT_SHAPE, MAX_ATTEMPTS, MISSIONS, RECEIVER_MODES, isRetryableStatus, nextDelayMs, runInWorker } from "./arenaLab.js";
import { applyKey, cursorPosition, highlight } from "./codeEditor.js";
import "./arena.css";

// A coding-challenge workspace: problem on the left, editor on the right, a console underneath with the test results, the delivery
// simulator and the "run it for real" guide. Progress and code are kept in the visitor's browser.

const STORE = "portalops.arena.v1";
const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode: progress simply is not kept */ } };

const copy = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
function CopyBtn({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="al-ghost sm" onClick={async () => { if (await copy(text)) { setDone(true); setTimeout(() => setDone(false), 1400); } }}>{done ? "Copied" : label}</button>;
}

// ---- the delivery simulator: PortalOps' real retry rules, sped up -----------------------------------------------------------------
const SPEED = 4; // simulated seconds per real second
const ARENA_EVENTS = [
  { name: "BattleResolved", sample: '{ battleId: "7", winner: "0xA1…", loser: "0xB2…", xpGained: "40" }' },
  { name: "LootDropped", sample: '{ player: "0xA1…", itemId: "3", item: "Iron Sword" }' },
  { name: "LevelUp", sample: '{ player: "0xA1…", level: "3" }' },
  { name: "PlayerJoined", sample: '{ player: "0xC3…", name: "Cleo" }' },
];

async function sampleSignature(secret, body) {
  try {
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body)));
    return "t=" + t + ",v1=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24) + "…";
  } catch { return "t=…,v1=…"; }
}

function Simulator() {
  const [mode, setMode] = useState("up");
  const [evIdx, setEvIdx] = useState(0);
  const [run, setRun] = useState(null); // { id, name, header, rows: [], state: "sending" | "retrying" | "delivered" | "failed" }
  const modeRef = useRef(mode);
  const timers = useRef([]);
  const alive = useRef(true);
  modeRef.current = mode;
  useEffect(() => { alive.current = true; return () => { alive.current = false; timers.current.forEach(clearTimeout); }; }, []);
  const later = (fn, ms) => { timers.current.push(setTimeout(() => alive.current && fn(), ms)); };
  const patch = (fn) => setRun((r) => (r ? fn(r) : r));

  function attempt(n) {
    patch((r) => ({ ...r, state: "sending", rows: [...r.rows, { n, status: undefined }] }));
    later(() => {
      const status = RECEIVER_MODES.find((m) => m.id === modeRef.current).status;
      const settle = (state, result) => patch((r) => ({ ...r, state, rows: r.rows.map((x) => (x.n === n && x.status === undefined ? { ...x, status, result } : x)) }));
      if (status !== null && status >= 200 && status < 300) settle("delivered", "delivered");
      else if (!isRetryableStatus(status)) settle("failed", "not retryable: a 4xx will never succeed, so PortalOps stops");
      else if (n >= MAX_ATTEMPTS) settle("failed", "gave up after " + MAX_ATTEMPTS + " attempts");
      else {
        const delay = nextDelayMs(n);
        settle("retrying", "retry in " + (delay / 1000).toFixed(1) + "s");
        later(() => attempt(n + 1), delay / SPEED);
      }
    }, 450);
  }

  async function fire() {
    timers.current.forEach(clearTimeout); timers.current = [];
    const e = ARENA_EVENTS[evIdx];
    const id = "evt_" + Math.random().toString(16).slice(2, 10);
    setRun({ id, name: e.name, header: "…", rows: [], state: "sending" });
    const header = await sampleSignature("whsec_simulated", id + e.name);
    if (!alive.current) return;
    setRun((r) => (r ? { ...r, header } : r));
    attempt(1);
  }
  function replay() {
    timers.current.forEach(clearTimeout); timers.current = [];
    setRun((r) => ({ ...r, state: "sending", rows: [...r.rows, { divider: true }] }));
    attempt(1);
  }

  const busy = run && (run.state === "sending" || run.state === "retrying");
  return (
    <div className="al-sim">
      <div className="al-sim-controls">
        <div>
          <div className="al-label">Event</div>
          <div className="al-seg">
            {ARENA_EVENTS.map((e, i) => <button key={e.name} type="button" className={i === evIdx ? "on" : ""} onClick={() => setEvIdx(i)}>{e.name}</button>)}
          </div>
        </div>
        <div>
          <div className="al-label">Your game server is</div>
          <div className="al-seg">
            {RECEIVER_MODES.map((m) => <button key={m.id} type="button" className={(m.id === mode ? "on " : "") + m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
          </div>
        </div>
        <div className="al-sim-go">
          <button type="button" className="al-primary" disabled={busy} onClick={fire}>Send event</button>
          {run && run.state === "failed" ? <button type="button" className="al-ghost" onClick={replay}>Replay event</button> : null}
        </div>
      </div>
      <code className="al-sample">{ARENA_EVENTS[evIdx].sample}</code>

      {run ? (
        <div className="al-timeline" aria-live="polite">
          <div className="al-tl-head"><b>{run.name}</b><code>{run.id}</code></div>
          <div className="al-sig">PortalOps-Signature: {run.header}</div>
          {run.rows.map((r, i) => r.divider ? (
            <div key={i} className="al-divider">Replayed: same event id, a fresh set of attempts</div>
          ) : (
            <div key={i} className={"al-attempt " + (r.status === undefined ? "wait" : r.result === "delivered" ? "ok" : "bad")}>
              <span className="n">#{r.n}</span>
              <span className="st">{r.status === undefined ? "sending…" : r.status === null ? "no answer" : r.status}</span>
              <span className="res">{r.result ?? ""}</span>
            </div>
          ))}
          {run.state === "delivered" ? <div className="al-verdict ok">Delivered. A replay-safe handler sees event id {run.id} once.</div> : null}
          {run.state === "failed" ? <div className="al-verdict bad">Failed, but nothing is lost: the event is stored. Fix the server, then replay it.</div> : null}
        </div>
      ) : <p className="al-empty">Pick an event, break the server, and press <b>Send event</b>. Flip the server back to Healthy while it is retrying to see it recover.</p>}
    </div>
  );
}

// ---- the page ---------------------------------------------------------------------------------------------------------------------
export default function Arena() {
  const [store, setStore] = useState(load);
  const [active, setActive] = useState(() => { const s = load(); return MISSIONS.find((m) => !s.solved?.[m.id])?.id ?? MISSIONS[0].id; });
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [leftTab, setLeftTab] = useState("description");
  const [consoleTab, setConsoleTab] = useState("results");
  const gutter = useRef(null);
  const hl = useRef(null);
  const ta = useRef(null);
  const wsRef = useRef(null);
  const rightRef = useRef(null);
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [lastRun, setLastRun] = useState(null); // { ms, passed, total }
  const mission = MISSIONS.find((m) => m.id === active);
  const code = store.code?.[active] ?? mission.starter;
  const solved = store.solved ?? {};
  const solvedCount = MISSIONS.filter((m) => solved[m.id]).length;
  const tries = store.tries?.[active] ?? 0;
  const solutionOpen = tries >= 2 || solved[active];
  const arena = useApi(() => api.example("arena"), [], { enabled: consoleTab === "real" });

  const update = (patch) => setStore((s) => { const n = { ...s, ...patch }; save(n); return n; });
  const setCode = (v) => update({ code: { ...store.code, [active]: v } });
  const pick = (id) => { setActive(id); setResults(null); setLeftTab("description"); setConsoleTab("results"); };

  async function run() {
    setRunning(true); setResults(null); setConsoleTab("results");
    const t0 = performance.now();
    const r = await runInWorker(active, code);
    setResults(r);
    setRunning(false);
    setLastRun({ ms: Math.round(performance.now() - t0), passed: r.filter((x) => x.pass).length, total: r.length });
    const pass = r.length > 0 && r.every((x) => x.pass);
    update({ tries: { ...store.tries, [active]: tries + 1 }, solved: pass ? { ...solved, [active]: true } : solved });
  }
  const reset = () => { update({ code: { ...store.code, [active]: undefined } }); setResults(null); };
  const syncCursor = (t) => setPos(cursorPosition(t.value, t.selectionStart));
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!running) run(); return; }
    const t = e.target;
    const r = applyKey({ value: t.value, start: t.selectionStart, end: t.selectionEnd }, e.key, { shift: e.shiftKey, mod: e.ctrlKey || e.metaKey });
    if (!r) return;
    e.preventDefault();
    setCode(r.value);
    requestAnimationFrame(() => { t.selectionStart = r.start; t.selectionEnd = r.end; syncCursor(t); });
  };
  const onEditorScroll = (e) => {
    const t = e.target;
    if (gutter.current) gutter.current.scrollTop = t.scrollTop;
    if (hl.current) { hl.current.scrollTop = t.scrollTop; hl.current.scrollLeft = t.scrollLeft; }
  };

  // resizable panels: fractions of the workspace width (problem | right) and of the right column height (editor | console), kept per browser
  const sizes = { lw: store.sizes?.lw ?? 0.42, eh: store.sizes?.eh ?? 0.56 };
  const setSize = (patch) => update({ sizes: { ...store.sizes, ...patch } });
  const drag = (axis) => (down) => {
    down.preventDefault();
    const box = (axis === "x" ? wsRef : rightRef).current.getBoundingClientRect();
    const move = (e) => {
      const f = axis === "x" ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height;
      setStore((s) => ({ ...s, sizes: { ...s.sizes, [axis === "x" ? "lw" : "eh"]: Math.min(axis === "x" ? 0.7 : 0.8, Math.max(axis === "x" ? 0.22 : 0.2, f)) } }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.userSelect = ""; setStore((s) => { save(s); return s; }); };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const nudge = (axis) => (e) => {
    const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -0.02 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 0.02 : 0;
    if (!d) return;
    e.preventDefault();
    const key = axis === "x" ? "lw" : "eh";
    setSize({ [key]: Math.min(axis === "x" ? 0.7 : 0.8, Math.max(axis === "x" ? 0.22 : 0.2, sizes[key] + d)) });
  };
  const resetSizes = () => update({ sizes: undefined });

  const lines = code.split("\n").length;
  const passed = results ? results.filter((r) => r.pass).length : 0;
  const allPass = results && results.length > 0 && passed === results.length;
  const cleared = solvedCount === MISSIONS.length;
  const idx = MISSIONS.findIndex((m) => m.id === active);

  return (
    <div className="al">
      <header className="al-top">
        <div className="al-top-l">
          <Link href="/" className="al-brand"><span className="mk"><i /></span><b>PortalOps</b></Link>
          <span className="al-crumb">Arena Lab</span>
        </div>
        <nav className="al-steps" aria-label="Challenges">
          <button type="button" className="al-arrow" disabled={idx === 0} onClick={() => pick(MISSIONS[idx - 1].id)} aria-label="Previous challenge">‹</button>
          {MISSIONS.map((m) => (
            <button key={m.id} type="button" className={"al-step" + (m.id === active ? " on" : "") + (solved[m.id] ? " done" : "")} onClick={() => pick(m.id)} title={m.title}>
              {solved[m.id] ? "✓" : m.n}
            </button>
          ))}
          <button type="button" className="al-arrow" disabled={idx === MISSIONS.length - 1} onClick={() => pick(MISSIONS[idx + 1].id)} aria-label="Next challenge">›</button>
        </nav>
        <div className="al-top-r">
          <span className="al-solved">{solvedCount}/{MISSIONS.length} solved</span>
          <Link href="/playground" className="al-link">Playground</Link>
          <Link href="/docs/guides/game-development" className="al-link">Docs</Link>
          <Link href="/auth#signup" className="al-primary sm">Start building</Link>
        </div>
      </header>

      {cleared ? (
        <div className="al-banner">
          <b>Arena cleared.</b> All five challenges solved. Run the real thing from the "Run it for real" tab, or
          <CopyBtn text={"I cleared the PortalOps Arena Lab: 5/5 challenges (leaderboard, replay safety, finality, HMAC verification, retries). https://portalops.onrender.com/arena"} label="copy your result" />
        </div>
      ) : null}

      <main className="al-ws" ref={wsRef} style={{ "--lw": sizes.lw + "fr", "--rw": 1 - sizes.lw + "fr" }}>
        {/* problem */}
        <section className="al-panel al-problem">
          <div className="al-tabs">
            {[["description", "Description"], ["rules", "Rules"], ["hint", "Hint"], ["solution", "Solution"]].map(([id, label]) => (
              <button key={id} type="button" className={leftTab === id ? "on" : ""} onClick={() => setLeftTab(id)}>{label}{id === "solution" && !solutionOpen ? " 🔒" : ""}</button>
            ))}
          </div>
          <div className="al-scroll">
            <div className="al-title">
              <h1>{mission.n}. {mission.title}</h1>
              <span className={"al-level " + mission.level.toLowerCase()}>{mission.level}</span>
              {solved[active] ? <span className="al-solved-pill">Solved</span> : null}
            </div>

            {leftTab === "description" ? (
              <>
                {mission.brief.map((p) => <p key={p} className="al-p">{p}</p>)}
                {mission.n <= 3 ? (<><div className="al-h">Event shape</div><pre className="al-code">{EVENT_SHAPE}</pre></>) : null}
                <div className="al-h">How this maps to PortalOps</div>
                <p className="al-p">The rules in this challenge are the ones PortalOps itself follows: signed webhooks, the same event id on every retry and replay, and a finality status on every event. Use the <b>Simulator</b> and <b>Run it for real</b> tabs below to see them live.</p>
              </>
            ) : null}
            {leftTab === "rules" ? <ul className="al-list">{mission.rules.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            {leftTab === "hint" ? <div className="al-callout">{mission.hint}</div> : null}
            {leftTab === "solution" ? (
              solutionOpen ? <pre className="al-code ok">{mission.solution}</pre>
                : <div className="al-callout">The reference solution unlocks after two attempts. Run your code to try it.</div>
            ) : null}
          </div>
        </section>

        <div className="al-split x" role="separator" aria-orientation="vertical" aria-label="Resize the problem panel" tabIndex={0}
          onPointerDown={drag("x")} onKeyDown={nudge("x")} onDoubleClick={resetSizes} title="Drag to resize, double-click to reset"><i /></div>

        {/* editor + console */}
        <div className="al-right" ref={rightRef} style={{ "--eh": sizes.eh + "fr", "--ch": 1 - sizes.eh + "fr" }}>
          <section className="al-panel al-editor-panel">
            <div className="al-bar">
              <span className="al-file">JavaScript <i>·</i> solution.js</span>
              <div className="al-bar-r">
                <span className="al-kbd">Ctrl + Enter</span>
                <button type="button" className="al-ghost" onClick={reset}>Reset</button>
                <button type="button" className="al-primary" disabled={running} onClick={run}>{running ? "Running…" : "Run tests"}</button>
              </div>
            </div>
            <div className="al-editor-wrap">
              <pre className="al-gutter" ref={gutter} aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre>
              <div className="al-code-area">
                <pre className="al-hl" ref={hl} aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlight(code) }} />
                <textarea className="al-editor" ref={ta} value={code} onChange={(e) => { setCode(e.target.value); syncCursor(e.target); }} onKeyDown={onKey}
                  onKeyUp={(e) => syncCursor(e.target)} onClick={(e) => syncCursor(e.target)} onScroll={onEditorScroll}
                  spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Your code" />
              </div>
            </div>
            <div className="al-status">
              <span>Ln {pos.line}, Col {pos.col}</span><span>Spaces: 2</span><span>JavaScript</span>
              <span className="grow" />
              {lastRun ? <span className={lastRun.passed === lastRun.total ? "ok" : "bad"}>{lastRun.passed}/{lastRun.total} passed · {lastRun.ms} ms</span> : <span>Not run yet</span>}
              <span>Saved in this browser</span>
            </div>
          </section>

          <div className="al-split y" role="separator" aria-orientation="horizontal" aria-label="Resize the editor" tabIndex={0}
            onPointerDown={drag("y")} onKeyDown={nudge("y")} onDoubleClick={resetSizes} title="Drag to resize, double-click to reset"><i /></div>

          <section className="al-panel al-console">
            <div className="al-tabs">
              {[["results", "Test results"], ["sim", "Simulator"], ["real", "Run it for real"]].map(([id, label]) => (
                <button key={id} type="button" className={consoleTab === id ? "on" : ""} onClick={() => setConsoleTab(id)}>{label}</button>
              ))}
              <span className="al-note">Runs in your browser only</span>
            </div>
            <div className="al-scroll">
              {consoleTab === "results" ? (
                results ? (
                  <div className="al-results" aria-live="polite">
                    <div className={"al-score " + (allPass ? "ok" : "bad")}>
                      <b>{allPass ? "Accepted" : "Wrong answer"}</b>
                      <span>{passed} / {results.length} tests passed</span>
                      {allPass && mission.n < MISSIONS.length ? <button type="button" className="al-primary sm" onClick={() => pick(MISSIONS[mission.n].id)}>Next challenge</button> : null}
                    </div>
                    {results.map((r) => (
                      <div key={r.name} className={"al-test " + (r.pass ? "ok" : "bad")}>
                        <span className="mark">{r.pass ? "✓" : "✕"}</span>
                        <div><div className="nm">{r.name}</div>{r.detail ? <pre className="dt">{r.detail}</pre> : null}</div>
                      </div>
                    ))}
                  </div>
                ) : <p className="al-empty">{running ? "Running your tests…" : <>Write your solution, then press <b>Run tests</b>. Every case shows what was expected and what your code returned.</>}</p>
              ) : null}

              {consoleTab === "sim" ? <Simulator /> : null}

              {consoleTab === "real" ? (
                <div className="al-real">
                  <p className="al-p">The tests and the simulator use PortalOps' real rules. This is how to make the same thing happen on the Portaldot testnet with the Arena contract.</p>
                  <ol>
                    <li><b>Deploy the contract</b> (needs a funded testnet account):
                      <div className="al-cmd"><code>npm run contract:deploy -- --example arena --send</code><CopyBtn text="npm run contract:deploy -- --example arena --send" /></div></li>
                    <li><b>Watch it.</b> Open the <Link href="/playground">playground</Link>, paste the address, choose <i>Arena game</i> in the decoding menu and press Watch.</li>
                    <li><b>Play.</b> From two wallets call <code>join("Ada")</code>, <code>join("Bo")</code> and <code>fight(opponent)</code>. Each move arrives as a decoded event.</li>
                    <li><b>Break it.</b> Point a webhook at a server that returns 500, fight again, then fix it and replay. That is the simulator, on chain.</li>
                  </ol>
                  <div className="al-real-links">
                    <Link href="/docs/tutorials/game-feed">Build a game feed</Link>
                    <Link href="/docs/guides/game-development">Game development guide</Link>
                  </div>
                  <div className="al-h">The Arena contract</div>
                  {arena.data ? (
                    <>
                      <div className="al-row"><CopyBtn text={arena.data.source} label="Copy Solidity" /><CopyBtn text={JSON.stringify(arena.data.abi, null, 2)} label="Copy ABI" /></div>
                      <pre className="al-code">{arena.data.source}</pre>
                    </>
                  ) : <p className="al-empty">{arena.error ? "Could not load the contract right now." : "Loading…"}</p>}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
