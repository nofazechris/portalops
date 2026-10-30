# PortalOps film

A 67-second narrated motion film for PortalOps. Open `portalops-film.html` through any static server
(for example `python -m http.server 8811 --directory brand/motion`), then press **Play the film**.

| File | What it is |
|---|---|
| `portalops-film.html` | The film: animation (GSAP), captions, player controls |
| `portalops-soundtrack.mp3` | Final mix: music, sound effects and narration, -16 LUFS |
| `portalops-voice.mp3` | Narration only, already placed on the film's timeline |
| `narration.json` | Narration lines with start and end times (used for captions and music ducking) |
| `soundtrack.mjs` | Synthesises the music and effects, timed to the film |

Player keys: Space play/pause, ← → skip 5 s, M mute, C captions.

## Rebuilding the soundtrack

The narration was made with a Microsoft neural voice (`en-US-AndrewMultilingualNeural`, rate -6%, pitch -3Hz) through the
`edge-tts` Python package, one clip per line, trimmed of silence and placed at the times in `narration.json`.

After changing music or effects in `soundtrack.mjs`:

```bash
node brand/motion/soundtrack.mjs music_fx.wav
ffmpeg -i music_fx.wav -i brand/motion/portalops-voice.mp3 -filter_complex "[1:a]volume=1.35,aresample=48000,pan=stereo|c0=c0|c1=c0[v];[0:a][v]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[o]" -map "[o]" -ar 48000 -b:a 160k brand/motion/portalops-soundtrack.mp3
```

## Rendering the MP4

```bash
node brand/motion/render-video.mjs demo-video/portalops-motion-film.mp4 60
```

Four headless Edge (or Chrome) browsers each render a slice of the film at 1920×1080, frame by frame, then the slices are joined and
the soundtrack is added. Set `WORKERS` to change how many run at once. It needs GPU access and takes about 30 minutes at 60 fps.

If you change scene timings in the HTML, move the matching effect times in `soundtrack.mjs` and the line times in `narration.json`.
