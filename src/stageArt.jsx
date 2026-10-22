import { useEffect, useRef } from "react";
import { useInView, useReducedMotion } from "./orb.jsx";

// Small canvas animations for the four stages of the pipeline, drawn in the same language as the thinking orb (dots of the brand colour on
// black) so they sit beside it as a family: Watch is the orb itself, the others are these.
//   decode:  a cube of dots turning, a scan band sweeping through it and lighting the dots it passes
//   deliver: packets travelling to a target; the target lights up when each one lands
//   recover: a packet fails (red), circles back round the ring (the retry), and lands again (green)

const ACCENT = [185, 167, 255];
const GREEN = [110, 231, 168];
const RED = [240, 138, 134];
const AMBER = [233, 196, 106];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

const dot = (ctx, x, y, r, color, a) => { ctx.fillStyle = rgba(color, a); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };

// ---- decode: the cube ----------------------------------------------------------------------------------------------
const CUBE = (() => {
  const pts = [];
  const n = 6;
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (let i = 0; i <= n; i++) { const t = -1 + (2 * i) / n; pts.push([t, a, b], [a, t, b], [a, b, t]); }
  for (const s of [-1, 1]) for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]]) pts.push([s, u, v], [u, s, v], [u, v, s]); // faint face dots
  return pts;
})();

function drawDecode(ctx, S, time) {
  const ry = time * 0.7, rx = 0.55 + Math.sin(time * 0.45) * 0.18;
  const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
  const scan = Math.sin(time * 1.5) * 1.15;
  const k = S * 0.29;
  const out = [];
  for (const [x, y, z] of CUBE) {
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y2 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
    const persp = 3.6 / (3.6 + z2);
    out.push({ px: S / 2 + x1 * k * persp, py: S / 2 + y2 * k * persp, depth: (z2 + 1.8) / 3.6, lit: 1 - clamp01(Math.abs(y2 - scan) / 0.3) });
  }
  out.sort((a, b) => a.depth - b.depth);
  for (const p of out) {
    const base = 0.3 + (1 - p.depth) * 0.6;
    const color = p.lit > 0 ? mix(ACCENT, GREEN, p.lit) : ACCENT;
    dot(ctx, p.px, p.py, 0.8 + (1 - p.depth) * 0.9 + p.lit * 0.7, color, base + p.lit * 0.5);
  }
}

// ---- deliver: packets to a target ----------------------------------------------------------------------------------
function drawDeliver(ctx, S, time) {
  const y0 = S / 2, xl = S * 0.15, xr = S * 0.85, period = 2.4;
  for (let i = 0; i <= 10; i++) dot(ctx, xl + ((xr - xl) * i) / 10, y0, 0.9, ACCENT, 0.32);
  // target: lit by the most recent landing
  let pulse = 0, ringU = 1;
  const packets = [];
  for (let j = 0; j < 3; j++) {
    const p = (time / period + j / 3) % 1;
    packets.push(p);
    if (p < 0.28) { pulse = Math.max(pulse, 1 - p / 0.28); ringU = Math.min(ringU, p / 0.28); }
  }
  dot(ctx, xr, y0, 5.2, mix(ACCENT, GREEN, pulse), 0.28 + pulse * 0.5);
  ctx.strokeStyle = rgba(mix(ACCENT, GREEN, pulse), 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(xr, y0, 5.2, 0, Math.PI * 2); ctx.stroke();
  if (ringU < 1) { ctx.strokeStyle = rgba(GREEN, (1 - ringU) * 0.7); ctx.beginPath(); ctx.arc(xr, y0, 5.2 + ringU * 9, 0, Math.PI * 2); ctx.stroke(); }
  // source
  dot(ctx, xl, y0, 3.6, ACCENT, 0.9);
  ctx.strokeStyle = rgba(ACCENT, 0.4); ctx.beginPath(); ctx.arc(xl, y0, 6 + Math.sin(time * 3) * 0.6, 0, Math.PI * 2); ctx.stroke();
  // packets with trails
  for (const p of packets) {
    if (p > 0.92) continue;
    for (let t = 6; t >= 0; t--) {
      const pe = ease(clamp01(Math.max(0, p - t * 0.018) / 0.92));
      const x = xl + (xr - xl) * pe, y = y0 + Math.sin(pe * Math.PI * 2) * 2.2;
      dot(ctx, x, y, t === 0 ? 2.5 : 1.7 - t * 0.12, ACCENT, t === 0 ? 1 : 0.5 - t * 0.07);
    }
  }
}

// ---- recover: fail, loop back, land --------------------------------------------------------------------------------
const RING = 18;
function drawRecover(ctx, S, time) {
  const period = 4.4, t = (time % period) / period;
  const c = S / 2, R = S * 0.34, top = -Math.PI / 2;
  const landed = t > 0.78 ? 1 - clamp01((t - 0.78) / 0.2) : 0;
  for (let i = 0; i < RING; i++) {
    const a = top + (i / RING) * Math.PI * 2;
    dot(ctx, c + Math.cos(a) * R, c + Math.sin(a) * R, 1.1, mix(ACCENT, GREEN, landed), 0.38 + landed * 0.5);
  }
  // where the packet is, and what colour
  let angle = top, color = ACCENT, radius = R, jitter = 0, trail = false;
  if (t < 0.2) { color = mix(ACCENT, RED, clamp01(t / 0.06)); jitter = Math.sin(t * 160) * 1.2 * (1 - t / 0.2); }
  else if (t < 0.78) {
    const u = ease((t - 0.2) / 0.58);
    angle = top - u * Math.PI * 2; // counter-clockwise: the rewind
    color = mix(RED, ACCENT, clamp01(u * 1.4)); trail = true;
  } else { color = mix(ACCENT, GREEN, clamp01((t - 0.78) / 0.08)); }
  if (trail) for (let j = 7; j >= 1; j--) { const a = angle + j * 0.2; dot(ctx, c + Math.cos(a) * radius, c + Math.sin(a) * radius, 2 - j * 0.15, color, 0.5 - j * 0.06); }
  const px = c + Math.cos(angle) * radius + jitter, py = c + Math.sin(angle) * radius;
  dot(ctx, px, py, 3.2, color, 1);
  ctx.strokeStyle = rgba(color, 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI * 2); ctx.stroke();
  // attempt marks in the middle: two red, then one green once it lands
  for (let i = 0; i < 3; i++) dot(ctx, c - 6 + i * 6, c, 1.5, i === 2 ? (t > 0.78 ? GREEN : ACCENT) : (t > 0.04 + i * 0.01 ? RED : ACCENT), i === 2 && t <= 0.78 ? 0.25 : 0.8);
}

const DRAW = { decode: drawDecode, deliver: drawDeliver, recover: drawRecover };
// a time that shows each animation at its most telling, for reduced motion
const STILL = { decode: 1.3, deliver: 0.8, recover: 3.2 };

export default function StageArt({ kind, size = 64, label }) {
  const reduced = useReducedMotion();
  const [boxRef, inView] = useInView();
  const canvas = useRef(null);
  const animate = !reduced && inView;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!ctx) return undefined;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = size * dpr; el.height = size * dpr;
    const draw = (time) => { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, size, size); ctx.lineWidth = 1; DRAW[kind](ctx, size, time); };
    if (!animate) { draw(STILL[kind]); return undefined; }
    let raf = 0;
    const started = performance.now();
    const tick = (now) => { draw((now - started) / 1000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [kind, size, animate]);

  return (
    <span ref={boxRef} style={{ display: "inline-flex", width: size, height: size, flexShrink: 0 }}>
      <canvas ref={canvas} role="img" aria-label={label ?? kind} style={{ width: size, height: size }} />
    </span>
  );
}
