// PortalOps film soundtrack: music bed and sound effects synthesised sample by sample,
// timed to the film (seconds), with the music ducked under the narration.
// Usage: node brand/motion/soundtrack.mjs <out.wav>
// Then mix with the narration:  see brand/motion/README.md
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SR = 48000;
export const DUR = 67.7;

export function compose(cues) {
  const LEN = Math.ceil(SR * DUR);
  const mus = [new Float32Array(LEN), new Float32Array(LEN)];
  const fx = [new Float32Array(LEN), new Float32Array(LEN)];
  const wet = [new Float32Array(LEN), new Float32Array(LEN)];
  let seed = 20261029 >>> 0;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const N = m => 440 * Math.pow(2, (m - 69) / 12);
  const TAU = Math.PI * 2;
  const panGains = p => { const a = (Math.max(-1, Math.min(1, p)) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; };

  // Write one mono signal into a bus with panning (fixed or ramped) and a reverb send.
  function write(bus, start, sig, g, pan0, pan1, w) {
    const i0 = Math.floor(start * SR);
    const n = sig.length;
    for (let k = 0; k < n; k++) {
      const i = i0 + k; if (i < 0 || i >= LEN) continue;
      const p = pan1 === pan0 ? pan0 : pan0 + (pan1 - pan0) * (k / n);
      const [gl, gr] = panGains(p);
      const v = sig[k] * g;
      bus[0][i] += v * gl; bus[1][i] += v * gr;
      if (w) { wet[0][i] += v * gl * w; wet[1][i] += v * gr * w; }
    }
  }
  const wave = (type, ph) => {
    const x = ph - Math.floor(ph);
    if (type === 'sine') return Math.sin(TAU * x);
    if (type === 'tri') return 1 - 4 * Math.abs(x - 0.5);
    if (type === 'square') return x < 0.5 ? 1 : -1;
    return 2 * x - 1; // saw
  };

  /* ---- Instruments ---- */
  function tone(t, f, o = {}) {
    const { type = 'sine', a = 0.005, d = 0.4, g = 0.2, pan = 0, w = 0.25, f2 = null, glide = 0.1, lp = null, bus = fx } = o;
    const n = Math.floor((a + d) * SR), sig = new Float32Array(n);
    const al = lp ? 1 - Math.exp(-TAU * lp / SR) : 0;
    let ph = 0, y1 = 0, y2 = 0;
    for (let k = 0; k < n; k++) {
      const tt = k / SR;
      const fr = f2 ? f * Math.pow(f2 / f, Math.min(tt / glide, 1)) : f;
      ph += fr / SR;
      let v = wave(type, ph);
      if (lp) { y1 += al * (v - y1); y2 += al * (y1 - y2); v = y2; }
      const env = tt < a ? tt / a : Math.exp(Math.log(1e-4) * (tt - a) / d);
      sig[k] = v * env;
    }
    write(bus, t, sig, g, pan, pan, w);
  }
  function bell(t, f, g = 0.08, d = 2.2, pan = 0) {
    tone(t, f, { d, g, pan, w: 0.6 });
    tone(t, f * 2.76, { d: d * 0.35, g: g * 0.18, pan, w: 0.7 });
    tone(t, f * 5.4, { d: d * 0.15, g: g * 0.06, pan, w: 0.7 });
  }
  // Noise through a swept band-pass (state-variable filter).
  function whoosh(t, dur = 0.9, o = {}) {
    const { from = 300, to = 4000, g = 0.2, pan0 = 0, pan1 = pan0, w = 0.3, q = 1.2, peakAt = 0.6 } = o;
    const n = Math.floor(dur * SR), sig = new Float32Array(n);
    let low = 0, band = 0; const damp = 1 / q;
    for (let k = 0; k < n; k++) {
      const u = k / n;
      const fc = Math.min(from * Math.pow(to / from, u), 9000);
      const F = 2 * Math.sin(Math.PI * fc / SR);
      const x = rnd() * 2 - 1;
      low += F * band; const high = x - low - damp * band; band += F * high;
      const env = u < peakAt ? Math.pow(u / peakAt, 2) : Math.pow((1 - u) / (1 - peakAt), 2);
      sig[k] = band * env * 1.6;
    }
    write(fx, t, sig, g, pan0, pan1, w);
  }
  function noiseHit(t, d, g, fromLp, toLp, pan = 0, w = 0.6) {
    const n = Math.floor(d * SR), sig = new Float32Array(n); let y = 0;
    for (let k = 0; k < n; k++) {
      const u = k / n, fc = fromLp * Math.pow(toLp / fromLp, u), al = 1 - Math.exp(-TAU * fc / SR);
      y += al * ((rnd() * 2 - 1) - y);
      sig[k] = y * Math.exp(Math.log(1e-4) * u);
    }
    write(fx, t, sig, g, pan, pan, w);
  }
  function riser(t0, t1, g = 0.16) {
    whoosh(t0, t1 - t0, { from: 180, to: 8000, g, q: 2.2, w: 0.45, peakAt: 0.97 });
    const n = Math.floor((t1 - t0) * SR), sig = new Float32Array(n); let ph = 0, y = 0;
    for (let k = 0; k < n; k++) {
      const u = k / n; ph += N(50) * Math.pow(N(74) / N(50), u) / SR;
      const al = 1 - Math.exp(-TAU * (300 * Math.pow(15, u)) / SR);
      y += al * (wave('saw', ph) - y);
      sig[k] = y * Math.pow(u, 2.5);
    }
    write(fx, t0, sig, g * 0.25, 0, 0, 0.35);
  }
  function impact(t, g = 0.85) {
    tone(t, 92, { f2: 34, glide: 1.5, d: 2.4, g, w: 0.12 });
    noiseHit(t, 1.2, g * 0.3, 3500, 160, 0, 0.7);
  }
  function shimmer(t, notes, g = 0.06, d = 3.6) { notes.forEach((m, i) => bell(t + i * 0.05, N(m), g, d, i % 2 ? 0.4 : -0.4)); }
  function click(t, g = 0.06, hp = 2500, pan = 0, len = 0.025) {
    const n = Math.floor(len * SR), sig = new Float32Array(n), al = 1 - Math.exp(-TAU * hp / SR); let lo = 0;
    for (let k = 0; k < n; k++) { const x = rnd() * 2 - 1; lo += al * (x - lo); sig[k] = (x - lo) * Math.exp(Math.log(1e-3) * k / n); }
    write(fx, t, sig, g, pan, pan, 0.08);
  }
  function kick(t, g = 0.5) { tone(t, 140, { f2: 42, glide: 0.18, d: 0.42, g, w: 0.05 }); click(t, g * 0.12, 3500); }
  function buzz(t, pan = 0.6) {
    tone(t, 110, { type: 'square', d: 0.28, g: 0.05, lp: 900, pan, w: 0.15 });
    tone(t, 116.5, { type: 'square', d: 0.28, g: 0.05, lp: 900, pan, w: 0.15 });
    tone(t + 0.17, 92.5, { type: 'square', d: 0.32, g: 0.05, lp: 700, pan, w: 0.15 });
  }
  function chime(t, m1, m2, pan = 0) { bell(t, N(m1), 0.1, 1.4, pan); bell(t + 0.1, N(m2), 0.1, 2.0, pan); }

  /* ---- Music: warm chord pads in D, then a soft pulse and arpeggio ---- */
  const CH = {
    Dmaj9: [38, 50, 54, 57, 61, 64], Bm11: [35, 47, 54, 57, 62, 64], Em9: [40, 52, 55, 59, 62, 66],
    Gmaj9: [43, 55, 59, 62, 66, 69], A6sus: [45, 57, 62, 64, 66, 69], Dbig: [38, 50, 57, 62, 66, 69, 73, 76]
  };
  const prog = [[1.2, 'Dmaj9'], [6.9, 'Bm11'], [10.3, 'Em9'], [13.15, 'Dbig'], [17.3, 'Gmaj9'], [21.5, 'Bm11'], [25.1, 'Dmaj9'],
    [28, 'Gmaj9'], [30.5, 'A6sus'], [31.7, 'Dmaj9'], [34, 'Em9'], [39.5, 'Dmaj9'], [40.4, 'Gmaj9'], [42.6, 'Dmaj9'],
    [45.6, 'Bm11'], [49, 'Gmaj9'], [52.4, 'Em9'], [56, 'A6sus'], [59.95, 'Dbig']];
  prog.forEach(([t, name], i) => {
    const last = i === prog.length - 1;
    const end = last ? DUR - 4.5 : prog[i + 1][0];
    const stop = last ? DUR - 0.1 : end + 1.5;
    const big = name === 'Dbig';
    const att = i === 0 ? 2.6 : 0.8;
    CH[name].forEach((m, k) => {
      const f = N(m), n = Math.floor((stop - t) * SR), sig = new Float32Array(n);
      const cut = big ? 1500 + k * 220 : 600 + k * 110, al = 1 - Math.exp(-TAU * cut / SR);
      const peak = k === 0 ? 0.07 : (big ? 0.016 : 0.013);
      const dets = k === 0 ? [1] : [Math.pow(2, -8 / 1200), Math.pow(2, 8 / 1200)];
      const ph = dets.map(() => rnd());
      let y1 = 0, y2 = 0;
      const lfoRate = 0.15 + rnd() * 0.2;
      for (let s = 0; s < n; s++) {
        const tt = s / SR, at = t + tt;
        let v = 0;
        dets.forEach((dt, j) => { ph[j] += f * dt / SR; v += wave(k === 0 ? 'sine' : 'saw', ph[j]); });
        y1 += al * (v - y1); y2 += al * (y1 - y2);
        let env = tt < att ? tt / att : 1;
        if (at > end) env *= Math.max(0, 1 - (at - end) / (stop - end));
        sig[s] = y2 * env * peak * (1 + 0.12 * Math.sin(TAU * lfoRate * tt));
      }
      write(mus, t, sig, 1, k === 0 ? 0 : (k % 2 ? 0.3 : -0.3), k === 0 ? 0 : (k % 2 ? 0.3 : -0.3), 0.3);
    });
  });
  const chordAt = t => { let c = prog[0][1]; for (const [at, nm] of prog) if (t >= at) c = nm; return CH[c]; };
  const rests = [[27.3, 28.3], [33.3, 34.3], [40.3, 41.0], [44.9, 46.0], [51.7, 52.6]];
  const resting = t => rests.some(([a, b]) => t >= a && t < b);
  const pat = [0, 2, 1, 3, 2, 1, 3, 2];
  for (let t = 21.5, n = 0; t < 59.2; t += 0.3, n++) {
    if (resting(t)) continue;
    const up = chordAt(t).slice(2);
    tone(t, N(up[pat[n % 8] % up.length] + 12), { type: 'tri', d: 0.32, g: 0.035, pan: n % 2 ? 0.45 : -0.45, w: 0.5, bus: mus });
    if (n % 2 === 0) kick(t, 0.2);
    else if (t > 34) click(t, 0.016, 7000, 0.2, 0.02);
  }

  /* ---- Effects, scene by scene ---- */
  bell(0.3, N(98), 0.03, 1.6);
  riser(0.3, 1.25, 0.14); impact(1.25, 0.7); shimmer(1.3, [74, 81, 85], 0.05);
  whoosh(2.9, 1.3, { from: 1200, to: 300, g: 0.08, w: 0.4 });
  whoosh(6.15, 0.75, { from: 400, to: 2500, g: 0.1 });
  whoosh(6.9, 1.2, { from: 200, to: 900, g: 0.1, pan0: 0.6, pan1: -0.4 });
  const penta = [74, 76, 78, 81, 83, 86, 88, 90, 93];
  for (let i = 0; i < 9; i++) for (let k = 0; k < 2; k++) {
    const at = 7.6 + i * 0.28 + k * 1.15;
    if (at < 10.2) tone(at, N(penta[i] - k * 12), { d: 0.55, g: 0.05, pan: -0.6 + i * 0.15, w: 0.55 });
  }
  for (let i = 0; i < 9; i++) tone(10.4 + i * 0.13, N(64 - i), { f2: N(52 - i), glide: 0.6, d: 0.6, g: 0.04, lp: 900, pan: -0.6 + i * 0.15, w: 0.4 });
  whoosh(9.7, 0.6, { from: 2500, to: 600, g: 0.06 });
  whoosh(12.35, 0.7, { from: 300, to: 3000, g: 0.1 });
  riser(12.0, 13.15, 0.16); impact(13.15, 0.9); shimmer(13.3, [74, 78, 81, 85, 90], 0.055);
  whoosh(16.7, 0.6, { from: 600, to: 4000, g: 0.12 });
  for (let i = 0; i < 5; i++) {
    const at = 17.35 + i * 0.8;
    kick(at, i === 4 ? 0.75 : 0.55);
    whoosh(at - 0.12, 0.3, { from: 5000, to: 900, g: 0.07, pan0: i % 2 ? 0.4 : -0.4 });
    bell(at, N([74, 76, 78, 81, 86][i]), 0.035, 1.0);
  }
  shimmer(20.6, [78, 81, 85, 88], 0.04);
  whoosh(21.3, 0.9, { from: 300, to: 2400, g: 0.1 });
  for (let i = 0; i < 5; i++) for (let k = 0; k < 9; k++) click(22.4 + i * 0.2 + k * 0.08, 0.035, 3500 + rnd() * 3000, -0.5 + k * 0.12, 0.012);
  for (let k = 0; k < 44; k++) tone(24.0 + k * 0.02 + rnd() * 0.01, 700 + rnd() * 2600, { type: 'square', d: 0.025, g: 0.016 + (k / 44) * 0.02, lp: 5000, pan: rnd() * 1.6 - 0.8, w: 0.1 });
  whoosh(24.6, 0.55, { from: 5000, to: 400, g: 0.1 });
  chime(25.1, 86, 93); impact(25.1, 0.3);
  whoosh(27.3, 0.7, { from: 400, to: 3000, g: 0.1 });
  whoosh(28.6, 0.6, { from: 300, to: 1200, g: 0.06 });
  bell(29.3, N(74), 0.09, 1.8, -0.6);
  whoosh(29.6, 0.95, { from: 400, to: 2200, g: 0.06, pan0: -0.6, pan1: 0 });
  bell(30.5, N(78), 0.09, 1.8, 0);
  whoosh(30.8, 0.95, { from: 400, to: 2200, g: 0.06, pan0: 0, pan1: 0.6 });
  bell(31.7, N(81), 0.11, 2.6, 0.6); shimmer(31.75, [74, 78, 81, 86], 0.05); impact(31.7, 0.35);
  whoosh(33.3, 0.7, { from: 400, to: 3000, g: 0.1 });
  whoosh(34.4, 0.8, { from: 200, to: 900, g: 0.08 });
  const send = (at, ok) => {
    click(at, 0.06, 2000, -0.7);
    whoosh(at + 0.2, 0.85, { from: 500, to: 3200, g: 0.13, pan0: -0.7, pan1: 0.7, q: 1.6 });
    if (ok) { chime(at + 1.0, 81, 88, 0.6); impact(at + 1.0, 0.22); } else buzz(at + 1.0);
  };
  send(35.0, false); send(36.75, false); send(38.5, true);
  tone(40.4, 1400, { type: 'saw', f2: 140, glide: 0.5, d: 0.55, g: 0.035, lp: 2600, w: 0.3 });
  whoosh(40.35, 0.55, { from: 6000, to: 300, g: 0.1, pan0: 0.6, pan1: -0.6 });
  send(41.6, true);
  whoosh(44.9, 0.7, { from: 400, to: 3000, g: 0.1 });
  whoosh(45.6, 0.9, { from: 200, to: 1600, g: 0.08 });
  for (let i = 0; i < 3; i++) {
    const t0 = 46.4 + i * 0.18;
    for (let k = 1; k <= 22; k++) click(t0 + 1.8 * (-Math.log2(1 - k / 23) / 10), 0.035, 5500, (i - 1) * 0.6, 0.012);
    bell(t0 + 1.05, N([81, 86, 90][i]), 0.05, 1.4, (i - 1) * 0.6);
  }
  for (let k = 0; k < 23; k++) click(48.8 + k * (1.2 / 23) + rnd() * 0.012, 0.05 + rnd() * 0.03, 1600 + rnd() * 1200, 0.1, 0.02);
  whoosh(51.7, 0.7, { from: 400, to: 3000, g: 0.1 });
  whoosh(52.3, 1.0, { from: 200, to: 1800, g: 0.09 });
  const chipNotes = [69, 74, 76, 78, 81, 83, 86, 88, 90, 93];
  for (let i = 0; i < 10; i++) tone(53.7 + i * 0.11, N(chipNotes[i]), { d: 0.45, g: 0.045, pan: i % 2 ? 0.55 : -0.55, w: 0.5 });
  whoosh(59.2, 0.7, { from: 600, to: 4000, g: 0.11 });
  riser(58.6, 59.95, 0.17); impact(59.95, 0.95); shimmer(60.15, [74, 78, 81, 85, 88, 93], 0.055, 4.5);
  bell(61.6, N(86), 0.04, 3.0);

  /* ---- Duck the music under the narration ---- */
  const spans = [];
  cues.forEach(c => {
    const s = c.start - 0.15, e = c.end + 0.35;
    if (spans.length && s - spans[spans.length - 1][1] < 0.8) spans[spans.length - 1][1] = e; else spans.push([s, e]);
  });
  const duckAt = t => {
    for (const [s, e] of spans) {
      if (t >= s - 0.2 && t < s) return 1 - 0.55 * ((t - (s - 0.2)) / 0.2);
      if (t >= s && t < e) return 0.45;
      if (t >= e && t < e + 0.4) return 0.45 + 0.55 * ((t - e) / 0.4);
    }
    return 1;
  };
  for (let i = 0; i < LEN; i++) {
    const d = duckAt(i / SR);
    mus[0][i] *= d; mus[1][i] *= d;
    wet[0][i] += mus[0][i] * 0.3; wet[1][i] += mus[1][i] * 0.3;
  }

  /* ---- Reverb (Freeverb) ---- */
  const scale = SR / 44100;
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], apT = [556, 441, 341, 225];
  const rev = [0, 1].map(ch => {
    const src = wet[ch], outp = new Float32Array(LEN), spread = ch ? 23 : 0;
    const combs = combT.map(c => ({ buf: new Float32Array(Math.round((c + spread) * scale)), i: 0, f: 0 }));
    const aps = apT.map(c => ({ buf: new Float32Array(Math.round((c + spread) * scale)), i: 0 }));
    const fb = 0.86, damp = 0.25;
    for (let n = 0; n < LEN; n++) {
      const x = src[n] * 0.015; let y = 0;
      for (const c of combs) { const o = c.buf[c.i]; c.f = o * (1 - damp) + c.f * damp; c.buf[c.i] = x + c.f * fb; c.i = (c.i + 1) % c.buf.length; y += o; }
      for (const a of aps) { const b = a.buf[a.i]; const o = -y + b; a.buf[a.i] = y + b * 0.5; a.i = (a.i + 1) % a.buf.length; y = o; }
      outp[n] = y;
    }
    return outp;
  });

  const L = new Float32Array(LEN), R = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    L[i] = Math.tanh((mus[0][i] + fx[0][i] + rev[0][i] * 1.4) * 1.1);
    R[i] = Math.tanh((mus[1][i] + fx[1][i] + rev[1][i] * 1.4) * 1.1);
  }
  return [L, R];
}

export function toWav([L, R]) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  return buf;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cues = JSON.parse(readFileSync(join(here, 'narration.json'), 'utf8'));
  const t0 = Date.now();
  const wav = toWav(compose(cues));
  writeFileSync(process.argv[2] || 'soundtrack.wav', wav);
  console.log(`soundtrack: ${DUR}s rendered in ${Date.now() - t0} ms`);
}
