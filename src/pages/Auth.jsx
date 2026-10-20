import { useEffect, useRef, useState } from "react";
import { Link, navigate } from "../router.jsx";
import { useSession } from "../state.jsx";
import { Alert } from "../ui.jsx";
import PasswordField from "./PasswordField.jsx";
import { assessPassword, emailProblem } from "./password.js";
import "./pages.css";

const modeFromHash = () => (location.hash === "#signup" ? "signup" : "signin");

export default function Auth() {
  const { login, signup, user } = useSession();
  const [mode, setMode] = useState(modeFromHash);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [alert, setAlert] = useState(null);          // form-level problem (wrong credentials, server unreachable...)
  const [fields, setFields] = useState({});           // field-level problems { email, password }
  const [touched, setTouched] = useState({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const signupMode = mode === "signup";

  useEffect(() => {
    const onHash = () => setMode(modeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { if (user) navigate("/app"); }, [user]);

  const choose = (m) => { setMode(m); setAlert(null); setFields({}); setAttempted(false); history.replaceState(null, "", "#" + m); };

  /** Client-side checks run on blur and submit, so mistakes are explained in the page instead of by a browser bubble. */
  function validate(vals = { email, password }) {
    const out = {};
    const em = emailProblem(vals.email);
    if (em) out.email = em;
    if (signupMode) {
      if (!assessPassword(vals.password, vals.email).meetsRequired) out.password = vals.password.length > 200 ? "Use at most 200 characters." : `Use at least 12 characters (you have ${vals.password.length}).`;
    } else if (!vals.password) out.password = "Enter your password.";
    return out;
  }
  const onEmailBlur = () => { setTouched((t) => ({ ...t, email: true })); const em = emailProblem(email); setFields((f) => ({ ...f, email: em || undefined })); };
  const shown = { email: fields.email, password: attempted || touched.password ? fields.password : undefined };

  async function submit(e) {
    e.preventDefault();
    setAlert(null); setAttempted(true);
    const problems = validate();
    setFields(problems);
    if (problems.email || problems.password) {
      (problems.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (signupMode) { await signup(email.trim(), password); navigate("/app"); }
      else { await login(email.trim(), password); navigate("/app"); }
    } catch (err) {
      setBusy(false);
      const detail = (field) => err.details?.find((d) => d.path === field)?.message;
      if (err.code === "email_taken") setFields({ email: "An account with this email already exists." });
      else if (err.details?.length) setFields({ email: detail("email"), password: detail("password") });
      else if (err.code === "invalid_credentials") setAlert({ tone: "error", title: "That email and password don't match", body: "Check for typos and try again. If you're new here, create an account instead.", action: "signup" });
      else if (err.code === "rate_limited") setAlert({ tone: "warn", title: "Too many attempts", body: err.message });
      else if (err.status === 0) setAlert({ tone: "error", title: "Can't reach PortalOps", body: "The server isn't answering. Check your connection and try again.", action: "retry" });
      else setAlert({ tone: "error", title: "Something went wrong", body: err.message || "Please try again." });
    }
  }

  const ok = <span style={{ color: "var(--green)" }}>✓</span>;
  return (
    <div className="auth-shell">
      <section style={{ position: "relative", borderRight: "1px solid #1b1b1b", padding: "40px 48px", display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden", background: "linear-gradient(170deg,#0a0a0a,#0c0b10)" }}>
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(50% 45% at 30% 20%, rgba(185,167,255,0.12), transparent 70%)", animation: "glowpulse 6s ease-in-out infinite", pointerEvents: "none" }} />
        <Link href="/" className="brand" style={{ position: "relative", padding: 0 }}>
          <span className="brand-mark"><i /></span><span className="brand-name">PortalOps</span>
        </Link>
        <div style={{ position: "relative" }}>
          <h2 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.12, margin: 0, maxWidth: 380, textWrap: "balance" }}>Turn Portaldot events into reliable application infrastructure.</h2>
          <p style={{ fontSize: 15, color: "var(--muted)", margin: "16px 0 0", maxWidth: 360, lineHeight: 1.55 }}>Event ingestion, webhooks, replay, monitoring and automation, without building the infrastructure yourself.</p>
          <div className="mono" style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 9, fontSize: 12 }}>
            {["Runs against the Portaldot V3.0 testnet", "Signed webhooks with retries", "Replay from stored events"].map((t) => <div key={t} style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg-3)" }}>{ok}{t}</div>)}
          </div>
        </div>
        <div className="mono" style={{ position: "relative", fontSize: 11, color: "var(--faint)" }}>// the operational event layer</div>
      </section>

      <section style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <form onSubmit={submit} noValidate style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ display: "flex", background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 11, padding: 4, marginBottom: 28 }}>
            <button type="button" className={"auth-tab" + (!signupMode ? " on" : "")} onClick={() => choose("signin")}>Sign in</button>
            <button type="button" className={"auth-tab" + (signupMode ? " on" : "")} onClick={() => choose("signup")}>Create account</button>
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>{signupMode ? "Create your account" : "Welcome back"}</h1>
          <p style={{ fontSize: 14, color: "var(--muted)", margin: "7px 0 0" }}>{signupMode ? "Start building on Portaldot in minutes." : "Sign in to your PortalOps workspace."}</p>

          <div className="stack" style={{ gap: 16, marginTop: 26 }}>
            <div>
              <label className="field-label" style={{ display: "block", marginBottom: 7 }} htmlFor="email">Email</label>
              <input
                id="email" ref={emailRef} className={"pops-in" + (shown.email ? " invalid" : "")} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
                placeholder="you@company.dev" value={email} onChange={(e) => { setEmail(e.target.value); if (fields.email) setFields((f) => ({ ...f, email: undefined })); }} onBlur={onEmailBlur}
                aria-invalid={shown.email ? "true" : undefined} aria-describedby={shown.email ? "email-err" : undefined}
              />
              {shown.email && (
                <div className="form-err" id="email-err" role="alert">
                  <span className="form-err-ico" aria-hidden="true">!</span>
                  <span>{shown.email}{shown.email.startsWith("An account") && <> <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => choose("signin")}>Sign in instead</button></>}</span>
                </div>
              )}
            </div>
            <PasswordField
              id="password" inputRef={passwordRef} value={password} email={email} strength={signupMode} attempted={attempted}
              autoComplete={signupMode ? "new-password" : "current-password"} placeholder={signupMode ? "At least 12 characters" : "Your password"}
              onChange={(v) => { setPassword(v); if (fields.password) setFields((f) => ({ ...f, password: undefined })); }}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              error={shown.password}
            />
          </div>

          {alert && (
            <div style={{ marginTop: 18 }}>
              <Alert
                tone={alert.tone} title={alert.title} onClose={() => setAlert(null)}
                action={alert.action === "signup" ? <button type="button" className="link-btn" onClick={() => choose("signup")}>Create an account</button>
                  : alert.action === "retry" ? <button type="button" className="link-btn" onClick={submit}>Try again</button> : null}
              >{alert.body}</Alert>
            </div>
          )}
          <button className="btn primary" style={{ width: "100%", marginTop: 22, padding: 13, fontSize: 14.5, borderRadius: 11 }} disabled={busy}>{busy ? "Please wait…" : signupMode ? "Create account" : "Sign in"}</button>

          <p style={{ textAlign: "center", fontSize: 13, color: "var(--muted)", marginTop: 22 }}>
            {signupMode ? "Already have an account?" : "New to PortalOps?"}{" "}
            <button type="button" className="link-btn" style={{ fontSize: 13 }} onClick={() => choose(signupMode ? "signin" : "signup")}>{signupMode ? "Sign in" : "Create one"}</button>
          </p>
          <p style={{ textAlign: "center", fontSize: 12, color: "var(--faint)", marginTop: 14, lineHeight: 1.5 }}>
            Just looking? <Link href="/app">Explore the live testnet explorer</Link>, no account needed.
            Password reset and GitHub sign-in are coming soon.
          </p>
        </form>
      </section>
    </div>
  );
}
