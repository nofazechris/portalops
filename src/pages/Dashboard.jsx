import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { navGroups, validScreens, tourSteps, LANDING_URL } from "../data.js";
import { Link, navigate } from "../router.jsx";
import { useApi, useSession } from "../state.jsx";
import { ErrorBoundary, ErrorBox, Field, Loading, Modal } from "../ui.jsx";
import Tour from "../Tour.jsx";
import Overview from "../screens/Overview.jsx";
import Setup from "../screens/Setup.jsx";
import { Events, EventDetail } from "../screens/Events.jsx";
import { Webhooks, WebhookDetail } from "../screens/Webhooks.jsx";
import Replay from "../screens/Replay.jsx";
import AiSetup from "../screens/AiSetup.jsx";
import { Logs, Contracts, Automations, Diagnostics, ApiSdk, Settings } from "../screens/Misc.jsx";

const TOUR_KEY = "pops_tour_done";
const readHash = () => (location.hash || "").replace("#", "");

function initialState() {
  const h = readHash();
  // The tour spotlights sidebar items, which are off-canvas on narrow screens: skip it there.
  const wide = window.innerWidth >= 900;
  if (h === "tour") return { screen: "overview", tour: wide };
  if (validScreens.includes(h)) return { screen: h, tour: false };
  let done = false;
  try { done = !!localStorage.getItem(TOUR_KEY); } catch { /* storage unavailable */ }
  return { screen: "overview", tour: !done && wide };
}

const CONN = { connected: ["green", "Connected"], disconnected: ["red", "Disconnected"], wrong_chain: ["amber", "Wrong chain"] };

function useOutsideClose(open, close) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);
  return ref;
}

function NewProjectModal({ onClose, onCreated }) {
  const { createProject } = useSession();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await createProject(name.trim(), desc.trim()); onClose(); onCreated?.(); } catch (x) { setErr(x); setBusy(false); }
  }
  return (
    <Modal title="Create project" onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <Field label="Project name" error={err?.details?.find((d) => d.path === "name")?.message}><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
        <Field label="Description (optional)"><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} /></Field>
        <Field label="Network"><input className="input" value="Portaldot V3.0 Testnet" disabled /></Field>
        {err && !err.details && <div className="field-error" style={{ marginBottom: 10 }}>{err.message}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Dashboard() {
  const [init] = useState(initialState);
  const session = useSession();
  const { user, loading, project, projects, projectId, setProjectId, logout } = session;
  const [view, setView] = useState({ screen: init.screen, params: {} });
  const [tour, setTour] = useState(init.tour);
  const [tourStep, setTourStep] = useState(0);
  const [menu, setMenu] = useState(null); // "project" | "user" | null
  const [navOpen, setNavOpen] = useState(false); // off-canvas sidebar on narrow screens
  const [creating, setCreating] = useState(false);
  const menuRef = useOutsideClose(!!menu, () => setMenu(null));

  const net = useApi(() => api.networkStatus(projectId), [projectId], { refreshMs: 8000, enabled: !!projectId });

  const go = (screen, params = {}) => {
    setView({ screen, params });
    setMenu(null);
    setNavOpen(false);
    if (validScreens.includes(screen)) history.replaceState(null, "", "#" + screen);
  };
  const openEvent = (id) => go("eventDetail", { id });

  useEffect(() => {
    const onHash = () => { const h = readHash(); if (validScreens.includes(h)) setView({ screen: h, params: {} }); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const endTour = () => {
    try { localStorage.setItem(TOUR_KEY, "1"); } catch { /* storage unavailable */ }
    setTour(false);
  };
  const nextTour = () => (tourStep + 1 >= tourSteps.length ? endTour() : setTourStep(tourStep + 1));
  useEffect(() => { if (tour) setView({ screen: "overview", params: {} }); }, [tour]);

  if (loading) return <div style={{ padding: 60 }}><Loading label="Loading workspace…" /></div>;

  const { screen, params } = view;
  const activeId = screen === "eventDetail" ? "events" : screen === "webhookDetail" ? "webhooks" : screen;
  const [dot, connLabel] = CONN[net.data?.connection] ?? ["grey", net.loading ? "Checking…" : "Unknown"];
  const initial = (user?.email ?? "?")[0].toUpperCase();

  return (
    <div className="shell">
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={"sidebar" + (navOpen ? " open" : "")}>
        <Link className="brand" href={LANDING_URL}>
          <span className="brand-mark"><i /></span>
          <span className="brand-name">PortalOps</span>
        </Link>
        <nav className="nav pops-scroll">
          {navGroups.map((g, gi) => (
            <div key={gi}>
              {g.label && <div className="nav-label">{g.label}</div>}
              {g.items.map((item) => {
                const inner = <><span className="bar" /><span className="glyph">{item.icon}</span><span className="label">{item.label}</span></>;
                return item.href
                  ? <Link key={item.id} className="nav-item" href={item.href}>{inner}</Link>
                  : <button key={item.id} className={"nav-item" + (item.id === activeId ? " active" : "")} data-tour={item.id} onClick={() => go(item.id)}>{inner}</button>;
              })}
            </div>
          ))}
        </nav>
        <div className="api-status" title={net.data?.rpcError ?? ""}>
          <span className={"dot " + dot} style={dot === "green" ? undefined : { boxShadow: "none", animation: "none" }} />
          <div>
            <div style={{ color: "var(--fg-2)" }}>RPC {connLabel.toLowerCase()}</div>
            <div style={{ color: "var(--dim)" }}>{net.data?.headBlock != null ? `head #${net.data.headBlock.toLocaleString()}` : "no head block"}</div>
          </div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button className="menu-btn" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>☰</button>
          <div style={{ position: "relative" }} ref={menu === "project" ? menuRef : null}>
            <button className="project-btn" onClick={() => setMenu(menu === "project" ? null : "project")} aria-haspopup="menu">
              <span className="swatch" />{project ? project.name : user ? "No project yet" : "Public testnet explorer"}<span className="caret">▾</span>
            </button>
            {menu === "project" && (
              <div className="dropdown" role="menu">
                {projects.map((p) => <button key={p.id} className={"item" + (project?.id === p.id ? " active" : "")} onClick={() => { setProjectId(p.id); go("overview"); }}>{p.name}</button>)}
                {projects.length > 0 && <div className="sep" />}
                {user ? <button className="item" onClick={() => { setMenu(null); setCreating(true); }}>+ New project</button>
                  : <Link className="item" href="/auth#signup" style={{ color: "var(--accent)" }}>Sign up to create a project</Link>}
              </div>
            )}
          </div>
          <div className="topbar-right">
            <span className="net-pill" title={net.data?.rpcError ?? ""}>
              <span className={"dot " + dot} style={dot === "green" ? undefined : { boxShadow: "none", animation: "none" }} />
              Portaldot V3.0 Testnet · {connLabel}
            </span>
            <span style={{ width: 1, height: 22, background: "#242424" }} />
            {user ? (
              <div style={{ position: "relative" }} ref={menu === "user" ? menuRef : null}>
                <button className="avatar" style={{ cursor: "pointer" }} onClick={() => setMenu(menu === "user" ? null : "user")} aria-label="Account menu">{initial}</button>
                {menu === "user" && (
                  <div className="dropdown" style={{ left: "auto", right: 0 }} role="menu">
                    <div style={{ padding: "8px 10px", fontSize: 12.5, color: "var(--muted)" }}>{user.email}</div>
                    <div className="sep" />
                    <button className="item" onClick={async () => { await logout(); navigate("/"); }}>Sign out</button>
                  </div>
                )}
              </div>
            ) : <Link className="pbtn" href="/auth#signin" style={{ fontSize: 13, padding: "8px 14px", borderRadius: 8 }}>Sign in</Link>}
          </div>
        </header>

        <main className="content pops-scroll">
          <div className="content-inner">
            {session.bootError && <ErrorBox error={session.bootError} />}
            <ErrorBoundary resetKey={screen + (params.id ?? "") + (projectId ?? "")}>
            {screen === "overview" && <Overview openEvent={openEvent} go={go} />}
            {screen === "setup" && <Setup go={go} />}
            {screen === "events" && <Events openEvent={openEvent} />}
            {screen === "eventDetail" && <EventDetail id={params.id} go={go} />}
            {screen === "webhooks" && <Webhooks openWebhook={(id) => go("webhookDetail", { id })} />}
            {screen === "webhookDetail" && <WebhookDetail id={params.id} go={go} />}
            {screen === "replay" && <Replay go={go} />}
            {screen === "logs" && <Logs />}
            {screen === "contracts" && <Contracts />}
            {screen === "automations" && <Automations />}
            {screen === "diagnostics" && <Diagnostics go={go} />}
            {screen === "apisdk" && <ApiSdk />}
            {screen === "aisetup" && <AiSetup />}
            {screen === "settings" && <Settings key={project?.id} />}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {tour && <Tour step={tourStep} onNext={nextTour} onSkip={endTour} />}
      {creating && <NewProjectModal onClose={() => setCreating(false)} onCreated={() => go("setup")} />}
    </div>
  );
}
