import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { navGroups, validScreens, tourSteps } from "../data.js";
import { Link, navigate } from "../router.jsx";
import { useApi, useSession } from "../state.jsx";
import { Alert, ErrorBoundary, ErrorBox, Field, Loading, Modal } from "../ui.jsx";
import Tour from "../Tour.jsx";
import Overview from "../screens/Overview.jsx";
import Setup from "../screens/Setup.jsx";
import { Events, EventDetail } from "../screens/Events.jsx";
import { Webhooks, WebhookDetail } from "../screens/Webhooks.jsx";
import Replay from "../screens/Replay.jsx";
import AiSetup from "../screens/AiSetup.jsx";
import { Logs, Contracts, Automations, Diagnostics, ApiSdk, Settings } from "../screens/Misc.jsx";

const TOUR_KEY = "pops_tour_done";
const SIDEBAR_KEY = "pops_sidebar_collapsed";
/** Form-like screens read better in a centered column than hugging the left edge. */
const NARROW = new Set(["setup", "settings", "apisdk", "aisetup", "diagnostics"]);
const readHash = () => (location.hash || "").replace("#", "");

function initialState() {
  const h = readHash();
  // The product tour only runs when asked for (#tour): onboarding is the one-time guided setup after the first project.
  // The tour spotlights sidebar items, which are off-canvas on narrow screens: skip it there.
  const wide = window.innerWidth >= 900;
  if (h === "tour") return { screen: "overview", tour: wide };
  if (validScreens.includes(h)) return { screen: h, tour: false };
  return { screen: "overview", tour: false };
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

function NewProjectModal({ onClose, onCreated, isFirst }) {
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
    <Modal title={isFirst ? "Create your first project" : "Create project"} onClose={onClose}>
      {isFirst && <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.55, margin: "0 0 16px" }}>A project holds your contracts, events and webhooks. Right after you create it, a short guided setup takes you to your first delivered event.</p>}
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

/** Asks people who signed up with a password to confirm their address. Hidden once verified; dismissible for the session. */
function VerifyBanner({ user, refreshUser }) {
  const [hidden, setHidden] = useState(false);
  const [state, setState] = useState({ busy: false, msg: null });
  if (!user || user.emailVerified !== false || hidden) return null;
  async function resend() {
    setState({ busy: true, msg: null });
    try { const r = await api.resendVerification(); setState({ busy: false, msg: r.alreadyVerified ? { tone: "ok", text: "Already confirmed." } : { tone: "ok", text: `Sent. Check ${user.email} (and spam).` } }); if (r.alreadyVerified) refreshUser(); }
    catch (e) { setState({ busy: false, msg: { tone: "warn", text: e.code === "rate_limited" ? e.message : e.code === "email_unavailable" ? "We couldn't send it right now. Try again in a few minutes." : e.message } }); }
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <Alert tone="info" title="Confirm your email address" onClose={() => setHidden(true)}
        action={(
          <span style={{ display: "inline-flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="link-btn" disabled={state.busy} onClick={resend}>{state.busy ? "Sending…" : "Resend email"}</button>
            <button type="button" className="link-btn" onClick={refreshUser}>I've confirmed it</button>
            {state.msg && <span style={{ fontSize: 12.5, color: state.msg.tone === "ok" ? "var(--green)" : "var(--amber)" }}>{state.msg.text}</span>}
          </span>
        )}
      >We sent a link to <strong style={{ color: "var(--fg-2)" }}>{user.email}</strong>. It proves the address is yours, which is how password reset reaches you.</Alert>
    </div>
  );
}

/** Shown on every project screen until the signed-in user has created a project. */
function FirstProject({ onCreate }) {
  return (
    <div className="first-project">
      <div className="first-project-mark" aria-hidden="true"><span /></div>
      <h1 className="h1" style={{ textAlign: "center" }}>Create your first project</h1>
      <p className="sub" style={{ textAlign: "center", maxWidth: 460, margin: "10px auto 0", lineHeight: 1.6 }}>
        A project is your workspace on the Portaldot testnet: its contracts, captured events, webhooks and API keys live in it.
        You can create as many as you like and switch between them from the menu at the top.
      </p>
      <button className="btn primary" style={{ marginTop: 26, padding: "12px 26px", fontSize: 14.5 }} onClick={onCreate}>Create project</button>
      <div className="first-project-steps">
        {["Create the project", "Guided setup", "Watch real events arrive"].map((t, i) => (
          <div key={t}><span className="mono">{i + 1}</span>{t}</div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [init] = useState(initialState);
  const session = useSession();
  const { user, loading, project, projects, projectId, setProjectId, logout, refreshUser } = session;
  const [view, setView] = useState({ screen: init.screen, params: {} });
  const [tour, setTour] = useState(init.tour);
  const [tourStep, setTourStep] = useState(0);
  const [menu, setMenu] = useState(null); // "project" | "user" | null
  const [navOpen, setNavOpen] = useState(false); // off-canvas sidebar on narrow screens
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; } });
  const toggleSidebar = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(SIDEBAR_KEY, n ? "1" : "0"); } catch { /* storage unavailable */ } return n; });
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

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const endTour = () => {
    try { localStorage.setItem(TOUR_KEY, "1"); } catch { /* storage unavailable */ }
    setTour(false);
  };
  const nextTour = () => (tourStep + 1 >= tourSteps.length ? endTour() : setTourStep(tourStep + 1));
  useEffect(() => { if (tour) setView({ screen: "overview", params: {} }); }, [tour]);

  if (loading) return <div style={{ padding: 60 }}><Loading label="Loading your workspace…" state="working" /></div>;

  const { screen, params } = view;
  const activeId = screen === "eventDetail" ? "events" : screen === "webhookDetail" ? "webhooks" : screen;
  const [dot, connLabel] = CONN[net.data?.connection] ?? ["grey", net.loading ? "Checking…" : "Unknown"];
  const initial = (user?.email ?? "?")[0].toUpperCase();

  return (
    <div className={"shell" + (collapsed ? " collapsed" : "")}>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={"sidebar" + (navOpen ? " open" : "")}>
        <button type="button" className="brand brand-btn" title="Overview" aria-label="PortalOps: go to the Overview" onClick={() => go("overview")}>
          <span className="brand-mark"><i /></span>
          <span className="brand-name">PortalOps</span>
        </button>
        <nav className="nav pops-scroll">
          {navGroups.map((g, gi) => (
            <div key={gi}>
              {g.label && <div className="nav-label">{g.label}</div>}
              {g.items.map((item) => {
                const inner = <><span className="bar" /><span className="glyph" aria-hidden="true">{item.icon}</span><span className="label">{item.label}</span></>;
                return item.href
                  ? <Link key={item.id} className="nav-item" href={item.href} title={item.label} aria-label={item.label}>{inner}</Link>
                  : <button key={item.id} className={"nav-item" + (item.id === activeId ? " active" : "")} data-tour={item.id} title={item.label} aria-label={item.label} aria-current={item.id === activeId ? "page" : undefined} onClick={() => go(item.id)}>{inner}</button>;
              })}
            </div>
          ))}
        </nav>
        <div className="api-status" title={net.data?.rpcError || `RPC ${connLabel.toLowerCase()}`}>
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
          <button
            className="collapse-btn" onClick={toggleSidebar} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}
            title={(collapsed ? "Expand sidebar" : "Collapse sidebar") + "  ( [ )"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M9 4v16" />
              {collapsed ? <path d="M14 10l2 2-2 2" /> : <path d="M16 10l-2 2 2 2" />}
            </svg>
          </button>
          <div style={{ position: "relative" }} ref={menu === "project" ? menuRef : null}>
            <button className="project-btn" onClick={() => setMenu(menu === "project" ? null : "project")} aria-haspopup="menu">
              <span className="swatch" />{project ? project.name : user ? "No project yet" : "Public testnet explorer"}<span className="caret">▾</span>
            </button>
            {menu === "project" && (
              <div className="dropdown" role="menu">
                {projects.length > 0 && <div className="dropdown-label">Your projects</div>}
                {projects.map((p) => (
                  <button key={p.id} role="menuitemradio" aria-checked={project?.id === p.id} className={"item project-item" + (project?.id === p.id ? " active" : "")} onClick={() => { setProjectId(p.id); go("overview"); }}>
                    <span>{p.name}</span>{project?.id === p.id && <span className="project-check" aria-hidden="true">✓</span>}
                  </button>
                ))}
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
            <VerifyBanner user={user} refreshUser={refreshUser} />
            <ErrorBoundary resetKey={screen + (params.id ?? "") + (projectId ?? "")}>
            {user && projects.length === 0 ? <FirstProject onCreate={() => setCreating(true)} /> : <div className={NARROW.has(screen) ? "page-narrow" : undefined}>
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
            </div>}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {tour && <Tour step={tourStep} onNext={nextTour} onSkip={endTour} />}
      {creating && <NewProjectModal isFirst={projects.length === 0} onClose={() => setCreating(false)} onCreated={() => go(projects.length === 0 ? "setup" : "overview")} />}
    </div>
  );
}
