# Reactive Music Visualizer

A browser-based music visualizer for Windows that listens to the computer's
**system audio** (any app, not one specific source) and automatically picks and
morphs its visual style to match the song. The reactivity is driven by audio
analysis (DSP); an AI classifier is a planned later upgrade for smarter,
mood-aware switching.

See [`reactive_visualizer_build_plan.md`](./reactive_visualizer_build_plan.md)
for the full architecture and roadmap.

## Status

🟢 **Step 1 complete — Capture proof.** System audio is captured via
`getDisplayMedia`, routed into a Web Audio `AnalyserNode`, and drawn as a plain
spectrum-bar display. This confirms audio is flowing before any real renderers
are built.

Remaining build order (not yet started):

2. Feature extraction — compute & smooth the full feature set, show as debug readouts
3. Renderer 1 — particle swarms
4. Renderer 2 — fluid plasma
5. Director — rule-based switching with crossfade
6. Polish — hysteresis, downbeat-aligned switching, tuning

## Tech stack

- **Vite + React + TypeScript** — app shell
- **Web Audio API** — capture (`getDisplayMedia` → `MediaStreamSource`) and
  analysis (`AnalyserNode` FFT)
- **Three.js** — WebGL rendering (installed, used from Step 3 onward)

Runs entirely on the local Vite dev server. `localhost` is a secure context, so
system-audio capture works with no deployment.

## Requirements

- **Windows** with **Chrome or Edge** (the system-audio capture path relies on
  Chromium's "Share system audio" option)
- **Node.js 18+** (developed on Node 24)

## Getting started

```bash
npm install
npm run dev
```

Then open **http://localhost:5173/** in Chrome or Edge.

## Using it (Step 1)

1. Click **Start capture**.
2. In the share dialog, choose **Entire Screen** (not a single browser tab).
3. **Tick the "Share system audio" checkbox** — this is the setting that
   matters. Sharing a single tab, or leaving this unchecked, captures no audio.
4. Click Share, then play music from any app (Spotify, YouTube, etc.).

**Success:** the bars react to your music across the whole window.

**Troubleshooting — flat bars:** the "Share system audio" box wasn't checked,
or you shared a single tab instead of the whole screen. Click **Stop**, then
**Start** again and re-check the box. On Windows the option reliably appears
when you pick **Entire Screen**; when sharing an individual *window* it may be
greyed out on some Chrome/Edge builds.

## Scripts

| Command           | Description                          |
| ----------------- | ------------------------------------ |
| `npm run dev`     | Start the Vite dev server            |
| `npm run build`   | Typecheck (`tsc`) and build for prod |
| `npm run preview` | Preview the production build         |

## Project structure

```
src/
  main.tsx                    # React entry
  App.tsx                     # Start/Stop UI + capture lifecycle
  index.css                   # Global styles
  audio/
    capture.ts                # getDisplayMedia → AudioContext → AnalyserNode
  components/
    SpectrumBars.tsx          # 2D-canvas spectrum-bar display (Step 1 proof)
```

## Design notes

- **Capture:** `getDisplayMedia` is requested with both audio and video. Video
  is only requested because some capture paths only expose the system-audio
  option when video is also requested; the video track is dropped immediately.
- **No echo:** the `AnalyserNode` is intentionally **not** connected to the
  audio destination, so captured audio is analysed but never played back out.
- **Renderer choice for Step 1:** the spectrum bars use a plain 2D canvas
  rather than Three.js — its only job is to prove capture works. Three.js comes
  in with the real renderers (Step 3+).
