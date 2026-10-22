import { Component, useEffect, useRef, useState } from "react";
import { Link } from "./router.jsx";
import { useSession } from "./state.jsx";
import Orb from "./orb.jsx";

/** The thinking orb stands in for a spinner: `state` says what is going on (searching: fetching, connecting: reaching a server). */
export const Loading = ({ label = "Loading…", state = "searching" }) => (
  <div className="state-box loading" role="status"><Orb size={64} state={state} label="" /><span>{label}</span></div>
);

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="banner error" role="alert">
      <div>
        <strong>{error.status === 0 ? "API unreachable" : "Something went wrong"}</strong>
        <div className="banner-sub">{error.message}</div>
      </div>
      {onRetry && <button className="btn secondary" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export const Empty = ({ title, children }) => (
  <div className="state-box empty"><div className="empty-title">{title}</div>{children && <div className="empty-sub">{children}</div>}</div>
);

/** Shown instead of owner-only screens (webhooks, replay, logs…) when browsing the public demo. */
export function NeedsProject({ what }) {
  const { user } = useSession();
  return (
    <Empty title={user ? "Create a project first" : "Sign in to " + what}>
      {user ? "This screen works on your own project. Create one from the project menu." : (
        <>This is the read-only public explorer. <Link href="/auth#signup">Create an account</Link> to {what.toLowerCase()}.</>
      )}
    </Empty>
  );
}

const FINALITY = {
  included: { label: "Included", color: "var(--amber)", hint: "Seen in a block, not yet confirmed by depth." },
  confirmed: { label: "Confirmed", color: "var(--accent)", hint: "Buried 12+ blocks deep. A depth heuristic, not protocol finality: the network can still reorganise it." },
  finalized: { label: "Finalized", color: "var(--green)", hint: "Finalized by the network's consensus and verified canonical. It can no longer be reorganised." },
  orphaned: { label: "Orphaned", color: "var(--red)", hint: "The block it was in is no longer on the canonical chain." },
};
const DELIVERY = {
  delivered: { label: "Delivered", icon: "✓", color: "var(--green)" },
  retrying: { label: "Retry scheduled", icon: "⚠", color: "var(--amber)" },
  pending: { label: "Queued", icon: "…", color: "var(--amber)" },
  failed: { label: "Failed", icon: "✕", color: "var(--red)" },
};

export const FinalityBadge = ({ status }) => {
  const f = FINALITY[status] ?? { label: status, color: "var(--muted)", hint: "" };
  return <span className="pill" title={f.hint} style={{ color: f.color, borderColor: "#242424" }}>{f.label}</span>;
};

export const DeliveryBadge = ({ delivery }) => {
  if (!delivery) return <span style={{ color: "var(--dim)", fontSize: 12 }}>No delivery</span>;
  const d = DELIVERY[delivery.status] ?? { label: delivery.status, icon: "", color: "var(--muted)" };
  return <span style={{ color: d.color, fontSize: 12 }}>{d.icon} {d.label}</span>;
};

export const deliveryLabel = (s) => DELIVERY[s]?.label ?? s;
export const deliveryColor = (s) => DELIVERY[s]?.color ?? "var(--muted)";

export function CopyButton({ text, label = "Copy", className = "link-btn" }) {
  const [done, setDone] = useState(false);
  const t = useRef();
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button className={className} onClick={() => {
      try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
      setDone(true); clearTimeout(t.current); t.current = setTimeout(() => setDone(false), 1500);
    }}>{done ? "Copied ✓" : label}</button>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { maxWidth: 640 } : undefined}>
        <div className="modal-head"><h2 className="h2">{title}</h2><button className="icon-x" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

/** A designed alert: tone icon, title, message, optional action and dismiss. Used instead of browser alerts and native validation bubbles. */
export function Alert({ tone = "error", title, children, action, onClose }) {
  const icon = { error: "!", warn: "!", info: "i", ok: "✓" }[tone] ?? "!";
  return (
    <div className={"alert tone-" + tone} role={tone === "error" || tone === "warn" ? "alert" : "status"}>
      <span className="alert-ico" aria-hidden="true">{icon}</span>
      <div className="alert-body">
        {title && <div className="alert-title">{title}</div>}
        {children && <div className="alert-msg">{children}</div>}
        {action && <div className="alert-action">{action}</div>}
      </div>
      {onClose && <button type="button" className="alert-x" onClick={onClose} aria-label="Dismiss">✕</button>}
    </div>
  );
}

/** Replaces window.confirm: a proper dialog with a clear primary action. Escape or clicking outside cancels. */
export function ConfirmDialog({ title, children, confirmLabel = "Confirm", danger = false, busy = false, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div style={{ fontSize: 14, color: "var(--fg-2)", lineHeight: 1.6 }}>{children}</div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 22 }}>
        <button type="button" className="btn secondary" onClick={onCancel} autoFocus>Cancel</button>
        <button type="button" className={"btn " + (danger ? "danger-solid" : "primary")} disabled={busy} onClick={onConfirm}>{busy ? "Working…" : confirmLabel}</button>
      </div>
    </Modal>
  );
}

export const Field = ({ label, hint, error, children }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && !error && <span className="field-hint">{hint}</span>}
    {error && <span className="field-error">{error}</span>}
  </label>
);

/** Maps zod issue details from the API onto field names. */
export const fieldErrors = (err) => Object.fromEntries((err?.details ?? []).map((d) => [d.path, d.message]));

export function PageHead({ title, sub, action }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
      <div><h1 className="h1">{title}</h1>{sub && <p className="sub">{sub}</p>}</div>
      {action}
    </div>
  );
}

export const ReadOnlyNote = () => (
  <div className="banner info">
    <div><strong>Read-only public explorer.</strong><div className="banner-sub">Live events from every contract on the Portaldot V3.0 testnet. They show as <em>raw logs</em> because the explorer has no ABIs to decode them. Sign in and register a contract with its ABI (or try the playground) to see named events, webhooks and replay.</div></div>
    <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
      <Link className="btn secondary small" href="/auth#signin">Sign in</Link>
      <Link className="btn primary small" href="/auth#signup">Create account</Link>
    </span>
  </div>
);

/** A crash in one screen must not blank the whole app. */
export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="banner error" role="alert">
        <div><strong>This screen crashed.</strong><div className="banner-sub">{String(this.state.error.message || this.state.error)}</div></div>
        <button className="btn secondary" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
