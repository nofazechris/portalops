import { useLayoutEffect, useState } from "react";
import { tourSteps } from "./data.js";

export default function Tour({ step, onNext, onSkip }) {
  const [rect, setRect] = useState(null);
  const target = tourSteps[step].target;

  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector(`[data-tour="${target}"]`);
      if (el) setRect(el.getBoundingClientRect());
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [target]);

  if (!rect) return null;
  const last = step + 1 >= tourSteps.length;
  const { title, body } = tourSteps[step];

  return (
    <div>
      <div className="tour-shield" />
      <div className="tour-ring" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />
      <div className="tour-pop" style={{ top: Math.max(16, rect.top - 8), left: rect.right + 22 }}>
        <div className="arrow" />
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>{title}</div>
        <p style={{ fontSize: 13.5, color: "var(--fg-3)", margin: "8px 0 0", lineHeight: 1.5 }}>{body}</p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>{step + 1} of {tourSteps.length}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="tour-btn skip" onClick={onSkip}>Skip</button>
            <button className="tour-btn next" onClick={onNext}>{last ? "Done" : "Next"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
