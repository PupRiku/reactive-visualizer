# Reactive Music Visualizer

A browser-based music visualizer for Windows that listens to the computer's
**system audio** (any app, not one specific source) and automatically picks and
morphs its visual style to match the song. No app in the render loop makes the
frame-by-frame decisions — the reactivity is driven by audio analysis (DSP), and
an AI classifier is a planned later upgrade for smarter, mood-aware switching.

See [`reactive_visualizer_build_plan.md`](./reactive_visualizer_build_plan.md)
for the full architecture, roadmap, and design rationale.

## Status

🟢 **v1 complete — fully self-driving.** The whole pipeline is built and tuned:
system-audio capture → per-frame feature extraction → a director that scores the
current music and crossfades between two renderers, all at 60fps with no
frame-by-frame app involvement.

The suggested build order is done:

1. ✅ Capture proof — system audio into an `AnalyserNode`
2. ✅ Feature extraction — full smoothed feature set + toggleable debug overlay
3. ✅ Renderer 1 — particle swarm
4. ✅ Renderer 2 — fluid plasma
5. ✅ Director — scored selection with downbeat-aligned crossfades
6. ✅ Polish — hysteresis, auto-gain, robust beat detection, feature-to-style tuning

Next up is **v1.1** (manual live controls + two more renderers); see
[Roadmap](#roadmap).

## How it works

Data flows one direction — **Capture → Analysis → Director → Renderers** — as
four decoupled layers:

- **Capture** ([`audio/capture.ts`](./src/audio/capture.ts)) — `getDisplayMedia`
  grabs system audio into a Web Audio `AnalyserNode`. Chrome's mic-oriented audio
  processing (auto-gain, noise suppression, echo cancellation) is disabled so the
  signal comes in raw and full-level.
- **Analysis** ([`audio/features.ts`](./src/audio/features.ts)) — each frame it
  computes band energies (bass/mid/treble), loudness (RMS), brightness (spectral
  centroid), motion (spectral flux), and beat/tempo, then packages them into one
  `features` object. Values are exposed raw, attack-decay **smoothed**, and
  auto-gained (**AGC**, normalized to the stream's own recent range) so the
  visuals react to a song's dynamics regardless of how loud the capture is.
- **Director** ([`director/Director.ts`](./src/director/Director.ts)) — scores
  every renderer each frame and picks the best fit, but commits with hysteresis:
  a challenger must lead by a margin and hold it, and the switch lands on a
  musical boundary (a 4-beat "downbeat", with a timeout fallback for beatless
  music). Transitions are ~1.5s opacity crossfades.
- **Renderers** ([`renderers/`](./src/renderers/)) — each implements a shared
  `Renderer` interface (`init` / `score` / `update` / `render` / `setOpacity` /
  `dispose`) so the director can swap and crossfade them freely.

The two v1 renderers are deliberately opposite so switching is obvious:

- **Particle swarm** — a 4,000-point Three.js cloud with a spring-damper motion
  model. Energetic: loudness drives liveliness, bass drives size + expansion,
  treble drives sparkle, motion drives turbulence, and each beat fires a radial
  burst.
- **Fluid plasma** — a full-screen fbm + domain-warp fragment shader, rendered
  to a resolution-capped target and upscaled for a stable 60fps. Calm: loudness
  drives intensity, bass the slow swell, motion the flow, brightness the palette
  (deep/dark ↔ cool/bright), and each beat a soft bloom.

## Tech stack

- **Vite + React + TypeScript** — app shell
- **Web Audio API** — capture (`getDisplayMedia` → `MediaStreamSource`) and
  analysis (`AnalyserNode` FFT); no audio library needed
- **Three.js** — WebGL rendering (`Points` for the swarm, a full-screen
  `ShaderMaterial` for the plasma)

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

Then open **http://localhost:5173/** in Chrome or Edge, in a **visible window**
(a hidden/background tab pauses the animation loop).

## Using it

1. Click **Start capture**.
2. In the share dialog, choose **Entire Screen** (not a single browser tab).
3. **Tick the "Share system audio" checkbox** — this is the setting that
   matters. Sharing a single tab, or leaving this unchecked, captures no audio.
4. Click Share, then play music from any app (Spotify, YouTube, etc.).

The visualizer starts in **AUTO** mode and drives itself: it defaults to the
particle swarm, and once the music has clearly favored the other style for long
enough, it crossfades to the fluid plasma on a downbeat (and back). Energetic /
percussive music leans toward the swarm; slow, calm, ambient music toward the
plasma.

### Controls

| Key           | Action                                                          |
| ------------- | --------------------------------------------------------------- |
| `d`           | Toggle the debug overlay                                        |
| `a`           | Toggle **AUTO** ↔ **MANUAL** direction                          |
| `1` / `2`     | In MANUAL, force ParticleSwarm / FluidPlasma (still crossfades) |

While capturing, a **● Start log** button records features + director state to a
CSV (10 Hz) for offline tuning; click again to stop and download.

### Debug overlay

Press **`d`** for a live readout of every feature (raw → smoothed, plus bars),
tempo/beat info, the AGC and beat-activity signals, and the director's state:
each style's score, the current style, the challenger and its hold-timer
progress, the switch-pending flag, and the transition progress. It's the main
tool for understanding and tuning behavior.

**Troubleshooting — inert visuals:** the "Share system audio" box wasn't
checked, or you shared a single tab instead of the whole screen. Click **Stop**,
then **Start** again and re-check the box. On Windows the option reliably appears
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
  App.tsx                     # Capture lifecycle + start/stop UI + status panel
  index.css                   # Global styles
  audio/
    capture.ts                # getDisplayMedia → AudioContext → AnalyserNode
    features.ts               # FeatureExtractor: bands, RMS, centroid, flux,
                              #   beat/tempo, AGC, beat-activity
  hooks/
    useFeatures.ts            # RAF loop that fills a features ref each frame
  director/
    Director.ts               # Scoring, hysteresis, downbeat-aligned crossfades
  renderers/
    types.ts                  # Shared Renderer interface + RendererContext
    scoring.ts                # Normalization helpers for score()
    ParticleSwarm.ts          # Energetic style (Three.js Points)
    FluidPlasma.ts            # Calm style (full-screen fbm shader)
  components/
    VisualizerCanvas.tsx      # Owns the WebGLRenderer + frame loop, hosts director
    DebugOverlay.tsx          # Toggleable live feature + director readout ('d')
    SessionLogger.tsx         # Record features/director state to CSV
```

## Design notes

- **Capture is raw:** disabling Chrome's audio processing keeps the level stable
  (auto-gain otherwise drags it toward silence and varies run-to-run), and the
  analyser's temporal smoothing is kept low so spectral flux and bass onsets
  survive for the DSP.
- **Volume-independent decisions:** because absolute capture level is
  unreliable, the director scores on musical cues that don't swing with volume —
  tempo, beat activity, and timbre — while the *visuals* run off the auto-gained
  (AGC) values to stay lively at any level.
- **Robust beats:** onsets fire on the *rise* in bass energy (not absolute
  level, which saturates on loud tracks) and are gated on a broadband
  spectral-flux spike, so tonal ambient swells don't register as false beats.
- **Commitment, not flicker:** the director smooths scores and uses a leaky
  hold-timer so brief wobble doesn't reset a genuine switch — a decisive change
  lands in ~15s and holds through temporary lulls.
- **No echo:** the `AnalyserNode` is intentionally **not** connected to the audio
  destination, so captured audio is analysed but never played back out.
- **Everything heavy stays out of the render loop:** the director's scoring is
  cheap math; the future AI classifier (v2) will run on its own slow interval and
  only hand the director a label.

## Roadmap

- **v1** ✅ — Full pipeline, DSP director, particle swarm + fluid plasma, fully
  self-driving.
- **v1.1** — Manual live controls (lock the current style, force a specific
  style, intensity nudge) plus two more renderers: reactive geometry and
  elevated spectrum.
- **v1.2** — A small, unobtrusive "now playing" tag that identifies the current
  track via a music-fingerprinting service (AudD/ACRCloud) through a tiny
  serverless proxy, triggered on demand by a hotkey.
- **v2** — An AI classifier (tensorflow.js, e.g. YAMNet) running every 1–2s,
  feeding genre/mood into the director so switching gets smarter than raw energy
  (e.g. it stops treating a quiet buildup as a calm song).

A tempo-estimation upgrade (autocorrelation of the onset signal) is also noted
for later — it would stabilize the BPM readout and sharpen borderline calls,
though it isn't required for correct switching.
