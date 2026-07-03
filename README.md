# Reactive Music Visualizer

A browser-based music visualizer for Windows that listens to the computer's
**system audio** (any app, not one specific source) and automatically picks and
morphs its visual style to match the song. No app in the render loop makes the
frame-by-frame decisions — the reactivity is driven by audio analysis (DSP), and
an AI classifier is a planned later upgrade for smarter, mood-aware switching.

See [`reactive_visualizer_build_plan.md`](./reactive_visualizer_build_plan.md)
for the full architecture, roadmap, and design rationale.

## Status

🟢 **v1.1 complete — self-driving, now with live controls.** The whole v1
pipeline is built and tuned — system-audio capture → per-frame feature
extraction → a director that scores the current music and crossfades between two
renderers, all at 60fps with no frame-by-frame app involvement — and **v1.1**
adds an auto-hiding control bar, a global intensity dial, and live-use hotkeys on
top.

The v1 build order is done:

1. ✅ Capture proof — system audio into an `AnalyserNode`
2. ✅ Feature extraction — full smoothed feature set + toggleable debug overlay
3. ✅ Renderer 1 — particle swarm
4. ✅ Renderer 2 — fluid plasma
5. ✅ Director — scored selection with downbeat-aligned crossfades
6. ✅ Polish — hysteresis, auto-gain, robust beat detection, BPM octave-folding,
   feature-to-style tuning, and a live dev tuning panel

Next up is **v1.2** (now-playing tag, set-list recaps, and Spotify buttons via a
small local backend); see [Roadmap](#roadmap).

## How it works

Data flows one direction — **Capture → Analysis → Director → Renderers** — as
four decoupled layers:

- **Capture** ([`audio/capture.ts`](./src/audio/capture.ts)) — `getDisplayMedia`
  grabs system audio into a Web Audio `AnalyserNode`. Chrome's mic-oriented audio
  processing (auto-gain, noise suppression, echo cancellation) is disabled so the
  signal comes in raw and full-level.
- **Analysis** ([`audio/features.ts`](./src/audio/features.ts)) — each frame it
  computes band energies (bass/mid/treble), loudness (RMS), brightness (spectral
  centroid), motion (spectral flux), and beat/tempo (the BPM is octave-folded
  into a musical range so subdivision over-fires don't double it), then packages
  them into one `features` object. Values are exposed raw, attack-decay
  **smoothed**, and
  auto-gained (**AGC**, normalized to the stream's own recent range) so the
  visuals react to a song's dynamics regardless of how loud the capture is.
- **Director** ([`director/Director.ts`](./src/director/Director.ts)) — scores
  every renderer each frame and picks the best fit, but commits with hysteresis:
  a challenger must lead by a margin and hold it, and the switch lands on a
  musical boundary (a 4-beat "downbeat", with a timeout fallback for beatless
  music). Transitions are ~1.5s opacity crossfades.
- **Renderers** ([`renderers/`](./src/renderers/)) — each implements a shared
  `Renderer` interface (`init` / `score` / `update` / `render` / `setOpacity` /
  `dispose`, plus optional `resize` / `setIntensity`) so the director can swap
  and crossfade them freely.

The two v1 renderers are deliberately opposite so switching is obvious:

- **Particle swarm** — a 4,000-point Three.js cloud with a spring-damper motion
  model. Energetic: loudness drives liveliness, bass drives size + expansion,
  treble drives sparkle, motion drives turbulence, and each beat fires a radial
  burst.
- **Fluid plasma** — a full-screen fbm + domain-warp fragment shader, rendered
  to a resolution-capped target and upscaled for a stable 60fps. Calm: loudness
  drives intensity, bass the slow swell, motion the flow, brightness the palette
  (deep/dark ↔ cool/bright), and each beat a soft bloom.

A global **intensity** dial (0–2, 1 = neutral) scales each renderer's reactive
magnitude only — never anything the director scores on — so turning liveliness up
or down never changes which style gets auto-picked.

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

A **control bar** auto-hides at the bottom of the screen (media-player style):
move the mouse to reveal it, and it fades out after ~3s idle so it never sits on
a screen share. It carries an **AUTO/MANUAL** toggle, **Swarm** / **Plasma**
buttons (a click drops to manual, so you needn't disable auto first), an
**intensity** slider, and a **fullscreen** toggle. Everything on it is also a key:

| Key           | Action                                                          |
| ------------- | --------------------------------------------------------------- |
| `a`           | Toggle **AUTO** ↔ **MANUAL** direction                          |
| `1` / `2`     | In MANUAL, force ParticleSwarm / FluidPlasma (still crossfades) |
| `↑` / `↓`     | Intensity up / down (also `+` / `-`)                            |
| `f`           | Toggle fullscreen                                               |
| `h`           | Hide / show the top-left capture panel                          |
| `d`           | Toggle the debug overlay                                        |
| `t`           | Toggle the dev tuning panel (live-adjust scoring/director)      |

While capturing, a **● Start log** button records features + director state to a
CSV (10 Hz) for offline tuning; click again to stop and download.

### Debug overlay

Press **`d`** for a live readout of every feature (raw → smoothed, plus bars),
tempo/beat info, the AGC and beat-activity signals, and the director's state:
each style's score, the current style, the challenger and its hold-timer
progress, the switch-pending flag, and the transition progress. It's the main
tool for understanding and tuning behavior.

### Tuning panel (dev)

Press **`t`** for a developer-only panel of live sliders (hidden by default,
clearly separated from the UI) bound to the score weights, the tempo/brightness
windows, and the director's timing constants. Changes apply on the next frame
with no rebuild, and a printout lets you copy good settings back into
[`src/tuning.ts`](./src/tuning.ts) as the new defaults. This is a dev instrument,
not a user control.

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
  tuning.ts                   # Live dev-tuning config (defaults + runtime overrides)
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
    VisualizerCanvas.tsx      # Owns the WebGLRenderer + frame loop, hosts director;
                              #   exposes the imperative control handle
    ControlBar.tsx            # v1.1 auto-hiding live control bar
    DebugOverlay.tsx          # Toggleable live feature + director readout ('d')
    TuningPanel.tsx           # Dev-only live tuning sliders ('t')
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
- **Live tuning:** the score weights, the tempo/brightness windows, and the five
  most-tuned director constants live in [`src/tuning.ts`](./src/tuning.ts); the
  dev tuning panel (`t`) mutates them at runtime so changes apply without a
  rebuild, and good values get copied back as the new defaults.
- **Intensity is visual-only:** the user's intensity dial scales renderers'
  reactive magnitude but never the features `score()` reads, so liveliness and
  style selection stay independent — turning it up can't change what the director
  auto-picks. The control bar (in `App`) drives the single director inside the
  canvas through an imperative command handle, mirroring the status up-channel —
  no second director.
- **No echo:** the `AnalyserNode` is intentionally **not** connected to the audio
  destination, so captured audio is analysed but never played back out.
- **Everything heavy stays out of the render loop:** the director's scoring is
  cheap math; the future AI classifier (v2) will run on its own slow interval and
  only hand the director a label.

## Roadmap

- **v1** ✅ — Full pipeline, DSP director, particle swarm + fluid plasma, fully
  self-driving.
- **v1.1** ✅ — Live-use controls: an auto-hiding control bar (auto lock, style
  selection, intensity dial, fullscreen) plus hotkeys. No new renderers and no
  scoring changes.
- **v1.2** — A now-playing experience backed by a small **local** Node server
  (not a cloud function — it writes to disk and holds Spotify tokens): an
  unobtrusive tag that IDs the current track via a fingerprinting service
  (AudD/ACRCloud) on a hotkey; a set-list **recap** appended to a timestamped
  file in `recaps/` as songs are recognized; and **Open in Spotify** /
  **Add to playlist** buttons (Spotify OAuth handled in the backend). All
  returned streaming IDs are stored behind a provider seam so other services can
  be added later.
- **v1.3** — More visualizations: reactive geometry and elevated spectrum
  renderers, plus a scoring rework. The two v1 styles are near-opposites, so a
  single energy axis works; genuinely new styles need multi-dimensional scoring
  (brightness / harmonic content as their own axes) or they'd never win a
  comparison.
- **v2** — An AI classifier (tensorflow.js, e.g. YAMNet) running every 1–2s,
  feeding genre/mood into the director so switching gets smarter than raw energy
  (e.g. it stops treating a quiet buildup as a calm song).

The BPM estimate is octave-folded into a preferred musical range so subdivision
over-fires don't double the tempo. A further tempo-estimation upgrade
(autocorrelation of the onset signal) could stabilize the readout and sharpen
borderline calls, but isn't required for correct switching.
