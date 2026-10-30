// Render the PortalOps film to an MP4, frame by frame, with headless Edge or Chrome.
// Several browsers render slices of the film in parallel; the slices are joined and the soundtrack added.
//
//   node brand/motion/render-video.mjs <out.mp4> [fps=60]
//
// Env: WORKERS (default 4), BROWSER (path to Edge/Chrome), FORMAT (jpeg|png, default jpeg).
// Needs ffmpeg on PATH, Edge or Chrome, Node 24+ (built-in WebSocket and fetch).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DUR } from './soundtrack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const W = 1920, H = 1080;
const FMT = process.env.FORMAT || 'jpeg';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
  p.on('close', c => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
});

if (process.env.WORKER == null) {
  /* ---------- Orchestrator ---------- */
  const OUT = resolve(process.argv[2] || 'portalops-film.mp4');
  const FPS = Number(process.argv[3] || 60);
  const K = Number(process.env.WORKERS || 4);
  const total = Math.round(DUR * FPS), per = Math.ceil(total / K);
  const work = join(tmpdir(), `portalops-render-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const t0 = Date.now();
  console.log(`Rendering ${total} frames at ${FPS} fps with ${K} browsers`);
  const segs = [];
  const jobs = [];
  for (let k = 0; k < K; k++) {
    const frame0 = k * per, frames = Math.min(per, total - frame0);
    if (frames <= 0) break;
    const seg = join(work, `seg${k}.mp4`); segs.push(seg);
    jobs.push(run(process.execPath, [self, seg, String(FPS)], {
      env: { ...process.env, WORKER: String(k), FRAME0: String(frame0), FRAMES: String(frames), PROFILE_DIR: join(work, `profile${k}`) }
    }));
  }
  await Promise.all(jobs);
  writeFileSync(join(work, 'list.txt'), segs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'list.txt'),
    '-i', join(here, 'portalops-soundtrack.mp3'), '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', OUT]);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  console.log(`done: ${OUT} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
} else {
  /* ---------- Worker: render frames [FRAME0, FRAME0 + FRAMES) to a video-only segment ---------- */
  const k = Number(process.env.WORKER), OUT = process.argv[2], FPS = Number(process.argv[3]);
  const FRAME0 = Number(process.env.FRAME0), FRAMES = Number(process.env.FRAMES);
  const PORT = 8830 + k, DBG = 9340 + k;
  const BROWSER = [process.env.BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => existsSync(p));
  if (!BROWSER) throw new Error('No Edge or Chrome found; set BROWSER=/path/to/browser');

  const types = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg', '.js': 'text/javascript', '.json': 'application/json' };
  const server = createServer((req, res) => {
    const p = join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(here) || !existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  }).listen(PORT);

  const chrome = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${process.env.PROFILE_DIR}`,
    `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--use-angle=d3d11', '--force-device-scale-factor=1', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch {} server.close(); };
  process.on('exit', cleanup);

  let target;
  for (let i = 0; i < 300 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find(t => t.type === 'page'); } catch { await sleep(200); }
  }
  if (!target) throw new Error(`worker ${k}: browser did not start`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, m => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed'); return r.result.value; };

  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/portalops-film.html` });
  for (let i = 0; i < 150; i++) { if (await evaluate('!!window.__film').catch(() => false)) break; await sleep(100); }
  await evaluate(`(async () => {
    await document.fonts.ready;
    const f = window.__film;
    document.querySelector('#intro').hidden = true;
    document.querySelector('#intro').style.display = 'none';
    document.querySelector('.ctrl').style.display = 'none';
    document.querySelector('#cap').style.display = 'none';
    f.audio.muted = true; f.tl.pause();
    window.dispatchEvent(new Event('resize'));
  })()`);
  await sleep(300);

  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', FMT === 'jpeg' ? 'mjpeg' : 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', '-tune', 'film', '-r', String(FPS), OUT],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let f = 0; f < FRAMES; f++) {
    const t = (FRAME0 + f) / FPS;
    await evaluate(`(() => { const F = window.__film; F.tl.time(${t.toFixed(6)}); F.draw(); })()`);
    const { data } = await cdp('Page.captureScreenshot', { format: FMT, ...(FMT === 'jpeg' ? { quality: 95 } : {}), optimizeForSpeed: true, captureBeyondViewport: false });
    if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 120 === 0 || f === FRAMES - 1) console.log(`  browser ${k}: ${f + 1}/${FRAMES} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  ws.close(); cleanup();
  process.exit(0);
}
