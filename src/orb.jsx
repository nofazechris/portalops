import { useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";

/** True when the visitor asked their system for less motion. Animated things hold still (or jump to their final state) when it is. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** True while the element is on screen: orbs off screen are paused so a long page never animates things nobody can see. */
export function useInView(rootMargin = "120px") {
  const ref = useRef(null);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return [ref, inView];
}

/**
 * PortalOps' "thinking" indicator: the thinking-orbs orb, tinted with the brand colour, paused off screen and for people who prefer
 * reduced motion. What each state means in this product:
 *   searching: scanning blocks for events    working: decoding them      connecting: delivering to a webhook
 *   solving: retrying / backing off          listening: waiting for you  composing: writing a reply
 *   breathing: idle and healthy              weaving / shaping: spare
 */
export default function Orb({ state = "working", size = 64, speed = 1, label, color = "#b9a7ff", style, paused = false }) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView();
  return (
    <span ref={ref} className="orb" style={{ display: "inline-flex", width: size, height: size, flexShrink: 0, ...style }}>
      <ThinkingOrb state={state} size={size} theme="dark" color={color} speed={speed} paused={paused || reduced || !inView} aria-label={label} />
    </span>
  );
}
