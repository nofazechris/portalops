import { useId, useState } from "react";
import { LEVELS, MIN_LENGTH, assessPassword } from "./password.js";

const Eye = ({ off }) => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M4 4l16 16" />}
  </svg>
);

/** Four segments that fill and change colour with the level; text label alongside so colour is never the only signal. */
export function StrengthBar({ level, compact }) {
  const l = LEVELS[level];
  return (
    <span className={"sbar tone-" + l.tone + (compact ? " compact" : "")} role="img" aria-label={`Password strength: ${l.label}`}>
      <span className="sbar-segs">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= level ? "on" : ""} />)}</span>
      <span className="sbar-label">{l.label}</span>
    </span>
  );
}

/**
 * Password input with a visible show/hide button, a Caps Lock hint, and (when `strength`) a strength bar plus a dropdown
 * checklist that opens while the field is focused or after a failed submit. Validation messages are shown inline, never as a
 * browser bubble.
 */
export default function PasswordField({ id, label = "Password", value, onChange, onBlur, autoComplete, placeholder, email, error, strength = false, attempted = false, inputRef, onKeyDown }) {
  const [shown, setShown] = useState(false);
  const [focused, setFocused] = useState(false);
  const [caps, setCaps] = useState(false);
  const uid = useId();
  const a = assessPassword(value, email);
  const open = strength && (focused || (attempted && !a.meetsRequired));
  const describedBy = [error ? `${uid}-err` : null, open ? `${uid}-pop` : null].filter(Boolean).join(" ") || undefined;

  return (
    <div
      className="pw"
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setFocused(false); setCaps(false); onBlur?.(); } }}
    >
      <div className="pw-head">
        <label className="field-label" htmlFor={id} style={{ margin: 0 }}>{label}</label>
        {strength && value && <StrengthBar level={a.level} compact />}
      </div>

      <div className={"pw-wrap" + (error ? " invalid" : "")}>
        <input
          id={id} ref={inputRef} className="pops-in pw-input" type={shown ? "text" : "password"} value={value} placeholder={placeholder}
          autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false}
          aria-invalid={error ? "true" : undefined} aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { setCaps(e.getModifierState?.("CapsLock") ?? false); onKeyDown?.(e); }}
          onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)}
        />
        <button type="button" className="pw-eye" onClick={() => setShown((s) => !s)} aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} title={shown ? "Hide password" : "Show password"}>
          <Eye off={shown} />
        </button>
      </div>

      {caps && <div className="pw-caps" role="status"><span aria-hidden="true">⇪</span> Caps Lock is on</div>}
      {error && <div className="form-err" id={`${uid}-err`} role="alert"><span className="form-err-ico" aria-hidden="true">!</span>{error}</div>}

      {open && (
        <div className="pw-pop" id={`${uid}-pop`} role="status" aria-live="polite">
          <div className="pw-pop-head"><span>Your password needs</span></div>
          <ul className="pw-checks">
            {a.checks.filter((c) => c.required).map((c) => (
              <li key={c.id} className={c.ok ? "ok" : "todo"}>
                <span className="pw-tick" aria-hidden="true">{c.ok ? "✓" : "○"}</span>
                <span>{c.label} <em>required</em></span>
                <span className="pw-count">{Math.min(a.length, 999)} / {MIN_LENGTH}</span>
              </li>
            ))}
          </ul>
          <div className="pw-sub">Makes it stronger</div>
          <ul className="pw-checks soft">
            {a.checks.filter((c) => !c.required).map((c) => (
              <li key={c.id} className={c.ok ? "ok" : "todo"}><span className="pw-tick" aria-hidden="true">{c.ok ? "✓" : "○"}</span><span>{c.label}</span></li>
            ))}
          </ul>
          <div className="pw-tip">{a.tip}</div>
        </div>
      )}
    </div>
  );
}
