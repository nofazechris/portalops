import { useEffect, useState } from "react";
import { Link, navigate } from "../router.jsx";
import { useSession } from "../state.jsx";
import "./pages.css";

const modeFromHash = () => (location.hash === "#signup" ? "signup" : "signin");

export default function Auth() {
  const { login, signup, user } = useSession();
  const [mode, setMode] = useState(modeFromHash);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const signupMode = mode === "signup";

  useEffect(() => {
    const onHash = () => setMode(modeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { if (user) navigate("/app"); }, [user]);

  const choose = (m) => { setMode(m); setError(null); history.replaceState(null, "", "#" + m); };

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (signupMode) { await signup(email, password); navigate("/app#tour"); }
      else { await login(email, password); navigate("/app"); }
    } catch (err) {
      const issue = err.details?.[0];
      setError(issue ? `${issue.path === "password" ? "Password" : "Email"}: ${issue.message}` : err.message);
      setBusy(false);
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
        <form onSubmit={submit} style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ display: "flex", background: "#0d0d0d", border: "1px solid #1f1f1f", borderRadius: 11, padding: 4, marginBottom: 28 }}>
            <button type="button" className={"auth-tab" + (!signupMode ? " on" : "")} onClick={() => choose("signin")}>Sign in</button>
            <button type="button" className={"auth-tab" + (signupMode ? " on" : "")} onClick={() => choose("signup")}>Create account</button>
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>{signupMode ? "Create your account" : "Welcome back"}</h1>
          <p style={{ fontSize: 14, color: "var(--muted)", margin: "7px 0 0" }}>{signupMode ? "Start building on Portaldot in minutes." : "Sign in to your PortalOps workspace."}</p>

          <div className="stack" style={{ gap: 14, marginTop: 26 }}>
            <div><label className="field-label" style={{ display: "block", marginBottom: 7 }} htmlFor="email">Email</label><input id="email" className="pops-in" type="email" autoComplete="email" placeholder="you@company.dev" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div>
              <label className="field-label" style={{ display: "block", marginBottom: 7 }} htmlFor="password">Password</label>
              <input id="password" className="pops-in" type="password" autoComplete={signupMode ? "new-password" : "current-password"} placeholder="••••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={signupMode ? 12 : undefined} />
              {signupMode && <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 7 }}>At least 12 characters.</div>}
            </div>
          </div>

          {error && <div className="banner error" role="alert" style={{ marginTop: 16, marginBottom: 0 }}>{error}</div>}
          <button className="btn primary" style={{ width: "100%", marginTop: 22, padding: 13, fontSize: 14.5, borderRadius: 11 }} disabled={busy}>{busy ? "Please wait…" : signupMode ? "Create account" : "Sign in"}</button>

          <p style={{ textAlign: "center", fontSize: 13, color: "var(--muted)", marginTop: 22 }}>
            {signupMode ? "Already have an account?" : "New to PortalOps?"}{" "}
            <button type="button" className="link-btn" style={{ fontSize: 13 }} onClick={() => choose(signupMode ? "signin" : "signup")}>{signupMode ? "Sign in" : "Create one"}</button>
          </p>
          <p style={{ textAlign: "center", fontSize: 12, color: "var(--faint)", marginTop: 14, lineHeight: 1.5 }}>
            Just looking? <Link href="/app">Explore the live testnet explorer</Link>, no account needed.
            Password reset and OAuth sign-in are not available yet.
          </p>
        </form>
      </section>
    </div>
  );
}
