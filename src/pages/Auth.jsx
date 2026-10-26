import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Link, navigate } from "../router.jsx";
import { useSession } from "../state.jsx";
import { Alert } from "../ui.jsx";
import PasswordField from "./PasswordField.jsx";
import { assessPassword, emailProblem } from "./password.js";
import "./pages.css";

/** What the URL fragment asks for. Tokens from email links live in the fragment so they never reach a server log or a Referer header. */
function parseHash() {
  const h = location.hash.replace(/^#/, "");
  const [key, ...rest] = h.split("=");
  const value = rest.join("=");
  if (key === "signup") return { mode: "signup" };
  if (key === "forgot") return { mode: "forgot" };
  if (key === "reset") return { mode: "reset", token: value || null };
  if (key === "verify") return { mode: "verify", token: value || null };
  if (key === "error") return { mode: "signin", error: value };
  return { mode: "signin" };
}

const GITHUB_ERRORS = {
  state_mismatch: ["GitHub sign-in couldn't be verified", "The sign-in attempt expired or didn't start here. Please try again."],
  access_denied: ["GitHub sign-in was cancelled", "You didn't approve access, so nothing was changed."],
  github_no_verified_email: ["Your GitHub account has no verified email", "Verify an email address in your GitHub settings, then try again."],
  github_account_mismatch: ["That email belongs to a different GitHub account", "Sign in with the GitHub account you used before, or use your email and password."],
  github_failed: ["GitHub didn't respond as expected", "Please try again in a moment."],
  github_unavailable: ["GitHub sign-in isn't available", "This server isn't set up for GitHub sign-in yet."],
  rate_limited: ["Too many attempts", "Wait a minute and try again."],
};

const GithubMark = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const field = (extra = {}) => ({ marginTop: 18, ...extra });

/** The second sign-in step for accounts with two-factor on: a 6-digit authenticator code, or a one-time recovery code. */
function MfaStep({ challenge, loginMfa, back }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (code.trim().length < 6) { setError("Enter the 6-digit code from your authenticator app."); return; }
    setBusy(true); setError(null);
    try { await loginMfa(challenge, code.trim()); navigate("/app"); }
    catch (err) {
      setBusy(false);
      if (err.code === "challenge_expired") setError("That sign-in expired. Go back and enter your password again.");
      else if (err.code === "invalid_code") setError("That code is not right, or it was already used. Codes change every 30 seconds.");
      else if (err.code === "rate_limited") setError(err.message);
      else setError(err.message || "Something went wrong. Please try again.");
    }
  }
  return (
    <form onSubmit={submit} noValidate>
      <h2 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>Two-factor code</h2>
      <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)", margin: "0 0 20px" }}>Open your authenticator app and enter the 6-digit code for PortalOps. Lost your phone? Use one of your recovery codes instead.</p>
      <label className="field-label" htmlFor="mfa-code">Code</label>
      <input id="mfa-code" className="pops-in mono" style={{ letterSpacing: "0.2em", fontSize: 18 }} inputMode="text" autoComplete="one-time-code" autoFocus maxLength={24} placeholder="123 456" value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} aria-invalid={!!error} />
      {error && <div className="field-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <button className="btn primary" style={{ width: "100%", marginTop: 22, padding: 13, fontSize: 14.5, borderRadius: 11 }} disabled={busy}>{busy ? "Checking…" : "Verify and sign in"}</button>
      <button type="button" className="link-btn" style={{ display: "block", margin: "18px auto 0", fontSize: 13 }} onClick={back}>← Back to sign in</button>
    </form>
  );
}

/** Email + password sign-in and sign-up, with GitHub. */
function CredentialsForm({ mode, choose, providers, initialAlert }) {
  const { login, loginMfa, signup } = useSession();
  const signupMode = mode === "signup";
  const [challenge, setChallenge] = useState(null); // set when the password was right but a second factor is needed
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [alert, setAlert] = useState(initialAlert ?? null);
  const [fields, setFields] = useState({});
  const [touched, setTouched] = useState({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  /** Client-side checks run on blur and submit, so mistakes are explained in the page instead of by a browser bubble. */
  function validate() {
    const out = {};
    const em = emailProblem(email);
    if (em) out.email = em;
    if (signupMode) {
      if (!assessPassword(password, email).meetsRequired) out.password = password.length > 200 ? "Use at most 200 characters." : `Use at least 12 characters (you have ${password.length}).`;
    } else if (!password) out.password = "Enter your password.";
    return out;
  }
  const onEmailBlur = () => { setTouched((t) => ({ ...t, email: true })); const em = emailProblem(email); setFields((f) => ({ ...f, email: em || undefined })); };
  const shown = { email: fields.email, password: attempted || touched.password ? fields.password : undefined };

  async function submit(e) {
    e?.preventDefault();
    setAlert(null); setAttempted(true);
    const problems = validate();
    setFields(problems);
    if (problems.email || problems.password) { (problems.email ? emailRef : passwordRef).current?.focus(); return; }
    setBusy(true);
    try {
      if (signupMode) await signup(email.trim(), password);
      else {
        const r = await login(email.trim(), password);
        if (r?.mfaRequired) { setChallenge(r.challenge); setBusy(false); return; }
      }
      navigate("/app");
    } catch (err) {
      setBusy(false);
      const detail = (f) => err.details?.find((d) => d.path === f)?.message;
      if (err.code === "email_taken") setFields({ email: "An account with this email already exists." });
      else if (err.details?.length) setFields({ email: detail("email"), password: detail("password") });
      else if (err.code === "invalid_credentials") setAlert({ tone: "error", title: "That email and password don't match", body: "Check for typos and try again. If you're new here, create an account instead.", action: "signup" });
      else if (err.code === "rate_limited") setAlert({ tone: "warn", title: "Too many attempts", body: err.message });
      else if (err.status === 0) setAlert({ tone: "error", title: "Can't reach PortalOps", body: "The server isn't answering. Check your connection and try again.", action: "retry" });
      else setAlert({ tone: "error", title: "Something went wrong", body: err.message || "Please try again." });
    }
  }

  if (challenge) return <MfaStep challenge={challenge} loginMfa={loginMfa} back={() => { setChallenge(null); setPassword(""); }} />;

  return (
    <form onSubmit={submit} noValidate>
      <div style={{ display: "flex", background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 11, padding: 4, marginBottom: 28 }}>
        <button type="button" className={"auth-tab" + (!signupMode ? " on" : "")} onClick={() => choose("signin")}>Sign in</button>
        <button type="button" className={"auth-tab" + (signupMode ? " on" : "")} onClick={() => choose("signup")}>Create account</button>
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>{signupMode ? "Create your account" : "Welcome back"}</h1>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "7px 0 0" }}>{signupMode ? "Start building on Portaldot in minutes." : "Sign in to your PortalOps workspace."}</p>

      {providers?.github && (
        <>
          <a className="auth-github" href="/api/v1/auth/github/start" style={{ marginTop: 24 }}><GithubMark />Continue with GitHub</a>
          <div className="auth-or"><span>or use email</span></div>
        </>
      )}

      <div className="stack" style={{ gap: 16, marginTop: providers?.github ? 0 : 26 }}>
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
          labelAction={!signupMode ? <button type="button" className="link-btn" style={{ fontSize: 12.5 }} onClick={() => choose("forgot")}>Forgot password?</button> : null}
        />
      </div>

      {alert && (
        <div style={field()}>
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
      </p>
    </form>
  );
}

/** "Forgot password": ask for a link. The answer is the same whether or not the address has an account. */
function ForgotForm({ choose, providers }) {
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState(null);
  const [alert, setAlert] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const p = emailProblem(email);
    setProblem(p); setAlert(null);
    if (p) return;
    setBusy(true);
    try { await api.forgotPassword(email.trim()); setSentTo(email.trim()); }
    catch (err) {
      setAlert(err.code === "rate_limited" ? { tone: "warn", title: "Too many requests", body: err.message } : { tone: "error", title: err.status === 0 ? "Can't reach PortalOps" : "Something went wrong", body: err.status === 0 ? "Check your connection and try again." : err.message });
    } finally { setBusy(false); }
  }

  if (sentTo) {
    return (
      <div>
        <div className="auth-icon ok" aria-hidden="true">✉</div>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: "18px 0 0" }}>Check your email</h1>
        <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.6, margin: "8px 0 0" }}>
          If an account exists for <strong style={{ color: "var(--fg-2)" }}>{sentTo}</strong>, a link to choose a new password is on its way. It works once and expires in 1 hour.
        </p>
        {providers && !providers.email && <div style={field()}><Alert tone="warn" title="Email isn't set up on this server yet">No message will arrive until the administrator connects an email provider.</Alert></div>}
        <p style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55, margin: "16px 0 0" }}>Nothing yet? Check your spam folder, or wait a minute and ask again.</p>
        <button className="btn secondary" style={{ width: "100%", marginTop: 22, padding: 12 }} onClick={() => { setSentTo(null); }}>Use a different address</button>
        <button type="button" className="link-btn" style={{ display: "block", margin: "18px auto 0", fontSize: 13 }} onClick={() => choose("signin")}>← Back to sign in</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate>
      <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>Forgot your password?</h1>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "7px 0 0", lineHeight: 1.55 }}>Enter your email and we'll send a link to choose a new one.</p>
      <div style={{ marginTop: 26 }}>
        <label className="field-label" style={{ display: "block", marginBottom: 7 }} htmlFor="forgot-email">Email</label>
        <input id="forgot-email" autoFocus className={"pops-in" + (problem ? " invalid" : "")} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
          placeholder="you@company.dev" value={email} onChange={(e) => { setEmail(e.target.value); setProblem(null); }} aria-invalid={problem ? "true" : undefined} />
        {problem && <div className="form-err" role="alert"><span className="form-err-ico" aria-hidden="true">!</span>{problem}</div>}
      </div>
      {alert && <div style={field()}><Alert tone={alert.tone} title={alert.title} onClose={() => setAlert(null)}>{alert.body}</Alert></div>}
      <button className="btn primary" style={{ width: "100%", marginTop: 22, padding: 13, fontSize: 14.5, borderRadius: 11 }} disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      <button type="button" className="link-btn" style={{ display: "block", margin: "20px auto 0", fontSize: 13 }} onClick={() => choose("signin")}>← Back to sign in</button>
    </form>
  );
}

/** The page the emailed link opens: choose a new password. */
function ResetForm({ token, choose }) {
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState(null);
  const [attempted, setAttempted] = useState(false);
  const [alert, setAlert] = useState(token ? null : { tone: "error", title: "This link is incomplete", body: "Open the link from your email again, or request a new one.", action: "forgot" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setAttempted(true); setAlert(null);
    if (!assessPassword(password).meetsRequired) { setProblem(password.length > 200 ? "Use at most 200 characters." : `Use at least 12 characters (you have ${password.length}).`); return; }
    setBusy(true);
    try { await api.resetPassword(token, password); setDone(true); }
    catch (err) {
      setBusy(false);
      if (err.code === "invalid_token") setAlert({ tone: "error", title: "This link has expired or was already used", body: "Reset links work once and last 1 hour. Request a new one.", action: "forgot" });
      else if (err.details?.length) setProblem(err.details[0].message);
      else if (err.code === "rate_limited") setAlert({ tone: "warn", title: "Too many attempts", body: err.message });
      else setAlert({ tone: "error", title: err.status === 0 ? "Can't reach PortalOps" : "Something went wrong", body: err.status === 0 ? "Check your connection and try again." : err.message });
    }
  }

  if (done) {
    return (
      <div>
        <div className="auth-icon ok" aria-hidden="true">✓</div>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: "18px 0 0" }}>Password updated</h1>
        <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.6, margin: "8px 0 0" }}>You've been signed out everywhere for safety. Sign in with your new password.</p>
        <button className="btn primary" style={{ width: "100%", marginTop: 24, padding: 13, fontSize: 14.5, borderRadius: 11 }} onClick={() => choose("signin")}>Continue to sign in</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate>
      <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>Choose a new password</h1>
      <p style={{ fontSize: 14, color: "var(--muted)", margin: "7px 0 0", lineHeight: 1.55 }}>Pick something you don't use anywhere else.</p>
      <div style={{ marginTop: 26 }}>
        <PasswordField id="new-password" value={password} strength attempted={attempted} autoComplete="new-password" placeholder="At least 12 characters" label="New password"
          onChange={(v) => { setPassword(v); setProblem(null); }} error={problem} />
      </div>
      {alert && (
        <div style={field()}>
          <Alert tone={alert.tone} title={alert.title} action={alert.action === "forgot" ? <button type="button" className="link-btn" onClick={() => choose("forgot")}>Request a new link</button> : null}>{alert.body}</Alert>
        </div>
      )}
      <button className="btn primary" style={{ width: "100%", marginTop: 22, padding: 13, fontSize: 14.5, borderRadius: 11 }} disabled={busy || !token}>{busy ? "Saving…" : "Update password"}</button>
      <button type="button" className="link-btn" style={{ display: "block", margin: "20px auto 0", fontSize: 13 }} onClick={() => choose("signin")}>← Back to sign in</button>
    </form>
  );
}

/** The page the verification link opens: confirms the address right away. */
function VerifyPanel({ token, choose }) {
  const { user, refreshUser } = useSession();
  const [state, setState] = useState(token ? "working" : "missing"); // working | ok | bad | missing | offline
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    (async () => {
      try { await api.verifyEmail(token); setState("ok"); refreshUser?.(); }
      catch (err) { setState(err.status === 0 ? "offline" : "bad"); }
    })();
  }, [token, refreshUser]);

  const go = () => (user ? navigate("/app") : choose("signin"));
  const view = {
    working: { icon: "…", cls: "", title: "Confirming your email…", body: "One moment." },
    ok: { icon: "✓", cls: "ok", title: "Email confirmed", body: "Thanks. Your address is verified." },
    bad: { icon: "!", cls: "bad", title: "This link has expired or was already used", body: "Sign in and use “Resend email” on the banner at the top of the dashboard to get a new one." },
    missing: { icon: "!", cls: "bad", title: "This link is incomplete", body: "Open the link from your email again." },
    offline: { icon: "!", cls: "bad", title: "Can't reach PortalOps", body: "Check your connection and reload this page." },
  }[state];
  return (
    <div>
      <div className={"auth-icon " + view.cls} aria-hidden="true">{view.icon}</div>
      <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: "18px 0 0" }} role={state === "working" ? "status" : undefined}>{view.title}</h1>
      <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.6, margin: "8px 0 0" }}>{view.body}</p>
      {state !== "working" && <button className="btn primary" style={{ width: "100%", marginTop: 24, padding: 13, fontSize: 14.5, borderRadius: 11 }} onClick={go}>{user ? "Continue to PortalOps" : "Go to sign in"}</button>}
    </div>
  );
}

export default function Auth() {
  const { user } = useSession();
  const first = useRef(parseHash());
  const [view, setView] = useState(first.current);
  const [providers, setProviders] = useState(null);
  const mode = view.mode;

  // The token (if any) is held in state and removed from the address bar straight away.
  useEffect(() => {
    if (first.current.token) history.replaceState(null, "", "#" + first.current.mode);
    else if (first.current.error) history.replaceState(null, "", "#signin");
  }, []);
  useEffect(() => {
    const onHash = () => {
      const p = parseHash();
      setView((v) => (p.token || p.error || p.mode !== v.mode ? p : v));
      // a link pasted into an already-open tab: take the token out of the address bar here too
      if (p.token) history.replaceState(null, "", "#" + p.mode);
      else if (p.error) history.replaceState(null, "", "#signin");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { api.authProviders().then(setProviders).catch(() => setProviders({ github: false, email: false })); }, []);
  // signed-in people are sent on, except when they opened an email link (verify / reset)
  useEffect(() => { if (user && (mode === "signin" || mode === "signup")) navigate("/app"); }, [user, mode]);

  const choose = (m) => { setView({ mode: m }); history.replaceState(null, "", "#" + m); };
  const github = view.error ? GITHUB_ERRORS[view.error] : null;
  const initialAlert = view.error ? { tone: "error", title: github?.[0] ?? "Sign-in failed", body: github?.[1] ?? "Please try again." } : null;

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
        <div style={{ width: "100%", maxWidth: 380 }} key={mode}>
          {(mode === "signin" || mode === "signup") && <CredentialsForm mode={mode} choose={choose} providers={providers} initialAlert={initialAlert} />}
          {mode === "forgot" && <ForgotForm choose={choose} providers={providers} />}
          {mode === "reset" && <ResetForm token={view.token} choose={choose} />}
          {mode === "verify" && <VerifyPanel token={view.token} choose={choose} />}
        </div>
      </section>
    </div>
  );
}
