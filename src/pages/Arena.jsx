import { useEffect, useRef, useState } from "react";
import { Link } from "../router.jsx";
import { api } from "../api.js";
import { useApi } from "../state.jsx";
import Orb from "../orb.jsx";
import { EVENT_SHAPE, MAX_ATTEMPTS, MISSIONS, RECEIVER_MODES, isRetryableStatus, nextDelayMs, runInWorker } from "./arenaLab.js";
import "./pages.css";
import "./landing.css";
import "./arena.css";

const STORE = "portalops.arena.v1";
const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode: progress simply is not kept */ } };

const copy = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
function CopyBtn({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="al-copy" onClick={async () => { if (await copy(text)) { setDone(true); setTimeout(() => setDone(false), 1400); } }}>{done ? "Copied ✓" : label}</button>;
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
  const [run, setRun] = useState(null); // { id, header, rows: [], state: "sending" | "retrying" | "delivered" | "failed" }
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
      if (status !== null && status >= 200 && status < 300) {
        patch((r) => ({ ...r, state: "delivered", rows: r.rows.map((x) => (x.n === n && x.status === undefined && !x.replayMark ? { ...x, status, result: "delivered" } : x)) }));
      } else if (!isRetryableStatus(status)) {
        patch((r) => ({ ...r, state: "failed", rows: r.rows.map((x) => (x.n === n && x.status === undefined ? { ...x, status, result: "not retryable: a 4xx will never succeed, so PortalOps stops" } : x)) }));
      } else if (n >= MAX_ATTEMPTS) {
        patch((r) => ({ ...r, state: "failed", rows: r.rows.map((x) => (x.n === n && x.status === undefined ? { ...x, status, result: "gave up after " + MAX_ATTEMPTS + " attempts" } : x)) }));
      } else {
        const delay = nextDelayMs(n);
        patch((r) => ({ ...r, state: "retrying", rows: r.rows.map((x) => (x.n === n && x.status === undefined ? { ...x, status, result: "retry in " + (delay / 1000).toFixed(1) + "s" } : x)) }));
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
    <div className="al-card al-sim">
      <div className="al-card-h"><b>Delivery simulator</b><span className="al-tag">simulated · real retry rules</span></div>
      <p className="al-muted">Fire an Arena event at a game server, then break the server and watch what PortalOps does. Flip the switch while it is retrying.</p>

      <div className="al-label">1. Pick an event</div>
      <div className="al-chips">
        {ARENA_EVENTS.map((e, i) => <button key={e.name} type="button" className={"al-chip" + (i === evIdx ? " on" : "")} onClick={() => setEvIdx(i)}>{e.name}</button>)}
      </div>
      <code className="al-sample">{ARENA_EVENTS[evIdx].sample}</code>

      <div className="al-label">2. Your game server is</div>
      <div className="al-chips">
        {RECEIVER_MODES.map((m) => <button key={m.id} type="button" className={"al-chip " + m.id + (m.id === mode ? " on" : "")} onClick={() => setMode(m.id)}>{m.label}</button>)}
      </div>

      <div className="al-actions">
        <button type="button" className="al-run" disabled={busy} onClick={fire}>Send event</button>
        {run && run.state === "failed" ? <button type="button" className="al-run alt" onClick={replay}>↻ Replay the event</button> : null}
      </div>

      {run ? (
        <div className="al-timeline" aria-live="polite">
          <div className="al-tl-head"><span>{run.name}</span><code>{run.id}</code></div>
          <div className="al-sig">PortalOps-Signature: {run.header}</div>
          {run.rows.map((r, i) => r.divider ? (
            <div key={i} className="al-divider">↻ replayed: same event id, a fresh set of attempts</div>
          ) : (
            <div key={i} className={"al-attempt " + (r.status === undefined ? "wait" : r.result === "delivered" ? "ok" : "bad")}>
              <span className="n">#{r.n}</span>
              <span className="st">{r.status === undefined ? "sending…" : r.status === null ? "no answer" : r.status}</span>
              <span className="res">{r.result ?? ""}</span>
            </div>
          ))}
          {run.state === "delivered" ? <div className="al-verdict ok">Delivered. Your server saw event id {run.id} and, being replay-safe, handled it once.</div> : null}
          {run.state === "failed" ? <div className="al-verdict bad">Failed, but nothing is lost: the event is stored. Fix the server, then replay it.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- the page ---------------------------------------------------------------------------------------------------------------------
export default function Arena() {
  const [store, setStore] = useState(load);
  const [active, setActive] = useState(() => { const s = load(); return MISSIONS.find((m) => !s.solved?.[m.id])?.id ?? MISSIONS[0].id; });
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [showSol, setShowSol] = useState(false);
  const [showContract, setShowContract] = useState(false);
  const mission = MISSIONS.find((m) => m.id === active);
  const code = store.code?.[active] ?? mission.starter;
  const solved = store.solved ?? {};
  const solvedCount = MISSIONS.filter((m) => solved[m.id]).length;
  const tries = store.tries?.[active] ?? 0;
  const arena = useApi(() => api.example("arena"), [], { enabled: showContract });

  const update = (patch) => setStore((s) => { const n = { ...s, ...patch }; save(n); return n; });
  const setCode = (v) => update({ code: { ...store.code, [active]: v } });
  const pick = (id) => { setActive(id); setResults(null); setShowHint(false); setShowSol(false); };

  async function run() {
    setRunning(true); setResults(null);
    const r = await runInWorker(active, code);
    setResults(r);
    setRunning(false);
    const pass = r.length > 0 && r.every((x) => x.pass);
    update({ tries: { ...store.tries, [active]: tries + 1 }, solved: pass ? { ...solved, [active]: true } : solved });
  }
  const reset = () => { update({ code: { ...store.code, [active]: undefined } }); setResults(null); };
  const onKey = (e) => {
    if (e.key === "Tab") { e.preventDefault(); const t = e.target, s = t.selectionStart; setCode(code.slice(0, s) + "  " + code.slice(t.selectionEnd)); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; }); }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!running) run(); }
  };

  const passed = results ? results.filter((r) => r.pass).length : 0;
  const allPass = results && results.length > 0 && passed === results.length;
  const cleared = solvedCount === MISSIONS.length;

  return (
    <div className="lp al">
      <nav className="lp-nav">
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg)" }}>
          <span className="brand-mark" style={{ width: 22, height: 22, borderRadius: 6 }}><i style={{ width: 8, height: 8 }} /></span>
          <span style={{ fontWeight: 600, fontSize: 16 }}>PortalOps</span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Link className="top-link" href="/playground" style={{ fontSize: 14 }}>Playground</Link>
          <Link className="top-link" href="/docs/guides/game-development" style={{ fontSize: 14 }}>Docs</Link>
          <Link className="pbtn" href="/auth#signup" style={{ fontSize: 14, padding: "9px 16px", borderRadius: 8 }}>Start Building</Link>
        </div>
      </nav>

      <header className="al-head">
        <span className="al-badge"><Orb size={20} state="breathing" label="" /> Arena Lab · no signup</span>
        <h1>Beat the Arena.</h1>
        <p>A game contract emits events. Your backend has to get them right when they repeat, reorganise and fail. Five challenges, real PortalOps rules, tests that tell you exactly what broke.</p>
        <div className="al-progress" aria-label={solvedCount + " of " + MISSIONS.length + " solved"}>
          {MISSIONS.map((m) => <i key={m.id} className={solved[m.id] ? "on" : ""} />)}
          <span>{solvedCount} / {MISSIONS.length} solved</span>
        </div>
      </header>

      {cleared ? (
        <div className="al-cleared">
          <b>Arena cleared.</b> You can make a game backend replay-safe, finality-aware, signature-checked and retry-literate. Now run the real thing below, or copy your result.
          <CopyBtn text={"I cleared the PortalOps Arena Lab: 5/5 challenges (leaderboard, replay safety, finality, HMAC verification, retries). https://portalops.onrender.com/arena"} label="Copy my result" />
        </div>
      ) : null}

      <div className="al-layout">
        <aside className="al-list" aria-label="Challenges">
          {MISSIONS.map((m) => (
            <button key={m.id} type="button" className={"al-mission" + (m.id === active ? " on" : "") + (solved[m.id] ? " done" : "")} onClick={() => pick(m.id)}>
              <span className="n">{solved[m.id] ? "✓" : m.n}</span>
              <span className="t"><b>{m.title}</b><small>{m.summary}</small></span>
              <span className={"lv " + m.level.toLowerCase()}>{m.level}</span>
            </button>
          ))}
        </aside>

        <section className="al-main">
          <div className="al-card">
            <div className="al-card-h"><b>{mission.n}. {mission.title}</b><span className={"lv " + mission.level.toLowerCase()}>{mission.level}</span></div>
            {mission.brief.map((p) => <p key={p} className="al-brief">{p}</p>)}
            <details className="al-details" open={mission.n <= 3}>
              <summary>Rules{mission.n <= 3 ? " and event shape" : ""}</summary>
              <ul>{mission.rules.map((r) => <li key={r}>{r}</li>)}</ul>
              {mission.n <= 3 ? <pre className="al-shape">{EVENT_SHAPE}</pre> : null}
            </details>

            <div className="al-editor-bar"><span>solution.js</span><span className="al-kbd">Ctrl + Enter to run</span></div>
            <textarea className="al-editor" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={onKey} spellCheck={false} aria-label="Your code" />
            <div className="al-actions">
              <button type="button" className="al-run" disabled={running} onClick={run}>{running ? "Running…" : "Run tests"}</button>
              <button type="button" className="al-run alt" onClick={reset}>Reset</button>
              <button type="button" className="al-run alt" onClick={() => setShowHint((v) => !v)}>{showHint ? "Hide hint" : "Hint"}</button>
              {tries >= 2 || solved[active] ? <button type="button" className="al-run alt" onClick={() => setShowSol((v) => !v)}>{showSol ? "Hide solution" : "Show solution"}</button> : null}
              <span className="al-note">Runs in your browser only. Nothing is sent anywhere.</span>
            </div>
            {showHint ? <div className="al-hint">{mission.hint}</div> : null}
            {showSol ? <pre className="al-solution">{mission.solution}</pre> : null}

            {results ? (
              <div className="al-results" aria-live="polite">
                <div className={"al-score " + (allPass ? "ok" : "bad")}>{allPass ? "All tests passed" : passed + " of " + results.length + " tests passed"}</div>
                {results.map((r) => (
                  <div key={r.name} className={"al-test " + (r.pass ? "ok" : "bad")}>
                    <span className="mark">{r.pass ? "✓" : "✕"}</span>
                    <div><div className="nm">{r.name}</div>{r.detail ? <pre className="dt">{r.detail}</pre> : null}</div>
                  </div>
                ))}
                {allPass && mission.n < MISSIONS.length ? <button type="button" className="al-run" onClick={() => pick(MISSIONS[mission.n].id)}>Next challenge →</button> : null}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="al-grid2">
        <Simulator />
        <div className="al-card">
          <div className="al-card-h"><b>Now run it for real</b><span className="al-tag live">real network</span></div>
          <p className="al-muted">The simulator and the tests use PortalOps' real rules. Here is how to make the same thing happen on the Portaldot testnet with the Arena contract.</p>
          <ol className="al-steps">
            <li><b>Get the contract.</b> Deploy it from the repo (needs a funded testnet account):<div className="al-cmd"><code>npm run contract:deploy -- --example arena --send</code><CopyBtn text="npm run contract:deploy -- --example arena --send" /></div></li>
            <li><b>Watch it.</b> Open the <Link href="/playground">playground</Link>, paste the address and choose <i>Arena game</i> in the decoding menu, then press Watch.</li>
            <li><b>Play.</b> From two wallets call <code>join("Ada")</code>, <code>join("Bo")</code> and <code>fight(opponent)</code>. Each move appears as a decoded event.</li>
            <li><b>Break it.</b> Point a webhook at a server that returns 500, fight again, then fix it and replay. That is exactly the simulator, on chain.</li>
          </ol>
          <button type="button" className="al-run alt" onClick={() => setShowContract((v) => !v)}>{showContract ? "Hide the contract" : "Read the Arena contract"}</button>
          {showContract ? (
            <div className="al-contract">
              {arena.data ? (
                <>
                  <div className="al-actions"><CopyBtn text={arena.data.source} label="Copy Solidity" /><CopyBtn text={JSON.stringify(arena.data.abi, null, 2)} label="Copy ABI" /></div>
                  <pre>{arena.data.source}</pre>
                </>
              ) : <div className="al-muted">{arena.error ? "Could not load the contract right now." : "Loading…"}</div>}
            </div>
          ) : null}
          <div className="al-links"><Link href="/docs/tutorials/game-feed">Build a game feed →</Link><Link href="/docs/guides/game-development">Game development guide →</Link></div>
        </div>
      </div>
    </div>
  );
}
